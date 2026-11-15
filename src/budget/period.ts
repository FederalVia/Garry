/**
 * Budget periods, in UTC.
 *
 * Monthly periods start at 00:00 UTC on the reset day (1..28, so every month
 * has it) and end at the same time next month; the boundary millisecond
 * belongs to the new period. A one-off budget starts on its start date and
 * never ends.
 */

import type { ResolvedBudget } from "./config.js";

export interface BudgetPeriod {
  startMs: number;
  /** Exclusive; null for a one-off budget. */
  endMs: number | null;
}

export function currentPeriod(b: Pick<ResolvedBudget, "period" | "resetDay" | "startMs">, nowMs: number): BudgetPeriod {
  if (b.period === "one-off") return { startMs: b.startMs ?? 0, endMs: null };
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let start = Date.UTC(y, m, b.resetDay);
  if (start > nowMs) start = Date.UTC(y, m - 1, b.resetDay);
  const s = new Date(start);
  const end = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, b.resetDay);
  return { startMs: start, endMs: end };
}
