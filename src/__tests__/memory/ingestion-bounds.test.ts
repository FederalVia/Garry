/**
 * Market-signal ingestion does bounded work per turn, every ingested fact
 * expires, and a newer observation replaces an older one.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../state/database.js";
import { MemoryIngestionPipeline } from "../../memory/ingestion.js";
import type { AgentTurn, ToolCallResult } from "../../types.js";

let adb: ReturnType<typeof createDatabase>;

beforeEach(() => {
  adb = createDatabase(":memory:");
});

afterEach(() => {
  adb.close();
});

function turn(id: string): AgentTurn {
  return {
    id,
    timestamp: new Date().toISOString(),
    state: "running",
    thinking: "looking at prices",
    toolCalls: [],
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    costCents: 0,
  };
}

function fetchCall(url: string, result: string, id = "c1"): ToolCallResult {
  return { id, name: "web_fetch", arguments: { url }, result, durationMs: 1 };
}

function knowledge(): Array<{ key: string; content: string; expires_at: string | null; confidence: number }> {
  return adb.raw.prepare("SELECT key, content, expires_at, confidence FROM knowledge_store ORDER BY key").all() as any;
}

function events(type: string): Array<{ content: string }> {
  return adb.raw.prepare("SELECT content FROM event_stream WHERE type = ? ORDER BY created_at").all(type) as any;
}

describe("bounded ingestion", () => {
  it("a 700-line pricing result yields at most 20 signals and 20 facts", () => {
    const lines = Array.from({ length: 700 }, (_, i) => `vendor${i}.io: price $${i + 1} per seat`).join("\n");
    const pipeline = new MemoryIngestionPipeline(adb.raw);
    expect(pipeline.extractMarketSignals([fetchCall("https://docs.example.com/prices", lines)]).length).toBeLessThanOrEqual(20);

    pipeline.ingest("s", turn("t1"), [fetchCall("https://docs.example.com/prices", lines)]);
    const rows = knowledge();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(20);
    expect(events("market_signal").length).toBeLessThanOrEqual(20);
  });

  it("only the first 20,000 characters of a result are scanned", () => {
    const pipeline = new MemoryIngestionPipeline(adb.raw);
    const line = "acme.io: price $10 per seat";
    const filler = "x".repeat(25_000);
    const url = "https://docs.acme.io/pricing";
    expect(pipeline.extractMarketSignals([fetchCall(url, `${line}\n${filler}`)]).length).toBeGreaterThan(0);
    expect(pipeline.extractMarketSignals([fetchCall(url, `${filler}\n${line}`)])).toEqual([]);
  });

  it("at most 50 signals per turn across many tool calls", () => {
    const calls = Array.from({ length: 5 }, (_, c) =>
      fetchCall(
        `https://docs.example${c}.com/`,
        Array.from({ length: 30 }, (_, i) => `v${c}x${i}.io: price $${i + 1}`).join("\n"),
        `c${c}`,
      ));
    expect(new MemoryIngestionPipeline(adb.raw).extractMarketSignals(calls).length).toBe(50);
  });

  it("every ingested fact expires, including high-confidence ones", () => {
    new MemoryIngestionPipeline(adb.raw).ingest("s", turn("t1"), [
      fetchCall("https://docs.acme.io/pricing", "acme.io: price $10 per seat"),
    ]);
    const rows = knowledge();
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBeGreaterThanOrEqual(0.7);
    expect(rows[0].expires_at).not.toBeNull();
    const days = (Date.parse(rows[0].expires_at!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
  });
});

describe("conflicting observations", () => {
  it("an equal-or-higher-confidence value replaces the old one with one event", () => {
    const pipeline = new MemoryIngestionPipeline(adb.raw);
    pipeline.ingest("s", turn("t1"), [fetchCall("https://docs.acme.io/pricing", "acme.io: price $10 per seat")]);
    pipeline.ingest("s", turn("t2"), [fetchCall("https://docs.acme.io/pricing", "acme.io: price $15 per seat")]);

    const rows = knowledge();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("$15");
    const updates = events("knowledge");
    expect(updates).toHaveLength(1);
    expect(updates[0].content).toContain("updated");
    expect(updates[0].content).toContain("$10");
    expect(updates[0].content).toContain("$15");
  });

  it("a lower-confidence value is dropped with no event", () => {
    const pipeline = new MemoryIngestionPipeline(adb.raw);
    pipeline.ingest("s", turn("t1"), [fetchCall("https://docs.acme.io/pricing", "acme.io: price $10 per seat")]);
    const signalsBefore = events("market_signal").length;
    pipeline.ingest("s", turn("t2"), [fetchCall("https://news.example.com/acme", "acme.io: price $15 per seat")]);

    const rows = knowledge();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("$10");
    expect(events("knowledge")).toHaveLength(0);
    expect(events("market_signal").length).toBe(signalsBefore);
  });

  it("two values for one key in one batch leave one row", () => {
    new MemoryIngestionPipeline(adb.raw).ingest("s", turn("t1"), [
      fetchCall("https://docs.acme.io/a", "acme.io: price $20 per seat", "c1"),
      fetchCall("https://docs.acme.io/b", "acme.io: price $25 per seat", "c2"),
    ]);
    const rows = knowledge();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("$25");
  });

  it("generic line prefixes do not make unrelated facts share a key", () => {
    new MemoryIngestionPipeline(adb.raw).ingest("s", turn("t1"), [
      { id: "c1", name: "api_call", arguments: { endpoint: "https://api.one.example/x" }, result: "stdout: price of widgets $10", durationMs: 1 },
      { id: "c2", name: "api_call", arguments: { endpoint: "https://api.two.example/y" }, result: "stdout: price of gadgets $99", durationMs: 1 },
    ]);
    const keys = knowledge().map((r) => r.key);
    expect(keys.some((k) => k.startsWith("pricing:stdout"))).toBe(false);
    expect(new Set(keys).size).toBe(2);
  });
});
