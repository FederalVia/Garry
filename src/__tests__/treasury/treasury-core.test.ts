/**
 * Treasury core: the reserve -> markSent -> settle state machine and every
 * gate invariant, tested against a real SQLite ledger with a fake clock and
 * a stub balance reader. No guarded primitives are involved.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AMBIGUITY_WINDOW_MS,
  DAY_MS,
  type AuthorizationStateRead,
  HOUR_MS,
  OutcomeUnknownError,
  TOPUP_UNKNOWN_BLOCK_MS,
  Treasury,
  TreasuryDeniedError,
  TreasuryNotInstalledError,
  X402_MAX_VALIDITY_SECONDS,
  budgetLimits,
  centsFromAtomic,
  classifySendError,
  currentTreasuryOrigin,
  domainDedupeKey,
  domainPerYearCents,
  getInstalledTreasury,
  getLedgerRow,
  installTreasury,
  listLedgerRows,
  isX402HostAllowed,
  normalizeTreasuryPolicy,
  processBootId,
  requireTreasury,
  resetTreasuryForTests,
  runWithTreasuryOrigin,
  sandboxDedupeKey,
  transferDedupeKey,
  x402DedupeKey,
  type OutflowQuote,
  type Reservation,
  type Settlement,
  type TreasuryDenyCode,
} from "../../treasury/index.js";
import { DEFAULT_TREASURY_POLICY } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { SCHEMA_VERSION } from "../../state/schema.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import type { CreditTransferResult } from "../../types.js";
import {
  CHILD_ADDRESS,
  OTHER_ADDRESS,
  PAY_TO,
  SELF_ADDRESS,
  T0,
  deferred,
  domainQuote,
  makeHarness,
  sandboxQuote,
  topupQuote,
  transferQuote,
  x402Quote,
  type Harness,
  type HarnessOptions,
} from "./harness.js";

let open: Harness[] = [];

function harness(opts: HarnessOptions = {}): Harness {
  const h = makeHarness(opts);
  open.push(h);
  return h;
}

afterEach(() => {
  for (const h of open) h.close();
  open = [];
  resetTreasuryForTests();
});

/** Generous transfer policy so only the limit under test binds. */
const WIDE = { requireConfirmationAboveCents: 100_000, maxSingleTransferCents: 5000 };

async function denied(p: Promise<unknown>): Promise<TreasuryDeniedError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TreasuryDeniedError) return err;
    throw err;
  }
  throw new Error("expected a TreasuryDeniedError");
}

async function expectDenied(p: Promise<unknown>, code: TreasuryDenyCode): Promise<void> {
  const err = await denied(p);
  expect(err.code).toBe(code);
}

/** reserve + markSent + commit at the reserved amount. */
async function spend(t: Treasury, q: OutflowQuote, s: Settlement = { outcome: "committed" }): Promise<Reservation> {
  const r = await t.reserve(q);
  t.markSent(r);
  t.settle(r, s);
  return r;
}

function transferClassify(
  o: { value: CreditTransferResult } | { error: unknown },
  info: { sent: boolean },
): Settlement {
  if ("value" in o) {
    return {
      outcome: "committed",
      amountCents: o.value.amountCents,
      externalRef: o.value.transferId,
      balanceAfterCents: o.value.balanceAfterCents ?? null,
    };
  }
  const outcome = classifySendError(o.error, info);
  return { outcome, reason: String((o.error as Error)?.message ?? o.error) };
}

function guardTransfer(h: Harness, t: Treasury, to: string, amount: number) {
  return t.guard(
    transferQuote(to, amount),
    (r) =>
      h.inner.transferCredits(to, amount, undefined, {
        idempotencyKey: r.idempotencyKey,
        onSend: () => t.markSent(r),
      }),
    transferClassify,
  );
}

function countTransactions(h: Harness, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) FROM transactions WHERE type = ?"
    : "SELECT COUNT(*) FROM transactions";
  const stmt = h.raw.prepare(sql).pluck();
  return (type ? stmt.get(type) : stmt.get()) as number;
}

function countMirror(h: Harness, category: string): number {
  return h.raw
    .prepare("SELECT COUNT(*) FROM spend_tracking WHERE category = ?")
    .pluck()
    .get(category) as number;
}

// ─── Policy ─────────────────────────────────────────────────────

