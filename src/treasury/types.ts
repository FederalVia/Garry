/**
 * Treasury types
 *
 * Shared vocabulary of the spending gate: outflow kinds, budgets, ledger
 * statuses, deny codes, the quote a caller hands to the gate, and the errors
 * the gate throws.
 */

import type { InputSource, ResolvedTreasuryPolicy } from "../types.js";

export type { ResolvedTreasuryPolicy };

export type OutflowKind =
  | "credit_transfer"
  | "x402_payment"
  | "credit_topup"
  | "sandbox_create"
  | "domain_register";

export type BudgetId = "transfer" | "x402" | "topup" | "topup_auto" | "infra";

export type TopupPurpose = "manual" | "sandbox_402" | "survival";

export type LedgerStatus =
  | "denied"
  | "reserved"
  | "sent"
  | "committed"
  | "released"
  | "unknown";

export type AmountBasis = "exact" | "quote" | "estimate" | "ceiling";

export type TreasuryDenyCode =
  | "INVALID_AMOUNT"
  | "INVALID_QUOTE"
  | "SPEND_LIMIT_EXCEEDED"
  | "RESERVE_VIOLATION"
  | "HALF_BALANCE"
  | "TRANSFER_COOLDOWN"
  | "SELF_TRANSFER"
  | "BALANCE_UNAVAILABLE"
  | "UNTRUSTED_SOURCE"
  | "X402_DOMAIN_NOT_ALLOWED"
  | "X402_AMOUNT_MISMATCH"
  | "X402_DEADLINE_TOO_LONG"
  | "X402_PAYTO_NOT_TRUSTED"
  | "TOPUP_RECIPIENT_NOT_SELF"
  | "PAYMENT_UNCONFIRMED"
  | "TOPUP_ALREADY_SETTLED"
  | "AMBIGUOUS_PENDING"
  | "TOPUP_IN_FLIGHT"
  | "TOPUP_COOLDOWN"
  | "TOPUP_NOT_NEEDED"
  | "BALANCE_UNKNOWN_LIMIT"
  | "ORIGIN_NOT_ALLOWED"
  | "PRICE_UNKNOWN"
  | "TREASURY_NOT_INSTALLED";

/** Who started an outflow. Stored on every ledger row. */
export interface TreasuryOrigin {
  type: "tool" | "auto" | "unattributed";
  /**
   * Tool name, or an automatic caller such as "orchestrator.fund_child",
   * "health.fund_child", "heartbeat.check_usdc_balance", "startup.bootstrap".
   */
  name?: string;
  /** Input source of the turn that called the tool, when known. */
  inputSource?: InputSource | string;
}

/** EIP-3009 authorization fields, persisted before the payment is signed. */
export interface X402AuthorizationFields {
  nonce: `0x${string}`;
  /** Unix seconds. Must come from Treasury.x402ValidBefore(). */
  validBefore: number;
  from: string;
  network: string;
  asset: string;
}

/** What a primitive is about to spend, handed to Treasury.reserve(). */
export interface OutflowQuote {
  kind: OutflowKind;
  /** Integer > 0, already rounded up. For USDC kinds: centsFromAtomic(amountAtomic). */
  amountCents: number;
  amountBasis: AmountBasis;
  /** To-address, x402 payTo, "conway:sandbox" or the domain name. */
  counterparty: string;
  dedupeKey: string;
  /** Becomes transactions.description on commit. */
  description: string;
  /** credit_topup only; defaults to "manual". "survival" selects budget topup_auto. */
  topupPurpose?: TopupPurpose;
  /** credit_topup only: the address the credits are bought for. Must be selfAddress. */
  recipient?: string;
  /** x402_payment / credit_topup: the paid URL. */
  url?: string;
  /** x402_payment / credit_topup: the exact atomic USDC amount that will be signed. */
  amountAtomic?: bigint;
  /** x402_payment / credit_topup: required. */
  x402?: X402AuthorizationFields;
}

export interface Reservation {
  /** Ledger row id (ulid). */
  id: string;
  /** Equals id, or the original row's key for a credit transfer replay. */
  idempotencyKey: string;
  budget: BudgetId;
  amountCents: number;
  replayOf?: string;
}

export type Settlement =
  | {
      outcome: "committed";
      /** Server-reported amount. The committed amount is never below the reserved one. */
      amountCents?: number;
      externalRef?: string;
      balanceAfterCents?: number | null;
    }
  | { outcome: "released"; reason: string }
  | { outcome: "unknown"; reason: string };

export type SettlementOutcome = Settlement["outcome"];

/** Extra fields on x402Fetch / topupCredits results. */
export interface TreasuryResultFields {
  paidCents?: number;
  reservationId?: string;
  settlement?: "none" | "committed" | "released" | "unknown";
  denied?: { code: TreasuryDenyCode; message: string };
}

/** Second argument to a guard() classifier. */
export interface ClassifyInfo {
  /** True once markSent ran for the reservation. */
  sent: boolean;
}

export class TreasuryDeniedError extends Error {
  constructor(
    readonly code: TreasuryDenyCode,
    message: string,
    readonly budget?: BudgetId,
  ) {
    super(message);
    this.name = "TreasuryDeniedError";
  }
}

/** The server answered a transfer with a failed/rejected status. Nothing was counted. */
export class TransferRejectedError extends Error {
  constructor(readonly status: string) {
    super(`Transfer rejected (status ${status})`);
    this.name = "TransferRejectedError";
  }
}

/** The request was sent but no reliable answer came back. The row stays counted. */
export class OutcomeUnknownError extends Error {
  constructor(
    readonly reservationId: string,
    readonly idempotencyKey: string,
    cause: unknown,
  ) {
    super(
      `Outcome unknown (ledger ${reservationId}): ${describeCause(cause)}`,
      { cause },
    );
    this.name = "OutcomeUnknownError";
  }
}

/** No Treasury is installed, so nothing may be sent or signed. */
export class TreasuryNotInstalledError extends TreasuryDeniedError {
  constructor(message = "No treasury is installed; outflows are refused.") {
    super("TREASURY_NOT_INSTALLED", message);
    this.name = "TreasuryNotInstalledError";
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "no reliable response";
}
