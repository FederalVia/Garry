/**
 * Treasury: the single spending gate.
 *
 * Every outflow (credit transfer, x402 payment, credit topup, sandbox,
 * domain) goes reserve -> markSent -> settle:
 *
 *   reserve   async pre-phase (fresh balance read, x402 reconcile), then ONE
 *             synchronous BEGIN IMMEDIATE transaction that checks every limit
 *             against the ledger and inserts a 'reserved' (or 'denied') row.
 *             Concurrent callers are totally ordered by that transaction, so
 *             the second one sees the first one's row.
 *   markSent  'reserved' -> 'sent', immediately before the first byte leaves.
 *   settle    'committed' (writes transactions + spend_tracking mirror in the
 *             same SQLite transaction), 'released' (nothing moved) or
 *             'unknown' (sent, no reliable answer; stays counted).
 *
 * Windows are rolling and have no upper bound (created_at_ms > now - W), so a
 * backward clock step never hides recent rows.
 */

import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { CircuitOpenError } from "../conway/http-client.js";
import { isInboxSource } from "../agent/inbox-isolation.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { createLogger } from "../observability/logger.js";
import type { SpendCategory, SpendTrackerInterface, TransactionType } from "../types.js";
import {
  AUTO_FUND_ORIGINS,
  CREDIT_DEBITING_KINDS,
  DAY_MS,
  HOUR_MS,
  USDC_KINDS,
  X402_MAX_VALIDITY_SECONDS,
  autoFundDailyCap,
  budgetFor,
  budgetLimits,
  centsFromAtomic,
  isX402HostAllowed,
} from "./policy.js";
import {
  HELD_ATOMIC_SQL,
  HELD_CENTS_SQL,
  ensureTreasuryLedger,
  getLedgerRow,
  type LedgerRow,
} from "./ledger.js";
import { currentTreasuryOrigin, processBootId } from "./registry.js";
import {
  OutcomeUnknownError,
  TreasuryDeniedError,
  type AmountBasis,
  type BudgetId,
  type ClassifyInfo,
  type OutflowKind,
  type OutflowQuote,
  type Reservation,
  type ResolvedTreasuryPolicy,
  type Settlement,
  type TreasuryDenyCode,
  type TreasuryOrigin,
} from "./types.js";

const logger = createLogger("treasury");

/** Row ids sort in insertion order, even within one millisecond. */
const ulid = monotonicFactory();

/** Single-flight: an unknown topup stops blocking other topups after this. */
export const TOPUP_UNKNOWN_BLOCK_MS = 15 * 60_000;
/** Ambiguity window for replays and AMBIGUOUS_PENDING / PAYMENT_UNCONFIRMED. */
export const AMBIGUITY_WINDOW_MS = DAY_MS;
/** Most charged replays of one ambiguous credit transfer. */
export const MAX_TRANSFER_REPLAYS = 2;
/** Identical denials within this window collapse into one row. */
export const DENY_COLLAPSE_MS = 60_000;
/** Denied and released rows older than this are pruned. */
export const PRUNE_AFTER_MS = 30 * DAY_MS;
/** A reserved/sent row from another boot older than this belongs to a dead process. */
export const STALE_OPEN_ROW_MS = HOUR_MS;
/** Grace after validBefore before an unused authorization is released. */
export const X402_RELEASE_GRACE_SECONDS = 60;

const KNOWN_KINDS: readonly OutflowKind[] = [
  "credit_transfer",
  "x402_payment",
  "credit_topup",
  "sandbox_create",
  "domain_register",
];
const KNOWN_BASES: readonly AmountBasis[] = ["exact", "quote", "estimate", "ceiling"];
const USDC_BUDGETS: readonly BudgetId[] = ["x402", "topup", "topup_auto"];
const COUNTED_SQL = `status IN ('reserved','sent','unknown','committed')`;

export interface TreasuryDeps {
  /** The raw better-sqlite3 handle (db.raw). */
  db: Database.Database;
  /** From normalizeTreasuryPolicy(). */
  policy: ResolvedTreasuryPolicy;
  selfAddress: string;
  /** Fresh credit balance read in cents. May throw. Never a cached value. */
  readCreditBalance: () => Promise<number>;
  /**
   * EIP-3009 authorizationState. true: used. { used: false, blockTimestamp }:
   * unused as of that block (unix seconds). null: unknown (RPC error). A bare
   * false carries no block time, so it never releases a row.
   */
  readAuthorizationState?: (a: {
    network: string;
    asset: string;
    from: string;
    nonce: string;
  }) => Promise<AuthorizationStateRead>;
  /** Commit-time mirror. Default: new SpendTracker(db). */
  spendTracker?: SpendTrackerInterface;
  now?: () => number;
  /** Conway API base URL; x402 fetches to its /pay/ endpoints are refused (topups only). */
  conwayApiUrl?: string;
  /** Overrides the per-process boot id (tests that simulate another process). */
  bootId?: string;
  /** Rows of other boots created before this are recovered. Default: now() at construction. */
  processStartMs?: number;
}

/** What an authorizationState read can say; see TreasuryDeps.readAuthorizationState. */
export type AuthorizationStateRead = boolean | null | { used: boolean; blockTimestamp: number };

/** Result of reserve's async pre-phase, handed to the synchronous commit phase. */
export interface ReservePrep {
  /** Fresh balance in cents, or null when not read or unreadable. */
  balanceCents: number | null;
  /** When the balance read started (t0), or null when no read was made. */
  balanceReadStartedMs: number | null;
}

export type ReserveOutcome =
  | { reservation: Reservation; denied?: undefined }
  | {
      reservation?: undefined;
      denied: { code: TreasuryDenyCode; message: string; budget?: BudgetId };
    };