describe("normalizeTreasuryPolicy", () => {
  it("replaces a non-numeric value with the default and warns", () => {
    const warnings: string[] = [];
    const p = normalizeTreasuryPolicy({ maxSingleTransferCents: "5,000" as any }, { onWarning: (m) => warnings.push(m) });
    expect(p.maxSingleTransferCents).toBe(1000);
    expect(warnings.some((w) => w.includes("maxSingleTransferCents"))).toBe(true);
  });

  it("replaces negative, NaN and infinite values, floors fractions, fills new fields", () => {
    const warnings: string[] = [];
    const p = normalizeTreasuryPolicy(
      { minimumReserveCents: -1, maxHourlyTransferCents: NaN, maxDailyTransferCents: Infinity, maxX402PaymentCents: 10.7 },
      { onWarning: (m) => warnings.push(m) },
    );
    expect(p.minimumReserveCents).toBe(1000);
    expect(p.maxHourlyTransferCents).toBe(10000);
    expect(p.maxDailyTransferCents).toBe(25000);
    expect(p.maxX402PaymentCents).toBe(10);
    expect(warnings).toHaveLength(4);
    expect(p.maxTopupSingleCents).toBe(2500);
    expect(p.maxTopupDailyCents).toBe(10000);
    expect(p.maxAutoTopupDailyCents).toBe(2000);
    expect(p.autoTopupCooldownMs).toBe(300_000);
    expect(p.survivalTopupThresholdCents).toBe(500);
    expect(p.maxInfraSingleCents).toBe(2500);
    expect(p.maxInfraDailyCents).toBe(5000);
  });

  it("validates x402AllowedDomains and topupPayTo", () => {
    expect(normalizeTreasuryPolicy({ x402AllowedDomains: "conway.tech" as any }).x402AllowedDomains).toEqual(["conway.tech"]);
    expect(normalizeTreasuryPolicy({ x402AllowedDomains: ["A.com", 5 as any, ""] }).x402AllowedDomains).toEqual(["a.com"]);
    expect(normalizeTreasuryPolicy({ topupPayTo: "nope" }).topupPayTo).toBeUndefined();
    expect(normalizeTreasuryPolicy({ topupPayTo: PAY_TO }).topupPayTo).toBe(PAY_TO);
    expect(normalizeTreasuryPolicy(undefined)).toEqual(normalizeTreasuryPolicy({}));
  });

  it("keeps every default numeric and non-negative", () => {
    for (const [key, value] of Object.entries(DEFAULT_TREASURY_POLICY)) {
      if (key === "x402AllowedDomains") continue;
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("policy helpers", () => {
  it("budget limits follow the limits matrix", () => {
    const p = normalizeTreasuryPolicy({});
    expect(budgetLimits(p, "transfer")).toEqual({ single: 1000, hourly: 10000, daily: 25000 });
    expect(budgetLimits(p, "x402")).toEqual({ single: 100, hourly: 1000, daily: 5000 });
    expect(budgetLimits(p, "topup")).toEqual({ single: 2500, daily: 10000 });
    expect(budgetLimits(p, "topup_auto")).toEqual({ single: 500, daily: 2000 });
    expect(budgetLimits(p, "infra")).toEqual({ single: 2500, daily: 5000 });
  });

  it("converts USDC atomic units to cents rounding up", () => {
    expect(centsFromAtomic(1_000_000n)).toBe(100);
    expect(centsFromAtomic(370_000n)).toBe(37);
    expect(centsFromAtomic(10_001n)).toBe(2);
    expect(centsFromAtomic(1n)).toBe(1);
    expect(centsFromAtomic(0n)).toBe(0);
  });

  it("reads domain prices as whole cents only, never guessing the unit (review TREASURY-3)", () => {
    expect(domainPerYearCents(1200)).toBe(1200);
    expect(domainPerYearCents(99)).toBe(99);
    expect(domainPerYearCents(150)).toBe(150);
    for (const bad of [12.99, 99.99, 0, -5, Number.NaN, Infinity, "1200", undefined]) {
      expect(domainPerYearCents(bad)).toBeNull();
    }
  });

  it("builds dedupe keys and matches x402 hosts", () => {
    expect(transferDedupeKey("0xABC", 5, "fund_child")).toBe("credit_transfer|0xabc|5|fund_child");
    expect(sandboxDedupeKey("a", 1, 512, 5)).toBe("sandbox_create|a|1|512|5");
    expect(domainDedupeKey("Test.COM", 2)).toBe("domain_register|test.com|2");
    const k1 = x402DedupeKey("get", "https://x.conway.tech/a?q=1", undefined, 5n);
    expect(k1).toMatch(/^x402\|GET\|https:\/\/x\.conway\.tech\/a\?q=1\|[0-9a-f]{64}\|5$/);
    expect(x402DedupeKey("GET", "https://x.conway.tech/a?q=1", "{}", 5n)).not.toBe(k1);
    expect(isX402HostAllowed("https://api.conway.tech/x", ["conway.tech"])).toBe(true);
    expect(isX402HostAllowed("https://evilconway.tech/x", ["conway.tech"])).toBe(false);
    expect(isX402HostAllowed("not a url", ["conway.tech"])).toBe(false);
  });

  it("keeps base58 case in transfer dedupe keys and lowercases only EVM", () => {
    // Two distinct, valid Solana keys that differ only in the case of one letter.
    const solA = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
    const solB = "7ecDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
    expect(transferDedupeKey(solA, 500, "x")).not.toBe(transferDedupeKey(solB, 500, "x"));
    expect(transferDedupeKey(solA, 500, "x")).toBe(`credit_transfer|${solA}|500|x`);
    const evm = "0x52908400098527886E0F7030069857D2E4169EE7";
    expect(transferDedupeKey(evm, 500, "x")).toBe(transferDedupeKey(evm.toLowerCase(), 500, "x"));
  });
});

// ─── State machine ──────────────────────────────────────────────

describe("reserve -> markSent -> settle", () => {
  it("commits with a transactions row and a spend mirror row in one go", async () => {
    const h = harness({ balance: 100_000 });
    const r = await h.treasury.reserve(transferQuote(CHILD_ADDRESS, 500));
    expect(r.idempotencyKey).toBe(r.id);
    expect(r.budget).toBe("transfer");
    expect(getLedgerRow(h.raw, r.id)!.status).toBe("reserved");
    h.treasury.markSent(r);
    expect(getLedgerRow(h.raw, r.id)!.status).toBe("sent");
    expect(h.treasury.settle(r, { outcome: "committed", externalRef: "txn_1", balanceAfterCents: 99_500 })).toBe(true);

    const row = getLedgerRow(h.raw, r.id)!;
    expect(row.status).toBe("committed");
    expect(row.committed_cents).toBe(500);
    expect(row.external_ref).toBe("txn_1");
    expect(row.boot_id).toBe(processBootId());
    const txn = h.raw.prepare("SELECT * FROM transactions").all() as any[];
    expect(txn).toHaveLength(1);
    expect(txn[0]).toMatchObject({ type: "transfer_out", amount_cents: 500, balance_after_cents: 99_500 });
    expect(h.tracker.getHourlySpend("transfer")).toBe(500);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(500);
  });

  it("maps each kind to its transactions type and mirror category", async () => {
    const h = harness({ balance: 100_000 });
    await spend(h.treasury, sandboxQuote(700));
    await spend(h.treasury, domainQuote("test.com", 1200));
    await spend(h.treasury, x402Quote(h.clock.now(), 370_000n));
    await spend(h.treasury, topupQuote(h.clock.now(), 5), { outcome: "committed", balanceAfterCents: 123 });
    expect(countTransactions(h, "tool_use")).toBe(2);
    expect(countTransactions(h, "x402_payment")).toBe(1);
    const purchase = h.raw.prepare("SELECT * FROM transactions WHERE type = 'credit_purchase'").get() as any;
    expect(purchase.amount_cents).toBe(500);
    expect(purchase.balance_after_cents).toBeNull();
    const x402 = h.raw.prepare("SELECT * FROM spend_tracking WHERE category = 'x402'").get() as any;
    expect(x402).toMatchObject({ amount_cents: 37, domain: "api.conway.tech" });
    expect(countMirror(h, "other")).toBe(3);
  });

  it("is single-use: markSent twice throws", async () => {
    const h = harness({ balance: 100_000 });
    const r = await h.treasury.reserve(transferQuote(CHILD_ADDRESS, 100));
    h.treasury.markSent(r);
    expect(() => h.treasury.markSent(r)).toThrow(/cannot be sent/);
  });

  it("allows only the specified transitions and is idempotent", async () => {
    const h = harness({ balance: 100_000 });
    const t = h.treasury;
    const a = await t.reserve(transferQuote(CHILD_ADDRESS, 100));
    expect(t.settle(a, { outcome: "committed" })).toBe(false); // reserved -> committed refused
    expect(t.settle(a, { outcome: "unknown", reason: "x" })).toBe(false); // reserved -> unknown refused
    expect(t.statusOf(a.id)).toBe("reserved");
    expect(t.settle(a, { outcome: "released", reason: "x" })).toBe(true);
    expect(t.settle(a, { outcome: "committed" })).toBe(false); // released is final
    expect(t.statusOf(a.id)).toBe("released");

    const b = await t.reserve(transferQuote(OTHER_ADDRESS, 100));
    t.markSent(b);
    expect(t.settle(b, { outcome: "unknown", reason: "504" })).toBe(true);
    expect(t.settle(b, { outcome: "unknown", reason: "again" })).toBe(false);
    expect(t.settle(b, { outcome: "committed" })).toBe(true); // unknown -> committed (reconcile)
    expect(t.settle(b, { outcome: "committed" })).toBe(false);
    expect(t.settle(b, { outcome: "released", reason: "late" })).toBe(false);
    expect(countTransactions(h)).toBe(1);
  });

  it("never commits below the reserved amount and counts a larger report", async () => {
    const h = harness({ balance: 100_000, policy: WIDE });
    const low = await spend(h.treasury, transferQuote(CHILD_ADDRESS, 1000), { outcome: "committed", amountCents: 1 });
    expect(getLedgerRow(h.raw, low.id)!.committed_cents).toBe(1000);
    const high = await spend(h.treasury, transferQuote(OTHER_ADDRESS, 1000), { outcome: "committed", amountCents: 1500 });
    expect(getLedgerRow(h.raw, high.id)!.committed_cents).toBe(1500);
    const junk = await spend(h.treasury, transferQuote("0x00000000000000000000000000000000000000aa", 100), {
      outcome: "committed",
      amountCents: 0.5,
    });
    expect(getLedgerRow(h.raw, junk.id)!.committed_cents).toBe(100);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(2600);
    expect(h.tracker.getHourlySpend("transfer")).toBe(2600);
  });

  it("denied and released rows never count", async () => {
    const h = harness({ balance: 100_000, policy: WIDE });
    await expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 6000)), "SPEND_LIMIT_EXCEEDED");
    const r = await h.treasury.reserve(transferQuote(CHILD_ADDRESS, 5000));
    h.treasury.settle(r, { outcome: "released", reason: "nothing sent" });
    expect(h.treasury.usage("transfer", DAY_MS)).toBe(0);
    expect(h.rows("transfer").map((x) => x.status).sort()).toEqual(["denied", "released"]);
    // The full cap is still available.
    await spend(h.treasury, transferQuote(CHILD_ADDRESS, 5000));
    await spend(h.treasury, transferQuote(OTHER_ADDRESS, 5000));
  });

  it("commits even when the spend mirror fails", async () => {
    const h = harness({ balance: 100_000 });
    const t = h.newTreasury({
      spendTracker: { ...h.tracker, recordSpend: () => { throw new Error("mirror down"); } } as any,
    });
    const r = await spend(t, transferQuote(CHILD_ADDRESS, 100));
    expect(t.statusOf(r.id)).toBe("committed");
    expect(countTransactions(h, "transfer_out")).toBe(1);
  });

  it("the commit phase is synchronous (never thenable)", () => {
    const h = harness({ balance: 100_000 });
    const out = h.treasury.reserveSync(
      transferQuote(CHILD_ADDRESS, 100),
      { type: "unattributed" },
      { balanceCents: 100_000, balanceReadStartedMs: h.clock.now() },
    );
    expect(out).toBeDefined();
    expect(typeof (out as any).then).toBe("undefined");
    expect(out.reservation?.amountCents).toBe(100);
  });
});

describe("guard", () => {
  it("commits on success and passes the reservation key to the primitive", async () => {
    const h = harness({ balance: 100_000 });
    const res = await guardTransfer(h, h.treasury, CHILD_ADDRESS, 300);
    expect(res.status).toBe("completed");
    const [row] = h.rows("transfer");
    expect(row.status).toBe("committed");
    expect(h.inner.calls.transferCredits[0].idempotencyKey).toBe(row.id);
  });

  it("releases and rethrows when exec fails before markSent", async () => {
    const h = harness({ balance: 100_000 });
    const boom = new Error("signing failed");
    await expect(
      h.treasury.guard(transferQuote(CHILD_ADDRESS, 300), async () => { throw boom; }, transferClassify),
    ).rejects.toBe(boom);
    expect(h.rows("transfer")[0].status).toBe("released");
  });

  it("marks unknown and throws OutcomeUnknownError on an ambiguous failure after send", async () => {
    const h = harness({ balance: 100_000 });
    h.inner.failNext("transferCredits", { status: 504 });
    const err = await guardTransfer(h, h.treasury, CHILD_ADDRESS, 300).catch((e) => e);
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    const [row] = h.rows("transfer");
    expect(err.reservationId).toBe(row.id);
    expect(err.idempotencyKey).toBe(row.idempotency_key);
    expect(row.status).toBe("unknown");
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(300);
  });

  it("releases definite failures after send and rethrows the original error", async () => {
    const h = harness({ balance: 100_000 });
    h.inner.failNext("transferCredits", { status: 422 });
    await expect(guardTransfer(h, h.treasury, CHILD_ADDRESS, 300)).rejects.toMatchObject({ status: 422 });
    h.inner.failNext("transferCredits", "refused");
    await expect(guardTransfer(h, h.treasury, OTHER_ADDRESS, 300)).rejects.toThrow(/fetch failed/);
    expect(h.rows("transfer").map((r) => r.status)).toEqual(["released", "released"]);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(0);
  });

  it("accounts for a primitive that returned without markSent", async () => {
    const h = harness({ balance: 100_000 });
    await h.treasury.guard(transferQuote(CHILD_ADDRESS, 300), async () => ({ ok: true }), () => ({ outcome: "committed" }));
    expect(h.rows("transfer")[0].status).toBe("committed");
  });

  it("treats a throwing classifier as unknown", async () => {
    const h = harness({ balance: 100_000 });
    await expect(
      h.treasury.guard(
        transferQuote(CHILD_ADDRESS, 300),
        async (r) => { h.treasury.markSent(r); return 1; },
        () => { throw new Error("bad classifier"); },
      ),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(h.rows("transfer")[0].status).toBe("unknown");
  });
});

describe("classifySendError", () => {
  const cases: Array<[string, unknown, "released" | "unknown"]> = [
    ["circuit open", Object.assign(new Error("open"), { name: "CircuitOpenError" }), "released"],
    ["invalid url", new Error("Invalid URL: x"), "released"],
    ["https required", new Error("HTTPS required: refusing insecure URL"), "released"],
    ["refused", Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "released"],
    ["dns", Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }), "released"],
    ["dns again", Object.assign(new Error("fetch failed"), { cause: { code: "EAI_AGAIN" } }), "released"],
    ["400", { status: 400 }, "released"],
    ["404", { status: 404 }, "released"],
    ["422", { status: 422 }, "released"],
    ["408", { status: 408 }, "unknown"],
    ["409", { status: 409 }, "unknown"],
    ["425", { status: 425 }, "unknown"],
    ["429", { status: 429 }, "unknown"],
    ["500", { status: 500 }, "unknown"],
    ["504", { status: 504 }, "unknown"],
    ["reset", Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }), "unknown"],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" }), "unknown"],
    ["other", new Error("weird"), "unknown"],
    ["treasury deny", new TreasuryDeniedError("SPEND_LIMIT_EXCEEDED", "x"), "released"],
  ];
  it.each(cases)("%s", (_name, err, expected) => {
    expect(classifySendError(err)).toBe(expected);
  });

  it("anything thrown before send is released", () => {
    expect(classifySendError({ status: 504 }, { sent: false })).toBe("released");
  });
});

