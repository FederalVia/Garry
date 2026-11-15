/**
 * financial: the budget meter. remaining = allowance + grants - AI spend -
 * treasury spend in the period, in-flight work counted, totals kept across
 * the 30-day ledger prune, owner database failures on the safe side.
 */

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Treasury, normalizeTreasuryPolicy, resetTreasuryForTests } from "../treasury/index.js";
import { createStandaloneClient } from "../providers/standalone-client.js";
import { OwnerDbReader } from "../budget/owner-db.js";
import { DAY, MAIN, makeBudgetEnv, newBudgetGate, req, spendAi, type BudgetEnv } from "./budget-fixtures.js";

const SELF = "0x1234567890abcdef1234567890abcdef12345678";
const PEER = "0x0000000000000000000000000000000000000b0b";

let envs: BudgetEnv[] = [];
function env(raw?: unknown, start?: number): BudgetEnv {
  const e = makeBudgetEnv(raw, start);
  envs.push(e);
  return e;
}
afterEach(() => {
  resetTreasuryForTests();
  for (const e of envs) e.close();
  envs = [];
});

function treasuryFor(e: BudgetEnv): Treasury {
  return new Treasury({
    db: e.raw,
    policy: normalizeTreasuryPolicy({ maxSingleTransferCents: 1000, requireConfirmationAboveCents: 1000, minimumReserveCents: 0 }),
    selfAddress: SELF,
    readCreditBalance: async () => 1_000_000,
    now: e.clock.now,
  });
}

function quote(amount: number, to = PEER, n = Math.random()) {
  return {
    kind: "credit_transfer" as const,
    amountCents: amount,
    amountBasis: "exact" as const,
    counterparty: to,
    dedupeKey: `test|${to}|${amount}|${n}`,
    description: "test",
  };
}

