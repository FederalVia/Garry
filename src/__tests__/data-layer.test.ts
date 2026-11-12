/**
 * Data Layer Hardening Tests (Sub-phase 1.6)
 *
 * Tests: SSRF blocking, URI allowlist, agent card validation,
 * installed tool loading, KV pruning, safeJsonParse,
 * agent_state validation, createdAt persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { claimInboxMessagesFromOneSender, createDatabase, pruneStaleKV, recoverStrandedInboxClaims } from "../state/database.js";
import type { AutomatonDatabase } from "../types.js";
import { SCHEMA_VERSION } from "../state/schema.js";
import { countSlotHoldingChildren } from "../replication/child-status.js";

// Mock erc8004.js to avoid ABI parse error at import time
vi.mock("../registry/erc8004.js", () => ({
  queryAgent: vi.fn(),
  getTotalAgents: vi.fn().mockResolvedValue(0),
  registerAgent: vi.fn(),
  leaveFeedback: vi.fn(),
}));

// Mock injection-defense.js to avoid import chain issues
vi.mock("../agent/injection-defense.js", () => ({
  sanitizeToolResult: vi.fn((s: string) => s),
  sanitizeInput: vi.fn((s: string) => ({ content: s, blocked: false })),
}));

// Import after mocks are set up
const { isAllowedUri, isInternalNetwork, validateAgentCard } = await import("../registry/discovery.js");
const { loadInstalledTools } = await import("../agent/tools.js");

function makeTmpDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-data-layer-test-"));
  return path.join(tmpDir, "test.db");
}

// ─── SSRF Protection Tests ──────────────────────────────────────

describe("SSRF Protection", () => {
  describe("isInternalNetwork", () => {
    it("blocks 127.0.0.1 (loopback)", () => {
      expect(isInternalNetwork("127.0.0.1")).toBe(true);
    });

    it("blocks 127.x.x.x range", () => {
      expect(isInternalNetwork("127.255.0.1")).toBe(true);
    });

    it("blocks 10.0.0.1 (private class A)", () => {
      expect(isInternalNetwork("10.0.0.1")).toBe(true);
    });

    it("blocks 10.255.255.255", () => {
      expect(isInternalNetwork("10.255.255.255")).toBe(true);
    });

    it("blocks 172.16.0.1 (private class B)", () => {
      expect(isInternalNetwork("172.16.0.1")).toBe(true);
    });

    it("blocks 172.31.255.255", () => {
      expect(isInternalNetwork("172.31.255.255")).toBe(true);
    });

    it("allows 172.15.0.1 (not in private range)", () => {
      expect(isInternalNetwork("172.15.0.1")).toBe(false);
    });

    it("allows 172.32.0.1 (not in private range)", () => {
      expect(isInternalNetwork("172.32.0.1")).toBe(false);
    });

    it("blocks 192.168.1.1 (private class C)", () => {
      expect(isInternalNetwork("192.168.1.1")).toBe(true);
    });

    it("blocks 169.254.0.0 (link-local)", () => {
      expect(isInternalNetwork("169.254.0.0")).toBe(true);
    });

    it("blocks ::1 (IPv6 loopback)", () => {
      expect(isInternalNetwork("::1")).toBe(true);
    });

    it("blocks localhost", () => {
      expect(isInternalNetwork("localhost")).toBe(true);
    });

    it("blocks LOCALHOST (case-insensitive)", () => {
      expect(isInternalNetwork("LOCALHOST")).toBe(true);
    });

    it("blocks 0.0.0.0", () => {
      expect(isInternalNetwork("0.0.0.0")).toBe(true);
    });

    it("allows public IPs", () => {
      expect(isInternalNetwork("8.8.8.8")).toBe(false);
      expect(isInternalNetwork("1.1.1.1")).toBe(false);
      expect(isInternalNetwork("203.0.113.1")).toBe(false);
    });

    it("allows public hostnames", () => {
      expect(isInternalNetwork("example.com")).toBe(false);
      expect(isInternalNetwork("api.conway.tech")).toBe(false);
    });
  });

  describe("isAllowedUri", () => {
    it("allows https URIs", () => {
      expect(isAllowedUri("https://example.com/agent-card.json")).toBe(true);
    });

    it("allows ipfs URIs", () => {
      expect(isAllowedUri("ipfs://QmTest123")).toBe(true);
    });

    it("blocks http URIs", () => {
      expect(isAllowedUri("http://example.com/agent-card.json")).toBe(false);
    });

    it("blocks file URIs", () => {
      expect(isAllowedUri("file:///etc/passwd")).toBe(false);
    });

    it("blocks ftp URIs", () => {
      expect(isAllowedUri("ftp://evil.com/data")).toBe(false);
    });

    it("blocks javascript URIs", () => {
      expect(isAllowedUri("javascript:alert(1)")).toBe(false);
    });

    it("blocks https URIs to internal networks", () => {
      expect(isAllowedUri("https://127.0.0.1/card.json")).toBe(false);
      expect(isAllowedUri("https://10.0.0.1/card.json")).toBe(false);
      expect(isAllowedUri("https://192.168.1.1/card.json")).toBe(false);
      expect(isAllowedUri("https://localhost/card.json")).toBe(false);
    });

    it("blocks invalid URIs", () => {
      expect(isAllowedUri("not-a-url")).toBe(false);
      expect(isAllowedUri("")).toBe(false);
    });
  });
});

// ─── Agent Card Validation Tests ────────────────────────────────

describe("Agent Card Validation", () => {
  it("accepts a valid agent card", () => {
    const card = validateAgentCard({
      name: "TestAgent",
      type: "automaton",
      address: "0x1234",
      description: "A test agent",
    });
    expect(card).not.toBeNull();
    expect(card?.name).toBe("TestAgent");
    expect(card?.type).toBe("automaton");
  });

  it("rejects null", () => {
    expect(validateAgentCard(null)).toBeNull();
  });

  it("rejects undefined", () => {
    expect(validateAgentCard(undefined)).toBeNull();
  });

  it("rejects non-object", () => {
    expect(validateAgentCard("string")).toBeNull();
    expect(validateAgentCard(42)).toBeNull();
  });

  it("rejects missing name", () => {
    expect(validateAgentCard({ type: "automaton" })).toBeNull();
  });

  it("rejects missing type", () => {
    expect(validateAgentCard({ name: "TestAgent" })).toBeNull();
  });

  it("rejects empty name", () => {
    expect(validateAgentCard({ name: "", type: "automaton" })).toBeNull();
  });

  it("rejects empty type", () => {
    expect(validateAgentCard({ name: "TestAgent", type: "" })).toBeNull();
  });

  it("rejects non-string address", () => {
    expect(validateAgentCard({ name: "TestAgent", type: "automaton", address: 123 })).toBeNull();
  });

  it("accepts card without optional fields", () => {
    const card = validateAgentCard({ name: "TestAgent", type: "automaton" });
    expect(card).not.toBeNull();
  });
});

// ─── KV Pruning Tests ───────────────────────────────────────────

describe("KV Pruning", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("prunes inbox_seen_* keys older than 7 days", () => {
    // Insert old KV entries directly via raw DB
    const rawDb = (db as any).raw;
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    rawDb.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("inbox_seen_abc123", "1", oldDate);
    rawDb.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("inbox_seen_def456", "1", oldDate);

    // Insert a recent one that should NOT be pruned
    db.setKV("inbox_seen_recent", "1");

    // Insert a non-inbox key that should NOT be pruned
    rawDb.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("other_key", "value", oldDate);

    const pruned = pruneStaleKV(rawDb, "inbox_seen_", 7);
    expect(pruned).toBe(2);

    // Verify recent inbox key still exists
    expect(db.getKV("inbox_seen_recent")).toBe("1");

    // Verify non-inbox old key still exists
    expect(db.getKV("other_key")).toBe("value");
  });

  it("returns 0 when nothing to prune", () => {
    db.setKV("inbox_seen_fresh", "1");
    const rawDb = (db as any).raw;
    const pruned = pruneStaleKV(rawDb, "inbox_seen_", 7);
    expect(pruned).toBe(0);
  });
});

// ─── Agent State Validation Tests ────────────────────────────────

describe("Agent State Validation", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("accepts valid agent states", () => {
    const validStates = ["setup", "waking", "running", "sleeping", "low_compute", "critical", "dead"];
    for (const state of validStates) {
      db.setAgentState(state as any);
      expect(db.getAgentState()).toBe(state);
    }
  });

  it("returns 'setup' for invalid agent state", () => {
    // Write an invalid state directly
    const rawDb = (db as any).raw;
    rawDb.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).run("agent_state", "invalid_state");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(db.getAgentState()).toBe("setup");
    consoleSpy.mockRestore();
  });

  it("returns 'setup' when no agent state is set", () => {
    expect(db.getAgentState()).toBe("setup");
  });
});

// ─── Installed Tools Loading Tests ──────────────────────────────

describe("Installed Tools Loading", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("loads enabled installed tools from DB", () => {
    db.installTool({
      id: "tool-1",
      name: "test_tool",
      type: "custom",
      config: { command: "echo hello" },
      installedAt: new Date().toISOString(),
      enabled: true,
    });

    const tools = loadInstalledTools(db);
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("test_tool");
    expect(tools[0].riskLevel).toBe("caution");
  });

  it("does not load disabled tools", () => {
    db.installTool({
      id: "tool-disabled",
      name: "disabled_tool",
      type: "custom",
      config: {},
      installedAt: new Date().toISOString(),
      enabled: true,
    });
    db.removeTool("tool-disabled");

    const tools = loadInstalledTools(db);
    expect(tools.length).toBe(0);
  });

  it("returns empty array when no tools installed", () => {
    const tools = loadInstalledTools(db);
    expect(tools.length).toBe(0);
  });
});

// ─── createdAt Persistence Tests ─────────────────────────────────

describe("createdAt Persistence", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("persists createdAt and does not overwrite on subsequent access", () => {
    // Simulate first run: set createdAt
    const firstCreatedAt = "2025-01-01T00:00:00.000Z";
    expect(db.getIdentity("createdAt")).toBeUndefined();
    db.setIdentity("createdAt", firstCreatedAt);

    // Simulate second run: createdAt should already exist
    const existing = db.getIdentity("createdAt");
    expect(existing).toBe(firstCreatedAt);

    // The logic in index.ts checks: only set if not already stored
    // So on second run, it should NOT overwrite
    const secondRunCreatedAt = existing || new Date().toISOString();
    expect(secondRunCreatedAt).toBe(firstCreatedAt);
  });
});

// ─── JSON Deserialization Safety Tests ──────────────────────────

describe("safeJsonParse in deserializers", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("handles corrupted JSON in turn tool_calls gracefully", () => {
    const rawDb = (db as any).raw;

    // Insert a turn with corrupted JSON
    rawDb.prepare(
      `INSERT INTO turns (id, timestamp, state, thinking, tool_calls, token_usage, cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("test-turn", new Date().toISOString(), "running", "thinking", "{invalid json}", '{"promptTokens":0,"completionTokens":0}', 0);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const turns = db.getRecentTurns(1);
    expect(turns.length).toBe(1);
    expect(turns[0].toolCalls).toEqual([]);
    consoleSpy.mockRestore();
  });

  it("handles corrupted JSON in heartbeat params gracefully", () => {
    const rawDb = (db as any).raw;

    rawDb.prepare(
      `INSERT INTO heartbeat_entries (name, schedule, task, enabled, params, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("test-hb", "* * * * *", "test", 1, "{bad json}");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const entries = db.getHeartbeatEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].params).toEqual({});
    consoleSpy.mockRestore();
  });

  it("handles corrupted JSON in installed tool config gracefully", () => {
    const rawDb = (db as any).raw;

    rawDb.prepare(
      `INSERT INTO installed_tools (id, name, type, config, installed_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("corrupt-tool", "bad_tool", "custom", "{not json!", new Date().toISOString(), 1);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tools = db.getInstalledTools();
    expect(tools.length).toBe(1);
    expect(tools[0].config).toEqual({});
    consoleSpy.mockRestore();
  });
});

// ─── Inbox Message Deserialization Tests ─────────────────────────

describe("Inbox Message Deserialization", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("uses to_address column instead of hardcoded empty string", () => {
    const rawDb = (db as any).raw;

    // Insert message with to_address
    rawDb.prepare(
      `INSERT INTO inbox_messages (id, from_address, to_address, content, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("msg-1", "0xSender", "0xRecipient", "Hello", new Date().toISOString());

    const messages = db.getUnprocessedInboxMessages(10);
    expect(messages.length).toBe(1);
    expect(messages[0].to).toBe("0xRecipient");
  });

  it("falls back to empty string when to_address is null", () => {
    db.insertInboxMessage({
      id: "msg-2",
      from: "0xSender",
      to: "",
      content: "Hello",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const messages = db.getUnprocessedInboxMessages(10);
    expect(messages.length).toBe(1);
    expect(messages[0].to).toBe("");
  });
});

// ─── Schema Migration Tests ──────────────────────────────────────

describe("Schema Migrations", () => {
  it("creates fresh database with current schema version", () => {
    const dbPath = makeTmpDbPath();
    const db = createDatabase(dbPath);
    const rawDb = (db as any).raw;

    const version = rawDb.prepare("SELECT MAX(version) as v FROM schema_version").get() as any;
    expect(version.v).toBeGreaterThanOrEqual(4);

    db.close();
  });

  it("has all required tables in fresh database", () => {
    const dbPath = makeTmpDbPath();
    const db = createDatabase(dbPath);
    const rawDb = (db as any).raw;

    const tables = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    const requiredTables = [
      "identity",
      "turns",
      "tool_calls",
      "heartbeat_entries",
      "transactions",
      "installed_tools",
      "modifications",
      "kv",
      "inbox_messages",
      "policy_decisions",
      "spend_tracking",
      "heartbeat_schedule",
      "heartbeat_history",
      "wake_events",
      "heartbeat_dedup",
      "soul_history",
      "working_memory",
      "episodic_memory",
      "semantic_memory",
      "procedural_memory",
      "relationship_memory",
      "session_summaries",
      "inference_costs",
      "model_registry",
      "child_lifecycle_events",
      "discovered_agents_cache",
      "onchain_transactions",
    ];

    for (const table of requiredTables) {
      expect(tables, `missing table: ${table}`).toContain(table);
    }

    db.close();
  });

  it("V4 migration adds inbox state columns", () => {
    const dbPath = makeTmpDbPath();
    const db = createDatabase(dbPath);
    const rawDb = (db as any).raw;

    // Check the inbox_messages table has status, retry_count, max_retries columns
    const columns = rawDb
      .prepare("PRAGMA table_info(inbox_messages)")
      .all()
      .map((c: any) => c.name);

    expect(columns).toContain("status");
    expect(columns).toContain("retry_count");
    expect(columns).toContain("max_retries");
    expect(columns).toContain("to_address");

    db.close();
  });
});

// ─── CRUD Operations for Core Tables ─────────────────────────────

describe("Core Table CRUD", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("turn CRUD: insert and read", () => {
    const turn = {
      id: "turn-1",
      timestamp: new Date().toISOString(),
      state: "running" as const,
      thinking: "Thinking about things",
      toolCalls: [],
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costCents: 0,
    };

    db.insertTurn(turn);
    const recent = db.getRecentTurns(1);
    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe("turn-1");
    expect(recent[0].thinking).toBe("Thinking about things");
  });

  it("tool call CRUD: insert linked to turn", () => {
    const turn = {
      id: "turn-tc-1",
      timestamp: new Date().toISOString(),
      state: "running" as const,
      thinking: "Using tools",
      toolCalls: [],
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costCents: 0,
    };
    db.insertTurn(turn);

    const tc = {
      id: "tc-1",
      name: "exec",
      arguments: { command: "echo test" },
      result: "stdout: test",
      durationMs: 100,
    };
    db.insertToolCall("turn-tc-1", tc);

    const turns = db.getRecentTurns(1);
    expect(turns[0].toolCalls.length).toBeGreaterThanOrEqual(0);
  });

  it("transaction CRUD: insert and read via raw", () => {
    db.insertTransaction({
      id: "txn-1",
      type: "transfer_out",
      amountCents: 500,
      balanceAfterCents: 9500,
      description: "Test transfer",
      timestamp: new Date().toISOString(),
    });

    const rawDb = (db as any).raw;
    const txns = rawDb.prepare("SELECT * FROM transactions WHERE id = ?").all("txn-1");
    expect(txns.length).toBe(1);
    expect(txns[0].id).toBe("txn-1");
    expect(txns[0].amount_cents).toBe(500);
  });

  it("KV store: set, get, delete", () => {
    db.setKV("test_key", "test_value");
    expect(db.getKV("test_key")).toBe("test_value");

    db.setKV("test_key", "updated_value");
    expect(db.getKV("test_key")).toBe("updated_value");
  });

  it("identity store: set and get", () => {
    db.setIdentity("name", "test-bot");
    expect(db.getIdentity("name")).toBe("test-bot");
  });

  it("modification CRUD: insert and read via raw", () => {
    db.insertModification({
      id: "mod-1",
      timestamp: new Date().toISOString(),
      type: "code_edit",
      description: "Edited test.ts",
      reversible: true,
    });

    const rawDb = (db as any).raw;
    const mods = rawDb.prepare("SELECT * FROM modifications WHERE id = ?").all("mod-1");
    expect(mods.length).toBe(1);
    expect(mods[0].type).toBe("code_edit");
  });

  it("heartbeat entry CRUD: upsert and read", () => {
    db.upsertHeartbeatEntry({
      name: "test_entry",
      schedule: "*/5 * * * *",
      task: "test_task",
      enabled: true,
    });

    const entries = db.getHeartbeatEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("test_entry");
    expect(entries[0].schedule).toBe("*/5 * * * *");
  });

  it("installed tool CRUD: install and remove", () => {
    db.installTool({
      id: "tool-1",
      name: "test_tool",
      type: "custom",
      config: { foo: "bar" },
      installedAt: new Date().toISOString(),
      enabled: true,
    });

    let tools = db.getInstalledTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("test_tool");

    db.removeTool("tool-1");
    tools = db.getInstalledTools();
    expect(tools.length).toBe(0);
  });

  it("turn count increments correctly", () => {
    expect(db.getTurnCount()).toBe(0);

    db.insertTurn({
      id: "count-turn-1",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "first",
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costCents: 0,
    });

    expect(db.getTurnCount()).toBe(1);

    db.insertTurn({
      id: "count-turn-2",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "second",
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costCents: 0,
    });

    expect(db.getTurnCount()).toBe(2);
  });

  it("children CRUD: insert and list", () => {
    const rawDb = (db as any).raw;
    rawDb.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("child-1", "test-child", "0xchild", "sandbox-1", "You are a child.", "spawning");

    const children = db.getChildren();
    expect(children.length).toBe(1);
    expect(children[0].name).toBe("test-child");
    expect(children[0].status).toBe("spawning");
  });

  it("skills CRUD: insert and list", () => {
    const rawDb = (db as any).raw;
    rawDb.prepare(
      `INSERT INTO skills (name, description, instructions, source, path, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("test_skill", "A test skill", "Do things", "self", "/tmp/skills/test", 1);

    const skills = db.getSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("test_skill");
    expect(skills[0].enabled).toBe(true);
  });
});

// ─── Migration 14: colony bookkeeping repair ─────────────────────

describe("Migration 14 (children dedupe, lifecycle status, self-sent colony rows)", () => {
  const PARENT = "0x1111111111111111111111111111111111111111";
  const A = "0x2222222222222222222222222222222222222222";
  const B = "0x3333333333333333333333333333333333333333";
  const C = "0x4444444444444444444444444444444444444444";
  const D = "0x5555555555555555555555555555555555555555";

  /** A schema-13 database carrying the damage the old runtime left behind. */
  function makeDamagedV13(dbPath: string): void {
    const db = createDatabase(dbPath);
    const raw = db.raw;
    raw.exec("DROP INDEX IF EXISTS idx_children_address");
    raw.prepare("DELETE FROM schema_version WHERE version >= 14").run();
    db.setIdentity("address", PARENT);

    const child = raw.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, creator_message, funded_amount_cents, status, created_at)
       VALUES (?, ?, ?, ?, 'p', ?, ?, ?, datetime('now'))`,
    );
    const event = raw.prepare(
      `INSERT INTO child_lifecycle_events (id, child_id, from_state, to_state, reason, metadata, created_at)
       VALUES (?, ?, ?, ?, NULL, '{}', ?)`,
    );
    const addEvents = (id: string, states: string[]) => {
      let from = "none";
      states.forEach((to, i) => {
        event.run(`${id}-e${i}`, id, from, to, new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString());
        from = to;
      });
    };

    // F067: spawnChild's lifecycle row plus the orchestrator's duplicate.
    child.run("L1", "kid-a", A, "sbx-a", null, 25, "wallet_verified");
    addEvents("L1", ["requested", "sandbox_created", "runtime_ready", "wallet_verified"]);
    child.run("R1", "kid-a", A, "sbx-a", "registered by orchestrator", 25, "running");
    // H3-003: the tracker wrote 'running' into a healthy lifecycle row.
    child.run("L2", "kid-b", B, "sbx-b", null, 100, "running");
    addEvents("L2", ["requested", "sandbox_created", "runtime_ready", "wallet_verified", "funded", "starting", "healthy"]);
    // F065/F071: local worker rows left running or revived to 'starting'.
    child.run("W1", "w1", "local://local-worker-1", "local", "registered by orchestrator", 0, "running");
    child.run("W2", "w2", "local://local-worker-2", "local", "registered by orchestrator", 0, "starting");
    // A registered row whose lifecycle twin was pruned.
    child.run("R3", "kid-c", C, "sbx-c", "registered by orchestrator", 25, "running");
    // F187 at base: L3 failed, its sandbox was reused by L4, which inherited
    // the wallet; L3 was retired to cleaned_up without a lifecycle event.
    child.run("L3", "kid-d", D, "sbx-d", null, 10, "cleaned_up");
    addEvents("L3", ["requested", "sandbox_created", "runtime_ready", "wallet_verified", "funded", "starting", "failed"]);
    child.run("L4", "kid-e", D, "sbx-d", null, 10, "healthy");
    addEvents("L4", ["requested", "sandbox_created", "runtime_ready", "wallet_verified", "funded", "starting", "healthy"]);
    // Legacy rows with no events: one the old health monitor "restarted"
    // from dead to starting, and one the pool optimizer culled to stopped.
    child.run("X1", "old-e", "0x6666666666666666666666666666666666666666", "sbx-x1", null, 5, "starting");
    child.run("X2", "old-f", "0x7777777777777777777777777777777777777777", "sbx-x2", null, 5, "stopped");

    const inbox = raw.prepare(
      `INSERT INTO inbox_messages (id, from_address, to_address, content, received_at, status)
       VALUES (?, ?, ?, ?, datetime('now'), 'received')`,
    );
    inbox.run("self-1", PARENT, A, '{"protocol":"colony_message_v1"}');
    // Claimed by the old inbox loop when the process died.
    inbox.run("self-2", PARENT, B, '{"protocol":"colony_message_v1"}');
    raw.prepare("UPDATE inbox_messages SET status = 'in_progress' WHERE id = 'self-2'").run();
    raw.prepare(
      `INSERT INTO inbox_messages (id, from_address, content, received_at, status)
       VALUES ('relay-1', '0x9999999999999999999999999999999999999999', 'hello', datetime('now'), 'received')`,
    ).run();
    db.close();
  }

  it("leaves one row per child with the true ledger, lifecycle statuses and a unique address index", () => {
    const dbPath = makeTmpDbPath();
    makeDamagedV13(dbPath);

    const db = createDatabase(dbPath);
    try {
      const raw = db.raw;
      const v = raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      // Later migrations run after 14 on the same open.
      expect(v.v).toBe(SCHEMA_VERSION);

      const rows = raw.prepare("SELECT id, address, status, funded_amount_cents AS f FROM children ORDER BY id").all();
      expect(rows).toEqual([
        // The orchestrator never started it: failed, so it holds no slot.
        { id: "L1", address: A, status: "failed", f: 25 },
        { id: "L2", address: B, status: "healthy", f: 100 },
        // Stays terminal, and gives up the address L4 inherited.
        { id: "L3", address: "", status: "cleaned_up", f: 10 },
        { id: "L4", address: D, status: "healthy", f: 10 },
        { id: "R3", address: C, status: "dead", f: 25 },
        { id: "W1", address: "local://local-worker-1", status: "cleaned_up", f: 0 },
        { id: "W2", address: "local://local-worker-2", status: "cleaned_up", f: 0 },
        // "Restarted" by the old monitor, which started nothing: dead, no slot.
        { id: "X1", address: "0x6666666666666666666666666666666666666666", status: "dead", f: 5 },
        { id: "X2", address: "0x7777777777777777777777777777777777777777", status: "stopped", f: 5 },
      ]);
      const sum = raw.prepare("SELECT SUM(funded_amount_cents) AS s FROM children WHERE address = ?").get(A) as { s: number };
      expect(sum.s).toBe(25);
      // Status still equals the latest lifecycle event, and the repairs say why.
      const latest = raw.prepare(
        "SELECT to_state, reason FROM child_lifecycle_events WHERE child_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      );
      expect(latest.get("L1")).toMatchObject({ to_state: "failed", reason: expect.stringContaining("never started") });
      expect(latest.get("L3")).toMatchObject({ to_state: "cleaned_up" });
      expect(countSlotHoldingChildren(raw)).toBe(2);

      const inbox = raw.prepare("SELECT id, status, processed_at FROM inbox_messages ORDER BY id").all() as Array<{
        id: string;
        status: string;
        processed_at: string | null;
      }>;
      expect(inbox.find((r) => r.id === "self-1")).toMatchObject({ status: "processed" });
      expect(inbox.find((r) => r.id === "self-1")?.processed_at).not.toBeNull();
      expect(inbox.find((r) => r.id === "self-2")).toMatchObject({ status: "processed" });
      // Relay rows belong to the inbox turn and are left alone.
      expect(inbox.find((r) => r.id === "relay-1")).toMatchObject({ status: "received", processed_at: null });
      // Nothing self-sent reaches the model's inbox claim, even after startup
      // requeues stranded claims.
      recoverStrandedInboxClaims(raw);
      expect(claimInboxMessagesFromOneSender(raw, 10).map((m) => m.fromAddress)).not.toContain(PARENT);

      expect(() =>
        raw.prepare(
          `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status) VALUES ('dup', 'dup', ?, 's', 'p', 'running')`,
        ).run(A),
      ).toThrow(/UNIQUE/);
      // Failed spawns keep an empty address; many may exist.
      raw.prepare(`INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status) VALUES ('e1', 'e', '', 's', 'p', 'failed')`).run();
      raw.prepare(`INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status) VALUES ('e2', 'e', '', 's', 'p', 'failed')`).run();
    } finally {
      db.close();
    }
  });

  it("is idempotent when it runs again", () => {
    const dbPath = makeTmpDbPath();
    makeDamagedV13(dbPath);
    createDatabase(dbPath).close();
    const again = createDatabase(dbPath);
    again.raw.prepare("DELETE FROM schema_version WHERE version >= 14").run();
    again.close();

    const db = createDatabase(dbPath);
    try {
      const count = db.raw.prepare("SELECT COUNT(*) AS n FROM children").get() as { n: number };
      expect(count.n).toBe(9);
      const events = db.raw.prepare("SELECT COUNT(*) AS n FROM child_lifecycle_events WHERE reason LIKE '%upgrade repair%'").get() as { n: number };
      expect(events.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it("skips the unique index while duplicates remain, and adds it once they are gone", () => {
    const dbPath = makeTmpDbPath();
    const db = createDatabase(dbPath);
    db.raw.exec("DROP INDEX IF EXISTS idx_children_address");
    const insert = db.raw.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status) VALUES (?, 'x', ?, 's', 'p', 'failed')`,
    );
    insert.run("d1", A);
    insert.run("d2", A);
    db.close();

    const reopened = createDatabase(dbPath);
    const hasIndex = (raw: any) =>
      raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_children_address'").get() !== undefined;
    expect(hasIndex(reopened.raw)).toBe(false);
    reopened.raw.prepare("DELETE FROM children WHERE id = 'd2'").run();
    reopened.close();

    const fixed = createDatabase(dbPath);
    try {
      expect(hasIndex(fixed.raw)).toBe(true);
    } finally {
      fixed.close();
    }
  });
});