// ─── Invariants ─────────────────────────────────────────────────

describe("I1/I2 caps", () => {
  it("enforces single, rolling hourly and rolling daily transfer caps", async () => {
    const h = harness({ balance: 1_000_000, policy: { ...WIDE, maxDailyTransferCents: 15_000 } });
    const t = h.treasury;
    await expectDenied(t.reserve(transferQuote(CHILD_ADDRESS, 5001)), "SPEND_LIMIT_EXCEEDED");
    await spend(t, transferQuote(CHILD_ADDRESS, 5000));
    h.clock.advance(30 * 60_000);
    await spend(t, transferQuote(OTHER_ADDRESS, 5000));
    await expectDenied(t.reserve(transferQuote(CHILD_ADDRESS, 1)), "SPEND_LIMIT_EXCEEDED");
    // 31 min later the first row has left the rolling hour.
    h.clock.advance(31 * 60_000);
    await spend(t, transferQuote(CHILD_ADDRESS, 5000));
    // Daily cap 15000 now binds although the hour has room.
    h.clock.advance(2 * HOUR_MS);
    await expectDenied(t.reserve(transferQuote(CHILD_ADDRESS, 1)), "SPEND_LIMIT_EXCEEDED");
    h.clock.advance(DAY_MS);
    await spend(t, transferQuote(CHILD_ADDRESS, 5000));
  });

  it("uses the confirmation threshold as the transfer single cap", async () => {
    const h = harness({ balance: 1_000_000 });
    await expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 1001)), "SPEND_LIMIT_EXCEEDED");
    await spend(h.treasury, transferQuote(CHILD_ADDRESS, 1000));
  });

  it("sums x402 windows in atomic units (sub-cent payments are not inflated)", async () => {
    const h = harness();
    const t = h.treasury;
    for (let i = 0; i < 10; i++) await spend(t, x402Quote(h.clock.now(), 999_999n));
    // Cents per row would sum to 1000; atomic is 9_999_990 of the 10_000_000 hourly envelope.
    expect(t.usage("x402", HOUR_MS)).toBe(1000);
    await spend(t, x402Quote(h.clock.now(), 10n));
    await expectDenied(t.reserve(x402Quote(h.clock.now(), 1n)), "SPEND_LIMIT_EXCEEDED");
    await expectDenied(t.reserve(x402Quote(h.clock.now(), 1_000_001n)), "SPEND_LIMIT_EXCEEDED"); // single 100c
  });

  it("caps topups, survival topups and infra separately", async () => {
    const h = harness({ balance: 0 });
    const t = h.treasury;
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 26)), "SPEND_LIMIT_EXCEEDED");
    for (let i = 0; i < 4; i++) {
      await spend(t, topupQuote(h.clock.now(), 25));
      h.clock.advance(60_000);
    }
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 25)), "SPEND_LIMIT_EXCEEDED");
    // Survival has its own budget and is not starved.
    await spend(t, topupQuote(h.clock.now(), 5, "survival"));
    await expectDenied(
      t.reserve(topupQuote(h.clock.now() + 1, 10, "survival")),
      "TOPUP_COOLDOWN",
    );

    const infra = harness({ balance: 100_000 });
    await expectDenied(infra.treasury.reserve(sandboxQuote(2501)), "SPEND_LIMIT_EXCEEDED");
    await spend(infra.treasury, sandboxQuote(2500, "a"));
    await spend(infra.treasury, domainQuote("a.com", 2500));
    await expectDenied(infra.treasury.reserve(sandboxQuote(1, "b")), "SPEND_LIMIT_EXCEEDED");
  });

  it("rejects amounts that are not positive safe integers", async () => {
    const h = harness({ balance: 100_000 });
    for (const bad of [0, -5, 10.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "500" as any]) {
      await expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, bad)), "INVALID_AMOUNT");
    }
    const q = x402Quote(h.clock.now(), 370_000n);
    await expectDenied(h.treasury.reserve({ ...q, amountCents: 36 }), "INVALID_AMOUNT");
    await expectDenied(h.treasury.reserve({ ...q, amountAtomic: undefined }), "INVALID_AMOUNT");
    await expectDenied(h.treasury.reserve({ ...q, x402: undefined }), "INVALID_QUOTE");
    await expectDenied(h.treasury.reserve({ ...q, counterparty: "" }), "INVALID_QUOTE");
    const rows = h.rows();
    expect(rows.every((r) => r.status === "denied")).toBe(true);
  });
});

