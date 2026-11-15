/**
 * treasury: the owner's budget in the treasury. The budget is the balance
 * the reserve floor and the half-balance rule read for credit outflows, and
 * BUDGET_EXHAUSTED is the hard cap for every outflow kind. Standalone has no
 * credit outflow today (x402 is its only treasury spend), so the credit
 * transfer cases cover the mechanism for when one exists.
 */

import { afterEach, describe, expect, it } from "vitest";
import { BudgetMeter } from "../budget/meter.js";
import { resolveBudget } from "../budget/config.js";
import { InferenceGate } from "../inference/gate.js";
import { TreasuryDeniedError, type TreasuryDenyCode } from "../treasury/index.js";
import { CHILD_ADDRESS, makeHarness, transferQuote, x402Quote, type Harness } from "./treasury/harness.js";
import { gatePolicy, spendAi } from "./budget-fixtures.js";

let open: Harness[] = [];
afterEach(() => {
  for (const h of open) h.close();
  open = [];
});

/** A harness whose treasury reads the budget as its balance, standalone style. */
function budgetHarness(allowanceCents: number, opts: { countTreasury?: boolean; policy?: Record<string, number> } = {}) {
  let meter!: BudgetMeter;
  let hRef: Harness | undefined;
  const now = () => hRef!.clock.now();
  const budget = resolveBudget({ allowanceCents, period: "monthly", countTreasury: opts.countTreasury ?? true })!;
  const h = makeHarness({
    policy: { maxSingleTransferCents: 5000, requireConfirmationAboveCents: 5000, minimumReserveCents: 1000, ...opts.policy },
    treasuryDeps: (raw) => {
      meter = new BudgetMeter({ db: raw, budget, owner: { grants: () => ({ sumCents: 0, count: 0, stale: false }) }, now });
      return {
        readCreditBalance: async () => meter.snapshot().remainingCents,
        budget: { remainingCents: (n: number) => meter.remainingCents(n), countsTreasury: budget.countTreasury },
      };
    },
  });
  hRef = h;
  open.push(h);
  const gate = new InferenceGate({ db: h.raw, policy: gatePolicy(), now, bootId: "boot-t", budget: meter });
  gate.setSurvival({ tier: "high", creditsCents: null });
  return { h, meter, gate };
}

async function code(p: Promise<unknown>): Promise<TreasuryDenyCode | "ok"> {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof TreasuryDeniedError) return err.code;
    throw err;
  }
}

describe("treasury: the budget as the balance (credit outflows)", () => {
  it("the reserve floor applies to the remaining budget", async () => {
    const { h } = budgetHarness(3000);
    expect(await code(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 2001)))).toBe("RESERVE_VIOLATION");
    const r = await h.treasury.reserve(transferQuote(CHILD_ADDRESS, 1000));
    expect(r.amountCents).toBe(1000);
  });

  it("the half-balance rule applies to the remaining budget", async () => {
    const { h } = budgetHarness(4000);
    // 4000 - 2100 = 1900 >= the 1000 reserve, but 2100 > half of 4000.
    expect(await code(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 2100)))).toBe("HALF_BALANCE");
    expect(await code(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 2000)))).toBe("ok");
  });

  it("AI spend lowers what the treasury may move", async () => {
    const { h, gate } = budgetHarness(3000);
    expect(await code(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 1100, { dedupeKey: "a" })))).toBe("ok");
    h.raw.prepare("DELETE FROM treasury_ledger").run();
    spendAi(gate, 1000);
    // 2000 left: 2000 - 1100 = 900, below the 1000 reserve.
    expect(await code(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 1100, { dedupeKey: "b" })))).toBe("RESERVE_VIOLATION");
  });

  it("neither rule applies to x402, standalone's only treasury spend", async () => {
    // 1040 - 50 = 990, below the 1000 reserve: allowed, only BUDGET_EXHAUSTED limits x402.
    let { h } = budgetHarness(1040);
    expect(await code(h.treasury.reserve(x402Quote(h.clock.now(), 500_000n)))).toBe("ok");
    // 50c is more than half of an 80c budget: allowed too.
    ({ h } = budgetHarness(80, { policy: { minimumReserveCents: 0 } }));
    expect(await code(h.treasury.reserve(x402Quote(h.clock.now(), 500_000n)))).toBe("ok");
  });
});

describe("treasury: BUDGET_EXHAUSTED", () => {
  it("refuses an x402 payment above what the budget has left", async () => {
    const { h, gate } = budgetHarness(100, { policy: { minimumReserveCents: 0 } });
    spendAi(gate, 50);
    // 60c of USDC against 50c left. x402 skips the reserve floor; the budget does not.
    expect(await code(h.treasury.reserve(x402Quote(h.clock.now(), 600_000n)))).toBe("BUDGET_EXHAUSTED");
    expect(await code(h.treasury.reserve(x402Quote(h.clock.now(), 500_000n)))).toBe("ok");
    expect(await code(h.treasury.reserve(x402Quote(h.clock.now(), 1n)))).toBe("BUDGET_EXHAUSTED");
  });

  it("refuses a credit transfer above what the budget has left, before the reserve floor", async () => {
    const { h } = budgetHarness(500, { policy: { minimumReserveCents: 0 } });
    expect(await code(h.treasury.reserve(transferQuote(CHILD_ADDRESS, 501)))).toBe("BUDGET_EXHAUSTED");
  });

  it("does not apply with countTreasury false", async () => {
    const { h, gate } = budgetHarness(100, { countTreasury: false, policy: { minimumReserveCents: 0 } });
    spendAi(gate, 90);
    expect(await code(h.treasury.reserve(x402Quote(h.clock.now(), 600_000n)))).toBe("ok");
  });
});
