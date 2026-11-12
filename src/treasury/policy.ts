/**
 * Treasury policy
 *
 * Normalizes the configured policy once, maps outflows to budgets and
 * limits, and holds the small pure helpers every guarded primitive shares
 * (unit conversion, dedupe keys, x402 host matching).
 */

import { createHash } from "node:crypto";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import type { TreasuryPolicy, ResolvedTreasuryPolicy } from "../types.js";
import type { BudgetId, OutflowKind, TopupPurpose } from "./types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("treasury.policy");

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Single cap of an automatic survival topup: the $5 tier. */
export const AUTO_TOPUP_SINGLE_CENTS = 500;

/** Longest validity a signed x402 authorization may have. */
export const X402_MAX_VALIDITY_SECONDS = 600;

/** Automatic callers that fund children; they share a sub-cap and a per-address cooldown. */
export const AUTO_FUND_ORIGINS: readonly string[] = Object.freeze([
  "orchestrator.fund_child",
  "health.fund_child",
]);

/** Share of the daily transfer cap automatic child funding may use. */
export const AUTO_FUND_DAILY_SHARE = 0.5;

/** Kinds that debit Conway credits (subject to the reserve floor). */
export const CREDIT_DEBITING_KINDS: readonly OutflowKind[] = Object.freeze([
  "credit_transfer",
  "sandbox_create",
  "domain_register",
]);

/** Kinds paid in USDC through x402. */
export const USDC_KINDS: readonly OutflowKind[] = Object.freeze([
  "x402_payment",
  "credit_topup",
]);

export interface BudgetLimits {
  single: number;
  hourly?: number;
  daily?: number;
}

const NUMERIC_KEYS = Object.keys(DEFAULT_TREASURY_POLICY).filter(
  (k) => k !== "x402AllowedDomains",
) as Array<Exclude<keyof typeof DEFAULT_TREASURY_POLICY, "x402AllowedDomains">>;

/**
 * Fill every missing or invalid field with its default. A numeric field that
 * is not a finite number >= 0 (whatever its type, so "5,000" too) falls back
 * to the default; a fractional value is floored. Each replacement produces a
 * warning.
 */
export function normalizeTreasuryPolicy(
  input?: Partial<TreasuryPolicy> | null | unknown,
  opts: { onWarning?: (message: string) => void } = {},
): ResolvedTreasuryPolicy {
  const warn = (message: string) => {
    logger.warn(message);
    opts.onWarning?.(message);
  };
  const src: Record<string, unknown> =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};

  for (const key of NUMERIC_KEYS) {
    const fallback = DEFAULT_TREASURY_POLICY[key];
    const value = src[key];
    if (value === undefined) {
      out[key] = fallback;
    } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      warn(`Invalid treasury value for ${key}: ${JSON.stringify(value)}; using ${fallback}`);
      out[key] = fallback;
    } else if (!Number.isInteger(value)) {
      warn(`Treasury value for ${key} is not an integer (${value}); using ${Math.floor(value)}`);
      out[key] = Math.floor(value);
    } else {
      out[key] = value;
    }
  }

  const domains = src.x402AllowedDomains;
  if (domains === undefined) {
    out.x402AllowedDomains = [...DEFAULT_TREASURY_POLICY.x402AllowedDomains];
  } else if (!Array.isArray(domains)) {
    warn(`Invalid treasury value for x402AllowedDomains; using the default list`);
    out.x402AllowedDomains = [...DEFAULT_TREASURY_POLICY.x402AllowedDomains];
  } else {
    const valid = domains.filter(
      (d): d is string => typeof d === "string" && d.trim() !== "",
    );
    if (valid.length !== domains.length) {
      warn(`Dropped ${domains.length - valid.length} invalid entries from x402AllowedDomains`);
    }
    out.x402AllowedDomains = valid.map((d) => d.trim().toLowerCase());
  }

  const payTo = src.topupPayTo;
  if (payTo !== undefined) {
    if (typeof payTo === "string" && /^0x[0-9a-fA-F]{40}$/.test(payTo)) {
      out.topupPayTo = payTo;
    } else {
      warn(`Invalid treasury value for topupPayTo; ignoring it`);
    }
  }

  return out as ResolvedTreasuryPolicy;
}

