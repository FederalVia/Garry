/**
 * Where the survival tier comes from: the Conway credit balance, the owner's
 * budget (standalone), or a tier the creator fixed. Without a balance to
 * read, a fixed tier keeps the agent out of "unknown", which would pause
 * orchestration and route at low_compute.
 */

import type { AutomatonConfig, SurvivalTier } from "../types.js";

export type FixedSurvivalTier = Exclude<SurvivalTier, "dead">;

export type SurvivalSource =
  | { kind: "conway" }
  | { kind: "budget" }
  | { kind: "fixed"; tier: FixedSurvivalTier };

export const FIXED_TIERS: readonly FixedSurvivalTier[] = Object.freeze(["high", "normal", "low_compute", "critical"]);
export const DEFAULT_FIXED_TIER: FixedSurvivalTier = "normal";

export function isFixedSurvivalTier(v: unknown): v is FixedSurvivalTier {
  return typeof v === "string" && (FIXED_TIERS as readonly string[]).includes(v);
}

/**
 * Conway mode reads the balance unless the creator opted into a fixed tier.
 * Standalone follows the owner's budget when one is set, unless the creator
 * chose source "fixed" (the budget's period cap still binds then); without
 * a budget it uses the fixed tier (default normal).
 */
export function resolveSurvivalSource(
  config: Pick<AutomatonConfig, "providers">,
  mode: "conway" | "standalone",
  hasBudget = false,
): SurvivalSource {
  const s = config.providers?.survival;
  const tier = isFixedSurvivalTier(s?.fixedTier) ? s!.fixedTier! : DEFAULT_FIXED_TIER;
  if (mode === "conway" && s?.source !== "fixed") return { kind: "conway" };
  if (mode === "standalone" && hasBudget && s?.source !== "fixed") return { kind: "budget" };
  return { kind: "fixed", tier };
}
