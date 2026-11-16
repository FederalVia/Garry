/**
 * The DNS change log and the agent's record ownership, in state.db.
 *
 * The tables are schema migration 21; ensureDnsTables creates them again
 * with IF NOT EXISTS, so a service on a bare database (tests, tools) works.
 * state.db is denied to the agent's file tools and named in the command
 * tripwire, so ownership cannot be forged from a tool.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { MIGRATION_V21_EDGE_DNS } from "../../state/schema.js";

/** The tables (schema migration 21); kept here so a bare database gets them too. */
export const DNS_TABLES_DDL = MIGRATION_V21_EDGE_DNS;

export const CHANGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** How long an unconfirmed create may still be adopted when it shows up. */
export const ADOPT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ChangeOutcome = "pending" | "ok" | "failed" | "unknown";

export interface OwnedRecordRow {
  provider: string;
  zone: string;
  record_id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  created_at_ms: number;
  deleted_at_ms: number | null;
}

export interface ChangeRow {
  id: string;
  at_ms: number;
  provider: string;
  zone: string;
  action: "create" | "delete";
  record_id: string | null;
  type: string | null;
  name: string | null;
  content: string | null;
  ttl: number | null;
  outcome: ChangeOutcome;
  error: string | null;
}

export function ensureDnsTables(db: Database.Database): void {
  db.exec(DNS_TABLES_DDL);
}

/** Drop change rows older than 90 days. */
export function pruneDnsChanges(db: Database.Database, nowMs: number): number {
  return db.prepare("DELETE FROM edge_dns_changes WHERE at_ms < ?").run(nowMs - CHANGE_RETENTION_MS).changes;
}

/**
 * Pending rows from an earlier process were interrupted mid-write: the
 * change may or may not have happened.
 */
export function markInterruptedAsUnknown(db: Database.Database, provider: string, zone: string, keep: ReadonlySet<string>): void {
  const rows = db
    .prepare("SELECT id FROM edge_dns_changes WHERE provider = ? AND zone = ? AND outcome = 'pending'")
    .all(provider, zone) as { id: string }[];
  const upd = db.prepare("UPDATE edge_dns_changes SET outcome = 'unknown', error = 'interrupted' WHERE id = ?");
  for (const r of rows) if (!keep.has(r.id)) upd.run(r.id);
}

/** Changes attempted for the zone since `sinceMs`, any outcome: a failing loop still spends the cap. */
export function countChangesSince(db: Database.Database, zone: string, sinceMs: number): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM edge_dns_changes WHERE zone = ? AND at_ms > ?").get(zone, sinceMs) as { n: number };
  return row.n;
}

/** Oldest change inside the window, so a refusal can say when the cap frees up. */
export function oldestChangeSince(db: Database.Database, zone: string, sinceMs: number): number | null {
  const row = db.prepare("SELECT MIN(at_ms) AS t FROM edge_dns_changes WHERE zone = ? AND at_ms > ?").get(zone, sinceMs) as { t: number | null };
  return row.t;
}

export function insertChange(
  db: Database.Database,
  c: Omit<ChangeRow, "id" | "outcome" | "error"> & { outcome?: ChangeOutcome },
): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO edge_dns_changes (id, at_ms, provider, zone, action, record_id, type, name, content, ttl, outcome, error)
     VALUES (@id, @at_ms, @provider, @zone, @action, @record_id, @type, @name, @content, @ttl, @outcome, NULL)`,
  ).run({ ...c, id, outcome: c.outcome ?? "pending" });
  return id;
}

export function settleChange(db: Database.Database, id: string, outcome: Exclude<ChangeOutcome, "pending">, extra: { recordId?: string; error?: string } = {}): void {
  db.prepare("UPDATE edge_dns_changes SET outcome = ?, record_id = COALESCE(?, record_id), error = ? WHERE id = ?").run(
    outcome,
    extra.recordId ?? null,
    extra.error ?? null,
    id,
  );
}

export function listChanges(db: Database.Database, zone: string): ChangeRow[] {
  return db.prepare("SELECT * FROM edge_dns_changes WHERE zone = ? ORDER BY at_ms, id").all(zone) as ChangeRow[];
}

/** Creates with no confirmed result, recent enough to adopt. */
export function unconfirmedCreates(db: Database.Database, provider: string, zone: string, sinceMs: number): ChangeRow[] {
  return db
    .prepare(
      `SELECT * FROM edge_dns_changes
       WHERE provider = ? AND zone = ? AND action = 'create' AND outcome = 'unknown' AND at_ms > ?
       ORDER BY at_ms`,
    )
    .all(provider, zone, sinceMs) as ChangeRow[];
}

export function insertOwnedRecord(
  db: Database.Database,
  r: Omit<OwnedRecordRow, "deleted_at_ms">,
): void {
  db.prepare(
    `INSERT INTO edge_dns_records (provider, zone, record_id, type, name, content, ttl, created_at_ms, deleted_at_ms)
     VALUES (@provider, @zone, @record_id, @type, @name, @content, @ttl, @created_at_ms, NULL)
     ON CONFLICT (provider, zone, record_id) DO UPDATE SET
       type = excluded.type, name = excluded.name, content = excluded.content, ttl = excluded.ttl,
       created_at_ms = excluded.created_at_ms, deleted_at_ms = NULL`,
  ).run(r);
}

export function liveOwnedRecords(db: Database.Database, provider: string, zone: string): OwnedRecordRow[] {
  return db
    .prepare("SELECT * FROM edge_dns_records WHERE provider = ? AND zone = ? AND deleted_at_ms IS NULL ORDER BY created_at_ms")
    .all(provider, zone) as OwnedRecordRow[];
}

export function getLiveOwnedRecord(db: Database.Database, provider: string, zone: string, recordId: string): OwnedRecordRow | undefined {
  return db
    .prepare("SELECT * FROM edge_dns_records WHERE provider = ? AND zone = ? AND record_id = ? AND deleted_at_ms IS NULL")
    .get(provider, zone, recordId) as OwnedRecordRow | undefined;
}

export function markRecordDeleted(db: Database.Database, provider: string, zone: string, recordId: string, nowMs: number): void {
  db.prepare("UPDATE edge_dns_records SET deleted_at_ms = ? WHERE provider = ? AND zone = ? AND record_id = ? AND deleted_at_ms IS NULL").run(
    nowMs,
    provider,
    zone,
    recordId,
  );
}
