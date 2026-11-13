/**
 * Where the survival tier comes from: the Conway credit balance, or a tier
 * the creator fixed. Without a balance to read, a fixed tier keeps the agent
 * out of "unknown", which would pause orchestration and route at low_compute.
 */

import type { AutomatonConfig, SurvivalTier } from "../types.js";

export type FixedSurvivalTier = Exclude<SurvivalTier, "dead">;

export type SurvivalSource = { kind: "conway" } | { kind: "fixed"; tier: FixedSurvivalTier };

export const FIXED_TIERS: readonly FixedSurvivalTier[] = Object.freeze(["high", "normal", "low_compute", "critical"]);
export const DEFAULT_FIXED_TIER: FixedSurvivalTier = "normal";

export function isFixedSurvivalTier(v: unknown): v is FixedSurvivalTier {
  return typeof v === "string" && (FIXED_TIERS as readonly string[]).includes(v);
}

/**
 * Conway mode reads the balance unless the creator opted into a fixed tier;
 * standalone always uses the fixed tier (default normal).
 */
export function resolveSurvivalSource(
  config: Pick<AutomatonConfig, "providers">,
  mode: "conway" | "standalone",
): SurvivalSource {
  const s = config.providers?.survival;
  const tier = isFixedSurvivalTier(s?.fixedTier) ? s!.fixedTier! : DEFAULT_FIXED_TIER;
  if (mode === "conway" && s?.source !== "fixed") return { kind: "conway" };
  return { kind: "fixed", tier };
}
