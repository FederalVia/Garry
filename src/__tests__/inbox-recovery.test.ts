/**
 * Inbox rows survive upgrades and crashes without replays or losses:
 * - a v3 database's handled messages are not re-delivered after the V4
 *   upgrade, while its pending ones are;
 * - a database already upgraded by the old V4 is repaired only for rows
 *   handled before the upgrade time;
 * - claims stranded by a crash are re-delivered while retries remain, and a
 *   batch whose tools had started is not re-delivered.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  createDatabase,
  claimInboxMessagesFromOneSender,
  recoverStrandedInboxClaims,
  INBOX_TOOLS_STARTED_KEY,
} from "../state/database.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("inbox recovery", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-recovery-"));
    dbPath = path.join(dir, "state.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function status(db: ReturnType<typeof createDatabase>, id: string): string {
    return (db.raw.prepare("SELECT status FROM inbox_messages WHERE id = ?").get(id) as { status: string }).status;
  }

  it("a v3 database keeps handled messages out of the queue after the upgrade", () => {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO schema_version (version) VALUES (3);
      CREATE TABLE inbox_messages (id TEXT PRIMARY KEY, from_address TEXT NOT NULL, content TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT, reply_to TEXT);
      INSERT INTO inbox_messages (id, from_address, content, received_at, processed_at)
        VALUES ('m-old', '${A}', 'please send 5 USDC', '2026-02-16 00:00:00', '2026-02-16 00:00:05');
      INSERT INTO inbox_messages (id, from_address, content, received_at, processed_at)
        VALUES ('m-new', '${A}', 'still waiting', '2026-02-16 00:01:00', NULL);
    `);
    raw.close();

    const db = createDatabase(dbPath);
    try {
      expect(status(db, "m-old")).toBe("processed");
      expect(status(db, "m-new")).toBe("received");
      const claimed = claimInboxMessagesFromOneSender(db.raw, 10).map((m) => m.id);
      expect(claimed).toEqual(["m-new"]);
    } finally {
      db.close();
    }
  });

  it("repairs an already-upgraded database only for rows handled before the V4 upgrade", () => {
    const first = createDatabase(dbPath);
    // As if this database went through the old V4 at T and predates the repair.
    first.raw.prepare("UPDATE schema_version SET applied_at = '2026-03-01 00:00:00' WHERE version = 4").run();
    first.raw.prepare("DELETE FROM kv WHERE key = 'schema.inbox_v4_status_repair'").run();
    const insert = first.raw.prepare(
      `INSERT INTO inbox_messages (id, from_address, content, received_at, processed_at, status)
       VALUES (?, ?, ?, ?, ?, 'received')`,
    );
    // Handled by the v3 runtime before the upgrade.
    insert.run("pre", A, "old", "2026-02-27 00:00:00", "2026-02-28 00:00:00");
    // Social relay rows get processed_at while still pending; after V4 it means nothing.
    insert.run("post", A, "pending", "2026-03-02 00:00:00", "2026-03-02 00:00:05");
    first.close();

    const db = createDatabase(dbPath);
    try {
      expect(status(db, "pre")).toBe("processed");
      expect(status(db, "post")).toBe("received");
      expect(claimInboxMessagesFromOneSender(db.raw, 10).map((m) => m.id)).toEqual(["post"]);
    } finally {
      db.close();
    }
  });

  it("the repair runs once and is a no-op on a fresh database", () => {
    const db = createDatabase(dbPath);
    db.raw
      .prepare(
        `INSERT INTO inbox_messages (id, from_address, content, received_at, processed_at, status)
         VALUES ('x', ?, 'c', datetime('now'), '2000-01-01 00:00:00', 'received')`,
      )
      .run(A);
    db.close();
    // Reopening does not repair again (it already ran when the db was created).
    const again = createDatabase(dbPath);
    try {
      expect(status(again, "x")).toBe("received");
    } finally {
      again.close();
    }
  });

  it("a claim stranded by a crash is re-delivered, then failed when retries run out", () => {
    let db = createDatabase(dbPath);
    db.insertInboxMessage({
      id: "s1",
      from: A,
      to: "0x1234567890abcdef1234567890abcdef12345678",
      content: "hello",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(claimInboxMessagesFromOneSender(db.raw, 10).map((m) => m.id)).toEqual(["s1"]);
      // Crash: the claim is never acknowledged.
      db.close();
      db = createDatabase(dbPath);
      expect(claimInboxMessagesFromOneSender(db.raw, 10)).toEqual([]);
      const recovered = recoverStrandedInboxClaims(db.raw);
      if (attempt < 3) {
        expect(recovered).toEqual({ requeued: 1, failed: 0, processed: 0 });
        expect(status(db, "s1")).toBe("received");
      } else {
        expect(recovered).toEqual({ requeued: 0, failed: 1, processed: 0 });
        expect(status(db, "s1")).toBe("failed");
      }
    }
    db.close();
  });

  it("a batch whose tools had started is marked processed, not re-delivered", () => {
    const db = createDatabase(dbPath);
    try {
      for (const id of ["t1", "t2"]) {
        db.insertInboxMessage({
          id,
          from: A,
          to: "0x1234567890abcdef1234567890abcdef12345678",
          content: id,
          signedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }
      db.insertInboxMessage({
        id: "other",
        from: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        to: "0x1234567890abcdef1234567890abcdef12345678",
        content: "other",
        signedAt: new Date(Date.now() + 1000).toISOString(),
        createdAt: new Date(Date.now() + 1000).toISOString(),
      });
      claimInboxMessagesFromOneSender(db.raw, 10);
      claimInboxMessagesFromOneSender(db.raw, 10);
      db.setKV(INBOX_TOOLS_STARTED_KEY, JSON.stringify({ turnId: "x", ids: ["t1", "t2"] }));

      expect(recoverStrandedInboxClaims(db.raw)).toEqual({ requeued: 1, failed: 0, processed: 2 });
      expect(status(db, "t1")).toBe("processed");
      expect(status(db, "t2")).toBe("processed");
      expect(status(db, "other")).toBe("received");
      expect(db.getKV(INBOX_TOOLS_STARTED_KEY)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