describe("financial: remaining", () => {
  it("is allowance + grants - AI spend - treasury spend", async () => {
    const e = env({ allowanceCents: 2500 });
    const gate = newBudgetGate(e);
    const t = treasuryFor(e);
    e.owner((w) => w.addGrant(1000, "extra", e.clock.now()));
    spendAi(gate, 300);
    const r = await t.reserve(quote(200));
    t.markSent(r);
    t.settle(r, { outcome: "committed" });
    const s = e.meter.snapshot();
    expect(s.allowanceCents).toBe(2500);
    expect(s.grantsCents).toBe(1000);
    expect(s.grantCount).toBe(1);
    expect(s.totalCents).toBe(3500);
    expect(s.aiSpentMicroUsd).toBe(300 * 10_000);
    expect(s.treasurySpentCents).toBe(200);
    expect(s.remainingCents).toBe(3000);
    expect(s.remainingMicroUsd).toBe(3000 * 10_000);
    expect(s.ownerDbStale).toBe(false);
  });

  it("monthly: grants count only in the period they were made; one-off: every grant", () => {
    const e = env({ allowanceCents: 1000 });
    const feb = Date.UTC(2026, 1, 20);
    e.owner((w) => {
      w.addGrant(500, "february", feb);
      w.addGrant(700, "march", e.clock.now());
    });
    expect(e.meter.snapshot().grantsCents).toBe(700);
    expect(e.meter.snapshot(Date.UTC(2026, 3, 2)).grantsCents).toBe(0);

    const o = env({ allowanceCents: 1000, period: "one-off", startDate: "2026-02-01" });
    o.owner((w) => {
      w.addGrant(500, "february", feb);
      w.addGrant(700, "march", o.clock.now());
      w.addGrant(900, "before the start", Date.UTC(2026, 0, 15));
    });
    expect(o.meter.snapshot().grantsCents).toBe(1200);
  });

  it("a negative grant (budget remove) lowers it", () => {
    const e = env({ allowanceCents: 1000 });
    e.owner((w) => w.addGrant(-300, "correction", e.clock.now()));
    expect(e.meter.snapshot().remainingCents).toBe(700);
  });

  it("open gate reservations and unknown rows count at the reserved amount; released rows count 0", () => {
    const e = env({ allowanceCents: 1000 });
    const gate = newBudgetGate(e);
    const open = gate.reserve(req(100));
    expect(e.meter.snapshot().remainingCents).toBe(900);
    const unknown = gate.reserve(req(50));
    gate.markUnknown(unknown.id, "timeout");
    expect(e.meter.snapshot().remainingCents).toBe(850);
    const released = gate.reserve(req(70));
    gate.release(released.id, "refused");
    expect(e.meter.snapshot().remainingCents).toBe(850);
    gate.commit(open.id, { inputTokens: 100_000, outputTokens: 1 }, 1);
    // 100,000 input tokens at $2/M + 1 output at $8/M: 20 cents and 8 micro-USD.
    expect(e.meter.snapshot().aiSpentMicroUsd).toBe(200_008 + 500_000);
  });

  it("every budget class counts, survival included", () => {
    const e = env({ allowanceCents: 1000 });
    const gate = newBudgetGate(e);
    spendAi(gate, 10, MAIN);
    spendAi(gate, 20, { caller: "orchestrator.plan" });
    spendAi(gate, 5, { caller: "survival_turn" });
    expect(e.meter.snapshot().remainingCents).toBe(965);
  });

  it("treasury reserved, sent, unknown and committed rows count; denied and released do not", async () => {
    const e = env({ allowanceCents: 5000 });
    const t = treasuryFor(e);
    await t.reserve(quote(100)); // reserved
    const sent = await t.reserve(quote(200));
    t.markSent(sent);
    const unknown = await t.reserve(quote(300));
    t.markSent(unknown);
    t.settle(unknown, { outcome: "unknown", reason: "timeout" });
    const committed = await t.reserve(quote(400));
    t.markSent(committed);
    t.settle(committed, { outcome: "committed" });
    const released = await t.reserve(quote(500));
    t.settle(released, { outcome: "released", reason: "nothing sent" });
    await expect(t.reserve(quote(600, SELF))).rejects.toThrow(/own address/);
    expect(e.meter.snapshot().treasurySpentCents).toBe(1000);
    expect(e.meter.snapshot().remainingCents).toBe(4000);
  });

  it("countTreasury false leaves treasury spend out", async () => {
    const e = env({ allowanceCents: 5000, countTreasury: false });
    const t = treasuryFor(e);
    const r = await t.reserve(quote(400));
    t.markSent(r);
    t.settle(r, { outcome: "committed" });
    expect(e.meter.snapshot().treasurySpentCents).toBe(0);
    expect(e.meter.snapshot().remainingCents).toBe(5000);
  });

  it("negative remaining stays negative in the snapshot; the reported balance is 0 and the tier critical", async () => {
    const e = env({ allowanceCents: 100 });
    const gate = newBudgetGate(e);
    const r = gate.reserve(req(90));
    // Usage reported far above the reservation (a provider that over-bills).
    gate.commit(r.id, { inputTokens: 1_000_000, outputTokens: 1 }, 1);
    const s = e.meter.snapshot();
    expect(s.remainingCents).toBeLessThan(0);
    expect(s.tier).toBe("critical");
    const client = createStandaloneClient({ budget: e.meter });
    await expect(client.getCreditsBalance()).resolves.toBe(0);
  });
});

