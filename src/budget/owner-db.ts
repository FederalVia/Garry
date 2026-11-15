/**
 * The owner database: budget grants and transfer approval decisions.
 *
 * A separate SQLite file (default ~/.automaton/owner/owner.db) in its own
 * folder, rollback journal (never WAL, so a read-only mount can be read).
 * Only owner code writes it: the operator CLI and setup import
 * openOwnerDbForWrite; the runtime only ever opens it through OwnerDbReader,
 * a { readonly: true } connection, so its writes fail with SQLITE_READONLY.
 * A static test enforces who imports the writer.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("budget.owner-db");

export const OWNER_DB_SCHEMA_VERSION = 1;
/** Largest single grant the table accepts, either sign: $10,000. */
export const MAX_GRANT_CENTS = 1_000_000;
const ERROR_LOG_INTERVAL_MS = 3_600_000;

export const OWNER_DB_DDL = `
  CREATE TABLE IF NOT EXISTS owner_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS budget_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents != 0 AND amount_cents BETWEEN -1000000 AND 1000000),
    note TEXT,
    created_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_grants_created ON budget_grants(created_at_ms);
  CREATE TABLE IF NOT EXISTS approval_decisions (
    request_id TEXT PRIMARY KEY,
    decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
    kind TEXT NOT NULL CHECK (kind = 'credit_transfer'),
    counterparty TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    decided_at_ms INTEGER NOT NULL,
    execute_by_ms INTEGER,
    note TEXT
  );
`;

export interface OwnerGrant {
  id: number;
  amountCents: number;
  note: string | null;
  createdAtMs: number;
}

export interface ApprovalDecision {
  requestId: string;
  decision: "approved" | "rejected";
  kind: "credit_transfer";
  /** Copied from the request when the owner decided; the treasury trusts only this copy. */
  counterparty: string;
  amountCents: number;
  decidedAtMs: number;
  /** Approved only: the transfer must execute by then. */
  executeByMs: number | null;
  note: string | null;
}

export interface GrantSum {
  sumCents: number;
  count: number;
  /** The read failed and this is the last good value (or 0). */
  stale: boolean;
}

interface DecisionRow {
  request_id: string;
  decision: "approved" | "rejected";
  kind: "credit_transfer";
  counterparty: string;
  amount_cents: number;
  decided_at_ms: number;
  execute_by_ms: number | null;
  note: string | null;
}

function toDecision(r: DecisionRow): ApprovalDecision {
  return {
    requestId: r.request_id,
    decision: r.decision,
    kind: r.kind,
    counterparty: r.counterparty,
    amountCents: r.amount_cents,
    decidedAtMs: r.decided_at_ms,
    executeByMs: r.execute_by_ms,
    note: r.note,
  };
}

/** WAL needs a writable -shm next to the file, which a read-only mount cannot give. */
export class OwnerDbWalError extends Error {
  constructor(dbPath: string) {
    super(`${dbPath} uses WAL journaling; the owner database must use a rollback journal (journal_mode=DELETE)`);
    this.name = "OwnerDbWalError";
  }
}

/**
 * Runtime side: read-only. A missing file means no grants and no decisions.
 * Any read error (SQLITE_BUSY while the owner writes, a WAL file, a damaged
 * file) returns the last good value flagged stale, which starts at 0 grants
 * and no decisions: the conservative side.
 */
export class OwnerDbReader {
  readonly path: string;
  private conn: Database.Database | null = null;
  private readonly now: () => number;
  private lastGrants = new Map<string, { sumCents: number; count: number }>();
  private lastDecisions = new Map<string, ApprovalDecision | null>();
  private lastErrorLogMs = -Infinity;

  constructor(dbPath: string, opts: { now?: () => number } = {}) {
    this.path = dbPath;
    this.now = opts.now ?? Date.now;
  }

