/**
 * financial: the hard period cap inside the inference gate. Every paid call
 * of every class is checked against the owner's budget first, inside the
 * gate's immediate transaction; the survival allowance cannot exceed it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ONE_OFF_RETRY_MS, resetInferenceGateForTests } from "../inference/gate.js";
import { InferenceRefusedError } from "../inference/errors.js";
import { Treasury, normalizeTreasuryPolicy } from "../treasury/index.js";
import { resolveRuntime } from "../providers/mode.js";
import { resolveInferencePolicy } from "../inference/policy.js";
import { defaultDailyCapCents } from "../budget/config.js";
import { createTestConfig } from "./mocks.js";
import { MAIN, ORCH, SURVIVAL, gatePolicy, makeBudgetEnv, newBudgetGate, req, spendAi, type BudgetEnv } from "./budget-fixtures.js";

let envs: BudgetEnv[] = [];
function env(raw?: unknown, start?: number): BudgetEnv {
  const e = makeBudgetEnv(raw, start);
  envs.push(e);
  return e;
}
afterEach(() => {
  resetInferenceGateForTests();
  for (const e of envs) e.close();
  envs = [];
});

function refusal(fn: () => unknown): InferenceRefusedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof InferenceRefusedError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("financial: PERIOD_CAP", () => {
  it.each([
    ["main", MAIN],
    ["orchestration", ORCH],
    ["survival", SURVIVAL],
  ] as const)("refuses a %s call that needs more than the budget has left", (_label, scope) => {
    const e = env({ allowanceCents: 100 });
    const gate = newBudgetGate(e);
    spendAi(gate, 95);
    const r = refusal(() => gate.reserve(req(6, scope)));
    expect(r.code).toBe("PERIOD_CAP");
    expect(r.message).toContain("automaton-cli budget add");
    // Exactly what is left still fits.
    expect(() => gate.reserve(req(5, scope))).not.toThrow();
  });

  it("retryAfterMs is the end of the monthly period; 30 minutes for a one-off budget", () => {
    const e = env({ allowanceCents: 10 });
    const gate = newBudgetGate(e);
    const r = refusal(() => gate.reserve(req(11)));
    expect(r.retryAfterMs).toBe(Date.UTC(2026, 3, 1) - e.clock.now());
    const o = env({ allowanceCents: 10, period: "one-off", startDate: "2026-03-01" });
    const og = newBudgetGate(o);
    expect(refusal(() => og.reserve(req(11))).retryAfterMs).toBe(ONE_OFF_RETRY_MS);
  });

  it("usage() reports what is left of the budget, for the planner", () => {
    const e = env({ allowanceCents: 100 });
    const gate = newBudgetGate(e);
    spendAi(gate, 70);
    expect(gate.usage().remaining.periodCents).toBeCloseTo(30, 5);
  });

  it("a free local model passes", () => {
    const e = env({ allowanceCents: 0 });
    const gate = newBudgetGate(e);
    const r = gate.reserve(req(5, MAIN, { price: { inputUsdPerM: 0, outputUsdPerM: 0, local: true }, provider: "ollama" }));
    expect(r.reservedMicroUsd).toBe(0);
    expect(refusal(() => gate.reserve(req(1))).code).toBe("PERIOD_CAP");
  });

  it("a zero allowance spends nothing paid until the owner grants, then the grant is spendable", () => {
    const raw = { allowanceCents: 0, period: "one-off", startDate: "2026-03-01" };
    const rt = resolveRuntime({ providers: { mode: "standalone" }, budget: raw } as never);
    const daily = defaultDailyCapCents({ allowanceCents: 0 });
    const e = env(raw);
    const gate = newBudgetGate(e, gatePolicy(daily, { ceiling: rt.dailyCapCeilingCents, room: rt.survivalRoomCents }));
    expect(refusal(() => gate.reserve(req(1))).code).toBe("PERIOD_CAP");
    expect(refusal(() => gate.reserve(req(1, SURVIVAL))).code).toBe("PERIOD_CAP");
    e.owner((w) => w.addGrant(5000, "top-up", e.clock.now() - 1000));
    expect(() => spendAi(gate, 1)).not.toThrow();
    expect(() => spendAi(gate, 1, SURVIVAL)).not.toThrow();
  });

  it("sequential reserves see each other's open rows", () => {
    const e = env({ allowanceCents: 100 });
    const gate = newBudgetGate(e);
    gate.reserve(req(60));
    expect(refusal(() => gate.reserve(req(60))).code).toBe("PERIOD_CAP");
    gate.reserve(req(40));
    expect(refusal(() => gate.reserve(req(1))).code).toBe("PERIOD_CAP");
  });

  it("a grant raises the headroom on the next reserve", () => {
    const e = env({ allowanceCents: 100 });
    const gate = newBudgetGate(e);
    spendAi(gate, 100);
    expect(refusal(() => gate.reserve(req(50))).code).toBe("PERIOD_CAP");
    e.owner((w) => w.addGrant(50, "more", e.clock.now()));
    expect(() => gate.reserve(req(50))).not.toThrow();
  });

  it("treasury spend lowers the gate's headroom", async () => {
    const e = env({ allowanceCents: 1000 });
    const gate = newBudgetGate(e);
    const t = new Treasury({
      db: e.raw,
      policy: normalizeTreasuryPolicy({ minimumReserveCents: 0 }),
      selfAddress: "0x1234567890abcdef1234567890abcdef12345678",
      readCreditBalance: async () => 1_000_000,
      now: e.clock.now,
    });
    const r = await t.reserve({
      kind: "credit_transfer",
      amountCents: 950,
      amountBasis: "exact",
      counterparty: "0x0000000000000000000000000000000000000b0b",
      dedupeKey: "test|950",
      description: "test",
    });
    t.markSent(r);
    expect(refusal(() => gate.reserve(req(51))).code).toBe("PERIOD_CAP");
    expect(() => gate.reserve(req(50))).not.toThrow();
  });

  it("headroom() reports PERIOD_CAP", () => {
    const e = env({ allowanceCents: 10 });
    const gate = newBudgetGate(e);
    expect(gate.headroom("main").allowed).toBe(true);
    spendAi(gate, 10);
    const h = gate.headroom("main");
    expect(h).toMatchObject({ allowed: false, code: "PERIOD_CAP" });
    expect(gate.headroom("survival").code).toBe("PERIOD_CAP");
  });

  it("is checked before the task cap and the survival branch", () => {
    const e = env({ allowanceCents: 10 });
    const gate = newBudgetGate(e);
    spendAi(gate, 10);
    expect(refusal(() => gate.reserve(req(1, { caller: "worker", taskId: "t1", taskCapCents: 0 }))).code).toBe("PERIOD_CAP");
  });

  it("without a budget nothing changes", () => {
    const e = env({ allowanceCents: 10 });
    const gate = newBudgetGate(e, gatePolicy(), false);
    expect(() => gate.reserve(req(500))).not.toThrow();
  });

  it("starts at the budget's tier, not unknown", () => {
    const e = env({ allowanceCents: 1000 });
    const gate = newBudgetGate(e);
    spendAi(gate, 900); // 100 left of 1000: low_compute (normal > 150, low_compute > 50)
    const fresh = new (gate.constructor as typeof import("../inference/gate.js").InferenceGate)({
      db: e.raw,
      policy: gatePolicy(),
      now: e.clock.now,
      budget: e.meter,
    });
    expect(fresh.survival()).toEqual({ tier: "low_compute", creditsCents: 100 });
  });
});

describe("financial: the survival allowance stays inside the period cap", () => {
  it("with a budget and daily cap = ceiling, survival turns get 25c of room", () => {
    const config = createTestConfig({
      conwayApiKey: undefined,
      openaiApiKey: "sk-test",
      providers: { mode: "standalone" },
      budget: { allowanceCents: 2500, period: "monthly" },
      treasuryPolicy: { ...normalizeTreasuryPolicy({}), maxInferenceDailyCents: 167 },
    });
    const runtime = resolveRuntime(config);
    expect(runtime.dailyCapCeilingCents).toBe(167);
    expect(runtime.survivalRoomCents).toBe(25);
    const p = resolveInferencePolicy(config, config.treasuryPolicy, {
      ceilingCents: runtime.dailyCapCeilingCents,
      survivalRoomCents: runtime.survivalRoomCents,
    });
    expect(p.dailyCapCents).toBe(167);
    expect(p.survivalAllowanceCents).toBe(25);
    // Without the room (the rule before budgets) it would be 0.
    expect(resolveInferencePolicy(config, config.treasuryPolicy, { ceilingCents: 167 }).survivalAllowanceCents).toBe(0);
  });

  it("a survival call larger than the remaining budget is still refused with PERIOD_CAP", () => {
    const e = env({ allowanceCents: 200 });
    const p = gatePolicy(167, { ceiling: 167, room: 25, strategy: { survivalMinIntervalMs: 0, hourlyBudgetCents: 167 } });
    expect(p.survivalAllowanceCents).toBe(25);
    const gate = newBudgetGate(e, p);
    spendAi(gate, 167);
    spendAi(gate, 25, SURVIVAL);
    // 8c left; the survival allowance is used up too, but the budget answers first.
    expect(refusal(() => gate.reserve(req(9, SURVIVAL))).code).toBe("PERIOD_CAP");
    // Inside the budget, the daily survival allowance still binds.
    expect(refusal(() => gate.reserve(req(5, SURVIVAL))).code).toBe("SURVIVAL_ALLOWANCE");
  });
});
