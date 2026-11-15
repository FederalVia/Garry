/**
 * The owner's budget block: validation and defaults.
 *
 * An invalid block refuses startup (loadConfig turns BudgetConfigError into
 * ConfigError): silently dropping it would remove the money limit.
 */

import os from "os";
import path from "path";

export interface BudgetThresholds {
  unit: "percent" | "cents";
  high: number;
  normal: number;
  lowCompute: number;
}

export interface ResolvedBudget {
  allowanceCents: number;
  period: "monthly" | "one-off";
  /** Monthly: 1..28. One-off: 1 (unused). */
  resetDay: number;
  /** One-off: the start date at 00:00 UTC. Monthly: null. */
  startMs: number | null;
  countTreasury: boolean;
  thresholds: BudgetThresholds;
  dead: boolean;
}

export class BudgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetConfigError";
  }
}

export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = Object.freeze({
  unit: "percent",
  high: 50,
  normal: 15,
  lowCompute: 5,
}) as BudgetThresholds;

/** Largest allowance accepted: $1,000,000. Anything above is a typo. */
export const MAX_ALLOWANCE_CENTS = 100_000_000;

export const DEFAULT_OWNER_DB_PATH = "~/.automaton/owner/owner.db";

/** Share of the allowance the daily AI cap defaults to (owner decision: about 1/15). */
export const DAILY_CAP_DIVISOR = 15;

const KNOWN_KEYS = new Set([
  "allowanceCents",
  "period",
  "resetDay",
  "startDate",
  "countTreasury",
  "thresholds",
  "dead",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** "YYYY-MM-DD" (a real calendar date) to UTC midnight ms, else null. */
export function parseUtcDate(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/**
 * A one-off start date: a valid date that is today or earlier (UTC). A later
 * date would leave spending before it outside every period.
 */
export function parseStartDate(value: unknown, nowMs: number = Date.now()): { ms: number } | { error: string } {
  const ms = parseUtcDate(value);
  if (ms === null) return { error: 'startDate must be a date written "YYYY-MM-DD"' };
  if (ms > nowMs) {
    return { error: `startDate ${String(value)} is after today (UTC); a one-off budget starts today or earlier` };
  }
  return { ms };
}

function resolveThresholdsBlock(raw: unknown): BudgetThresholds {
  if (raw === undefined) return { ...DEFAULT_BUDGET_THRESHOLDS };
  const fail = (msg: string): never => {
    throw new BudgetConfigError(`budget.thresholds: ${msg}`);
  };
  if (!isPlainObject(raw)) fail("must be an object");
  const t = raw as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    if (!["unit", "high", "normal", "lowCompute"].includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  }
  const unit = t.unit === undefined ? "percent" : t.unit;
  if (unit !== "percent" && unit !== "cents") fail('unit must be "percent" or "cents"');
  const nums: number[] = [];
  for (const k of ["high", "normal", "lowCompute"] as const) {
    const v = t[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(`${k} must be a number > 0`);
    if (unit === "cents" && !Number.isInteger(v)) fail(`${k} must be whole cents`);
    if (unit === "percent" && (v as number) > 100) fail(`${k} must be at most 100 (percent)`);
    nums.push(v as number);
  }
  if (!(nums[0] > nums[1] && nums[1] > nums[2])) fail("high > normal > lowCompute is required");
  return { unit: unit as BudgetThresholds["unit"], high: nums[0], normal: nums[1], lowCompute: nums[2] };
}

/**
 * Validate the budget block. undefined or null: no budget (null). Anything
 * else must be a complete, valid block, or BudgetConfigError is thrown.
 */
export function resolveBudget(raw: unknown, nowMs: number = Date.now()): ResolvedBudget | null {
  if (raw === undefined || raw === null) return null;
  const fail = (msg: string): never => {
    throw new BudgetConfigError(`budget.${msg}`);
  };
  if (!isPlainObject(raw)) throw new BudgetConfigError("budget must be an object");
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!KNOWN_KEYS.has(k)) fail(`${k} is not a budget field`);
  }
  const allowance = b.allowanceCents;
  if (typeof allowance !== "number" || !Number.isSafeInteger(allowance) || allowance < 0) {
    fail("allowanceCents must be a whole number of cents >= 0");
  }
  if ((allowance as number) > MAX_ALLOWANCE_CENTS) fail(`allowanceCents must be at most ${MAX_ALLOWANCE_CENTS}`);
  const period = b.period === undefined ? "monthly" : b.period;
  if (period !== "monthly" && period !== "one-off") fail('period must be "monthly" or "one-off"');

  let resetDay = 1;
  let startMs: number | null = null;
  if (period === "monthly") {
    if (b.resetDay !== undefined) {
      const d = b.resetDay;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 28) fail("resetDay must be a whole number from 1 to 28");
      resetDay = d as number;
    }
    if (b.startDate !== undefined) fail('startDate applies to period "one-off" only');
  } else {
    if (b.startDate === undefined) fail('startDate ("YYYY-MM-DD", UTC) is required for period "one-off"');
    const start = parseStartDate(b.startDate, nowMs);
    if ("error" in start) fail(start.error);
    else startMs = start.ms;
    if (b.resetDay !== undefined) fail('resetDay applies to period "monthly" only');
  }
  if (b.countTreasury !== undefined && typeof b.countTreasury !== "boolean") fail("countTreasury must be true or false");
  if (b.dead !== undefined && typeof b.dead !== "boolean") fail("dead must be true or false");

  return {
    allowanceCents: allowance as number,
    period: period as ResolvedBudget["period"],
    resetDay,
    startMs,
    countTreasury: b.countTreasury !== false,
    thresholds: resolveThresholdsBlock(b.thresholds),
    dead: b.dead !== false,
  };
}

/**
 * With a zero allowance only the owner's grants can be spent; the period cap
 * keeps paid calls at zero until one arrives. This is the standalone default
 * ceiling (providers/mode.ts), so a grant is spendable at all.
 */
export const ZERO_ALLOWANCE_DAILY_CAP_CENTS = 200;

/**
 * The daily AI cap a budget implies: ceil(allowance / 15), at least 1 when
 * the allowance is > 0; the standalone default for a zero allowance.
 */
export function defaultDailyCapCents(b: Pick<ResolvedBudget, "allowanceCents">): number {
  if (b.allowanceCents <= 0) return ZERO_ALLOWANCE_DAILY_CAP_CENTS;
  return Math.max(1, Math.ceil(b.allowanceCents / DAILY_CAP_DIVISOR));
}

/** Absolute owner database path; a leading ~ is the agent's HOME. */
export function resolveOwnerDbPath(config: { ownerDbPath?: string }): string {
  const raw =
    typeof config.ownerDbPath === "string" && config.ownerDbPath.trim() !== ""
      ? config.ownerDbPath.trim()
      : DEFAULT_OWNER_DB_PATH;
  const home = process.env.HOME || os.homedir();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  return path.resolve(raw);
}

/** "$25.00 monthly, resets day 1 UTC" / "$25.00 one-off from 2026-01-01". */
export function describeBudget(b: ResolvedBudget): string {
  const amount = `$${(b.allowanceCents / 100).toFixed(2)}`;
  if (b.period === "monthly") return `${amount} monthly, resets day ${b.resetDay} UTC`;
  return `${amount} one-off from ${new Date(b.startMs ?? 0).toISOString().slice(0, 10)}`;
}
