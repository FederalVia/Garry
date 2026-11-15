/**
 * Survival thresholds.
 *
 * Conway mode keeps the fixed cent thresholds in SURVIVAL_THRESHOLDS. With a
 * budget, the owner's thresholds (percent of allowance + grants, or cents)
 * are installed once at startup, and every runtime caller of
 * getSurvivalTier passes currentSurvivalThresholds().
 */

import { SURVIVAL_THRESHOLDS } from "../types.js";
import type { BudgetThresholds } from "./config.js";

/** In cents: above high is high, above normal normal, above low_compute low_compute. */
export interface SurvivalThresholds {
  high: number;
  normal: number;
  low_compute: number;
}

export function resolveThresholds(t: BudgetThresholds, totalCents: number): SurvivalThresholds {
  if (t.unit === "cents") return { high: t.high, normal: t.normal, low_compute: t.lowCompute };
  const total = Math.max(0, totalCents);
  const pct = (p: number) => Math.floor((total * p) / 100);
  return { high: pct(t.high), normal: pct(t.normal), low_compute: pct(t.lowCompute) };
}

const KEY = Symbol.for("automaton.survival-thresholds");

/** Install the thresholds source (null restores the Conway defaults). */
export function installSurvivalThresholds(fn: (() => SurvivalThresholds) | null): void {
  (globalThis as Record<symbol, unknown>)[KEY] = fn ?? undefined;
}

/** The installed thresholds, or SURVIVAL_THRESHOLDS; a failing source falls back too. */
export function currentSurvivalThresholds(): SurvivalThresholds {
  const fn = (globalThis as Record<symbol, unknown>)[KEY] as (() => SurvivalThresholds) | undefined;
  if (fn) {
    try {
      return fn();
    } catch {
      // A failed snapshot keeps the fixed thresholds rather than throwing in a caller.
    }
  }
  return { high: SURVIVAL_THRESHOLDS.high, normal: SURVIVAL_THRESHOLDS.normal, low_compute: SURVIVAL_THRESHOLDS.low_compute };
}