  grants(startMs: number, endMs: number | null): GrantSum {
    const key = `${startMs}|${endMs ?? ""}`;
    try {
      const db = this.open();
      if (!db) return { sumCents: 0, count: 0, stale: false };
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS n FROM budget_grants
            WHERE created_at_ms >= ? AND (? IS NULL OR created_at_ms < ?)`,
        )
        .get(startMs, endMs, endMs) as { s: number; n: number };
      const value = { sumCents: Number(row.s) || 0, count: Number(row.n) || 0 };
      this.lastGrants.set(key, value);
      return { ...value, stale: false };
    } catch (err) {
      this.noteError(err);
      const last = this.lastGrants.get(key) ?? { sumCents: 0, count: 0 };
      return { ...last, stale: true };
    }
  }

  decision(requestId: string): ApprovalDecision | null {
    try {
      const db = this.open();
      if (!db) return null;
      const row = db.prepare("SELECT * FROM approval_decisions WHERE request_id = ?").get(requestId) as
        | DecisionRow
        | undefined;
      const value = row ? toDecision(row) : null;
      this.lastDecisions.set(requestId, value);
      return value;
    } catch (err) {
      this.noteError(err);
      return this.lastDecisions.get(requestId) ?? null;
    }
  }

  close(): void {
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
    this.conn = null;
  }

  private open(): Database.Database | null {
    if (this.conn) return this.conn;
    if (!fs.existsSync(this.path)) return null;
    const db = new Database(this.path, { readonly: true, fileMustExist: true });
    try {
      db.pragma("busy_timeout = 250");
      const mode = String(db.pragma("journal_mode", { simple: true }) ?? "").toLowerCase();
      if (mode === "wal") throw new OwnerDbWalError(this.path);
    } catch (err) {
      db.close();
      throw err;
    }
    this.conn = db;
    return db;
  }

  private noteError(err: unknown): void {
    // A broken connection is reopened on the next read.
    if (!(err instanceof Error) || !/SQLITE_BUSY/.test((err as { code?: string }).code ?? "")) this.close();
    const now = this.now();
    if (now - this.lastErrorLogMs < ERROR_LOG_INTERVAL_MS && now >= this.lastErrorLogMs) return;
    this.lastErrorLogMs = now;
    logger.warn(
      `Owner database ${this.path} could not be read; using the last good values: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Owner side ──────────────────────────────────────────────────

export interface OwnerDbWriter {
  readonly path: string;
  addGrant(amountCents: number, note: string | null, nowMs: number): OwnerGrant;
  listGrants(opts?: { sinceMs?: number; limit?: number }): OwnerGrant[];
  /** Throws when the request was already decided. */
  decide(d: Omit<ApprovalDecision, "decidedAtMs"> & { nowMs: number }): ApprovalDecision;
  decision(requestId: string): ApprovalDecision | null;
  decisions(): ApprovalDecision[];
  close(): void;
}

export class OwnerDecisionExistsError extends Error {
  constructor(readonly requestId: string) {
    super(`Request ${requestId} was already decided`);
    this.name = "OwnerDecisionExistsError";
  }
}

/**
 * Owner code only (operator CLI, setup). Creates the folder (0755) and the
 * file (0644) when missing, sets the rollback journal and the schema.
 */
export function openOwnerDbForWrite(dbPath: string): OwnerDbWriter {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const p of [dir, dbPath]) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a symbolic link; refusing to open the owner database`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const created = !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("busy_timeout = 5000");
    db.exec(OWNER_DB_DDL);
    db.prepare("INSERT OR IGNORE INTO owner_meta (key, value) VALUES ('schema_version', ?)").run(
      String(OWNER_DB_SCHEMA_VERSION),
    );
    if (created) fs.chmodSync(dbPath, 0o644);
  } catch (err) {
    db.close();
    throw err;
  }

  const grantOf = (r: { id: number; amount_cents: number; note: string | null; created_at_ms: number }): OwnerGrant => ({
    id: r.id,
    amountCents: r.amount_cents,
    note: r.note,
    createdAtMs: r.created_at_ms,
  });

  return {
    path: dbPath,
    addGrant(amountCents, note, nowMs) {
      if (!Number.isSafeInteger(amountCents) || amountCents === 0 || Math.abs(amountCents) > MAX_GRANT_CENTS) {
        throw new Error(`A grant must be a whole, non-zero number of cents up to ${MAX_GRANT_CENTS} either way`);
      }
      const info = db
        .prepare("INSERT INTO budget_grants (amount_cents, note, created_at_ms) VALUES (?, ?, ?)")
        .run(amountCents, note, nowMs);
      return { id: Number(info.lastInsertRowid), amountCents, note, createdAtMs: nowMs };
    },
    listGrants(opts = {}) {
      const rows = db
        .prepare("SELECT * FROM budget_grants WHERE created_at_ms >= ? ORDER BY created_at_ms DESC, id DESC LIMIT ?")
        .all(opts.sinceMs ?? 0, opts.limit ?? 1000) as Array<{
        id: number;
        amount_cents: number;
        note: string | null;
        created_at_ms: number;
      }>;
      return rows.map(grantOf);
    },
    decide(d) {
      const decision: ApprovalDecision = {
        requestId: d.requestId,
        decision: d.decision,
        kind: d.kind,
        counterparty: d.counterparty,
        amountCents: d.amountCents,
        decidedAtMs: d.nowMs,
        executeByMs: d.decision === "approved" ? d.executeByMs : null,
        note: d.note,
      };
      try {
        db.prepare(
          `INSERT INTO approval_decisions (request_id, decision, kind, counterparty, amount_cents, decided_at_ms, execute_by_ms, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          decision.requestId,
          decision.decision,
          decision.kind,
          decision.counterparty,
          decision.amountCents,
          decision.decidedAtMs,
          decision.executeByMs,
          decision.note,
        );
      } catch (err) {
        if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") throw new OwnerDecisionExistsError(d.requestId);
        throw err;
      }
      return decision;
    },
    decision(requestId) {
      const row = db.prepare("SELECT * FROM approval_decisions WHERE request_id = ?").get(requestId) as
        | DecisionRow
        | undefined;
      return row ? toDecision(row) : null;
    },
    decisions() {
      return (db.prepare("SELECT * FROM approval_decisions ORDER BY decided_at_ms DESC").all() as DecisionRow[]).map(
        toDecision,
      );
    },
    close() {
      db.close();
    },
  };
}