interface Pass {
  replayOf?: string;
  idempotencyKey?: string;
}
interface Fail {
  code: TreasuryDenyCode;
  message: string;
}
type Verdict = { ok: true; pass: Pass } | { ok: false; fail: Fail };

const ok = (pass: Pass = {}): Verdict => ({ ok: true, pass });
const no = (code: TreasuryDenyCode, message: string): Verdict => ({ ok: false, fail: { code, message } });

/**
 * Classify an error thrown by a value-moving request. 'released' only when
 * nothing can have reached the server; everything else is 'unknown'.
 */
export function classifySendError(err: unknown, info: ClassifyInfo = { sent: true }): "released" | "unknown" {
  if (!info.sent) return "released";
  if (err instanceof TreasuryDeniedError) return "released";
  if (err instanceof CircuitOpenError || (err as { name?: unknown })?.name === "CircuitOpenError") {
    return "released";
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (message.startsWith("Invalid URL") || message.startsWith("HTTPS required")) return "released";
  const code =
    (err as { cause?: { code?: unknown } })?.cause?.code ?? (err as { code?: unknown })?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return "released";
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status <= 499) {
    return [408, 409, 425, 429].includes(status) ? "unknown" : "released";
  }
  return "unknown";
}

export class Treasury {
  readonly policy: ResolvedTreasuryPolicy;
  readonly bootId: string;
  private readonly db: Database.Database;
  private readonly deps: TreasuryDeps;
  private readonly now: () => number;
  private readonly spendTracker: SpendTrackerInterface;
  private readonly processStartMs: number;
  private readonly conwayHost: string | null;
  private lastPruneMs: number;

  constructor(deps: TreasuryDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.policy = deps.policy;
    this.now = deps.now ?? Date.now;
    this.bootId = deps.bootId ?? processBootId();
    this.spendTracker = deps.spendTracker ?? new SpendTracker(deps.db);
    this.conwayHost = hostOf(deps.conwayApiUrl);
    const now = this.now();
    this.processStartMs = deps.processStartMs ?? now;
    const ensured = ensureTreasuryLedger(this.db, now);
    if (ensured.legacyCopied > 0) {
      logger.info(`Copied ${ensured.legacyCopied} legacy spend rows into the treasury ledger`);
    }
    const recovered = this.recover();
    if (recovered.released || recovered.unknown) {
      logger.warn("Recovered open treasury rows from an earlier process", recovered);
    }
    this.prune();
    this.lastPruneMs = now;
  }

  // ─── reserve ────────────────────────────────────────────────

  /**
   * Async pre-phase (balance read for credit-debiting kinds and survival
   * topups; x402 reconcile of the same dedupe key), then one synchronous
   * immediate transaction that checks every limit and inserts the row.
   * Throws TreasuryDeniedError on denial (a 'denied' row is written).
   */
  async reserve(quote: OutflowQuote): Promise<Reservation> {
    const origin = currentTreasuryOrigin();
    const prep: ReservePrep = { balanceCents: null, balanceReadStartedMs: null };

    const plausible =
      Number.isSafeInteger(quote.amountCents) &&
      quote.amountCents > 0 &&
      !isInboxSource(origin.inputSource);
    const needsBalance =
      CREDIT_DEBITING_KINDS.includes(quote.kind) ||
      (quote.kind === "credit_topup" && quote.topupPurpose === "survival");
    if (plausible && needsBalance) {
      prep.balanceReadStartedMs = this.now();
      try {
        const b = await this.deps.readCreditBalance();
        if (typeof b === "number" && Number.isFinite(b)) {
          prep.balanceCents = Math.floor(b);
        } else {
          logger.warn("Credit balance read returned a non-number", { value: String(b) });
        }
      } catch (err) {
        logger.warn("Credit balance read failed", { error: errMessage(err) });
      }
    }

    if (plausible && USDC_KINDS.includes(quote.kind) && typeof quote.dedupeKey === "string") {
      try {
        await this.reconcileX402({ dedupeKey: quote.dedupeKey });
      } catch (err) {
        logger.warn("x402 reconcile before reserve failed", { error: errMessage(err) });
      }
    }

    this.maybePrune();
    const outcome = this.reserveSync(quote, origin, prep);
    if (outcome.denied) {
      throw new TreasuryDeniedError(outcome.denied.code, outcome.denied.message, outcome.denied.budget);
    }
    return outcome.reservation;
  }

  /**
   * The commit phase. Synchronous by design: it must never return a Promise,
   * or concurrent callers could interleave between check and insert.
   * @internal exposed for tests.
   */
  reserveSync(quote: OutflowQuote, origin: TreasuryOrigin, prep: ReservePrep): ReserveOutcome {
    return this.db
      .transaction((): ReserveOutcome => this.decideAndInsert(quote, origin, prep))
      .immediate();
  }

