/**
 * Migration 20: the inference spend rollup, the treasury ledger's
 * approval_id and the transfer approval requests, from every earlier
 * version still in use. The owner database has its own schema and is not
 * part of this chain.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { SCHEMA_VERSION } from "../state/schema.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "budget-mig-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A database as version `from` left it: none of migration 20's tables, column or indexes. */
function makeOld(dbPath: string, from: number): void {
  createDatabase(dbPath).close();
  const raw = new Database(dbPath);
  raw.exec(`
    DROP TABLE IF EXISTS transfer_approval_requests;
    DROP TABLE IF EXISTS inference_spend_rollup;
    DROP INDEX IF EXISTS idx_treasury_approval;
    DROP INDEX IF EXISTS idx_treasury_created;
    ALTER TABLE treasury_ledger DROP COLUMN approval_id;
  `);
  raw.prepare("DELETE FROM schema_version WHERE version > ?").run(from);
  raw.close();
}

function shape(raw: Database.Database) {
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  const indexes = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
  const ledgerCols = (raw.prepare("PRAGMA table_info(treasury_ledger)").all() as { name: string }[]).map((c) => c.name);
  const requestCols = (raw.prepare("PRAGMA table_info(transfer_approval_requests)").all() as { name: string }[]).map((c) => c.name);
  return { tables, indexes, ledgerCols, requestCols };
}

describe("migration to version 20", () => {
  it("is followed only by migration 21 (public access DNS tables)", () => {
    expect(SCHEMA_VERSION).toBe(21);
  });

  it.each([16, 17, 18, 19])("upgrades a version %i database once, and a second open changes nothing", (from) => {
    const dbPath = path.join(tmp, `v${from}.db`);
    makeOld(dbPath, from);
    const before = new Database(dbPath, { readonly: true });
    expect(shape(before).tables).not.toContain("transfer_approval_requests");
    expect(shape(before).ledgerCols).not.toContain("approval_id");
    before.close();

    const db = createDatabase(dbPath);
    let first: ReturnType<typeof shape>;
    try {
      first = shape(db.raw);
      expect(first.tables).toEqual(expect.arrayContaining(["inference_spend_rollup", "transfer_approval_requests"]));
      expect(first.ledgerCols.filter((c) => c === "approval_id")).toHaveLength(1);
      expect(first.requestCols).toEqual(expect.arrayContaining(["origin_ref", "decision_seen", "executor_note"]));
      expect(first.indexes).toEqual(expect.arrayContaining(["idx_treasury_approval", "idx_treasury_created", "idx_apr_created"]));
      const applied = (
        db.raw.prepare("SELECT version FROM schema_version WHERE version > ? ORDER BY version").all(from) as { version: number }[]
      ).map((r) => r.version);
      expect(applied).toEqual(Array.from({ length: SCHEMA_VERSION - from }, (_, i) => from + 1 + i));
      db.raw
        .prepare(
          `INSERT INTO transfer_approval_requests (id, kind, counterparty, amount_cents, created_at_ms, expires_at_ms)
           VALUES ('apr_1', 'credit_transfer', '0xabc', 3000, 1, 2)`,
        )
        .run();
    } finally {
      db.close();
    }

    const again = createDatabase(dbPath);
    try {
      expect(shape(again.raw)).toEqual(first);
      expect((again.raw.prepare("SELECT COUNT(*) AS c FROM transfer_approval_requests").get() as { c: number }).c).toBe(1);
      expect((again.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(SCHEMA_VERSION);
    } finally {
      again.close();
    }
  });
});
