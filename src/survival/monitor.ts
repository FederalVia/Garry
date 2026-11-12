/**
 * Resource Monitor
 *
 * Continuously monitors the automaton's resources and triggers
 * survival mode transitions when needed.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  AutomatonIdentity,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import { getSurvivalTier, formatCredits } from "../conway/credits.js";
import { readCredits, readUsdc, usdcNetworkFor } from "../conway/balance.js";

export interface ResourceStatus {
  financial: FinancialState;
  /** null when the credit balance could not be read. */
  tier: SurvivalTier | null;
  previousTier: SurvivalTier | null;
  tierChanged: boolean;
  sandboxHealthy: boolean;
}

/**
 * Check all resources and return current status.
 */
export async function checkResources(
  identity: AutomatonIdentity,
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<ResourceStatus> {
  // An unreadable balance stays unknown; it is never reported as $0.00.
  const creditRead = await readCredits(conway);
  const chainType = identity.chainType || "evm";
  const usdcRead = await readUsdc(identity.address, usdcNetworkFor(chainType), chainType);
  const creditsCents = creditRead.known ? creditRead.value : null;
  const usdcBalance = usdcRead.known ? usdcRead.value : null;

  // Check sandbox health
  let sandboxHealthy = true;
  try {
    const result = await conway.exec("echo ok", 5000);
    sandboxHealthy = result.exitCode === 0;
  } catch {
    sandboxHealthy = false;
  }

  const financial: FinancialState = {
    creditsCents,
    usdcBalance,
    credits: creditRead.known ? "live" : "unknown",
    usdc: usdcRead.known ? "live" : "unknown",
    lastChecked: new Date().toISOString(),
  };

  const tier = creditsCents === null ? null : getSurvivalTier(creditsCents);
  const prevTierStr = db.getKV("current_tier");
  const previousTier = (prevTierStr as SurvivalTier) || null;
  const tierChanged = tier !== null && previousTier !== null && previousTier !== tier;

  // Store current tier (only from a reading)
  if (tier !== null) db.setKV("current_tier", tier);

  // Store financial state
  db.setKV("financial_state", JSON.stringify(financial));

  return {
    financial,
    tier,
    previousTier,
    tierChanged,
    sandboxHealthy,
  };
}

/**
 * Generate a human-readable resource report.
 */
export function formatResourceReport(status: ResourceStatus): string {
  const lines = [
    `=== RESOURCE STATUS ===`,
    `Credits: ${status.financial.creditsCents === null ? "unknown" : formatCredits(status.financial.creditsCents)}`,
    `USDC: ${status.financial.usdcBalance === null ? "unknown" : status.financial.usdcBalance.toFixed(6)}`,
    `Tier: ${status.tier ?? "unknown"}${status.tierChanged ? ` (changed from ${status.previousTier})` : ""}`,
    `Sandbox: ${status.sandboxHealthy ? "healthy" : "UNHEALTHY"}`,
    `Checked: ${status.financial.lastChecked}`,
    `========================`,
  ];
  return lines.join("\n");
}
