/**
 * Treasury ledger
 *
 * One row per outflow attempt. A row is inserted as 'reserved' (or 'denied')
 * before anything leaves the process, moves to 'sent' immediately before the
 * first byte is sent, and ends 'committed', 'released' or 'unknown'.
 *
 * The table is created by schema migration 12 (which also runs the one-time
 * legacy copy) and again, idempotently, by the Treasury constructor, so a
 * database opened without the migration runner still gets it.
 */

import type Database from "better-sqlite3";
import type { AmountBasis, BudgetId, LedgerStatus } from "./types.js";
import { MIGRATION_V12 } from "../state/schema.js";

export const TREASURY_LEDGER_DDL = MIGRATION_V12;

/**
 * Copy the last 24h of real transfer and x402 spend from spend_tracking, so
 * an upgrade does not reset today's usage. Runs only when the ledger table is
 * first created. Zero and fractional amounts are skipped.
 */
const LEGACY_COPY_SQL = `
INSERT OR IGNORE INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents,
  committed_cents, amount_atomic, debits_credits, counterparty, dedupe_key, origin_type, origin_name,
  created_at_ms, settled_at_ms, updated_at_ms)
SELECT id, id, 'legacy', category, 'committed', amount_cents, amount_cents,
  CASE category WHEN 'x402' THEN amount_cents * 10000 ELSE NULL END,
  CASE category WHEN 'transfer' THEN 1 ELSE 0 END,
  COALESCE(recipient, domain, ''), 'legacy:' || id, 'auto', 'legacy:' || tool_name,
  CAST(strftime('%s', created_at) AS INTEGER) * 1000,
  CAST(strftime('%s', created_at) AS INTEGER) * 1000,
  @nowMs
FROM spend_tracking
WHERE category IN ('transfer', 'x402')
  AND amount_cents > 0
  AND amount_cents = CAST(amount_cents AS INTEGER)
  AND created_at >= datetime(@nowSec, 'unixepoch', '-1 day')
`;

export interface EnsureLedgerResult {
  created: boolean;
  legacyCopied: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Create the ledger if needed and, only on first creation, copy legacy spend.
 * Both happen in one immediate transaction, so a crash cannot leave a table
 * without its legacy rows.
 */
export function ensureTreasuryLedger(db: Database.Database, nowMs: number): EnsureLedgerResult {
  return db
    .transaction((): EnsureLedgerResult => {
      if (tableExists(db, "treasury_ledger")) {
        db.exec(TREASURY_LEDGER_DDL);
        return { created: false, legacyCopied: 0 };
      }
      db.exec(TREASURY_LEDGER_DDL);
      if (!tableExists(db, "spend_tracking")) return { created: true, legacyCopied: 0 };
      const info = db
        .prepare(LEGACY_COPY_SQL)
        .run({ nowMs, nowSec: Math.floor(nowMs / 1000) });
      return { created: true, legacyCopied: info.changes };
    })
    .immediate();
}

/** A treasury_ledger row as stored. */
export interface LedgerRow {
  id: string;
  idempotency_key: string;
  replay_of: string | null;
  kind: string;
  budget: BudgetId;
  status: LedgerStatus;
  amount_cents: number;
  committed_cents: number | null;
  amount_atomic: number | null;
  amount_basis: AmountBasis;
  debits_credits: 0 | 1;
  counterparty: string;
  dedupe_key: string;
  origin_type: string;
  origin_name: string | null;
  input_source: string | null;
  boot_id: string | null;
  topup_purpose: string | null;
  url: string | null;
  description: string | null;
  deny_code: string | null;
  deny_count: number;
  reason: string | null;
  external_ref: string | null;
  x402_nonce: string | null;
  x402_valid_before: number | null;
  x402_from: string | null;
  x402_network: string | null;
  x402_asset: string | null;
  balance_observed_cents: number | null;
  balance_read_started_ms: number | null;
  balance_unknown: 0 | 1;
  created_at_ms: number;
  sent_at_ms: number | null;
  settled_at_ms: number | null;
  updated_at_ms: number;
}

/** Statuses that count against budgets. */
export const COUNTED_STATUSES: readonly LedgerStatus[] = Object.freeze([
  "reserved",
  "sent",
  "unknown",
  "committed",
]);

/** SQL fragment: amount a row holds against its budget, in cents. */
export const HELD_CENTS_SQL = `CASE WHEN status = 'committed' THEN COALESCE(committed_cents, amount_cents) ELSE amount_cents END`;

/**
 * SQL fragment: amount a row holds in USDC atomic units. A commit above the
 * reserved amount counts at the committed cents.
 */
export const HELD_ATOMIC_SQL = `CASE
  WHEN status = 'committed' AND committed_cents IS NOT NULL AND committed_cents > amount_cents
    THEN committed_cents * 10000
  ELSE COALESCE(amount_atomic, amount_cents * 10000) END`;

export function getLedgerRow(db: Database.Database, id: string): LedgerRow | undefined {
  return db.prepare("SELECT * FROM treasury_ledger WHERE id = ?").get(id) as LedgerRow | undefined;
}

export function listLedgerRows(
  db: Database.Database,
  filter: { budget?: BudgetId; status?: LedgerStatus } = {},
): LedgerRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.budget) {
    where.push("budget = ?");
    params.push(filter.budget);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const sql = `SELECT * FROM treasury_ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at_ms, id`;
  return db.prepare(sql).all(...params) as LedgerRow[];
}