describe("I3/I4 reserve floor and half balance", () => {
  it("keeps the observed balance above the reserve", async () => {
    const h = harness({ balance: 1500 });
    await expectDenied(guardTransfer(h, h.treasury, CHILD_ADDRESS, 750), "RESERVE_VIOLATION");
    expect(h.inner.calls.transferCredits).toHaveLength(0);
    await guardTransfer(h, h.treasury, CHILD_ADDRESS, 500);
    await expectDenied(guardTransfer(h, h.treasury, OTHER_ADDRESS, 1), "RESERVE_VIOLATION");
  });

  it("applies the reserve to sandboxes and domains but not to USDC outflows", async () => {
    const h = harness({ balance: 2500 });
    await expectDenied(h.treasury.reserve(sandboxQuote(2000)), "RESERVE_VIOLATION");
    await expectDenied(h.treasury.reserve(domainQuote("a.com", 1600)), "RESERVE_VIOLATION");
    await spend(h.treasury, x402Quote(h.clock.now(), 1_000_000n));
    expect(h.inner.balanceReads).toBe(2);
  });

  it("limits a transfer to half the available balance", async () => {
    const h = harness({ balance: 6000, policy: WIDE });
    await expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 3001)), "HALF_BALANCE");
    await h.treasury.reserve(transferQuote(CHILD_ADDRESS, 2500));
    // The open reservation is subtracted: (6000 - 2500) / 2 = 1750.
    await expectDenied(h.treasury.reserve(transferQuote(OTHER_ADDRESS, 2500)), "HALF_BALANCE");
  });

  it("denies credit outflows when the balance cannot be read", async () => {
    const h = harness({ balance: 100_000 });
    h.inner.balanceError = new Error("circuit open");
    await expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 100)), "BALANCE_UNAVAILABLE");
    await expectDenied(h.treasury.reserve(sandboxQuote(100)), "BALANCE_UNAVAILABLE");
    const row = h.rows("transfer")[0];
    expect(row).toMatchObject({ status: "denied", deny_code: "BALANCE_UNAVAILABLE", balance_unknown: 1 });
  });

  it("subtracts rows settled after the balance read began, not long-settled ones", async () => {
    const h = harness({ balance: 2500, policy: WIDE });
    const t = h.treasury;
    // Committed 2 minutes before the next read (beyond the 60s lag): not subtracted.
    await spend(t, transferQuote(CHILD_ADDRESS, 1000));
    h.clock.advance(120_000);
    await spend(t, transferQuote(OTHER_ADDRESS, 1000));
    // Committed just now and the balance endpoint still shows 2500: subtracted.
    await expectDenied(t.reserve(transferQuote(CHILD_ADDRESS, 1000)), "RESERVE_VIOLATION");
  });

  it("keeps ambiguous transfers in flight after they settle (queued transfers may land later)", async () => {
    // Four automatic transfers time out at t=0..30s while Conway queues them.
    const h = harness({ balance: 5000, policy: { requireConfirmationAboveCents: 1000, autoFundCounterpartyCooldownMs: 0 } });
    const t = h.treasury;
    const children = [1, 2, 3, 4].map((i) => `0x${String(i).padStart(40, "0")}`);
    const reservations: Reservation[] = [];
    for (const to of children) {
      const r = await runWithTreasuryOrigin({ type: "auto", name: "orchestrator.fund_child" }, () =>
        t.reserve(transferQuote(to, 1000)),
      );
      t.markSent(r);
      reservations.push(r);
    }
    h.clock.advance(30_000);
    for (const r of reservations) t.settle(r, { outcome: "unknown", reason: "timeout" });
    // At t=40s the balance still shows 5000.
    h.clock.advance(10_000);
    await expectDenied(t.reserve(transferQuote(OTHER_ADDRESS, 1000)), "RESERVE_VIOLATION");
    // Once the unknown rows are older than unknownInflightMs they stop being subtracted.
    h.clock.advance(HOUR_MS);
    await spend(t, transferQuote(OTHER_ADDRESS, 1000));
  });
});

describe("I5 cooldowns", () => {
  it("enforces transferCooldownMs on counted transfers", async () => {
    const h = harness({ balance: 100_000, policy: { transferCooldownMs: 60_000 } });
    await spend(h.treasury, transferQuote(CHILD_ADDRESS, 100));
    h.clock.advance(1000);
    await expectDenied(h.treasury.reserve(transferQuote(OTHER_ADDRESS, 100)), "TRANSFER_COOLDOWN");
    h.clock.advance(59_001);
    await spend(h.treasury, transferQuote(OTHER_ADDRESS, 100));
  });

  it("survival cooldown counts released attempts but not denials", async () => {
    const h = harness({ balance: 0 });
    const t = h.treasury;
    const r = await t.reserve(topupQuote(h.clock.now(), 5, "survival"));
    t.settle(r, { outcome: "released", reason: "sign failed" });
    h.clock.advance(1000);
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "survival")), "TOPUP_COOLDOWN");
    h.clock.advance(300_000);
    await spend(t, topupQuote(h.clock.now(), 5, "survival"));
  });
});

describe("I7 single-flight topups", () => {
  it("allows one open topup across manual, sandbox and survival", async () => {
    const h = harness({ balance: 0 });
    const t = h.treasury;
    const open = await t.reserve(topupQuote(h.clock.now(), 25, "sandbox_402"));
    t.markSent(open);
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "survival")), "TOPUP_IN_FLIGHT");
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 10)), "TOPUP_IN_FLIGHT");
    t.settle(open, { outcome: "unknown", reason: "502" });
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 10)), "TOPUP_IN_FLIGHT");
    h.clock.advance(TOPUP_UNKNOWN_BLOCK_MS + 1);
    await spend(t, topupQuote(h.clock.now(), 10));
    // The unknown row still counts in its daily budget: 2500 + 1000.
    expect(t.usage("topup", DAY_MS)).toBe(3500);
  });
});

describe("I8 bounded ambiguity", () => {
  it("replays an ambiguous transfer with the original key, charged, at most twice", async () => {
    const h = harness({ balance: 100_000 });
    const t = h.treasury;
    h.inner.failNext("transferCredits", { status: 504 });
    await expect(guardTransfer(h, t, CHILD_ADDRESS, 100)).rejects.toBeInstanceOf(OutcomeUnknownError);
    const original = h.rows("transfer")[0];

    h.inner.failNext("transferCredits", "timeout");
    await expect(guardTransfer(h, t, CHILD_ADDRESS, 100)).rejects.toBeInstanceOf(OutcomeUnknownError);
    h.inner.failNext("transferCredits", { status: 502 });
    await expect(guardTransfer(h, t, CHILD_ADDRESS, 100)).rejects.toBeInstanceOf(OutcomeUnknownError);
    const keys = h.inner.calls.transferCredits.map((c) => c.idempotencyKey);
    expect(keys).toEqual([original.id, original.id, original.id]);
    const replays = h.rows("transfer").filter((r) => r.replay_of === original.id);
    expect(replays).toHaveLength(2);
    expect(t.usage("transfer", HOUR_MS)).toBe(300);

    await expectDenied(guardTransfer(h, t, CHILD_ADDRESS, 100), "AMBIGUOUS_PENDING");
    // A different amount is a different request.
    await guardTransfer(h, t, CHILD_ADDRESS, 101);
    // After 24h the original no longer blocks.
    h.clock.advance(AMBIGUITY_WINDOW_MS + 1);
    await guardTransfer(h, t, CHILD_ADDRESS, 100);
    expect(h.inner.calls.transferCredits.at(-1)!.idempotencyKey).not.toBe(original.id);
  });

  it("a committed replay resolves the original, so the next identical transfer is new", async () => {
    const h = harness({ balance: 100_000 });
    const t = h.treasury;
    h.inner.failNext("transferCredits", { status: 504 });
    await guardTransfer(h, t, CHILD_ADDRESS, 100).catch(() => {});
    await guardTransfer(h, t, CHILD_ADDRESS, 100);
    const [k0, k1] = h.inner.calls.transferCredits.map((c) => c.idempotencyKey);
    expect(k1).toBe(k0);
    await guardTransfer(h, t, CHILD_ADDRESS, 100);
    expect(h.inner.calls.transferCredits[2].idempotencyKey).not.toBe(k0);
  });

  it("blocks identical sandbox and domain requests while one is unknown", async () => {
    const h = harness({ balance: 100_000 });
    const t = h.treasury;
    const s = await t.reserve(sandboxQuote(500, "a"));
    t.markSent(s);
    t.settle(s, { outcome: "unknown", reason: "timeout" });
    await expectDenied(t.reserve(sandboxQuote(500, "a")), "AMBIGUOUS_PENDING");
    await spend(t, sandboxQuote(500, "b"));
    const d = await t.reserve(domainQuote("a.com", 1200));
    t.markSent(d);
    t.settle(d, { outcome: "unknown", reason: "timeout" });
    await expectDenied(t.reserve(domainQuote("a.com", 1200)), "AMBIGUOUS_PENDING");
    h.clock.advance(AMBIGUITY_WINDOW_MS + 1);
    await t.reserve(sandboxQuote(500, "a"));
  });

  it("blocks an identical x402 payment until its authorization has expired", async () => {
    const h = harness();
    const t = h.treasury;
    const q = x402Quote(h.clock.now(), 100_000n, undefined, { dedupeKey: "x402|GET|u|h|100000" });
    const r = await t.reserve(q);
    t.markSent(r);
    t.settle(r, { outcome: "unknown", reason: "502" });
    await expectDenied(
      t.reserve(x402Quote(h.clock.now(), 100_000n, undefined, { dedupeKey: q.dedupeKey })),
      "PAYMENT_UNCONFIRMED",
    );
    h.clock.set((q.x402!.validBefore + 61) * 1000);
    await t.reserve(x402Quote(h.clock.now(), 100_000n, undefined, { dedupeKey: q.dedupeKey }));
    // The unknown row is still counted in its windows.
    expect(t.usage("x402", HOUR_MS)).toBe(20);
  });
});