  private decideAndInsert(quote: OutflowQuote, origin: TreasuryOrigin, prep: ReservePrep): ReserveOutcome {
    const now = this.now();
    if (!quote || !KNOWN_KINDS.includes(quote.kind)) {
      return { denied: { code: "INVALID_QUOTE", message: `Unknown outflow kind: ${String(quote?.kind)}` } };
    }
    const budget = budgetFor(quote.kind, quote.topupPurpose);
    const verdict = this.evaluate(quote, origin, prep, budget, now);
    if (!verdict.ok) {
      this.insertDenied(quote, origin, prep, budget, verdict.fail, now);
      return { denied: { ...verdict.fail, budget } };
    }

    const id = ulid();
    const idempotencyKey = verdict.pass.idempotencyKey ?? id;
    const x = quote.x402;
    this.db
      .prepare(
        `INSERT INTO treasury_ledger (id, idempotency_key, replay_of, kind, budget, status, amount_cents,
           amount_atomic, amount_basis, debits_credits, counterparty, dedupe_key, origin_type, origin_name,
           input_source, boot_id, topup_purpose, url, description, x402_nonce, x402_valid_before, x402_from,
           x402_network, x402_asset, balance_observed_cents, balance_read_started_ms, balance_unknown,
           created_at_ms, updated_at_ms)
         VALUES (@id, @idempotencyKey, @replayOf, @kind, @budget, 'reserved', @amount, @atomic, @basis,
           @debits, @counterparty, @dedupeKey, @originType, @originName, @inputSource, @bootId,
           @topupPurpose, @url, @description, @nonce, @validBefore, @from, @network, @asset,
           @balance, @balanceStarted, @balanceUnknown, @now, @now)`,
      )
      .run({
        id,
        idempotencyKey,
        replayOf: verdict.pass.replayOf ?? null,
        kind: quote.kind,
        budget,
        amount: quote.amountCents,
        atomic: quote.amountAtomic ?? null,
        basis: quote.amountBasis ?? "exact",
        debits: CREDIT_DEBITING_KINDS.includes(quote.kind) ? 1 : 0,
        counterparty: quote.counterparty,
        dedupeKey: quote.dedupeKey,
        originType: origin.type,
        originName: origin.name ?? null,
        inputSource: origin.inputSource ?? null,
        bootId: this.bootId,
        topupPurpose: quote.kind === "credit_topup" ? (quote.topupPurpose ?? "manual") : null,
        url: quote.url ?? null,
        description: quote.description ?? "",
        nonce: x?.nonce ?? null,
        validBefore: x?.validBefore ?? null,
        from: x?.from ?? null,
        network: x?.network ?? null,
        asset: x?.asset ?? null,
        balance: prep.balanceCents,
        balanceStarted: prep.balanceReadStartedMs,
        balanceUnknown: prep.balanceReadStartedMs !== null && prep.balanceCents === null ? 1 : 0,
        now,
      });

    const reservation: Reservation = { id, idempotencyKey, budget, amountCents: quote.amountCents };
    if (verdict.pass.replayOf) reservation.replayOf = verdict.pass.replayOf;
    return { reservation };
  }

  /** Every invariant, in a fixed order; the first failure wins. */
  private evaluate(
    quote: OutflowQuote,
    origin: TreasuryOrigin,
    prep: ReservePrep,
    budget: BudgetId,
    now: number,
  ): Verdict {
    const policy = this.policy;
    const kind = quote.kind;
    const amount = quote.amountCents;
    const isUsdc = USDC_KINDS.includes(kind);
    const debits = CREDIT_DEBITING_KINDS.includes(kind);
    const nowSec = Math.floor(now / 1000);

    // Shape of the quote.
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return no("INVALID_AMOUNT", `Amount must be a positive whole number of cents (got ${String(amount)})`);
    }
    if (typeof quote.counterparty !== "string" || quote.counterparty.trim() === "") {
      return no("INVALID_QUOTE", "Outflow has no counterparty");
    }
    if (typeof quote.dedupeKey !== "string" || quote.dedupeKey === "") {
      return no("INVALID_QUOTE", "Outflow has no dedupe key");
    }
    if (quote.amountBasis !== undefined && !KNOWN_BASES.includes(quote.amountBasis)) {
      return no("INVALID_QUOTE", `Unknown amount basis: ${String(quote.amountBasis)}`);
    }
    if (isUsdc) {
      const atomic = quote.amountAtomic;
      if (
        typeof atomic !== "bigint" ||
        atomic <= 0n ||
        atomic > BigInt(Number.MAX_SAFE_INTEGER) ||
        centsFromAtomic(atomic) !== amount
      ) {
        return no("INVALID_AMOUNT", "USDC outflows need amountAtomic > 0 with amountCents = ceil(atomic / 10000)");
      }
      const x = quote.x402;
      if (
        !x ||
        typeof x.nonce !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(x.nonce) ||
        !Number.isSafeInteger(x.validBefore) ||
        typeof x.from !== "string" ||
        typeof x.network !== "string" ||
        typeof x.asset !== "string" ||
        typeof quote.url !== "string"
      ) {
        return no("INVALID_QUOTE", "USDC outflows need the url and the x402 authorization fields");
      }
      if (x.validBefore <= nowSec) {
        return no("INVALID_QUOTE", "x402 validBefore is already in the past");
      }
      if (x.validBefore > nowSec + X402_MAX_VALIDITY_SECONDS) {
        return no(
          "X402_DEADLINE_TOO_LONG",
          `x402 authorizations may be valid for at most ${X402_MAX_VALIDITY_SECONDS}s`,
        );
      }
    }

    // I9: untrusted source. Must stay in step with the inbox isolation rules.
    if (isInboxSource(origin.inputSource)) {
      return no("UNTRUSTED_SOURCE", `Outflows are refused for input source "${origin.inputSource}"`);
    }
    if (budget === "topup_auto" && origin.type === "tool") {
      return no("ORIGIN_NOT_ALLOWED", "Survival topups cannot be started by a tool call");
    }

    // Kind-specific counterparty rules.
    if (kind === "credit_transfer" && sameAddress(quote.counterparty, this.deps.selfAddress)) {
      return no("SELF_TRANSFER", "Credit transfers to this automaton's own address are refused");
    }
    if (kind === "x402_payment") {
      if (!isX402HostAllowed(quote.url!, policy.x402AllowedDomains)) {
        return no(
          "X402_DOMAIN_NOT_ALLOWED",
          `Host of ${quote.url} is not in the x402 allowlist [${policy.x402AllowedDomains.join(", ")}]`,
        );
      }
      if (this.isConwayPayUrl(quote.url!)) {
        return no("X402_DOMAIN_NOT_ALLOWED", "Credit purchases must go through topup, not x402 fetch");
      }
    }
    if (kind === "credit_topup") {
      if (typeof quote.recipient !== "string" || !sameAddress(quote.recipient, this.deps.selfAddress)) {
        return no("TOPUP_RECIPIENT_NOT_SELF", "Credit topups may only buy credits for this automaton");
      }
      // Survival buys ($5, capped per day) skip the trust-on-first-use pin, so
      // a payTo rotation cannot starve the agent; an operator pin still binds.
      const pinned = this.policy.topupPayTo;
      const trusted = pinned ?? (quote.topupPurpose === "survival" ? undefined : this.trustedTopupPayTo());
      if (trusted && !sameAddress(trusted, quote.counterparty)) {
        logger.error(`Topup payTo ${quote.counterparty} differs from the trusted ${trusted}`);
        return no(
          "X402_PAYTO_NOT_TRUSTED",
          `Topup payTo ${quote.counterparty} does not match ${trusted}` +
            (pinned ? "" : "; set treasuryPolicy.topupPayTo to accept a new address"),
        );
      }
    }

