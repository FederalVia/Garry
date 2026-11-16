/**
 * Migration 21: the DNS records the agent created and the DNS change log,
 * from every earlier version still in use, and over tables an earlier build
 * created outside the migration chain.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../state/database.js";
import { SCHEMA_VERSION } from "../../state/schema.js";
import { ensureDnsTables } from "../../edge/dns/changelog.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-mig-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A database as version `from` left it: no DNS tables. */
function makeOld(dbPath: string, from: number): void {
  createDatabase(dbPath).close();
  const raw = new Database(dbPath);
  raw.exec(`
    DROP INDEX IF EXISTS edge_dns_changes_zone_at;
    DROP TABLE IF EXISTS edge_dns_changes;
    DROP TABLE IF EXISTS edge_dns_records;
  `);
  raw.prepare("DELETE FROM schema_version WHERE version > ?").run(from);
  raw.close();
}

function shape(raw: Database.Database) {
  const names = (type: string) =>
    (raw.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'edge_dns%' ORDER BY name").all(type) as {
      name: string;
    }[]).map((r) => r.name);
  const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  return { tables: names("table"), indexes: names("index"), records: cols("edge_dns_records"), changes: cols("edge_dns_changes") };
}

const versions = (raw: Database.Database, from: number): number[] =>
  (raw.prepare("SELECT version FROM schema_version WHERE version > ? ORDER BY version").all(from) as { version: number }[]).map(
    (r) => r.version,
  );

describe("migration to version 21", () => {
  it("is the latest version", () => {
    expect(SCHEMA_VERSION).toBe(21);
  });

  it("a new database has the DNS tables", () => {
    const db = createDatabase(path.join(tmp, "new.db"));
    try {
      expect(shape(db.raw).tables).toEqual(["edge_dns_changes", "edge_dns_records"]);
      expect(shape(db.raw).indexes).toContain("edge_dns_changes_zone_at");
    } finally {
      db.close();
    }
  });

  it.each([16, 17, 18, 19, 20])("upgrades a version %i database once, and a second open changes nothing", (from) => {
    const dbPath = path.join(tmp, `v${from}.db`);
    makeOld(dbPath, from);
    const before = new Database(dbPath, { readonly: true });
    expect(shape(before).tables).toEqual([]);
    before.close();

    const db = createDatabase(dbPath);
    let first: ReturnType<typeof shape>;
    try {
      first = shape(db.raw);
      expect(first.tables).toEqual(["edge_dns_changes", "edge_dns_records"]);
      expect(first.indexes).toContain("edge_dns_changes_zone_at");
      expect(first.records).toEqual(expect.arrayContaining(["provider", "zone", "record_id", "created_at_ms", "deleted_at_ms"]));
      expect(first.changes).toEqual(expect.arrayContaining(["action", "outcome", "error"]));
      expect(versions(db.raw, from)).toEqual(Array.from({ length: SCHEMA_VERSION - from }, (_, i) => from + 1 + i));
      db.raw
        .prepare(
          `INSERT INTO edge_dns_changes (id, at_ms, provider, zone, action, outcome) VALUES ('c1', 1, 'fake', 'example.com', 'create', 'ok')`,
        )
        .run();
    } finally {
      db.close();
    }

    const again = createDatabase(dbPath);
    try {
      expect(shape(again.raw)).toEqual(first);
      expect((again.raw.prepare("SELECT COUNT(*) AS c FROM edge_dns_changes").get() as { c: number }).c).toBe(1);
      expect((again.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(SCHEMA_VERSION);
    } finally {
      again.close();
    }
  });

  it("keeps the rows of tables an earlier build created outside the chain at version 20", () => {
    const dbPath = path.join(tmp, "v20-with-tables.db");
    makeOld(dbPath, 20);
    const raw = new Database(dbPath);
    ensureDnsTables(raw);
    raw
      .prepare(
        `INSERT INTO edge_dns_records (provider, zone, record_id, type, name, content, ttl, created_at_ms)
         VALUES ('cloudflare', 'example.com', 'r1', 'A', 'www2.example.com', '203.0.113.7', 300, 1)`,
      )
      .run();
    raw.close();

    const db = createDatabase(dbPath);
    try {
      expect(versions(db.raw, 20)).toEqual([21]);
      expect(db.raw.prepare("SELECT record_id, content FROM edge_dns_records").all()).toEqual([
        { record_id: "r1", content: "203.0.113.7" },
      ]);
    } finally {
      db.close();
    }
  });
});
