/**
 * Relay storage: one SQLite file, schema versioned with PRAGMA user_version.
 */

import fs from "node:fs";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { ProtocolTag } from "./protocol.js";

export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  from_addr  TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  content    TEXT NOT NULL,
  signed_at  TEXT NOT NULL,
  signature  TEXT NOT NULL,
  protocol   TEXT NOT NULL CHECK (protocol IN ('automaton/1','conway')),
  reply_to   TEXT,
  sig_hash   TEXT NOT NULL UNIQUE,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_to        ON messages(to_addr, seq);
CREATE INDEX idx_messages_from_time ON messages(from_addr, created_at);
CREATE INDEX idx_messages_to_time   ON messages(to_addr, created_at);
CREATE INDEX idx_messages_expiry    ON messages(expires_at, size);
CREATE TABLE poll_nonces (
  address TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (address, nonce)
) WITHOUT ROWID;
CREATE INDEX idx_poll_nonces_expiry ON poll_nonces(expires_at);
CREATE TABLE recipients (address TEXT PRIMARY KEY, last_polled_seq INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
`;

export interface MessageRow {
  seq: number;
  id: string;
  from_addr: string;
  to_addr: string;
  content: string;
  signed_at: string;
  signature: string;
  protocol: ProtocolTag;
  reply_to: string | null;
  sig_hash: string;
  /** UTF-8 bytes of content plus signature, counted against the total byte budget. */
  size: number;
  created_at: number;
  expires_at: number;
}

export type NewMessage = Omit<MessageRow, "seq">;

const TOTAL_CACHE_MS = 10_000;
const PRUNE_BATCH = 5_000;

export interface Store {
  readonly db: Database.Database;
  /** Random per database: a cursor from another relay or a wiped one restarts from the beginning. */
  readonly epoch: string;
  idForSigHash(sigHash: string): string | undefined;
  countFromSince(from: string, since: number): { count: number; oldest: number | null };
  countToSince(to: string, since: number): { count: number; oldest: number | null };
  /** Unread retained mail for `to` (after its last poll). */
  mailbox(to: string, now: number): { count: number; firstExpiry: number | null };
  /** Retained messages and their summed size (cached for a few seconds). */
  total(now: number): { count: number; bytes: number };
  firstExpiry(now: number): number | null;
  insert(msg: NewMessage): void;
  /** False when the (address, nonce) pair was already used. */
  useNonce(address: string, nonce: string, expiresAt: number): boolean;
  poll(to: string, after: number, now: number, limit: number): MessageRow[];
  markPolled(address: string, seq: number): void;
  unread(address: string, now: number): number;
  prune(now: number): { messages: number; nonces: number; recipients: number };
  close(): void;
}

function migrate(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(`relay DB schema ${version} is newer than this relay`);
  }
  if (version === 0) {
    db.transaction(() => {
      db.exec(SCHEMA_V1);
      db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?)").run(randomBytes(8).toString("hex"));
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
}

export function openStore(dbPath: string): Store {
  const isNew = dbPath !== ":memory:" && !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  // Message content is plain text: keep the file private to the relay's user.
  if (isNew) {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* best effort */
    }
  }

  const epoch = (db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string }).value;

  const q = {
    bySigHash: db.prepare("SELECT id FROM messages WHERE sig_hash = ?"),
    fromSince: db.prepare(
      "SELECT count(*) AS n, min(created_at) AS oldest FROM messages WHERE from_addr = ? AND created_at > ?",
    ),
    toSince: db.prepare(
      "SELECT count(*) AS n, min(created_at) AS oldest FROM messages WHERE to_addr = ? AND created_at > ?",
    ),
    // Only unread mail fills a mailbox: otherwise strangers could fill it once and keep the
    // recipient's real contacts out for the whole retention period, however often it polls.
    mailbox: db.prepare(
      `SELECT count(*) AS n, min(expires_at) AS first FROM messages
       WHERE to_addr = @to AND expires_at > @now
         AND seq > coalesce((SELECT last_polled_seq FROM recipients WHERE address = @to), 0)`,
    ),
    // Covered by idx_messages_expiry, so content pages are never read.
    total: db.prepare("SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM messages WHERE expires_at > ?"),
    firstExpiry: db.prepare("SELECT min(expires_at) AS first FROM messages WHERE expires_at > ?"),
    // seq is at least the insert time in ms, not just the next counter value. A DB restored
    // from a backup then still hands out seqs above every cursor issued before the restore,
    // instead of reusing seqs that clients have already polled past.
    insert: db.prepare(
      `INSERT INTO messages (seq, id, from_addr, to_addr, content, signed_at, signature, protocol, reply_to, sig_hash, size, created_at, expires_at)
       VALUES (max(coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'messages'), 0) + 1, @created_at),
               @id, @from_addr, @to_addr, @content, @signed_at, @signature, @protocol, @reply_to, @sig_hash, @size, @created_at, @expires_at)`,
    ),
    nonce: db.prepare("INSERT OR IGNORE INTO poll_nonces (address, nonce, expires_at) VALUES (?, ?, ?)"),
    poll: db.prepare(
      "SELECT * FROM messages WHERE to_addr = ? AND seq > ? AND expires_at > ? ORDER BY seq LIMIT ?",
    ),
    markPolled: db.prepare(
      `INSERT INTO recipients (address, last_polled_seq) VALUES (?, ?)
       ON CONFLICT(address) DO UPDATE SET last_polled_seq = max(last_polled_seq, excluded.last_polled_seq)`,
    ),
    lastPolled: db.prepare("SELECT last_polled_seq AS seq FROM recipients WHERE address = ?"),
    unread: db.prepare("SELECT count(*) AS n FROM messages WHERE to_addr = ? AND seq > ? AND expires_at > ?"),
    pruneMessages: db.prepare(
      `DELETE FROM messages WHERE seq IN (SELECT seq FROM messages WHERE expires_at <= ? LIMIT ${PRUNE_BATCH})`,
    ),
    pruneNonces: db.prepare("DELETE FROM poll_nonces WHERE expires_at <= ?"),
    // A recipient with no retained mail loses nothing by being forgotten: every
    // later message has a higher seq than anything it already polled.
    pruneRecipients: db.prepare(
      "DELETE FROM recipients WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.to_addr = recipients.address)",
    ),
  };

  let totalCache: { value: { count: number; bytes: number }; at: number } | null = null;

  return {
    db,
    epoch,
    idForSigHash(sigHash) {
      return (q.bySigHash.get(sigHash) as { id: string } | undefined)?.id;
    },
    countFromSince(from, since) {
      const r = q.fromSince.get(from, since) as { n: number; oldest: number | null };
      return { count: r.n, oldest: r.oldest };
    },
    countToSince(to, since) {
      const r = q.toSince.get(to, since) as { n: number; oldest: number | null };
      return { count: r.n, oldest: r.oldest };
    },
    mailbox(to, now) {
      const r = q.mailbox.get({ to, now }) as { n: number; first: number | null };
      return { count: r.n, firstExpiry: r.first };
    },
    total(now) {
      if (!totalCache || now - totalCache.at >= TOTAL_CACHE_MS || now < totalCache.at) {
        const r = q.total.get(now) as { n: number; bytes: number };
        totalCache = { value: { count: r.n, bytes: r.bytes }, at: now };
      }
      return { ...totalCache.value };
    },
    firstExpiry(now) {
      return (q.firstExpiry.get(now) as { first: number | null }).first;
    },
    insert(msg) {
      q.insert.run(msg);
      if (totalCache) {
        totalCache.value.count += 1;
        totalCache.value.bytes += msg.size;
      }
    },
    useNonce(address, nonce, expiresAt) {
      return q.nonce.run(address, nonce, expiresAt).changes === 1;
    },
    poll(to, after, now, limit) {
      return q.poll.all(to, after, now, limit) as MessageRow[];
    },
    markPolled(address, seq) {
      q.markPolled.run(address, seq);
    },
    unread(address, now) {
      const last = (q.lastPolled.get(address) as { seq: number } | undefined)?.seq ?? 0;
      return (q.unread.get(address, last, now) as { n: number }).n;
    },
    prune(now) {
      let messages = 0;
      for (;;) {
        const n = q.pruneMessages.run(now).changes;
        messages += n;
        if (n < PRUNE_BATCH) break;
      }
      const nonces = q.pruneNonces.run(now).changes;
      const recipients = q.pruneRecipients.run().changes;
      totalCache = null;
      return { messages, nonces, recipients };
    },
    close() {
      if (db.open) db.close();
    },
  };
}
