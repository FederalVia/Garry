/**
 * Credit Topup via x402
 *
 * Converts USDC to Conway credits via the x402 payment protocol.
 *
 * - On startup: bootstraps with the minimum tier ($5) so the agent can run.
 * - At runtime: the agent uses the `topup_credits` tool to choose how much.
 * - Heartbeat: wakes the agent when USDC is available but credits are low.
 *
 * Endpoint: GET /pay/{amountUsd}/{walletAddress}
 * Payment: x402 (USDC on Base, an EIP-3009 authorization)
 *
 * Valid tiers: 5, 25, 100, 500, 1000, 2500 (USD)
 *
 * Every purchase is a Treasury outflow of kind credit_topup. The signed
 * amount may not exceed the requested tier, the credits must be for this
 * automaton, and the purpose picks the budget: "manual" (topup_credits),
 * "sandbox_402" (spawn retries) or "survival" (automatic $5 buys, which the
 * gate allows only when its own fresh balance read is low).
 */

import type { PrivateKeyAccount, Address } from "viem";
import { x402Fetch, getUsdcBalance, type X402PaymentResult } from "./x402.js";
import { createLogger } from "../observability/logger.js";
import type { ChainType } from "../identity/chain.js";
import {
  runWithTreasuryOrigin,
  type TopupPurpose,
  type TreasuryResolver,
  type TreasuryResultFields,
} from "../treasury/index.js";

const logger = createLogger("topup");

/** Valid topup tier amounts in USD. */
export const TOPUP_TIERS = [5, 25, 100, 500, 1000, 2500];

export interface TopupResult extends TreasuryResultFields {
  success: boolean;
  amountUsd: number;
  creditsCentsAdded?: number;
  error?: string;
}

export interface TopupOptions {
  /** Which topup budget the purchase draws on. Default "manual". */
  topupPurpose?: TopupPurpose;
  /** Explicit gate; default is the installed Treasury. */
  treasury?: TreasuryResolver;
}

/** Gate refusals of an automatic topup that need no action from the agent. */
export const ROUTINE_TOPUP_REFUSALS: readonly string[] = Object.freeze([
  "TOPUP_NOT_NEEDED",
  "TOPUP_COOLDOWN",
  "TOPUP_IN_FLIGHT",
  "BALANCE_UNKNOWN_LIMIT",
  "PAYMENT_UNCONFIRMED",
  "TOPUP_ALREADY_SETTLED",
]);

/**
 * Gate refusals of an automatic topup the agent should hear about, but at
 * most once a day: the survival daily cap and an untrusted payTo. Neither is
 * fixed by retrying, and waking on every tick would cost a turn each time.
 */
export const DAILY_NOTICE_TOPUP_REFUSALS: readonly string[] = Object.freeze([
  "SPEND_LIMIT_EXCEEDED",
  "X402_PAYTO_NOT_TRUSTED",
]);

function treasuryFields(result: X402PaymentResult): TreasuryResultFields {
  const fields: TreasuryResultFields = {};
  if (result.paidCents !== undefined) fields.paidCents = result.paidCents;
  if (result.reservationId !== undefined) fields.reservationId = result.reservationId;
  if (result.settlement !== undefined) fields.settlement = result.settlement;
  if (result.denied !== undefined) fields.denied = result.denied;
  return fields;
}

/**
 * Execute a credit topup via x402 payment.
 *
 * Calls GET /pay/{amountUsd}/{address} which returns HTTP 402.
 * x402Fetch reserves the payment with the Treasury, signs at most
 * amountUsd of USDC and records the outcome.
 */