    // Ambiguous earlier attempts with the same dedupe key.
    let pass: Pass = {};
    if (kind === "credit_transfer") {
      const replay = this.replayTarget(quote.dedupeKey, now);
      if (replay) {
        if (replay.replays >= MAX_TRANSFER_REPLAYS) {
          return no(
            "AMBIGUOUS_PENDING",
            `An identical transfer (ledger ${replay.id}) has an unknown outcome and was already retried ${replay.replays} times`,
          );
        }
        pass = { replayOf: replay.id, idempotencyKey: replay.idempotencyKey };
      }
    } else if (kind === "sandbox_create" || kind === "domain_register") {
      const pending = this.db
        .prepare(
          `SELECT id FROM treasury_ledger WHERE dedupe_key = ? AND status = 'unknown' AND created_at_ms > ? LIMIT 1`,
        )
        .get(quote.dedupeKey, now - AMBIGUITY_WINDOW_MS) as { id: string } | undefined;
      if (pending) {
        return no("AMBIGUOUS_PENDING", `An identical request (ledger ${pending.id}) has an unknown outcome`);
      }
    } else {
      const pending = this.db
        .prepare(
          `SELECT id, x402_valid_before FROM treasury_ledger
           WHERE dedupe_key = ? AND status = 'unknown' AND created_at_ms > ?
             AND (x402_valid_before IS NULL OR ? <= x402_valid_before + ?)
           LIMIT 1`,
        )
        .get(quote.dedupeKey, now - AMBIGUITY_WINDOW_MS, nowSec, X402_RELEASE_GRACE_SECONDS) as
        | { id: string; x402_valid_before: number | null }
        | undefined;
      if (pending) {
        return no(
          "PAYMENT_UNCONFIRMED",
          `An identical payment (ledger ${pending.id}) is unconfirmed; retry after its authorization expires`,
        );
      }
      if (kind === "credit_topup") {
        const settled = this.ambiguousTopupSettled(quote.dedupeKey, now);
        if (settled) {
          return no(
            "TOPUP_ALREADY_SETTLED",
            `An identical topup (ledger ${settled}) whose outcome was unknown was confirmed on chain; it counts as done. Check the credit balance before buying again.`,
          );
        }
      }
    }

    // Survival topups: only when actually needed.
    if (budget === "topup_auto") {
      if (prep.balanceCents === null) {
        const blind = this.scalar(
          `SELECT COUNT(*) FROM treasury_ledger WHERE budget = 'topup_auto' AND balance_unknown = 1
             AND ${COUNTED_SQL} AND created_at_ms > ?`,
          now - DAY_MS,
        );
        if (blind > 0) {
          return no("BALANCE_UNKNOWN_LIMIT", "Balance unreadable and the one blind topup per 24h is used");
        }
      } else if (prep.balanceCents >= policy.survivalTopupThresholdCents) {
        return no(
          "TOPUP_NOT_NEEDED",
          `Balance ${prep.balanceCents}c is not below the survival threshold ${policy.survivalTopupThresholdCents}c`,
        );
      }
    }

    // I7: single-flight topups.
    if (kind === "credit_topup") {
      const inflight = this.db
        .prepare(
          `SELECT id FROM treasury_ledger WHERE budget IN ('topup','topup_auto')
             AND (status IN ('reserved','sent') OR (status = 'unknown' AND created_at_ms > ?)) LIMIT 1`,
        )
        .get(now - TOPUP_UNKNOWN_BLOCK_MS) as { id: string } | undefined;
      if (inflight) return no("TOPUP_IN_FLIGHT", `Another topup (ledger ${inflight.id}) is in flight`);
    }

    // I5: cooldowns.
    if (budget === "topup_auto" && policy.autoTopupCooldownMs > 0) {
      const recent = this.scalar(
        `SELECT COUNT(*) FROM treasury_ledger WHERE budget = 'topup_auto' AND status != 'denied' AND created_at_ms > ?`,
        now - policy.autoTopupCooldownMs,
      );
      if (recent > 0) return no("TOPUP_COOLDOWN", "A survival topup was attempted too recently");
    }
    if (budget === "transfer") {
      if (policy.transferCooldownMs > 0) {
        const recent = this.scalar(
          `SELECT COUNT(*) FROM treasury_ledger WHERE budget = 'transfer' AND ${COUNTED_SQL} AND created_at_ms > ?`,
          now - policy.transferCooldownMs,
        );
        if (recent > 0) {
          return no("TRANSFER_COOLDOWN", `Transfers are limited to one per ${policy.transferCooldownMs}ms`);
        }
      }
      if (isAutoFundOrigin(origin) && policy.autoFundCounterpartyCooldownMs > 0) {
        const recent = this.scalar(
          `SELECT COUNT(*) FROM treasury_ledger WHERE budget = 'transfer' AND ${COUNTED_SQL}
             AND lower(counterparty) = lower(?) AND created_at_ms > ?`,
          quote.counterparty,
          now - policy.autoFundCounterpartyCooldownMs,
        );
        if (recent > 0) {
          return no("TRANSFER_COOLDOWN", `${quote.counterparty} was funded too recently`);
        }
      }
    }