describe("I9 untrusted source", () => {
  const sources = ["external", "peer"];
  it.each(sources)("denies every budget for input source %s", async (source) => {
    const h = harness({ balance: 0 });
    const quotes: OutflowQuote[] = [
      transferQuote(CHILD_ADDRESS, 100),
      sandboxQuote(500),
      domainQuote("a.com", 1200),
      x402Quote(h.clock.now(), 10_000n),
      topupQuote(h.clock.now(), 5),
      topupQuote(h.clock.now(), 5, "survival"),
    ];
    for (const q of quotes) {
      await runWithTreasuryOrigin({ type: "tool", name: "x", inputSource: source }, () =>
        expectDenied(h.treasury.reserve(q), "UNTRUSTED_SOURCE"),
      );
    }
    expect(h.inner.balanceReads).toBe(0);
    expect(h.rows().every((r) => r.status === "denied" && r.input_source === source)).toBe(true);
  });

  it("allows an undefined source and heartbeat", async () => {
    const h = harness({ balance: 100_000 });
    await runWithTreasuryOrigin({ type: "tool", name: "transfer_credits" }, () =>
      spend(h.treasury, transferQuote(CHILD_ADDRESS, 100)),
    );
    await runWithTreasuryOrigin({ type: "tool", name: "transfer_credits", inputSource: "heartbeat" }, () =>
      spend(h.treasury, transferQuote(OTHER_ADDRESS, 100)),
    );
    for (const s of ["creator", "agent", "system", "wakeup"]) {
      await runWithTreasuryOrigin({ type: "tool", name: "create_sandbox", inputSource: s }, () =>
        spend(h.treasury, sandboxQuote(100, s)),
      );
    }
  });

  it("an untrusted source survives a nested origin wrapper", async () => {
    const h = harness({ balance: 100_000 });
    await runWithTreasuryOrigin({ type: "tool", name: "x", inputSource: "external" }, () =>
      runWithTreasuryOrigin({ type: "auto", name: "orchestrator.fund_child" }, async () => {
        expect(currentTreasuryOrigin()).toMatchObject({ type: "auto", inputSource: "external" });
        await expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 100)), "UNTRUSTED_SOURCE");
      }),
    );
  });
});

describe("I10 and counterparty rules", () => {
  it("denies transfers to self, whatever the case", async () => {
    const h = harness({ balance: 100_000 });
    await expectDenied(h.treasury.reserve(transferQuote(SELF_ADDRESS.toUpperCase().replace("0X", "0x"), 100)), "SELF_TRANSFER");
    expect(h.inner.balanceReads).toBe(1);
  });

  it("treats a case variant of a Solana self address as a different recipient", async () => {
    const h = harness({ balance: 100_000 });
    const self = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
    const t = h.newTreasury({ selfAddress: self });
    await expectDenied(t.reserve(transferQuote(self, 100)), "SELF_TRANSFER");
    const r = await t.reserve(transferQuote("7ecDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV", 100));
    expect(r.id).toBeTruthy();
  });

  it("checks the x402 allowlist and refuses Conway /pay/ through x402 fetch", async () => {
    const h = harness();
    await expectDenied(h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, "https://evil.example/x")), "X402_DOMAIN_NOT_ALLOWED");
    await expectDenied(
      h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, `https://api.conway.tech/pay/5/${OTHER_ADDRESS}`)),
      "X402_DOMAIN_NOT_ALLOWED",
    );
    const empty = harness({ policy: { x402AllowedDomains: [] } });
    await expectDenied(empty.treasury.reserve(x402Quote(empty.clock.now(), 10_000n)), "X402_DOMAIN_NOT_ALLOWED");
  });

  it("refuses Conway /pay/ URLs however the path is spelled", async () => {
    const h = harness();
    const variants = [
      `//pay/5/${OTHER_ADDRESS}`,
      `/%70ay/5/${OTHER_ADDRESS}`,
      `/%2570ay/5/${OTHER_ADDRESS}`,
      `/PAY/5/${OTHER_ADDRESS}`,
      `/v1/..%2fpay/5/${OTHER_ADDRESS}`,
      `/v1/%2e%2e/pay/5/${OTHER_ADDRESS}`,
      `/pay;x=1/5/${OTHER_ADDRESS}`,
      `/pay%2F5%2F${OTHER_ADDRESS}`,
      `/pay`,
    ];
    for (const path of variants) {
      await expectDenied(h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, `https://api.conway.tech${path}`)), "X402_DOMAIN_NOT_ALLOWED");
    }
    // Sibling Conway hosts and a trailing-dot host are covered too.
    await expectDenied(h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, `https://pay.conway.tech/pay/5/x`)), "X402_DOMAIN_NOT_ALLOWED");
    await expectDenied(h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, `https://conway.tech/pay/5/x`)), "X402_DOMAIN_NOT_ALLOWED");
    // Paths that only resemble /pay/ stay payable.
    await h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, `https://api.conway.tech/v1/payments/list`));
    await h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, `https://api.conway.tech/v1/pay/5`));
  });

  it("topups must buy for self and pay a trusted payTo", async () => {
    const h = harness({ balance: 0 });
    const t = h.treasury;
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "manual", { recipient: OTHER_ADDRESS })), "TOPUP_RECIPIENT_NOT_SELF");
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "manual", { recipient: undefined })), "TOPUP_RECIPIENT_NOT_SELF");
    // First committed topup sets the trusted payTo.
    await spend(t, topupQuote(h.clock.now(), 5));
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "manual", { counterparty: OTHER_ADDRESS })), "X402_PAYTO_NOT_TRUSTED");

    const pinned = harness({ balance: 0, policy: { topupPayTo: OTHER_ADDRESS } });
    await expectDenied(pinned.treasury.reserve(topupQuote(pinned.clock.now(), 5)), "X402_PAYTO_NOT_TRUSTED");
    await pinned.treasury.reserve(topupQuote(pinned.clock.now(), 5, "manual", { counterparty: OTHER_ADDRESS }));
  });

  it("a payTo rotation does not starve survival topups, and survival buys do not re-pin the payTo", async () => {
    const h = harness({ balance: 0 });
    const t = h.treasury;
    await spend(t, topupQuote(h.clock.now(), 5, "manual"));
    h.clock.advance(10 * 60_000);
    // Conway now quotes another payTo: manual topups are refused, survival goes on.
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "manual", { counterparty: OTHER_ADDRESS })), "X402_PAYTO_NOT_TRUSTED");
    await spend(t, topupQuote(h.clock.now(), 5, "survival", { counterparty: OTHER_ADDRESS }));
    h.clock.advance(7 * DAY_MS);
    await spend(t, topupQuote(h.clock.now(), 5, "survival", { counterparty: OTHER_ADDRESS }));
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "manual", { counterparty: OTHER_ADDRESS })), "X402_PAYTO_NOT_TRUSTED");

    // An operator pin binds survival too.
    const pinned = harness({ balance: 0, policy: { topupPayTo: PAY_TO } });
    await expectDenied(
      pinned.treasury.reserve(topupQuote(pinned.clock.now(), 5, "survival", { counterparty: OTHER_ADDRESS })),
      "X402_PAYTO_NOT_TRUSTED",
    );
  });

  it("clamps x402 validity and refuses longer authorizations", async () => {
    const h = harness();
    const nowSec = Math.floor(h.clock.now() / 1000);
    expect(h.treasury.x402ValidBefore(31_536_000)).toBe(nowSec + X402_MAX_VALIDITY_SECONDS);
    expect(h.treasury.x402ValidBefore(60)).toBe(nowSec + 60);
    expect(h.treasury.x402ValidBefore(NaN)).toBe(nowSec + X402_MAX_VALIDITY_SECONDS);
    await expectDenied(h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, undefined, {}, 601)), "X402_DEADLINE_TOO_LONG");
    await expectDenied(h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, undefined, {}, 0)), "INVALID_QUOTE");
    await h.treasury.reserve(x402Quote(h.clock.now(), 10_000n, undefined, {}, 600));
  });
});

