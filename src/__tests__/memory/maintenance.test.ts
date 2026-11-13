/**
 * The memory_maintenance heartbeat task, the indexes behind the per-turn
 * queries, and expiry comparisons on ISO-8601 timestamps.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createDatabase,
  insertDedupKey,
  isDeduplicated,
  pruneExpiredDedupKeys,
  pruneOldInboxMessages,
  INBOX_MIN_RETENTION_DAYS,
  wmClearExpired,
} from "../../state/database.js";
import { INBOUND_MAX_AGE_MS } from "../../social/inbound.js";
import { BUILTIN_TASKS } from "../../heartbeat/tasks.js";
import { loadHeartbeatConfig } from "../../heartbeat/config.js";
import { WorkingMemoryManager } from "../../memory/working.js";
import type { HeartbeatLegacyContext } from "../../types.js";

let adb: ReturnType<typeof createDatabase>;

beforeEach(() => {
  adb = createDatabase(":memory:");
});

afterEach(() => {
  adb.close();
});

function runMaintenance(): Promise<{ shouldWake: boolean }> {
  const ctx = { db: adb } as unknown as HeartbeatLegacyContext;
  return BUILTIN_TASKS.memory_maintenance({} as any, ctx);
}

function plan(sql: string): string {
  return (adb.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(" | ");
}

describe("episodic retention", () => {
  it("deletes old low-importance rows and keeps goal records and important rows", async () => {
    const insert = adb.raw.prepare(
      `INSERT INTO episodic_memory (id, session_id, event_type, summary, importance, created_at)
       VALUES (?, 'default', ?, ?, ?, datetime('now', ?))`,
    );
    insert.run("old-low", "tool:exec", "old low", 0.3, "-40 days");
    insert.run("old-goal", "goal_completed", "old goal", 0.3, "-40 days");
    insert.run("old-archived", "goal_archived", "old archived goal", 0.2, "-40 days");
    insert.run("old-high", "tool:exec", "old important", 0.9, "-40 days");
    insert.run("new-low", "tool:exec", "recent", 0.3, "-1 days");

    expect(await runMaintenance()).toEqual({ shouldWake: false });
    const ids = (adb.raw.prepare("SELECT id FROM episodic_memory ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["new-low", "old-archived", "old-goal", "old-high"]);
    const counts = JSON.parse(adb.getKV("last_memory_maintenance") ?? "{}");
    expect(counts.episodic).toBe(1);
  });

  it("getRecent uses the session/created_at index", () => {
    expect(plan("SELECT * FROM episodic_memory WHERE session_id = 'default' ORDER BY created_at DESC LIMIT 20"))
      .toContain("idx_episodic_session_created");
  });
});

describe("inbox, wake events and other tables", () => {
  it("is a default heartbeat entry and a built-in task", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-maint-"));
    try {
      const defaults = loadHeartbeatConfig(path.join(dir, "missing.yml"));
      expect(defaults.entries.find((e) => e.name === "memory_maintenance")).toMatchObject({
        task: "memory_maintenance",
        schedule: "23 * * * *",
        enabled: true,
      });
      // An existing heartbeat.yml gets it through the merge with defaults.
      const file = path.join(dir, "heartbeat.yml");
      fs.writeFileSync(file, "entries:\n  - name: heartbeat_ping\n    schedule: '*/15 * * * *'\n    task: heartbeat_ping\n");
      expect(loadHeartbeatConfig(file).entries.some((e) => e.name === "memory_maintenance")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(typeof BUILTIN_TASKS.memory_maintenance).toBe("function");
  });

  it("deletes old finished inbox rows, keeps pending and recent ones, and prunes old seen keys and wake events", async () => {
    const inbox = adb.raw.prepare(
      `INSERT INTO inbox_messages (id, from_address, content, received_at, status, sig_hash)
       VALUES (?, '0xabc', ?, ?, ?, ?)`,
    );
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    inbox.run("m-old", "old processed text", old, "processed", "h1");
    inbox.run("m-old-spam", "old blocked text", old, "rate_limited", "h2");
    inbox.run("m-old-pending", "still unanswered", old, "received", "h3");
    inbox.run("m-new", "recent processed text", recent, "processed", "h4");

    adb.raw.exec("INSERT INTO kv (key, value, updated_at) VALUES ('inbox_seen_old', '1', datetime('now', '-40 days'))");
    adb.raw.exec("INSERT INTO kv (key, value, updated_at) VALUES ('inbox_seen_new', '1', datetime('now'))");

    adb.raw.exec("INSERT INTO wake_events (source, reason, consumed_at) VALUES ('t', 'old', datetime('now', '-10 days'))");
    adb.raw.exec("INSERT INTO wake_events (source, reason, consumed_at) VALUES ('t', 'recent', datetime('now', '-1 days'))");
    adb.raw.exec("INSERT INTO wake_events (source, reason) VALUES ('t', 'pending')");

    await runMaintenance();

    const rows = adb.raw.prepare("SELECT id, content, sig_hash FROM inbox_messages ORDER BY id").all();
    expect(rows).toEqual([
      { id: "m-new", content: "recent processed text", sig_hash: "h4" },
      { id: "m-old-pending", content: "still unanswered", sig_hash: "h3" },
    ]);
    expect(JSON.parse(adb.getKV("last_memory_maintenance") ?? "{}").inbox).toBe(2);
    expect(adb.getKV("inbox_seen_old")).toBeUndefined();
    expect(adb.getKV("inbox_seen_new")).toBe("1");
    const reasons = (adb.raw.prepare("SELECT reason FROM wake_events ORDER BY id").all() as Array<{ reason: string }>).map((r) => r.reason);
    expect(reasons).toEqual(["recent", "pending"]);
  });

  it("never deletes inbox rows inside the replay floor, which stays above the freshness window", () => {
    expect(INBOX_MIN_RETENTION_DAYS * 86_400_000).toBeGreaterThanOrEqual(2 * INBOUND_MAX_AGE_MS);
    const inbox = adb.raw.prepare(
      "INSERT INTO inbox_messages (id, from_address, content, received_at, status) VALUES (?, '0xabc', 'x', ?, 'processed')",
    );
    inbox.run("d10", new Date(Date.now() - 10 * 86_400_000).toISOString());
    inbox.run("d20", new Date(Date.now() - 20 * 86_400_000).toISOString());
    expect(pruneOldInboxMessages(adb.raw, 1)).toBe(1);
    expect((adb.raw.prepare("SELECT id FROM inbox_messages").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["d10"]);
  });

  it("prunes spend records and inference costs after 90 days and keeps recent ones", async () => {
    const sqlTime = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const spend = adb.raw.prepare(
      `INSERT INTO spend_tracking (id, tool_name, amount_cents, window_hour, window_day, category, created_at)
       VALUES (?, 'transfer_credits', 100, '2026-01-01T00', '2026-01-01', 'transfer', ?)`,
    );
    spend.run("s-old", sqlTime(91));
    spend.run("s-new", sqlTime(1));
    const cost = adb.raw.prepare(
      `INSERT INTO inference_costs (id, session_id, model, provider, input_tokens, output_tokens, cost_cents, tier, task_type, created_at)
       VALUES (?, 's', 'm', 'p', 1, 1, 1, 'normal', 'agent_turn', ?)`,
    );
    cost.run("c-old", sqlTime(91));
    cost.run("c-new", sqlTime(1));

    await runMaintenance();
    expect((adb.raw.prepare("SELECT id FROM spend_tracking").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["s-new"]);
    expect((adb.raw.prepare("SELECT id FROM inference_costs").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["c-new"]);
    const counts = JSON.parse(adb.getKV("last_memory_maintenance") ?? "{}");
    expect(counts.spend_records).toBe(1);
    expect(counts.inference_costs).toBe(1);
  });

  it("prunes old knowledge events and heartbeat history only", async () => {
    const ev = adb.raw.prepare(
      "INSERT INTO event_stream (id, type, agent_address, content, token_count, created_at) VALUES (?, ?, 'a', 'c', 1, ?)",
    );
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    ev.run("e1", "market_signal", old);
    ev.run("e2", "knowledge", old);
    ev.run("e3", "task_completed", old);
    ev.run("e4", "market_signal", new Date().toISOString());
    adb.raw.exec("INSERT INTO heartbeat_schedule (task_name, cron_expression) VALUES ('t', '* * * * *')");
    adb.raw.prepare(
      "INSERT INTO heartbeat_history (id, task_name, started_at, result) VALUES ('h-old', 't', ?, 'success'), ('h-new', 't', ?, 'success')",
    ).run(old, new Date().toISOString());

    await runMaintenance();
    expect((adb.raw.prepare("SELECT id FROM event_stream ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["e3", "e4"]);
    expect((adb.raw.prepare("SELECT id FROM heartbeat_history").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["h-new"]);
  });

  it("the inbox claim query uses the pending-inbox index", () => {
    expect(plan(
      "SELECT id FROM inbox_messages WHERE status = 'received' AND retry_count < max_retries ORDER BY received_at ASC LIMIT 10",
    )).toContain("idx_inbox_received_pending");
  });
});

describe("ISO-8601 expiry", () => {
  it("a dedup key that expired a minute ago is not active and is pruned", () => {
    expect(insertDedupKey(adb.raw, "k", "task", -60_000)).toBe(true);
    expect(isDeduplicated(adb.raw, "k")).toBe(false);
    expect(pruneExpiredDedupKeys(adb.raw)).toBe(1);
    expect(insertDedupKey(adb.raw, "k2", "task", 60_000)).toBe(true);
    expect(isDeduplicated(adb.raw, "k2")).toBe(true);
  });

  it("a working row whose ISO expiry passed a minute ago is cleared", () => {
    const wm = new WorkingMemoryManager(adb.raw);
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    wm.add({ sessionId: "s", content: "stale", contentType: "observation", expiresAt: minuteAgo });
    wm.add({ sessionId: "s", content: "fresh", contentType: "observation", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(wm.clearExpired()).toBe(1);
    wm.add({ sessionId: "s", content: "stale2", contentType: "observation", expiresAt: minuteAgo });
    expect(wmClearExpired(adb.raw)).toBe(1);
    expect(wm.getBySession("s").map((e) => e.content)).toEqual(["fresh"]);
  });
});

describe("registry entry lookup", () => {
  it("prefers the Base mainnet entry over a later testnet one", () => {
    const entry = (agentId: string, chain: string, registeredAt: string) => ({
      agentId,
      agentURI: "https://example.com/card.json",
      chain,
      contractAddress: "0x0000000000000000000000000000000000000001",
      txHash: `0x${agentId}`,
      registeredAt,
    });
    adb.setRegistryEntry(entry("7", "eip155:84532", "2026-01-01T00:00:00.000Z"));
    expect(adb.getRegistryEntry()?.agentId).toBe("7");
    adb.setRegistryEntry(entry("42", "eip155:8453", "2025-01-01T00:00:00.000Z"));
    adb.setRegistryEntry(entry("9", "eip155:84532", "2026-06-01T00:00:00.000Z"));
    expect(adb.getRegistryEntry()?.agentId).toBe("42");
  });
});