    // I2 single cap, I1 rolling window caps.
    const limits = budgetLimits(policy, budget);
    if (amount > limits.single) {
      return no("SPEND_LIMIT_EXCEEDED", `${amount}c exceeds the ${budget} single limit of ${limits.single}c`);
    }
    const windows: Array<[string, number, number | undefined]> = [
      ["hourly", HOUR_MS, limits.hourly],
      ["daily", DAY_MS, limits.daily],
    ];
    for (const [label, windowMs, cap] of windows) {
      if (cap === undefined) continue;
      if (USDC_BUDGETS.includes(budget)) {
        const used = this.usageAtomic(budget, now - windowMs);
        if (used + Number(quote.amountAtomic) > cap * 10_000) {
          return no(
            "SPEND_LIMIT_EXCEEDED",
            `${budget} ${label} cap: ${Math.ceil(used / 10_000)}c used + ${amount}c > ${cap}c`,
          );
        }
      } else {
        const used = this.usageCents(budget, now - windowMs);
        if (used + amount > cap) {
          return no("SPEND_LIMIT_EXCEEDED", `${budget} ${label} cap: ${used}c used + ${amount}c > ${cap}c`);
        }
      }
    }
    if (budget === "transfer" && isAutoFundOrigin(origin)) {
      const cap = autoFundDailyCap(policy);
      const used = this.scalar(
        `SELECT COALESCE(SUM(${HELD_CENTS_SQL}), 0) FROM treasury_ledger WHERE budget = 'transfer'
           AND ${COUNTED_SQL} AND origin_name IN (${AUTO_FUND_ORIGINS.map(() => "?").join(",")})
           AND created_at_ms > ?`,
        ...AUTO_FUND_ORIGINS,
        now - DAY_MS,
      );
      if (used + amount > cap) {
        return no("SPEND_LIMIT_EXCEEDED", `Automatic child funding daily cap: ${used}c used + ${amount}c > ${cap}c`);
      }
    }

    // I3 reserve floor, I4 half balance.
    if (debits) {
      if (prep.balanceCents === null || prep.balanceReadStartedMs === null) {
        return no("BALANCE_UNAVAILABLE", "The credit balance could not be read, so the reserve cannot be checked");
      }
      const available = prep.balanceCents - this.inflightDebits(prep.balanceReadStartedMs, now);
      if (available - amount < policy.minimumReserveCents) {
        return no(
          "RESERVE_VIOLATION",
          `${amount}c would leave ${available - amount}c, below the ${policy.minimumReserveCents}c reserve`,
        );
      }
      if (budget === "transfer" && amount > Math.floor(available / 2)) {
        return no("HALF_BALANCE", `${amount}c exceeds half of the available ${available}c`);
      }
    }