describe("survival topups (topup_auto)", () => {
  it("refuses tool origins and runs only below the threshold", async () => {
    const h = harness({ balance: 10_000 });
    const t = h.treasury;
    await runWithTreasuryOrigin({ type: "tool", name: "topup_credits" }, () =>
      expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "survival")), "ORIGIN_NOT_ALLOWED"),
    );
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "survival")), "TOPUP_NOT_NEEDED");
    h.inner.creditsCents = 499;
    await runWithTreasuryOrigin({ type: "auto", name: "heartbeat.check_usdc_balance" }, () =>
      spend(t, topupQuote(h.clock.now(), 5, "survival")),
    );
    expect(h.rows("topup_auto", "committed")[0]).toMatchObject({ origin_name: "heartbeat.check_usdc_balance", balance_observed_cents: 499 });
  });

  it("never buys blind: a survival topup with the balance unreadable is refused", async () => {
    const h = harness({ balance: 0 });
    h.inner.balanceError = new Error("down");
    await expectDenied(h.treasury.reserve(topupQuote(h.clock.now(), 5, "survival")), "BALANCE_UNAVAILABLE");
    h.clock.advance(DAY_MS);
    await expectDenied(h.treasury.reserve(topupQuote(h.clock.now(), 5, "survival")), "BALANCE_UNAVAILABLE");
    // Once the balance reads again the buy is judged on it.
    h.inner.balanceError = null;
    await spend(h.treasury, topupQuote(h.clock.now(), 5, "survival"));
  });

  it("caps a survival buy at $5 and $20 per rolling day", async () => {
    const h = harness({ balance: 0 });
    await expectDenied(h.treasury.reserve(topupQuote(h.clock.now(), 10, "survival")), "SPEND_LIMIT_EXCEEDED");
    for (let i = 0; i < 4; i++) {
      await spend(h.treasury, topupQuote(h.clock.now(), 5, "survival"));
      h.clock.advance(5 * 60_000 + 1);
    }
    await expectDenied(h.treasury.reserve(topupQuote(h.clock.now(), 5, "survival")), "SPEND_LIMIT_EXCEEDED");
  });

  it("an unknown survival topup unblocks once its clamped authorization expires unused", async () => {
    let used: boolean | null = null;
    const h: ReturnType<typeof harness> = harness({
      balance: 0,
      readAuthorizationState: async () =>
        used === false ? { used: false, blockTimestamp: Math.floor(h.clock.now() / 1000) } : used,
    });
    const t = h.treasury;
    const validBefore = t.x402ValidBefore(31_536_000);
    const q = topupQuote(h.clock.now(), 5, "survival");
    q.x402!.validBefore = validBefore;
    const r = await t.reserve(q);
    t.markSent(r);
    t.settle(r, { outcome: "unknown", reason: "502" });
    h.clock.advance(6 * 60_000);
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "survival")), "PAYMENT_UNCONFIRMED");
    // RPC down: unchanged. Then the chain says unused, past validBefore + 60s.
    h.clock.set((validBefore + 61) * 1000);
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 5, "survival")), "TOPUP_IN_FLIGHT");
    used = false;
    await spend(t, topupQuote(h.clock.now(), 5, "survival"));
    expect(t.statusOf(r.id)).toBe("released");
  });
});

describe("automatic child funding", () => {
  const auto = <T>(fn: () => Promise<T>) => runWithTreasuryOrigin({ type: "auto", name: "health.fund_child" }, fn);

  it("funds one address at most once per cooldown", async () => {
    const h = harness({ balance: 100_000 });
    await auto(() => spend(h.treasury, transferQuote(CHILD_ADDRESS, 250)));
    h.clock.advance(60_000);
    await auto(() => expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 250)), "TRANSFER_COOLDOWN"));
    await auto(() => spend(h.treasury, transferQuote(OTHER_ADDRESS, 250)));
    // Model transfers are not subject to the per-address cooldown.
    await spend(h.treasury, transferQuote(CHILD_ADDRESS, 250));
    h.clock.advance(30 * 60_000);
    await auto(() => spend(h.treasury, transferQuote(CHILD_ADDRESS, 250)));
  });

  it("limits automatic funding to half the daily transfer cap", async () => {
    const h = harness({ balance: 1_000_000, policy: { ...WIDE, maxHourlyTransferCents: 100_000, maxDailyTransferCents: 10_000 } });
    const addr = (i: number) => `0x${String(i + 100).padStart(40, "0")}`;
    await auto(() => spend(h.treasury, transferQuote(addr(1), 5000)));
    await auto(() => expectDenied(h.treasury.reserve(transferQuote(addr(2), 1)), "SPEND_LIMIT_EXCEEDED"));
    await spend(h.treasury, transferQuote(addr(3), 5000));
  });
});

// ─── Concurrency ────────────────────────────────────────────────

describe("concurrency", () => {
  it("lets exactly one of four concurrent transfers through at the hourly cap", async () => {
    const h = harness({ balance: 100_000, policy: WIDE });
    const t = h.treasury;
    await spend(t, transferQuote("0x00000000000000000000000000000000000000a1", 5000));
    await spend(t, transferQuote("0x00000000000000000000000000000000000000a2", 4000));
    const gate = deferred();
    h.inner.gates.balance = gate.promise;
    h.inner.balanceReads = 0;
    const addrs = [1, 2, 3, 4].map((i) => `0x${String(i).padStart(40, "0")}`);
    const all = Promise.allSettled(addrs.map((a) => guardTransfer(h, t, a, 1000)));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.inner.balanceReads).toBe(4); // all four are past the pre-phase
    gate.resolve();
    const results = await all;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => r.reason.code)).toEqual([
      "SPEND_LIMIT_EXCEEDED",
      "SPEND_LIMIT_EXCEEDED",
      "SPEND_LIMIT_EXCEEDED",
    ]);
    expect(h.inner.calls.transferCredits).toHaveLength(1);
    expect(t.usage("transfer", HOUR_MS)).toBe(10_000);
  });

  it("subtracts concurrent reservations from the shared balance read", async () => {
    const h = harness({ balance: 1500 });
    const gate = deferred();
    h.inner.gates.balance = gate.promise;
    const addrs = [1, 2, 3].map((i) => `0x${String(i).padStart(40, "0")}`);
    const all = Promise.allSettled(addrs.map((a) => h.treasury.reserve(transferQuote(a, 250))));
    await new Promise((r) => setTimeout(r, 10));
    gate.resolve();
    const results = await all;
    // 1500 - 250 - 250 = 1000 is the floor; the third is denied.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((results[2] as PromiseRejectedResult).reason.code).toBe("RESERVE_VIOLATION");
  });

  it("serializes two Treasury objects over one database", async () => {
    const h = harness({ balance: 100_000, policy: WIDE });
    const t2 = h.newTreasury();
    await spend(h.treasury, transferQuote("0x00000000000000000000000000000000000000a1", 5000));
    await spend(h.treasury, transferQuote("0x00000000000000000000000000000000000000a2", 4000));
    const gate = deferred();
    h.inner.gates.balance = gate.promise;
    const calls = [h.treasury, t2, h.treasury, t2].map((t, i) =>
      guardTransfer(h, t, `0x${String(i + 1).padStart(40, "0")}`, 1000),
    );
    const all = Promise.allSettled(calls);
    await new Promise((r) => setTimeout(r, 10));
    gate.resolve();
    const results = await all;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.inner.calls.transferCredits).toHaveLength(1);
  });

  it("a second Treasury in the same process does not recover live rows", async () => {
    const h = harness({ balance: 100_000 });
    const r = await h.treasury.reserve(transferQuote(CHILD_ADDRESS, 100));
    const s = await h.treasury.reserve(transferQuote(OTHER_ADDRESS, 100));
    h.treasury.markSent(s);
    h.clock.advance(10_000);
    const t2 = h.newTreasury();
    expect(t2.statusOf(r.id)).toBe("reserved");
    expect(t2.statusOf(s.id)).toBe("sent");
    h.treasury.markSent(r);
  });
});

// ─── Crash recovery, clock steps, pruning ───────────────────────

function seedOpenRow(raw: any, id: string, status: "reserved" | "sent", bootId: string | null, createdAt: number): void {
  raw
    .prepare(
      `INSERT INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents, debits_credits,
         counterparty, dedupe_key, origin_type, boot_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'credit_transfer', 'transfer', ?, 400, 1, ?, ?, 'unattributed', ?, ?, ?)`,
    )
    .run(id, id, status, CHILD_ADDRESS, `k-${id}`, bootId, createdAt, createdAt);
}

