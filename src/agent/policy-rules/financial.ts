/**
 * Financial Policy Rules
 *
 * Early, friendly denials for spending tools: amount shape, per-payment and
 * per-turn limits, the confirmation threshold, the x402 allowlist and the
 * hourly/daily envelopes. The Treasury is the authoritative gate: it checks
 * the same limits (and the reserve, half balance and cooldowns) atomically
 * on rolling windows for every outflow, including automatic ones. These
 * rules read the calendar-bucket spend mirror; a current-hour bucket is a
 * subset of the rolling hour, so a rule never denies what the gate allows.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
  TreasuryPolicy,
} from "../../types.js";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("policy.financial");

/** Tools that move Conway credits to another address; they share one transfer budget. */
export const CREDIT_TRANSFER_TOOLS = ["transfer_credits", "fund_child"] as const;

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Deny x402 fetches once the x402 hourly or daily envelope is used up. The
 * exact amount is only known from the server's 402 quote, so the treasury
 * checks it before signing; this rule refuses early when nothing is left.
 */
function createX402EnvelopeRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.x402_envelope",
    description: `Deny x402 payments once the x402 envelope (${policy.maxX402PaymentCents * 10}c/h, ${policy.maxX402PaymentCents * 50}c/day) is used up`,
    priority: 500,
    appliesTo: { by: "name", names: ["x402_fetch"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const check = request.turnContext.sessionSpend.checkLimit(1, "x402", policy);
      if (!check.allowed) {
        return deny(
          "financial.x402_envelope",
          "SPEND_LIMIT_EXCEEDED",
          `x402 spending envelope used up: ${check.currentHourlySpend}c this hour (cap ${check.limitHourly}c), ${check.currentDailySpend}c today (cap ${check.limitDaily}c)`,
        );
      }
      return null;
    },
  };
}

/**
 * Deny x402 requests to domains not in the allowlist.
 */