    return ok(pass);
  }

  /**
   * Credit debits that may not yet show in a balance read started at t0:
   * open rows, unknown rows (they may still land), and rows that settled
   * shortly before or after t0. Double counting errs toward denying.
   */
  private inflightDebits(t0: number, now: number): number {
    return this.scalar(
      `SELECT COALESCE(SUM(${HELD_CENTS_SQL}), 0) FROM treasury_ledger WHERE debits_credits = 1 AND (
         status IN ('reserved','sent')
         OR (status = 'unknown' AND created_at_ms > ?)
         OR (status IN ('unknown','committed') AND settled_at_ms >= ?))`,
      now - this.policy.unknownInflightMs,
      t0 - this.policy.balanceLagMs,
    );
  }

  /**
   * The ambiguous transfer a new identical request would replay: the newest
   * unknown original within 24h that no replay has committed.
   */
  private replayTarget(
    dedupeKey: string,
    now: number,
  ): { id: string; idempotencyKey: string; replays: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT o.id, o.idempotency_key,
           (SELECT COUNT(*) FROM treasury_ledger r WHERE r.replay_of = o.id AND r.status != 'denied') AS replays
         FROM treasury_ledger o
         WHERE o.kind = 'credit_transfer' AND o.dedupe_key = ? AND o.status = 'unknown'
           AND o.replay_of IS NULL AND o.created_at_ms > ?
           AND NOT EXISTS (SELECT 1 FROM treasury_ledger c WHERE c.replay_of = o.id AND c.status = 'committed')
         ORDER BY o.created_at_ms DESC, o.id DESC LIMIT 1`,
      )
      .get(dedupeKey, now - AMBIGUITY_WINDOW_MS) as
      | { id: string; idempotency_key: string; replays: number }
      | undefined;
    return row ? { id: row.id, idempotencyKey: row.idempotency_key, replays: row.replays } : undefined;
  }

  private trustedTopupPayTo(): string | undefined {
    if (this.policy.topupPayTo) return this.policy.topupPayTo;
    const row = this.db
      .prepare(
        `SELECT counterparty FROM treasury_ledger WHERE kind = 'credit_topup' AND status = 'committed'
           AND COALESCE(topup_purpose, 'manual') != 'survival'
         ORDER BY settled_at_ms DESC, id DESC LIMIT 1`,
      )
      .get() as { counterparty: string } | undefined;
    return row?.counterparty;
  }

  /**
   * A Conway credit purchase URL (/pay/...) on the Conway API host or a
   * sibling host. The path is normalized the way common servers do before
   * comparing: percent-decoded, slashes collapsed, dot segments resolved,
   * ;params dropped, lowercased.
   */
  private isConwayPayUrl(url: string): boolean {
    if (!this.conwayHost) return false;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    // api.conway.tech -> conway.tech, so sibling Conway hosts are covered too.
    const parent =
      this.conwayHost.split(".").length > 2
        ? this.conwayHost.slice(this.conwayHost.indexOf(".") + 1)
        : this.conwayHost;
    if (host !== this.conwayHost && host !== parent && !host.endsWith(`.${parent}`)) return false;
    const path = normalizedPath(u.pathname);
    return path === "/pay" || path.startsWith("/pay/");
  }

  /**
   * A credit_topup with this dedupe key whose outcome was unknown and that
   * was since confirmed on chain, not yet reported to a caller by a
   * TOPUP_ALREADY_SETTLED denial. Rows that went through 'unknown' keep the
   * reason set there; a direct commit has none.
   */
  private ambiguousTopupSettled(dedupeKey: string, now: number): string | undefined {
    const row = this.db
      .prepare(
        `SELECT c.id FROM treasury_ledger c
         WHERE c.kind = 'credit_topup' AND c.dedupe_key = ? AND c.status = 'committed'
           AND c.reason IS NOT NULL AND c.created_at_ms > ?
           AND NOT EXISTS (SELECT 1 FROM treasury_ledger d WHERE d.dedupe_key = c.dedupe_key
             AND d.status = 'denied' AND d.deny_code = 'TOPUP_ALREADY_SETTLED' AND d.updated_at_ms >= c.settled_at_ms)
         ORDER BY c.settled_at_ms DESC LIMIT 1`,
      )
      .get(dedupeKey, now - AMBIGUITY_WINDOW_MS) as { id: string } | undefined;
    return row?.id;
  }

  private insertDenied(
    quote: OutflowQuote,
    origin: TreasuryOrigin,
    prep: ReservePrep,
    budget: BudgetId,
    fail: Fail,
    now: number,
  ): void {
    const dedupeKey = typeof quote.dedupeKey === "string" ? quote.dedupeKey : "";
    const existing = this.db
      .prepare(
        `SELECT id FROM treasury_ledger WHERE status = 'denied' AND dedupe_key = ? AND deny_code = ?
           AND budget = ? AND created_at_ms > ? ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .get(dedupeKey, fail.code, budget, now - DENY_COLLAPSE_MS) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE treasury_ledger SET deny_count = deny_count + 1, reason = ?, updated_at_ms = ? WHERE id = ?`,
        )
        .run(fail.message, now, existing.id);
      return;
    }
    const amount = Number.isSafeInteger(quote.amountCents) && quote.amountCents > 0 ? quote.amountCents : 0;
    const atomic =
      typeof quote.amountAtomic === "bigint" &&
      quote.amountAtomic > 0n &&
      quote.amountAtomic <= BigInt(Number.MAX_SAFE_INTEGER)
        ? quote.amountAtomic
        : null;
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents, amount_atomic,
           amount_basis, debits_credits, counterparty, dedupe_key, origin_type, origin_name, input_source,
           boot_id, topup_purpose, url, description, deny_code, reason, balance_observed_cents,
           balance_read_started_ms, balance_unknown, created_at_ms, settled_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 'denied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        id,
        quote.kind,
        budget,
        amount,
        atomic,
        KNOWN_BASES.includes(quote.amountBasis) ? quote.amountBasis : "exact",
        CREDIT_DEBITING_KINDS.includes(quote.kind) ? 1 : 0,
        typeof quote.counterparty === "string" ? quote.counterparty : "",
        dedupeKey,
        origin.type,
        origin.name ?? null,
        origin.inputSource ?? null,
        this.bootId,
        quote.kind === "credit_topup" ? (quote.topupPurpose ?? "manual") : null,
        typeof quote.url === "string" ? quote.url : null,
        typeof quote.description === "string" ? quote.description : "",
        fail.code,
        fail.message,
        prep.balanceCents,
        prep.balanceReadStartedMs,
        prep.balanceReadStartedMs !== null && prep.balanceCents === null ? 1 : 0,
        now,
        now,
        now,
      );
  }

  // ─── markSent / settle ──────────────────────────────────────

  /** 'reserved' -> 'sent'. Call synchronously right before the first byte is sent. Single use. */
  markSent(r: Reservation): void {
    const now = this.now();
    const info = this.db
      .prepare(
        `UPDATE treasury_ledger SET status = 'sent', sent_at_ms = ?, updated_at_ms = ? WHERE id = ? AND status = 'reserved'`,
      )
      .run(now, now, r.id);
    if (info.changes !== 1) {
      const row = getLedgerRow(this.db, r.id);
      throw new Error(
        `Treasury reservation ${r.id} cannot be sent (status ${row?.status ?? "missing"})`,
      );
    }
  }

  /**
   * Record the outcome. Allowed transitions: reserved -> released;
   * sent -> committed | released | unknown; unknown -> committed | released.
   * Anything else is a no-op. Returns true when the row changed.
   * A commit writes the transactions row and the spend mirror in the same
   * SQLite transaction; the committed amount is never below the reserved one.
   */
  settle(r: Reservation, s: Settlement): boolean {
    return this.db.transaction((): boolean => this.settleInTx(r.id, s)).immediate();
  }

  private settleInTx(id: string, s: Settlement): boolean {
    const now = this.now();
    const row = getLedgerRow(this.db, id);
    if (!row) {
      logger.error(`Treasury settle: no ledger row ${id}`);
      return false;
    }

    if (s.outcome === "released") {
      const info = this.db
        .prepare(
          `UPDATE treasury_ledger SET status = 'released', reason = ?, settled_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status IN ('reserved','sent','unknown')`,
        )
        .run(s.reason, now, now, id);
      return info.changes === 1;
    }

    if (s.outcome === "unknown") {
      const info = this.db
        .prepare(
          `UPDATE treasury_ledger SET status = 'unknown', reason = ?, settled_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'sent'`,
        )
        .run(s.reason, now, now, id);
      if (info.changes !== 1 && row.status !== "unknown") {
        logger.warn(`Treasury settle: cannot mark ${id} unknown from ${row.status}`);
      }
      return info.changes === 1;
    }

    // committed
    let committed = row.amount_cents;
    if (s.amountCents !== undefined && s.amountCents !== null) {
      if (Number.isSafeInteger(s.amountCents) && s.amountCents >= 0) {
        if (s.amountCents !== row.amount_cents) {
          logger.error(
            `Treasury: reported amount ${s.amountCents}c differs from reserved ${row.amount_cents}c (ledger ${id}); counting the larger`,
          );
        }
        committed = Math.max(row.amount_cents, s.amountCents);
      } else {
        logger.error(`Treasury: reported amount ${String(s.amountCents)} is not whole cents (ledger ${id})`);
      }
    }
    const info = this.db
      .prepare(
        `UPDATE treasury_ledger SET status = 'committed', committed_cents = ?, external_ref = ?,
           settled_at_ms = ?, updated_at_ms = ? WHERE id = ? AND status IN ('sent','unknown')`,
      )
      .run(committed, s.externalRef ?? null, now, now, id);
    if (info.changes !== 1) {
      if (row.status !== "committed") {
        logger.warn(`Treasury settle: cannot commit ${id} from ${row.status}`);
      }
      return false;
    }

    const balanceAfter =
      row.debits_credits === 1 &&
      typeof s.balanceAfterCents === "number" &&
      Number.isSafeInteger(s.balanceAfterCents)
        ? s.balanceAfterCents
        : null;
    this.db
      .prepare(
        `INSERT INTO transactions (id, type, amount_cents, balance_after_cents, description) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ulid(), transactionTypeFor(row.kind), committed, balanceAfter, row.description ?? "");

    // The mirror is best effort: a failure must not undo the commit.
    try {
      this.db.transaction(() => {
        this.spendTracker.recordSpend({
          toolName: row.origin_name ?? row.kind,
          amountCents: committed,
          category: mirrorCategory(row.budget),
          recipient: row.budget === "transfer" ? row.counterparty : undefined,
          domain: row.budget === "x402" ? (hostOf(row.url) ?? undefined) : undefined,
        });
      })();
    } catch (err) {
      logger.error(`Treasury: spend mirror write failed for ledger ${id}`, asError(err));
    }
    return true;
  }

  // ─── guard ──────────────────────────────────────────────────

  /**
   * reserve -> exec -> classify -> settle. exec must call markSent(r)
   * synchronously before sending. If exec throws before markSent, the row is
   * released and the error rethrown. An 'unknown' settlement throws
   * OutcomeUnknownError; otherwise exec's error is rethrown or its value
   * returned.
   */
  async guard<T>(
    quote: OutflowQuote,
    exec: (r: Reservation) => Promise<T>,
    classify: (o: { value: T } | { error: unknown }, info: ClassifyInfo) => Settlement,
  ): Promise<T> {
    const r = await this.reserve(quote);
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await exec(r) };
    } catch (error) {
      outcome = { error };
    }

    if (this.statusOf(r.id) === "reserved") {
      if ("error" in outcome) {
        this.settle(r, { outcome: "released", reason: `failed before send: ${errMessage(outcome.error)}` });
        throw outcome.error;
      }
      // The primitive returned without marking the row sent. Value may have
      // moved, so account for it as sent rather than release it.
      logger.error(`Treasury: outflow for ledger ${r.id} returned without markSent`);
      this.markSent(r);
    }

    let settlement: Settlement;
    try {
      settlement = classify(outcome, { sent: true });
    } catch (err) {
      settlement = { outcome: "unknown", reason: `classifier failed: ${errMessage(err)}` };
    }
    this.settle(r, settlement);

    if (settlement.outcome === "unknown") {
      throw new OutcomeUnknownError(
        r.id,
        r.idempotencyKey,
        "error" in outcome ? outcome.error : settlement.reason,
      );
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  // ─── reconcile / recover / prune ────────────────────────────

  /**
   * Resolve unknown x402/topup rows on chain: authorization used -> committed;
   * unused and past validBefore + 60s -> released; RPC error -> unchanged.
   * Returns the number of rows changed.
   */
  async reconcileX402(opts: { dedupeKey?: string; limit?: number } = {}): Promise<number> {
    const read = this.deps.readAuthorizationState;
    if (!read) return 0;
    const params: unknown[] = [];
    let sql = `SELECT * FROM treasury_ledger WHERE status = 'unknown' AND kind IN ('x402_payment','credit_topup')
      AND x402_nonce IS NOT NULL`;
    if (opts.dedupeKey !== undefined) {
      sql += " AND dedupe_key = ?";
      params.push(opts.dedupeKey);
    }
    sql += " ORDER BY created_at_ms LIMIT ?";
    params.push(opts.limit ?? 20);
    const rows = this.db.prepare(sql).all(...params) as LedgerRow[];

    let changed = 0;
    for (const row of rows) {
      let state: AuthorizationStateRead;
      try {
        state = await read({
          network: row.x402_network ?? "",
          asset: row.x402_asset ?? "",
          from: row.x402_from ?? "",
          nonce: row.x402_nonce!,
        });
      } catch {
        state = null;
      }
      const used = typeof state === "object" && state !== null ? state.used : state;
      const r = reservationOf(row);
      const nowSec = Math.floor(this.now() / 1000);
      if (used === true) {
        if (this.settle(r, { outcome: "committed" })) changed++;
        continue;
      }
      // Validity is judged on chain by block.timestamp, so an unused
      // authorization is released only when it was still unused at a block
      // past validBefore. The host clock alone (or a lagging node) is not enough.
      const blockTimestamp =
        typeof state === "object" && state !== null && Number.isFinite(state.blockTimestamp)
          ? state.blockTimestamp
          : null;
      if (
        used === false &&
        row.x402_valid_before !== null &&
        blockTimestamp !== null &&
        blockTimestamp > row.x402_valid_before &&
        nowSec > row.x402_valid_before + X402_RELEASE_GRACE_SECONDS
      ) {
        if (this.settle(r, { outcome: "released", reason: "authorization expired unused" })) changed++;
      }
    }
    return changed;
  }

  /**
   * Close rows left open by a process that is gone: 'reserved' -> 'released'
   * (nothing was sent), 'sent' -> 'unknown'. Only rows of another boot that
   * were created before this process started, or are stale, are touched.
   */
  recover(): { released: number; unknown: number } {
    const now = this.now();
    const params = {
      boot: this.bootId,
      start: this.processStartMs,
      stale: now - STALE_OPEN_ROW_MS,
      now,
    };
    const scope = `(boot_id IS NULL OR boot_id != @boot) AND (created_at_ms < @start OR created_at_ms < @stale)`;
    return this.db
      .transaction(() => {
        const released = this.db
          .prepare(
            `UPDATE treasury_ledger SET status = 'released', reason = 'process ended before send',
               settled_at_ms = @now, updated_at_ms = @now WHERE status = 'reserved' AND ${scope}`,
          )
          .run(params).changes;
        const unknown = this.db
          .prepare(
            `UPDATE treasury_ledger SET status = 'unknown', reason = 'process ended after send',
               settled_at_ms = @now, updated_at_ms = @now WHERE status = 'sent' AND ${scope}`,
          )
          .run(params).changes;
        return { released, unknown };
      })
      .immediate();
  }

  /** Delete denied and released rows older than 30 days. Returns the number deleted. */
  prune(): number {
    return this.db
      .prepare(
        `DELETE FROM treasury_ledger WHERE status IN ('denied','released') AND created_at_ms < ?`,
      )
      .run(this.now() - PRUNE_AFTER_MS).changes;
  }

  private maybePrune(): void {
    const now = this.now();
    if (now - this.lastPruneMs < HOUR_MS && now >= this.lastPruneMs) return;
    this.lastPruneMs = now;
    try {
      this.prune();
      this.recover();
    } catch (err) {
      logger.warn("Treasury prune failed", { error: errMessage(err) });
    }
  }

  // ─── queries ────────────────────────────────────────────────

  /** Counted spend of a budget over the last windowMs, in cents (USDC budgets rounded up). */
  usage(budget: BudgetId, windowMs: number): number {
    const since = this.now() - windowMs;
    if (USDC_BUDGETS.includes(budget)) return Math.ceil(this.usageAtomic(budget, since) / 10_000);
    return this.usageCents(budget, since);
  }

  /** validBefore (unix seconds) for an x402 authorization, clamped to the maximum validity. */
  x402ValidBefore(requiredDeadlineSeconds: number): number {
    const nowSec = Math.floor(this.now() / 1000);
    const want =
      Number.isFinite(requiredDeadlineSeconds) && requiredDeadlineSeconds > 0
        ? Math.floor(requiredDeadlineSeconds)
        : X402_MAX_VALIDITY_SECONDS;
    return nowSec + Math.max(1, Math.min(want, X402_MAX_VALIDITY_SECONDS));
  }

  /** Current status of a ledger row. */
  statusOf(id: string): LedgerRow["status"] | undefined {
    const row = this.db.prepare("SELECT status FROM treasury_ledger WHERE id = ?").get(id) as
      | { status: LedgerRow["status"] }
      | undefined;
    return row?.status;
  }

  private usageCents(budget: BudgetId, sinceMs: number): number {
    return this.scalar(
      `SELECT COALESCE(SUM(${HELD_CENTS_SQL}), 0) FROM treasury_ledger WHERE budget = ? AND ${COUNTED_SQL} AND created_at_ms > ?`,
      budget,
      sinceMs,
    );
  }

  private usageAtomic(budget: BudgetId, sinceMs: number): number {
    return this.scalar(
      `SELECT COALESCE(SUM(${HELD_ATOMIC_SQL}), 0) FROM treasury_ledger WHERE budget = ? AND ${COUNTED_SQL} AND created_at_ms > ?`,
      budget,
      sinceMs,
    );
  }

  private scalar(sql: string, ...params: unknown[]): number {
    const value = this.db.prepare(sql).pluck().get(...params);
    return typeof value === "number" ? value : Number(value ?? 0);
  }
}