describe("crash recovery", () => {
  it("releases reserved rows and marks sent rows unknown from an earlier process", () => {
    const h = harness({ balance: 100_000 });
    seedOpenRow(h.raw, "r1", "reserved", "old-boot", T0 - 5000);
    seedOpenRow(h.raw, "s1", "sent", "old-boot", T0 - 5000);
    seedOpenRow(h.raw, "s2", "sent", null, T0 - 5000);
    // Another live process that started after us: untouched.
    seedOpenRow(h.raw, "live", "sent", "other-live", T0 + 5000);
    h.clock.advance(10_000);
    const t = h.newTreasury({ bootId: "new-boot", processStartMs: T0 });
    expect(t.statusOf("r1")).toBe("released");
    expect(t.statusOf("s1")).toBe("unknown");
    expect(t.statusOf("s2")).toBe("unknown");
    expect(t.statusOf("live")).toBe("sent");
    // A row of another boot left open for over an hour belongs to a dead process.
    h.clock.advance(HOUR_MS + 5001);
    expect(t.recover()).toEqual({ released: 0, unknown: 1 });
    expect(t.statusOf("live")).toBe("unknown");
  });

  it("under the instance lock, startup recovers a dead boot's rows even with the clock behind them (review TREASURY-6)", () => {
    const h = harness({ balance: 100_000 });
    // The dead boot wrote its rows 10 minutes "in the future": the clock stepped back since.
    seedOpenRow(h.raw, "r1", "reserved", "dead-boot", T0 + 10 * 60_000);
    seedOpenRow(h.raw, "s1", "sent", "dead-boot", T0 + 10 * 60_000);
    const unlocked = h.newTreasury({ bootId: "boot-b", processStartMs: T0 });
    expect(unlocked.statusOf("s1")).toBe("sent");
    const t = h.newTreasury({ bootId: "boot-c", processStartMs: T0, holdsInstanceLock: true });
    expect(t.statusOf("r1")).toBe("released");
    expect(t.statusOf("s1")).toBe("unknown");
    // Its own rows are never touched.
    seedOpenRow(h.raw, "mine", "sent", "boot-c", T0 + 10 * 60_000);
    expect(t.recover({ allOtherBoots: true })).toEqual({ released: 0, unknown: 0 });
    expect(t.statusOf("mine")).toBe("sent");
  });

  it("a recovered sent row stays counted and replays with its key", async () => {
    const h = harness({ balance: 100_000 });
    seedOpenRow(h.raw, "s1", "sent", "old-boot", T0 - 5000);
    h.raw.prepare("UPDATE treasury_ledger SET dedupe_key = ? WHERE id = 's1'").run(transferQuote(CHILD_ADDRESS, 400).dedupeKey);
    const t = h.newTreasury({ bootId: "new-boot" });
    expect(t.usage("transfer", HOUR_MS)).toBe(400);
    const r = await t.reserve(transferQuote(CHILD_ADDRESS, 400));
    expect(r).toMatchObject({ replayOf: "s1", idempotencyKey: "s1" });
  });
});

describe("clock steps", () => {
  it("a backward clock step does not reset caps, cooldowns or single-flight", async () => {
    const h = harness({ balance: 1_000_000, policy: { ...WIDE, transferCooldownMs: 60_000 } });
    const t = h.treasury;
    await spend(t, transferQuote("0x00000000000000000000000000000000000000a1", 5000));
    h.clock.advance(61_000);
    await spend(t, transferQuote("0x00000000000000000000000000000000000000a2", 5000));
    const topup = await t.reserve(topupQuote(h.clock.now(), 5));
    t.markSent(topup);
    t.settle(topup, { outcome: "unknown", reason: "502" });

    h.clock.advance(-2 * HOUR_MS);
    expect(t.usage("transfer", HOUR_MS)).toBe(10_000);
    const err = await denied(t.reserve(transferQuote(CHILD_ADDRESS, 1)));
    expect(["SPEND_LIMIT_EXCEEDED", "TRANSFER_COOLDOWN"]).toContain(err.code);
    // With the cooldown off, the hourly cap alone still binds.
    const t2 = h.newTreasury({ policy: { ...t.policy, transferCooldownMs: 0 } });
    await expectDenied(t2.reserve(transferQuote(CHILD_ADDRESS, 1)), "SPEND_LIMIT_EXCEEDED");
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 10)), "TOPUP_IN_FLIGHT");
  });
});

describe("ledger hygiene", () => {
  it("collapses identical denials within 60s", async () => {
    const h = harness({ balance: 100_000 });
    for (let i = 0; i < 3; i++) {
      await expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 9999)), "SPEND_LIMIT_EXCEEDED");
      h.clock.advance(1000);
    }
    expect(h.rows("transfer")).toHaveLength(1);
    expect(h.rows("transfer")[0].deny_count).toBe(3);
    h.clock.advance(61_000);
    await expectDenied(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 9999)), "SPEND_LIMIT_EXCEEDED");
    expect(h.rows("transfer")).toHaveLength(2);
  });

  it("prunes old denied and released rows, at most hourly from reserve", async () => {
    const h = harness({ balance: 100_000 });
    const t = h.treasury;
    await expectDenied(t.reserve(transferQuote(CHILD_ADDRESS, 9999)), "SPEND_LIMIT_EXCEEDED");
    const rel = await t.reserve(transferQuote(CHILD_ADDRESS, 100));
    t.settle(rel, { outcome: "released", reason: "x" });
    const kept = await spend(t, transferQuote(OTHER_ADDRESS, 100));
    h.clock.advance(31 * DAY_MS);
    await spend(t, transferQuote(CHILD_ADDRESS, 100));
    const statuses = h.rows("transfer").map((r) => r.status);
    expect(statuses).toEqual(["committed", "committed"]);
    expect(t.statusOf(kept.id)).toBe("committed");
  });
});

describe("legacy copy", () => {
  function seedLegacy(raw: any): void {
    const at = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
    const ins = raw.prepare(
      `INSERT INTO spend_tracking (id, tool_name, amount_cents, recipient, domain, category, window_hour, window_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'h', 'd', ?)`,
    );
    ins.run("L1", "transfer_credits", 9000, CHILD_ADDRESS, null, "transfer", at(T0 - 10 * 60_000));
    ins.run("L2", "x402_fetch", 0, null, "api.conway.tech", "x402", at(T0 - 10 * 60_000));
    ins.run("L3", "transfer_credits", 5000, CHILD_ADDRESS, null, "transfer", at(T0 - 2 * DAY_MS));
    ins.run("L4", "transfer_credits", 10.5, CHILD_ADDRESS, null, "transfer", at(T0 - 60_000));
    ins.run("L5", "inference", 300, null, null, "inference", at(T0 - 60_000));
    ins.run("L6", "x402_fetch", 40, null, "api.conway.tech", "x402", at(T0 - 60_000));
  }

  it("copies the last day of real transfer and x402 spend once", async () => {
    // A database from before schema 12 has no ledger yet.
    const preLedger = (raw: any) => {
      raw.exec("DROP TABLE treasury_ledger");
      seedLegacy(raw);
    };
    const h = harness({ balance: 100_000, policy: WIDE, beforeTreasury: preLedger });
    const legacy = h.rows().filter((r) => r.kind === "legacy");
    expect(legacy.map((r) => [r.id, r.budget, r.amount_cents, r.status])).toEqual([
      ["L1", "transfer", 9000, "committed"],
      ["L6", "x402", 40, "committed"],
    ]);
    expect(legacy[0].created_at_ms).toBe(T0 - 10 * 60_000);
    expect(legacy[1].amount_atomic).toBe(400_000);
    h.newTreasury();
    expect(h.rows().filter((r) => r.kind === "legacy")).toHaveLength(2);
    await expectDenied(h.treasury.reserve(transferQuote(OTHER_ADDRESS, 1001)), "SPEND_LIMIT_EXCEEDED");
    await spend(h.treasury, transferQuote(OTHER_ADDRESS, 1000));
    expect(h.treasury.usage("x402", HOUR_MS)).toBe(40);
  });

  it("schema migration 12 creates the ledger and copies legacy spend on upgrade", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "automaton-treasury-")), "state.db");
    const before = createDatabase(dbPath);
    // Turn it back into a schema-11 database holding spend from before the upgrade.
    before.raw.exec("DROP TABLE treasury_ledger");
    before.raw.prepare("DELETE FROM schema_version WHERE version >= 12").run();
    new SpendTracker(before.raw).recordSpend({ toolName: "transfer_credits", amountCents: 9000, category: "transfer" });
    before.close();

    const upgraded = createDatabase(dbPath);
    try {
      const rows = listLedgerRows(upgraded.raw);
      expect(rows.map((r) => [r.kind, r.budget, r.status, r.amount_cents])).toEqual([
        ["legacy", "transfer", "committed", 9000],
      ]);
      const v = upgraded.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      // Later migrations run in the same upgrade.
      expect(v.v).toBe(SCHEMA_VERSION);
    } finally {
      upgraded.close();
    }
    // Opening again neither re-runs the migration nor duplicates the copy.
    const reopened = createDatabase(dbPath);
    try {
      expect(listLedgerRows(reopened.raw)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("does not copy into a ledger that already exists", () => {
    const h = harness({ balance: 100_000 });
    seedLegacy(h.raw);
    h.newTreasury();
    expect(h.rows().filter((r) => r.kind === "legacy")).toHaveLength(0);
  });
});

// ─── reconcile ──────────────────────────────────────────────────

