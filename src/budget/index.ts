/**
 * The owner's budget: config, periods, thresholds, the meter and the
 * read-only owner database. The owner database writer is deliberately not
 * re-exported here; owner code imports it from ./owner-db.js directly.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonConfig } from "../types.js";
import { resolveBudget, resolveOwnerDbPath, type ResolvedBudget } from "./config.js";
import { BudgetMeter } from "./meter.js";
import { OwnerDbReader, type ApprovalDecision } from "./owner-db.js";
import { installSurvivalThresholds } from "./thresholds.js";

export {
  BudgetConfigError,
  DEFAULT_BUDGET_THRESHOLDS,
  DEFAULT_OWNER_DB_PATH,
  defaultDailyCapCents,
  describeBudget,
  parseUtcDate,
  resolveBudget,
  resolveOwnerDbPath,
  type BudgetThresholds,
  type ResolvedBudget,
} from "./config.js";
export { currentPeriod, type BudgetPeriod } from "./period.js";
export {
  currentSurvivalThresholds,
  installSurvivalThresholds,
  resolveThresholds,
  type SurvivalThresholds,
} from "./thresholds.js";
export { BudgetMeter, type BudgetSnapshot } from "./meter.js";
export { OwnerDbReader, type ApprovalDecision, type GrantSum, type OwnerGrant } from "./owner-db.js";

export interface InstalledBudget {
  budget: ResolvedBudget;
  meter: BudgetMeter;
  owner: OwnerDbReader;
}

const KEY = Symbol.for("automaton.budget");

/** The process-wide budget (heartbeat, tools and prompt read it); null clears it. */
export function installBudget(b: InstalledBudget | null): void {
  (globalThis as Record<symbol, unknown>)[KEY] = b ?? undefined;
  installSurvivalThresholds(b ? () => b.meter.snapshot().thresholds : null);
}

export function installedBudget(): InstalledBudget | null {
  return ((globalThis as Record<symbol, unknown>)[KEY] as InstalledBudget | undefined) ?? null;
}

/**
 * Build the budget for a standalone config that has one, on this state
 * database. Null when the config has no budget. Throws BudgetConfigError on
 * an invalid block (loadConfig refuses such a file first).
 */
export function createBudget(
  db: BetterSqlite3.Database,
  config: Pick<AutomatonConfig, "budget" | "ownerDbPath">,
  opts: { now?: () => number } = {},
): InstalledBudget | null {
  const budget = resolveBudget(config.budget);
  if (!budget) return null;
  const owner = new OwnerDbReader(resolveOwnerDbPath(config), opts);
  return { budget, owner, meter: new BudgetMeter({ db, budget, owner, now: opts.now }) };
}

/** Owner decisions for the treasury: read-only, from the owner database. */
export function ownerDecisions(owner: Pick<OwnerDbReader, "decision">): { decision(id: string): ApprovalDecision | null } {
  return { decision: (id) => owner.decision(id) };
}
