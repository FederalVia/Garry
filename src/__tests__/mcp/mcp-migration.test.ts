/**
 * Version 18: policy_decisions accepts risk level third_party (rows kept,
 * indexes recreated) and mcp_calls exists. The rebuild is idempotent.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase, migratePolicyRiskLevels } from "../../state/database.js";
import { SCHEMA_VERSION } from "../../state/schema.js";

const OLD_TABLE = `
  CREATE TABLE policy_decisions (
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    tool_name TEXT NOT NULL,
    tool_args_hash TEXT NOT NULL,
    risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','caution','dangerous','forbidden')),
    decision TEXT NOT NULL CHECK(decision IN ('allow','deny','quarantine')),
    rules_evaluated TEXT NOT NULL DEFAULT '[]',
    rules_triggered TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_policy_decisions_turn ON policy_decisions(turn_id);
  CREATE INDEX idx_policy_decisions_tool ON policy_decisions(tool_name);
  CREATE INDEX idx_policy_decisions_decision ON policy_decisions(decision);
`;

function insertDecision(db: Database.Database, id: string, risk: string): void {
  db.prepare(
    "INSERT INTO policy_decisions (id, turn_id, tool_name, tool_args_hash, risk_level, decision, reason) VALUES (?, 't1', 'exec', 'h', ?, 'allow', 'ok')",
  ).run(id, risk);
}

/**
 * A database as an earlier version left it: old CHECK, no mcp_calls, no
 * version rows at or above `from + 1`.
 */
function makeOld(dbPath: string, from: number): void {
  createDatabase(dbPath).close();
  const raw = new Database(dbPath);
  raw.exec("DROP TABLE policy_decisions; DROP TABLE IF EXISTS mcp_calls;");
  raw.exec(OLD_TABLE);
  raw.prepare("DELETE FROM schema_version WHERE version > ?").run(from);
  insertDecision(raw, "d1", "dangerous");
  insertDecision(raw, "d2", "safe");
  expect(() => insertDecision(raw, "bad", "third_party")).toThrow(/CHECK constraint failed/);
  raw.close();
}

describe("migration to version 18", () => {
  it("is the current schema version", () => {
    expect(SCHEMA_VERSION).toBe(18);
  });

  // 17 is the memory/inbox index migration; 16 also runs it on the way up.
  it.each([16, 17])("rebuilds policy_decisions from version %i, keeping rows and indexes", (from) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-"));
    const dbPath = path.join(dir, "state.db");
    makeOld(dbPath, from);
    const db = createDatabase(dbPath);
    try {
      const rows = db.raw.prepare("SELECT id, risk_level FROM policy_decisions ORDER BY id").all();
      expect(rows).toEqual([
        { id: "d1", risk_level: "dangerous" },
        { id: "d2", risk_level: "safe" },
      ]);
      insertDecision(db.raw, "d3", "third_party");
      expect(() => insertDecision(db.raw, "d4", "bogus")).toThrow(/CHECK constraint failed/);
      const indexes = (
        db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'policy_decisions'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(indexes).toEqual(
        expect.arrayContaining(["idx_policy_decisions_turn", "idx_policy_decisions_tool", "idx_policy_decisions_decision"]),
      );
      db.raw.prepare("INSERT INTO mcp_calls (server, tool, sent_at) VALUES ('a', 'b', '2026-01-01T00:00:00.000Z')").run();
      const v = db.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(v.v).toBe(18);
      const applied = (db.raw.prepare("SELECT version FROM schema_version WHERE version > ? ORDER BY version").all(from) as { version: number }[]).map((r) => r.version);
      expect(applied).toEqual(from === 16 ? [17, 18] : [18]);

      // Running it again changes nothing.
      const before = db.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'policy_decisions'").get();
      migratePolicyRiskLevels(db.raw);
      expect(db.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'policy_decisions'").get()).toEqual(before);
      expect((db.raw.prepare("SELECT COUNT(*) AS c FROM policy_decisions").get() as { c: number }).c).toBe(3);
      expect((db.raw.prepare("SELECT COUNT(*) AS c FROM mcp_calls").get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
    }
  });

  it("gives a fresh database the new CHECK", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-"));
    const db = createDatabase(path.join(dir, "state.db"));
    try {
      insertDecision(db.raw, "x", "third_party");
      expect((db.raw.prepare("SELECT COUNT(*) AS c FROM policy_decisions").get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
    }
  });
});