describe("financial: totals survive the 30-day prune", () => {
  it("a one-off budget keeps rows 40 days old after a gate prunes them; older-period rows stay out", () => {
    const start = Date.UTC(2026, 0, 1, 12);
    const e = env({ allowanceCents: 10_000, period: "one-off", startDate: "2026-01-01" }, start);
    const before = newBudgetGate(e, undefined, false);
    // Spent before the budget started: never counted.
    e.clock.set(Date.UTC(2025, 11, 30, 12));
    spendAi(before, 77);
    e.clock.set(start);
    spendAi(before, 100);
    spendAi(before, 23, { caller: "orchestrator.plan" });
    e.clock.set(start + 5 * DAY);
    spendAi(before, 50);
    e.clock.set(start + 40 * DAY);
    const snapBefore = e.meter.snapshot();
    expect(snapBefore.aiSpentMicroUsd).toBe(173 * 10_000);

    newBudgetGate(e); // rollup + prune at construction
    const rows = e.raw.prepare("SELECT COUNT(*) FROM inference_ledger").pluck().get();
    expect(rows).toBe(0);
    const rolled = e.raw
      .prepare("SELECT day_start_ms, budget_class, held_micro_usd, calls FROM inference_spend_rollup ORDER BY 1, 2")
      .all();
    expect(rolled).toEqual([
      { day_start_ms: Date.UTC(2025, 11, 30), budget_class: "main", held_micro_usd: 770_000, calls: 1 },
      { day_start_ms: Date.UTC(2026, 0, 1), budget_class: "main", held_micro_usd: 1_000_000, calls: 1 },
      { day_start_ms: Date.UTC(2026, 0, 1), budget_class: "orchestration", held_micro_usd: 230_000, calls: 1 },
      { day_start_ms: Date.UTC(2026, 0, 6), budget_class: "main", held_micro_usd: 500_000, calls: 1 },
    ]);
    expect(e.meter.snapshot()).toEqual(snapBefore);

    // A second prune adds nothing twice.
    newBudgetGate(e);
    expect(e.meter.snapshot()).toEqual(snapBefore);
  });

  it("Treasury.prune never touches counted rows", async () => {
    const e = env({ allowanceCents: 50_000, period: "one-off", startDate: "2026-01-01" }, Date.UTC(2026, 0, 2));
    const t = treasuryFor(e);
    const c = await t.reserve(quote(400));
    t.markSent(c);
    t.settle(c, { outcome: "committed" });
    const u = await t.reserve(quote(300));
    t.markSent(u);
    t.settle(u, { outcome: "unknown", reason: "timeout" });
    const rel = await t.reserve(quote(200));
    t.settle(rel, { outcome: "released", reason: "nothing sent" });
    e.clock.advance(60 * DAY);
    const deleted = t.prune();
    expect(deleted).toBe(1);
    const statuses = (e.raw.prepare("SELECT status FROM treasury_ledger ORDER BY status").pluck().all() as string[]);
    expect(statuses).toEqual(["committed", "unknown"]);
    expect(e.meter.snapshot().treasurySpentCents).toBe(700);
  });
});

describe("financial: the owner database", () => {
  it("missing: no grants, not stale", () => {
    const e = env({ allowanceCents: 1000 });
    const s = e.meter.snapshot();
    expect(s.grantsCents).toBe(0);
    expect(s.ownerDbStale).toBe(false);
  });

  it("locked by the owner: the last good value, flagged stale", () => {
    const e = env({ allowanceCents: 1000 });
    e.owner((w) => w.addGrant(400, "first", e.clock.now()));
    expect(e.meter.snapshot().grantsCents).toBe(400);
    const writer = new Database(e.ownerPath);
    try {
      writer.exec("BEGIN EXCLUSIVE");
      writer.prepare("INSERT INTO budget_grants (amount_cents, note, created_at_ms) VALUES (5000, 'uncommitted', ?)").run(e.clock.now());
      const s = e.meter.snapshot();
      expect(s.grantsCents).toBe(400);
      expect(s.ownerDbStale).toBe(true);
      writer.exec("ROLLBACK");
    } finally {
      writer.close();
    }
    const after = e.meter.snapshot();
    expect(after.grantsCents).toBe(400);
    expect(after.ownerDbStale).toBe(false);
  });

  it("locked before any good read: 0 grants (the safe side)", () => {
    const e = env({ allowanceCents: 1000 });
    e.owner((w) => w.addGrant(400, "first", e.clock.now()));
    const fresh = new OwnerDbReader(e.ownerPath);
    const writer = new Database(e.ownerPath);
    try {
      writer.exec("BEGIN EXCLUSIVE");
      writer.prepare("INSERT INTO budget_grants (amount_cents, note, created_at_ms) VALUES (1, 'x', 1)").run();
      expect(fresh.grants(0, null)).toEqual({ sumCents: 0, count: 0, stale: true });
      writer.exec("ROLLBACK");
    } finally {
      writer.close();
      fresh.close();
    }
  });

  it("a WAL-mode owner database is refused (read as stale, 0 grants)", () => {
    const e = env({ allowanceCents: 1000 });
    e.owner((w) => w.addGrant(400, "first", e.clock.now()));
    const db = new Database(e.ownerPath);
    db.pragma("journal_mode = WAL");
    db.close();
    const fresh = new OwnerDbReader(e.ownerPath);
    try {
      expect(fresh.grants(0, null)).toEqual({ sumCents: 0, count: 0, stale: true });
    } finally {
      fresh.close();
    }
  });
});
