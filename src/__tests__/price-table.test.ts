/**
 * The price table: every row pinned, agreement with the static baseline,
 * dated Anthropic ids, the highest known price, and the precedence rules
 * for one row (owner, then the larger of reported and table, else unpriced).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { LogEntry } from "../types.js";
import { StructuredLogger } from "../observability/logger.js";
import { STATIC_MODEL_BASELINE } from "../inference/types.js";
import {
  PRICE_TABLE,
  PRICES_AS_OF,
  highestKnownPrice,
  longPromptPrice,
  lookupPrice,
  maxKnownPrice,
  resetPriceWarningsForTests,
  resolvePrice,
  seedRows,
} from "../providers/price-table.js";

const ANTHROPIC = { id: "anthropic", kind: "anthropic" as const, baseUrl: "https://api.anthropic.com" };
const OPENAI = { id: "openai", kind: "openai" as const, baseUrl: "https://api.openai.com/v1" };
const GROQ = { id: "groq", kind: "openai" as const, baseUrl: "https://api.groq.com/openai/v1" };
const CUSTOM_OPENAI = { id: "openai", kind: "openai" as const, baseUrl: "http://127.0.0.1:8080/v1" };

const logs: LogEntry[] = [];
afterEach(() => {
  StructuredLogger.resetSink();
  logs.length = 0;
  resetPriceWarningsForTests();
});

describe("PRICE_TABLE", () => {
  it("pins every row (id, served by, USD/M in and out, tier)", () => {
    const pinned = PRICE_TABLE.map((r) => [
      typeof r.servedBy === "string" ? r.servedBy : r.servedBy.host,
      r.id,
      r.inputUsdPerM,
      r.outputUsdPerM,
      r.tierMinimum,
    ]);
    expect(pinned).toEqual([
      ["anthropic", "claude-fable-5-2", 8, 40, "normal"],
      ["anthropic", "claude-mythos-5-2", 8, 40, "normal"],
      ["anthropic", "claude-fable-5-1", 10, 50, "normal"],
      ["anthropic", "claude-mythos-5-1", 10, 50, "normal"],
      ["anthropic", "claude-fable-5", 10, 50, "normal"],
      ["anthropic", "claude-mythos-5", 10, 50, "normal"],
      ["anthropic", "claude-opus-5-5", 4, 20, "normal"],
      ["anthropic", "claude-opus-5", 5, 25, "normal"],
      ["anthropic", "claude-opus-4-8", 5, 25, "normal"],
      ["anthropic", "claude-opus-4-7", 5, 25, "normal"],
      ["anthropic", "claude-opus-4-6", 5, 25, "normal"],
      ["anthropic", "claude-sonnet-5-5", 2, 10, "normal"],
      ["anthropic", "claude-sonnet-5", 2, 10, "normal"],
      ["anthropic", "claude-sonnet-4-6", 3, 15, "normal"],
      ["anthropic", "claude-haiku-5-5", 0.1, 0.5, "critical"],
      ["anthropic", "claude-haiku-4-5", 1, 5, "critical"],
      ["openai", "gpt-5.2", 1.8, 14, "normal"],
      ["openai", "gpt-5.3", 2, 8, "normal"],
      ["openai", "gpt-4.1", 2, 8, "normal"],
      ["openai", "gpt-4.1-mini", 0.4, 1.6, "low_compute"],
      ["openai", "gpt-4.1-nano", 0.1, 0.4, "critical"],
      ["openai", "gpt-5-mini", 0.8, 3.2, "low_compute"],
      ["api.groq.com", "llama-3.3-70b-versatile", 0.59, 0.79, "normal"],
      ["api.groq.com", "llama-3.1-8b-instant", 0.05, 0.08, "critical"],
      ["api.together.xyz", "meta-llama/Llama-3.3-70B-Instruct-Turbo", 0.88, 0.88, "normal"],
      ["api.together.xyz", "meta-llama/Llama-3.1-8B-Instruct-Turbo", 0.18, 0.18, "critical"],
    ]);
    expect(PRICES_AS_OF).toBe("2026-11-03");
  });

  it("pins capabilities: thinking, effort, the output floor and Haiku 5.5's long-prompt tier", () => {
    const caps = (id: string) => PRICE_TABLE.find((r) => r.id === id)!.capabilities!;
    expect(caps("claude-opus-5-5")).toMatchObject({ thinking: "default-on", effort: true, sampling: false, minOutputTokens: 2048 });
    expect(caps("claude-sonnet-4-6")).toMatchObject({ thinking: "opt-in", effort: true, sampling: true });
    expect(caps("claude-sonnet-4-6").effortLevels).not.toContain("xhigh");
    expect(caps("claude-opus-4-8")).toMatchObject({ thinking: "opt-in", effort: true });
    expect(caps("claude-haiku-4-5")).toMatchObject({ thinking: "opt-in", effort: false });
    expect(caps("claude-haiku-5-5").longPrompt).toEqual({ aboveInputTokens: 100_000, inputUsdPerM: 0.5, outputUsdPerM: 2.5 });
    for (const r of PRICE_TABLE) {
      if (r.capabilities?.thinking === "default-on") expect(r.capabilities.minOutputTokens, r.id).toBe(2048);
    }
  });

  it("every baseline model is in the table at the same or a higher price", () => {
    for (const m of STATIC_MODEL_BASELINE) {
      const row = lookupPrice(OPENAI, m.modelId);
      expect(row, m.modelId).toBeDefined();
      expect(row!.inputUsdPerM, m.modelId).toBeGreaterThanOrEqual(m.costPer1kInput / 10);
      expect(row!.outputUsdPerM, m.modelId).toBeGreaterThanOrEqual(m.costPer1kOutput / 10);
    }
  });

  it("seeds the owner-decision Anthropic defaults and the Phase 1 pair, never Mythos", () => {
    expect(seedRows("anthropic").map((r) => r.id).sort()).toEqual(
      ["claude-haiku-4-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5-5"].sort(),
    );
    expect(seedRows("openai")).toEqual([]);
  });
});

describe("lookupPrice", () => {
  it("a dated Anthropic id matches its alias", () => {
    expect(lookupPrice(ANTHROPIC, "claude-haiku-4-5-20251001")?.id).toBe("claude-haiku-4-5");
    expect(lookupPrice(ANTHROPIC, "claude-opus-5-5")?.inputUsdPerM).toBe(4);
  });

  it("prices only on the serving endpoint", () => {
    expect(lookupPrice(OPENAI, "claude-opus-5-5")).toBeUndefined();
    expect(lookupPrice(ANTHROPIC, "gpt-5.2")).toBeUndefined();
    // OpenAI's price does not follow its model ids to another server.
    expect(lookupPrice(CUSTOM_OPENAI, "gpt-5.2")).toBeUndefined();
    expect(lookupPrice(GROQ, "llama-3.3-70b-versatile")?.inputUsdPerM).toBe(0.59);
    expect(lookupPrice({ ...GROQ, baseUrl: "https://api.together.xyz/v1" }, "llama-3.3-70b-versatile")).toBeUndefined();
  });
});

describe("maxKnownPrice", () => {
  it("is $10 / $50 per M with today's table", () => {
    expect(maxKnownPrice()).toEqual({ inputUsdPerM: 10, outputUsdPerM: 50 });
  });

  it("an owner price above it raises it, per side", () => {
    expect(
      maxKnownPrice({
        providers: { compatible: [{ id: "x", baseUrl: "https://x.example/v1", models: [{ id: "m", inputUsdPerM: 15, outputUsdPerM: 20 }] }] },
      }),
    ).toEqual({ inputUsdPerM: 15, outputUsdPerM: 50 });
    expect(maxKnownPrice({ providers: { anthropic: { models: [{ id: "m", outputUsdPerM: 75 }] } } })).toEqual({
      inputUsdPerM: 10,
      outputUsdPerM: 75,
    });
  });
});

describe("resolvePrice", () => {
  const table = lookupPrice(ANTHROPIC, "claude-sonnet-5-5")!;

  it("takes the larger of reported and table, per side", () => {
    expect(resolvePrice({ table, listed: { inputUsdPerM: 3, outputUsdPerM: 5 } })).toEqual({
      inputUsdPerM: 3,
      outputUsdPerM: 10,
      source: "listed",
    });
    expect(resolvePrice({ table, listed: { inputUsdPerM: 1, outputUsdPerM: 1 } })).toEqual({
      inputUsdPerM: 2,
      outputUsdPerM: 10,
      source: "table",
    });
    expect(resolvePrice({ table })).toEqual({ inputUsdPerM: 2, outputUsdPerM: 10, source: "table" });
  });

  it("a zero or missing reported price counts as missing", () => {
    expect(resolvePrice({ listed: { inputUsdPerM: 0, outputUsdPerM: 0 } })).toBeNull();
    expect(resolvePrice({ listed: { inputUsdPerM: 1, outputUsdPerM: 0 } })).toBeNull();
    expect(resolvePrice({ table, listed: { inputUsdPerM: 0, outputUsdPerM: 0 } })?.source).toBe("table");
  });

  it("a per-request fee makes the model unpriced, unless the owner priced it", () => {
    expect(resolvePrice({ listed: { inputUsdPerM: 1, outputUsdPerM: 2, requestFeeUsd: 0.005 } })).toBeNull();
    expect(resolvePrice({ table, listed: { inputUsdPerM: 1, outputUsdPerM: 2, requestFeeUsd: 0.005 } })).toBeNull();
    expect(
      resolvePrice({ owner: { inputUsdPerM: 4, outputUsdPerM: 8 }, listed: { inputUsdPerM: 1, outputUsdPerM: 2, requestFeeUsd: 1 } }),
    ).toEqual({ inputUsdPerM: 4, outputUsdPerM: 8, source: "owner" });
  });

  it("the owner price wins, even below the table, and that is logged once", () => {
    StructuredLogger.setSink((e) => logs.push(e));
    const owner = { inputUsdPerM: 1, outputUsdPerM: 1 };
    expect(resolvePrice({ owner, table, listed: { inputUsdPerM: 9, outputUsdPerM: 9 }, label: "anthropic/claude-sonnet-5-5" })).toEqual({
      ...owner,
      source: "owner",
    });
    resolvePrice({ owner, table, label: "anthropic/claude-sonnet-5-5" });
    const warned = logs.filter((l) => l.level === "warn" && l.message.includes("below the list price"));
    expect(warned).toHaveLength(1);
    // Above the table: no warning.
    resolvePrice({ owner: { inputUsdPerM: 50, outputUsdPerM: 50 }, table, label: "other" });
    expect(logs.filter((l) => l.message.includes("below the list price"))).toHaveLength(1);
  });

  it("an incomplete owner price falls back to the table", () => {
    expect(resolvePrice({ owner: { inputUsdPerM: 1 }, table })).toEqual({ inputUsdPerM: 2, outputUsdPerM: 10, source: "table" });
  });
});

describe("highestKnownPrice and longPromptPrice", () => {
  it("highestKnownPrice takes the larger of the table/owner maximum and the priciest listed row", () => {
    expect(highestKnownPrice(null)).toEqual({ inputUsdPerM: 10, outputUsdPerM: 50 });
    expect(highestKnownPrice(null, { maxListedPrice: () => ({ inputUsdPerM: 25, outputUsdPerM: 5 }) })).toEqual({
      inputUsdPerM: 25,
      outputUsdPerM: 50,
    });
  });

  // Rewritten on purpose: the trigger moved from 80% to 70% so an estimate
  // up to 1.4x short still reserves the high tier.
  it("Haiku 5.5's high tier applies from 70% of 100K estimated prompt tokens", () => {
    const caps = lookupPrice(ANTHROPIC, "claude-haiku-5-5")!.capabilities;
    expect(longPromptPrice(caps, 69_999)).toBeNull();
    expect(longPromptPrice(caps, 70_000)).toEqual({ inputUsdPerM: 0.5, outputUsdPerM: 2.5 });
    expect(longPromptPrice(lookupPrice(ANTHROPIC, "claude-opus-5-5")!.capabilities, 900_000)).toBeNull();
    expect(longPromptPrice(undefined, 1e9)).toBeNull();
  });
});