export async function topupCredits(
  apiUrl: string,
  account: PrivateKeyAccount,
  amountUsd: number,
  recipientAddress?: Address,
  opts: TopupOptions = {},
): Promise<TopupResult> {
  if (!Number.isSafeInteger(amountUsd) || amountUsd <= 0) {
    return { success: false, amountUsd, error: `Invalid topup amount: ${String(amountUsd)}` };
  }
  const address = recipientAddress || account.address;
  const url = `${apiUrl}/pay/${amountUsd}/${address}`;
  const topupPurpose = opts.topupPurpose ?? "manual";

  logger.info(`Attempting credit topup: $${amountUsd} USD for ${address} (${topupPurpose})`);

  const result = await x402Fetch(url, account, "GET", undefined, undefined, undefined, undefined, {
    purpose: "topup",
    topupPurpose,
    maxAtomic: BigInt(amountUsd) * 1_000_000n,
    recipient: address,
    amountUsd,
    treasury: opts.treasury,
  });
  const fields = treasuryFields(result);

  if (!result.success) {
    if (result.denied) {
      logger.info(`Credit topup refused: ${result.denied.code} — ${result.denied.message}`);
    } else {
      logger.error(`Credit topup failed: ${result.error}`);
    }
    return {
      success: false,
      amountUsd,
      error: result.error || `HTTP ${result.status}`,
      ...fields,
    };
  }

  const creditsCentsAdded = typeof result.response === "object"
    ? result.response?.credits_cents ?? result.response?.amount_cents ?? amountUsd * 100
    : amountUsd * 100;

  logger.info(`Credit topup successful: $${amountUsd} USD → ${creditsCentsAdded} credits cents`);

  return {
    success: true,
    amountUsd,
    creditsCentsAdded,
    ...fields,
  };
}

/**
 * Attempt a credit topup in response to a 402 sandbox creation error.
 *
 * Parses the error response to determine the deficit, picks the smallest
 * tier that covers it, checks USDC balance, and calls topupCredits().
 * Returns null if the error isn't a 402 or topup can't proceed.
 */
export async function topupForSandbox(params: {
  apiUrl: string;
  account: PrivateKeyAccount;
  error: Error & { status?: number; responseText?: string };
  chainType?: ChainType;
  treasury?: TreasuryResolver;
}): Promise<TopupResult | null> {
  const { apiUrl, account, error, chainType } = params;

  // Solana wallets cannot use x402 for topup (EVM-only payment protocol)
  if (chainType === "solana") {
    logger.info(
      "Sandbox topup skipped: Solana wallets cannot use x402. Fund via Conway credits API or dashboard.",
    );
    return null;
  }

  if (error.status !== 402 && !error.message?.includes("INSUFFICIENT_CREDITS")) return null;

  // Parse the 402 response body for credit details
  let requiredCents: number | undefined;
  let currentCents: number | undefined;
  try {
    const body = JSON.parse(error.responseText || "{}");
    requiredCents = body.details?.required_cents;
    currentCents = body.details?.current_balance_cents;
  } catch {
    // If we can't parse the body, check for INSUFFICIENT_CREDITS in message
    if (!error.message?.includes("INSUFFICIENT_CREDITS")) return null;
  }

  // Calculate deficit in cents; default to minimum tier if details missing
  const deficitCents = (requiredCents != null && currentCents != null)
    ? requiredCents - currentCents
    : TOPUP_TIERS[0] * 100;

  // Pick smallest tier that covers the deficit (tier is in USD, deficit in cents)
  const selectedTier = TOPUP_TIERS.find((tier) => tier * 100 >= deficitCents)
    ?? TOPUP_TIERS[TOPUP_TIERS.length - 1];

  // Check USDC balance before attempting payment
  let usdcBalance: number;
  try {
    usdcBalance = await getUsdcBalance(account.address);
  } catch (err: any) {
    logger.warn(`Failed to check USDC balance for sandbox topup: ${err.message}`);
    return null;
  }

  if (usdcBalance < selectedTier) {
    logger.info(
      `Sandbox topup skipped: USDC $${usdcBalance.toFixed(2)} < tier $${selectedTier}`,
    );
    return null;
  }

  logger.info(`Sandbox topup: deficit=${deficitCents}c, buying $${selectedTier} tier`);
  return topupCredits(apiUrl, account, selectedTier, undefined, {
    topupPurpose: "sandbox_402",
    treasury: params.treasury,
  });
}