/** Budget an outflow draws on. */
export function budgetFor(kind: OutflowKind, topupPurpose?: TopupPurpose): BudgetId {
  switch (kind) {
    case "credit_transfer":
      return "transfer";
    case "x402_payment":
      return "x402";
    case "credit_topup":
      return topupPurpose === "survival" ? "topup_auto" : "topup";
    case "sandbox_create":
    case "domain_register":
      return "infra";
  }
}

/** Single, rolling-hour and rolling-day caps of a budget, in cents. */
export function budgetLimits(policy: ResolvedTreasuryPolicy, budget: BudgetId): BudgetLimits {
  switch (budget) {
    case "transfer":
      return {
        // No approval flow exists, so the confirmation threshold is a hard cap.
        single: Math.min(policy.maxSingleTransferCents, policy.requireConfirmationAboveCents),
        hourly: policy.maxHourlyTransferCents,
        daily: policy.maxDailyTransferCents,
      };
    case "x402":
      return {
        single: policy.maxX402PaymentCents,
        hourly: policy.maxX402PaymentCents * 10,
        daily: policy.maxX402PaymentCents * 50,
      };
    case "topup":
      return { single: policy.maxTopupSingleCents, daily: policy.maxTopupDailyCents };
    case "topup_auto":
      return { single: AUTO_TOPUP_SINGLE_CENTS, daily: policy.maxAutoTopupDailyCents };
    case "infra":
      return { single: policy.maxInfraSingleCents, daily: policy.maxInfraDailyCents };
  }
}

/** Cap on the share of the daily transfer budget automatic child funding may use. */
export function autoFundDailyCap(policy: ResolvedTreasuryPolicy): number {
  return Math.floor(policy.maxDailyTransferCents * AUTO_FUND_DAILY_SHARE);
}

/** USDC atomic units (6 decimals) to cents, rounded up so nothing signed is under-counted. */
export function centsFromAtomic(atomic: bigint): number {
  if (atomic <= 0n) return 0;
  return Number((atomic + 9_999n) / 10_000n);
}

/**
 * Per-year domain price in cents. No real domain costs under $1 a year, so an
 * integer below 100 or any fractional price is read as dollars.
 */
export function domainPerYearCents(price: number): number {
  if (Number.isSafeInteger(price) && price >= 100) return price;
  return Math.ceil(price * 100);
}

/**
 * Cents to reserve for a registration of `years`: the first year at the
 * registration price, every further year at the higher of registration and
 * renewal (registrars usually bill renewal from year two, and a promotional
 * first year is often far cheaper).
 */
export function domainRegistrationCents(
  registrationPrice: number,
  renewalPrice: number | undefined,
  years: number,
): number {
  const first = domainPerYearCents(registrationPrice);
  const renewal =
    typeof renewalPrice === "number" && Number.isFinite(renewalPrice) && renewalPrice > 0
      ? domainPerYearCents(renewalPrice)
      : first;
  return first + (years - 1) * Math.max(first, renewal);
}

/** True when the URL's host is an allowlisted domain or a subdomain of one. */
export function isX402HostAllowed(url: string, allowedDomains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

// ─── Dedupe keys ───────────────────────────────────────────────

export function transferDedupeKey(to: string, amountCents: number, originName?: string): string {
  return `credit_transfer|${to.toLowerCase()}|${amountCents}|${originName ?? ""}`;
}

/** Method, full URL and body hash, so one ambiguous call blocks only that exact call. */
export function x402DedupeKey(
  method: string,
  url: string,
  body: string | undefined,
  atomic: bigint,
): string {
  const bodyHash = createHash("sha256").update(body ?? "").digest("hex");
  return `x402|${method.toUpperCase()}|${url}|${bodyHash}|${atomic}`;
}

export function topupDedupeKey(purpose: TopupPurpose, amountUsd: number): string {
  return `topup|${purpose}|${amountUsd}`;
}

/** Callers pass the resolved values (defaults applied), never undefined. */
export function sandboxDedupeKey(
  name: string,
  vcpu: number,
  memoryMb: number,
  diskGb: number,
): string {
  return `sandbox_create|${name}|${vcpu}|${memoryMb}|${diskGb}`;
}

export function domainDedupeKey(domain: string, years: number): string {
  return `domain_register|${domain.toLowerCase()}|${years}`;
}
