/**
 * The budget meter: what the owner's budget has left in the current period.
 *
 *   remaining = allowance + grants - AI spend - treasury spend
 *
 * in micro-USD (1c = 10,000), all within the current period:
 * - grants: the owner database (monthly: grants made in this period only;
 *   one-off: every grant since the start date);
 * - AI spend: inference_ledger rows at what they hold (reserved and unknown
 *   rows at their worst case, so in-flight calls count) plus the daily
 *   rollup of rows pruned after 30 days; every budget class, survival too;
 * - treasury spend (countTreasury): reserved, sent, unknown and committed rows.
 *
 * Synchronous, so the gate and the treasury call it inside their immediate
 * transactions on the same database.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { SurvivalTier } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { INFERENCE_HELD_SQL } from "../inference/gate.js";
import { HELD_CENTS_SQL } from "../treasury/ledger.js";
import { MIGRATION_V20_ROLLUP } from "../state/schema.js";
import type { ResolvedBudget } from "./config.js";
import { currentPeriod } from "./period.js";
import { resolveThresholds, type SurvivalThresholds } from "./thresholds.js";
import type { OwnerDbReader } from "./owner-db.js";

export const MICRO_USD_PER_CENT = 10_000;

export interface BudgetSnapshot {
  periodStartMs: number;
  periodEndMs: number | null;
  allowanceCents: number;
  grantsCents: number;
  grantCount: number;
  /** allowance + grants: the base for percentage thresholds. */
  totalCents: number;
  aiSpentMicroUsd: number;
  treasurySpentCents: number;
  remainingMicroUsd: number;
  /** floor(remainingMicroUsd / 10,000); negative when actual usage passed a reservation. */
  remainingCents: number;
  thresholds: SurvivalThresholds;
  /** From the remaining budget clamped at 0: never "dead" (that comes only from the one-hour timer). */
  tier: SurvivalTier;
  ownerDbStale: boolean;
}

export interface BudgetMeterDeps {
  db: BetterSqlite3.Database;
  budget: ResolvedBudget;
  owner: Pick<OwnerDbReader, "grants">;
  now?: () => number;
}

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export class BudgetMeter {
  readonly budget: ResolvedBudget;
  private readonly db: BetterSqlite3.Database;
  private readonly owner: Pick<OwnerDbReader, "grants">;
  private readonly now: () => number;
  private haveInference = false;
  private haveTreasury = false;
  private haveRollup = false;

  constructor(deps: BudgetMeterDeps) {
    this.db = deps.db;
    this.budget = deps.budget;
    this.owner = deps.owner;
    this.now = deps.now ?? Date.now;
    // Read-only callers (the owner CLI) may open a database without it.
    if (!tableExists(this.db, "inference_spend_rollup")) {
      try {
        this.db.exec(MIGRATION_V20_ROLLUP);
      } catch {
        // read-only connection: the rollup counts as empty until the agent creates it
      }
    }
  }

  snapshot(nowMs: number = this.now()): BudgetSnapshot {
    const b = this.budget;
    const period = currentPeriod(b, nowMs);
    const g = this.owner.grants(period.startMs, b.period === "monthly" ? period.endMs : null);
    const ai = this.aiSpentMicroUsd(period.startMs);
    const treasury = b.countTreasury ? this.treasurySpentCents(period.startMs) : 0;
    const totalCents = b.allowanceCents + g.sumCents;
    const remainingMicroUsd = totalCents * MICRO_USD_PER_CENT - ai - treasury * MICRO_USD_PER_CENT;
    const remainingCents = Math.floor(remainingMicroUsd / MICRO_USD_PER_CENT);
    const thresholds = resolveThresholds(b.thresholds, totalCents);
    return {
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      allowanceCents: b.allowanceCents,
      grantsCents: g.sumCents,
      grantCount: g.count,
      totalCents,
      aiSpentMicroUsd: ai,
      treasurySpentCents: treasury,
      remainingMicroUsd,
      remainingCents,
      thresholds,
      tier: getSurvivalTier(Math.max(0, remainingCents), thresholds),
      ownerDbStale: g.stale,
    };
  }

  remainingMicroUsd(nowMs: number = this.now()): number {
    return this.snapshot(nowMs).remainingMicroUsd;
  }

  remainingCents(nowMs: number = this.now()): number {
    return this.snapshot(nowMs).remainingCents;
  }

  periodEndMs(nowMs: number = this.now()): number | null {
    return currentPeriod(this.budget, nowMs).endMs;
  }

  /** True when this meter reads `db`. */
  usesDatabase(db: BetterSqlite3.Database): boolean {
    return this.db === db;
  }

  get countsTreasury(): boolean {
    return this.budget.countTreasury;
  }

  private aiSpentMicroUsd(startMs: number): number {
    let total = 0;
    if (this.haveInference || (this.haveInference = tableExists(this.db, "inference_ledger"))) {
      total += Number(
        this.db
          .prepare(`SELECT COALESCE(SUM(${INFERENCE_HELD_SQL}), 0) FROM inference_ledger WHERE created_at_ms >= ?`)
          .pluck()
          .get(startMs) ?? 0,
      );
    }
    if (this.haveRollup || (this.haveRollup = tableExists(this.db, "inference_spend_rollup"))) {
      total += Number(
        this.db
          .prepare("SELECT COALESCE(SUM(held_micro_usd), 0) FROM inference_spend_rollup WHERE day_start_ms >= ?")
          .pluck()
          .get(startMs) ?? 0,
      );
    }
    return total;
  }

  private treasurySpentCents(startMs: number): number {
    if (!this.haveTreasury && !(this.haveTreasury = tableExists(this.db, "treasury_ledger"))) return 0;
    return Number(
      this.db
        .prepare(
          `SELECT COALESCE(SUM(${HELD_CENTS_SQL}), 0) FROM treasury_ledger
            WHERE status IN ('reserved','sent','unknown','committed') AND created_at_ms >= ?`,
        )
        .pluck()
        .get(startMs) ?? 0,
    );
  }
}