function createX402DomainAllowlistRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.x402_domain_allowlist",
    description: "Deny x402 to domains not in allowlist",
    priority: 500,
    appliesTo: { by: "name", names: ["x402_fetch"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const url = request.args.url as string | undefined;
      if (!url) return null;

      const allowedDomains = policy.x402AllowedDomains;
      if (allowedDomains.length === 0) {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          "x402 payments are disabled (empty allowlist)",
        );
      }

      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          `Invalid URL: ${url}`,
        );
      }

      const isAllowed = allowedDomains.some(
        (domain) =>
          hostname === domain || hostname.endsWith(`.${domain}`),
      );

      if (!isAllowed) {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          `Domain "${hostname}" not in x402 allowlist: [${allowedDomains.join(", ")}]`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny single transfers above the configured max.
 */
function createTransferMaxSingleRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_max_single",
    description: `Deny transfers above ${policy.maxSingleTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: [...CREDIT_TRANSFER_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents;
      if (typeof amount !== "number") return null;

      if (amount > policy.maxSingleTransferCents) {
        return deny(
          "financial.transfer_max_single",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer of ${amount} cents exceeds single transfer max of ${policy.maxSingleTransferCents} cents ($${(policy.maxSingleTransferCents / 100).toFixed(2)})`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny if hourly transfer total would exceed cap.
 */
function createTransferHourlyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_hourly_cap",
    description: `Deny if hourly transfers exceed ${policy.maxHourlyTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: [...CREDIT_TRANSFER_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents;
      if (typeof amount !== "number") return null;

      const spendTracker = request.turnContext.sessionSpend;
      const check = spendTracker.checkLimit(amount, "transfer", policy);

      if (!check.allowed && check.reason?.includes("Hourly")) {
        return deny(
          "financial.transfer_hourly_cap",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer would exceed hourly cap: current ${check.currentHourlySpend} + ${amount} > ${check.limitHourly} cents ($${(check.limitHourly / 100).toFixed(2)}/hr)`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny if daily transfer total would exceed cap.
 */
function createTransferDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_daily_cap",
    description: `Deny if daily transfers exceed ${policy.maxDailyTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: [...CREDIT_TRANSFER_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents;
      if (typeof amount !== "number") return null;

      const spendTracker = request.turnContext.sessionSpend;
      const check = spendTracker.checkLimit(amount, "transfer", policy);

      if (!check.allowed && check.reason?.includes("Daily")) {
        return deny(
          "financial.transfer_daily_cap",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer would exceed daily cap: current ${check.currentDailySpend} + ${amount} > ${check.limitDaily} cents ($${(check.limitDaily / 100).toFixed(2)}/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny credit transfers whose amount is not a positive whole number of cents.
 * The other rules compare numbers, so "5,000" or NaN would slip past them.
 */
function createAmountIntegerRule(): PolicyRule {
  return {
    id: "financial.amount_integer",
    description: "Deny credit transfers whose amount is not a positive whole number of cents",
    priority: 500,
    appliesTo: { by: "name", names: [...CREDIT_TRANSFER_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents;
      if (typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0) {
        return null;
      }
      return deny(
        "financial.amount_integer",
        "INVALID_AMOUNT",
        `amount_cents must be a positive whole number of cents (got ${JSON.stringify(amount) ?? String(amount)})`,
      );
    },
  };
}

/**
 * Deny if too many transfer operations in a single turn.
 * Prevents iterative credit drain within one turn. turnToolCallCount is
 * counted by the caller (the agent loop and the worker harness).
 */
function createTurnTransferLimitRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.turn_transfer_limit",
    description: `Deny more than ${policy.maxTransfersPerTurn} transfers per turn`,
    priority: 500,
    appliesTo: { by: "name", names: [...CREDIT_TRANSFER_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const count = request.turnContext.turnToolCallCount;

      if (count >= policy.maxTransfersPerTurn) {
        return deny(
          "financial.turn_transfer_limit",
          "TURN_TRANSFER_LIMIT",
          `Maximum ${policy.maxTransfersPerTurn} transfers per turn exceeded (current: ${count})`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny inference calls if daily inference cost exceeds maxInferenceDailyCents.
 * Checks spend_tracking table for category 'inference'.
 */
function createInferenceDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.inference_daily_cap",
    description: `Deny inference if daily cost exceeds ${policy.maxInferenceDailyCents} cents`,
    priority: 500,
    appliesTo: { by: "category", categories: ["conway"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      // Only apply to inference-related tools
      if (request.tool.name !== "chat" && request.tool.name !== "inference") {
        return null;
      }

      const spendTracker = request.turnContext.sessionSpend;
      const dailyInferenceSpend = spendTracker.getDailySpend("inference");

      if (dailyInferenceSpend >= policy.maxInferenceDailyCents) {
        return deny(
          "financial.inference_daily_cap",
          "INFERENCE_BUDGET_EXCEEDED",
          `Daily inference budget exceeded: ${dailyInferenceSpend} cents spent (max ${policy.maxInferenceDailyCents} cents / $${(policy.maxInferenceDailyCents / 100).toFixed(2)}/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Refuse transfers above requireConfirmationAboveCents. No confirmation flow
 * exists, so this is a hard cap (the treasury caps every transfer at the same
 * threshold); the action stays 'quarantine' so the decision log keeps the
 * distinction, and the message says plainly that nothing will confirm it.
 */
function createRequireConfirmationRule(policy: TreasuryPolicy): PolicyRule {
  const threshold = policy.requireConfirmationAboveCents;
  return {
    id: "financial.require_confirmation",
    description: `Refuse transfers above ${threshold} cents (no confirmation flow exists)`,
    priority: 500,
    appliesTo: { by: "name", names: [...CREDIT_TRANSFER_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents;
      if (typeof amount !== "number") return null;

      if (amount > threshold) {
        return {
          rule: "financial.require_confirmation",
          action: "quarantine",
          reasonCode: "TRANSFER_ABOVE_CONFIRMATION_THRESHOLD",
          humanMessage: `Transfer of ${amount} cents (${usd(amount)}) refused: transfers above ${usd(threshold)} are refused because no confirmation flow exists. The operator can raise treasuryPolicy.requireConfirmationAboveCents.`,
        };
      }

      return null;
    },
  };
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The warning createFinancialRules logs when maxSingleTransferCents is above
 * the confirmation threshold (which then caps every transfer), else null.
 */
export function transferCapWarning(policy: TreasuryPolicy): string | null {
  if (policy.maxSingleTransferCents > policy.requireConfirmationAboveCents) {
    return `treasuryPolicy.maxSingleTransferCents (${policy.maxSingleTransferCents}c) has no effect above requireConfirmationAboveCents (${policy.requireConfirmationAboveCents}c): transfers above ${usd(policy.requireConfirmationAboveCents)} are refused because no confirmation flow exists.`;
  }
  return null;
}

/**
 * Create all financial policy rules.
 */
export function createFinancialRules(
  treasuryPolicy: TreasuryPolicy,
): PolicyRule[] {
  const warning = transferCapWarning(treasuryPolicy);
  if (warning) logger.warn(warning);
  // Same priority: the first deny in this order wins, so the amount shape is
  // checked before any rule compares the amount.
  return [
    createX402EnvelopeRule(treasuryPolicy),
    createX402DomainAllowlistRule(treasuryPolicy),
    createAmountIntegerRule(),
    createTransferMaxSingleRule(treasuryPolicy),
    createTransferHourlyCapRule(treasuryPolicy),
    createTransferDailyCapRule(treasuryPolicy),
    createTurnTransferLimitRule(treasuryPolicy),
    createInferenceDailyCapRule(treasuryPolicy),
    createRequireConfirmationRule(treasuryPolicy),
  ];
}