/**
 * Bootstrap topup: buy the minimum tier ($5) on startup so the agent
 * can run inference. The agent decides larger topups itself via the
 * `topup_credits` tool.
 *
 * Only triggers when credits are below threshold AND USDC covers the
 * minimum tier. The caller's creditsCents may be stale; the Treasury makes
 * its own balance read and refuses the buy when credits are not low.
 */
export async function bootstrapTopup(params: {
  apiUrl: string;
  account: PrivateKeyAccount;
  creditsCents: number;
  creditThresholdCents?: number;
  chainType?: ChainType;
  treasury?: TreasuryResolver;
}): Promise<TopupResult | null> {
  const { apiUrl, account, creditsCents, creditThresholdCents = 500, chainType } = params;

  // Solana wallets cannot use x402 for topup (EVM-only payment protocol)
  if (chainType === "solana") {
    if (creditsCents < creditThresholdCents) {
      logger.info(
        "Bootstrap topup skipped: Solana wallets cannot use x402. Fund via Conway credits API or dashboard.",
      );
    }
    return null;
  }

  if (creditsCents >= creditThresholdCents) {
    return null;
  }

  let usdcBalance: number;
  try {
    usdcBalance = await getUsdcBalance(account.address);
  } catch (err: any) {
    logger.warn(`Failed to check USDC balance for bootstrap topup: ${err.message}`);
    return null;
  }

  const minTier = TOPUP_TIERS[0];
  if (usdcBalance < minTier) {
    logger.info(
      `Bootstrap topup skipped: USDC balance $${usdcBalance.toFixed(2)} below minimum tier ($${minTier})`,
    );
    return null;
  }

  logger.info(
    `Bootstrap topup: credits=$${(creditsCents / 100).toFixed(2)}, USDC=$${usdcBalance.toFixed(2)}, buying $${minTier}`,
  );

  return topupCredits(apiUrl, account, minTier, undefined, {
    topupPurpose: "survival",
    treasury: params.treasury,
  });
}

export type StartupTopupOutcome =
  | { status: "skipped"; reason: string }
  | { status: "timed_out" }
  | { status: "done"; result: TopupResult | null };

/**
 * The startup bootstrap topup. Runs with origin "startup.bootstrap", skips
 * the buy when the credit balance cannot be read (a failed read is not a
 * zero balance), and stops waiting after timeoutMs. A timeout only abandons
 * the wait: the payment's ledger row stays open, so the heartbeat and the
 * loop cannot buy alongside it.
 */
export async function startupBootstrapTopup(params: {
  apiUrl: string;
  account: PrivateKeyAccount;
  readCreditBalance: () => Promise<number>;
  chainType?: ChainType;
  timeoutMs?: number;
  treasury?: TreasuryResolver;
}): Promise<StartupTopupOutcome> {
  const timeoutMs = params.timeoutMs ?? 15_000;
  const work = runWithTreasuryOrigin(
    { type: "auto", name: "startup.bootstrap" },
    async (): Promise<StartupTopupOutcome> => {
      let creditsCents: number;
      try {
        creditsCents = await params.readCreditBalance();
      } catch (err: any) {
        return { status: "skipped", reason: `credit balance unavailable: ${err?.message || String(err)}` };
      }
      if (typeof creditsCents !== "number" || !Number.isFinite(creditsCents)) {
        return { status: "skipped", reason: "credit balance unavailable" };
      }
      const result = await bootstrapTopup({
        apiUrl: params.apiUrl,
        account: params.account,
        creditsCents,
        chainType: params.chainType,
        treasury: params.treasury,
      });
      return { status: "done", result };
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StartupTopupOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs);
  });
  // Keep a late failure from surfacing as an unhandled rejection.
  work.catch((err) => logger.warn(`Bootstrap topup failed: ${err?.message || String(err)}`));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