// ─── helpers ──────────────────────────────────────────────────

function reservationOf(row: LedgerRow): Reservation {
  const r: Reservation = {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    budget: row.budget,
    amountCents: row.amount_cents,
  };
  if (row.replay_of) r.replayOf = row.replay_of;
  return r;
}

function isAutoFundOrigin(origin: TreasuryOrigin): boolean {
  return origin.type === "auto" && origin.name !== undefined && AUTO_FUND_ORIGINS.includes(origin.name);
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A URL path as lenient servers see it: decoded, slashes collapsed, dot segments resolved, lowercased. */
function normalizedPath(pathname: string): string {
  let p = pathname;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      break;
    }
    if (decoded === p) break;
    p = decoded;
  }
  p = p.replace(/\\/g, "/").replace(/;[^/]*/g, "").replace(/\/{2,}/g, "/");
  try {
    p = new URL(p.startsWith("/") ? p : `/${p}`, "http://x").pathname;
  } catch {
    // keep p as it is
  }
  return p.replace(/\/{2,}/g, "/").toLowerCase();
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function transactionTypeFor(kind: string): TransactionType {
  switch (kind) {
    case "credit_transfer":
      return "transfer_out";
    case "credit_topup":
      return "credit_purchase";
    case "x402_payment":
      return "x402_payment";
    default:
      return "tool_use";
  }
}

function mirrorCategory(budget: BudgetId): SpendCategory {
  if (budget === "transfer") return "transfer";
  if (budget === "x402") return "x402";
  return "other";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