describe("reconcileX402", () => {
  async function unknownPayment(h: Harness) {
    const q = x402Quote(h.clock.now(), 250_000n);
    const r = await h.treasury.reserve(q);
    h.treasury.markSent(r);
    h.treasury.settle(r, { outcome: "unknown", reason: "502" });
    return { r, q };
  }

  it("commits a used authorization and writes the transactions row then", async () => {
    let state: boolean | null = null;
    const seen: string[] = [];
    const h = harness({
      readAuthorizationState: async (a) => {
        seen.push(a.nonce);
        return state;
      },
    });
    const { r, q } = await unknownPayment(h);
    expect(await h.treasury.reconcileX402()).toBe(0);
    expect(countTransactions(h, "x402_payment")).toBe(0);
    state = true;
    expect(await h.treasury.reconcileX402()).toBe(1);
    expect(h.treasury.statusOf(r.id)).toBe("committed");
    expect(seen.at(-1)).toBe(q.x402!.nonce);
    expect(countTransactions(h, "x402_payment")).toBe(1);
    expect(countMirror(h, "x402")).toBe(1);
  });

  it("releases an unused authorization only after validBefore + 60s, and ignores RPC errors", async () => {
    let mode: "false" | "throw" = "throw";
    const h: ReturnType<typeof harness> = harness({
      readAuthorizationState: async () => {
        if (mode === "throw") throw new Error("rpc down");
        return { used: false, blockTimestamp: Math.floor(h.clock.now() / 1000) };
      },
    });
    const { r, q } = await unknownPayment(h);
    h.clock.set((q.x402!.validBefore + 61) * 1000);
    expect(await h.treasury.reconcileX402()).toBe(0);
    mode = "false";
    h.clock.set((q.x402!.validBefore + 30) * 1000);
    expect(await h.treasury.reconcileX402()).toBe(0);
    expect(h.treasury.statusOf(r.id)).toBe("unknown");
    h.clock.set((q.x402!.validBefore + 61) * 1000);
    expect(await h.treasury.reconcileX402({ dedupeKey: q.dedupeKey })).toBe(1);
    expect(h.treasury.statusOf(r.id)).toBe("released");
  });

  it("does not release while chain time has not passed validBefore (fast host clock, lagging node)", async () => {
    let state: AuthorizationStateRead = null;
    const h = harness({ readAuthorizationState: async () => state });
    const { r, q } = await unknownPayment(h);
    // The host clock is two hours ahead of the chain.
    h.clock.set((q.x402!.validBefore + 7200) * 1000);
    state = { used: false, blockTimestamp: q.x402!.validBefore - 6840 };
    expect(await h.treasury.reconcileX402()).toBe(0);
    // A bare false carries no block time and never releases.
    state = false;
    expect(await h.treasury.reconcileX402()).toBe(0);
    expect(h.treasury.statusOf(r.id)).toBe("unknown");
    // Still counted, so a payment that settles late stays inside the caps.
    expect(h.treasury.usage("x402", DAY_MS)).toBe(25);
    // Once a block past validBefore still shows it unused, it is released.
    state = { used: false, blockTimestamp: q.x402!.validBefore + 1 };
    expect(await h.treasury.reconcileX402()).toBe(1);
    expect(h.treasury.statusOf(r.id)).toBe("released");
  });

  it("an ambiguous topup confirmed on chain refuses one identical retry, then allows buying again", async () => {
    let used: AuthorizationStateRead = null;
    const h = harness({ balance: 0, readAuthorizationState: async () => used });
    const t = h.treasury;
    const r = await t.reserve(topupQuote(h.clock.now(), 25));
    t.markSent(r);
    t.settle(r, { outcome: "unknown", reason: "502" });
    h.clock.advance(1000);
    // RPC down: still unconfirmed.
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 25)), "PAYMENT_UNCONFIRMED");
    // The chain confirms it during the retry's reconcile: the retry is refused, not paid.
    used = true;
    await expectDenied(t.reserve(topupQuote(h.clock.now(), 25)), "TOPUP_ALREADY_SETTLED");
    expect(t.statusOf(r.id)).toBe("committed");
    // Told once; a later identical topup is a new purchase.
    h.clock.advance(16 * 60_000);
    await spend(t, topupQuote(h.clock.now(), 25));
    expect(h.rows("topup", "committed")).toHaveLength(2);
    // A direct commit never triggers the refusal.
    h.clock.advance(16 * 60_000);
    await spend(t, topupQuote(h.clock.now(), 25));
  });

  it("an ambiguous topup confirmed by the startup reconcile also refuses the next identical retry once", async () => {
    const h = harness({ balance: 0, readAuthorizationState: async () => true });
    const r = await h.treasury.reserve(topupQuote(h.clock.now(), 25));
    h.treasury.markSent(r);
    h.treasury.settle(r, { outcome: "unknown", reason: "timeout" });
    expect(await h.treasury.reconcileX402({ limit: 20 })).toBe(1);
    h.clock.advance(16 * 60_000);
    await expectDenied(h.treasury.reserve(topupQuote(h.clock.now(), 25)), "TOPUP_ALREADY_SETTLED");
    await spend(h.treasury, topupQuote(h.clock.now(), 25));
  });

  it("recovers a pending payment after a crash and reconciles it by nonce", async () => {
    const h = harness({ readAuthorizationState: async () => true });
    const q = x402Quote(h.clock.now(), 250_000n);
    const r = await h.treasury.reserve(q);
    h.treasury.markSent(r);
    h.raw.prepare("UPDATE treasury_ledger SET boot_id = 'dead' WHERE id = ?").run(r.id);
    const t2 = h.newTreasury({ bootId: "next", processStartMs: h.clock.now() + 1 });
    expect(t2.statusOf(r.id)).toBe("unknown");
    expect(await t2.reconcileX402({ limit: 20 })).toBe(1);
    expect(t2.statusOf(r.id)).toBe("committed");
  });
});

// ─── Registry and origin ────────────────────────────────────────

describe("registry", () => {
  it("fails closed when no treasury is installed", () => {
    resetTreasuryForTests();
    expect(getInstalledTreasury()).toBeUndefined();
    expect(() => requireTreasury()).toThrow(TreasuryNotInstalledError);
    expect(() => requireTreasury(() => undefined)).toThrow(TreasuryNotInstalledError);
    try {
      requireTreasury();
    } catch (err) {
      expect(err).toBeInstanceOf(TreasuryDeniedError);
      expect((err as TreasuryDeniedError).code).toBe("TREASURY_NOT_INSTALLED");
    }
  });

  it("resolves explicit, then resolver, then installed", () => {
    const h = harness({ install: false });
    const other = h.newTreasury();
    expect(() => requireTreasury()).toThrow(TreasuryNotInstalledError);
    expect(requireTreasury(other)).toBe(other);
    installTreasury(h.treasury);
    expect(requireTreasury()).toBe(h.treasury);
    expect(requireTreasury(() => other)).toBe(other);
    expect(requireTreasury(() => undefined)).toBe(h.treasury);
  });

  it("keeps its state on a globalThis symbol", () => {
    const h = harness();
    const state = (globalThis as any)[Symbol.for("automaton.treasury")];
    expect(state.treasury).toBe(h.treasury);
    expect(state.bootId).toBe(processBootId());
  });

  it("records the origin on the row and defaults to unattributed", async () => {
    const h = harness({ balance: 100_000 });
    expect(currentTreasuryOrigin()).toEqual({ type: "unattributed" });
    const r1 = await spend(h.treasury, transferQuote(CHILD_ADDRESS, 100));
    const r2 = await runWithTreasuryOrigin({ type: "tool", name: "fund_child", inputSource: "agent" }, async () => {
      // The origin survives awaits inside the wrapper.
      await new Promise((res) => setTimeout(res, 1));
      return spend(h.treasury, transferQuote(OTHER_ADDRESS, 100));
    });
    expect(getLedgerRow(h.raw, r1.id)).toMatchObject({ origin_type: "unattributed", origin_name: null });
    expect(getLedgerRow(h.raw, r2.id)).toMatchObject({ origin_type: "tool", origin_name: "fund_child", input_source: "agent" });
    expect(h.tracker.getHourlySpend("transfer")).toBe(200);
    const mirror = h.raw.prepare("SELECT tool_name FROM spend_tracking ORDER BY rowid").pluck().all();
    expect(mirror).toEqual(["credit_transfer", "fund_child"]);
  });
});

describe("harness", () => {
  it("runs a tool through executeTool with the guarded client and the policy engine", async () => {
    const h = harness({ balance: 4321 });
    const result = await h.exec("check_credits", {});
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("43.21");
    const viaUntrusted = await h.exec("transfer_credits", { to_address: CHILD_ADDRESS, amount_cents: 1 }, { source: "external" });
    expect(viaUntrusted.error).toMatch(/Policy denied/);
  });
});
