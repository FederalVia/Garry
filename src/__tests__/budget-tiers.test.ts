/**
 * Survival tiers from the owner's budget: percentage and cents thresholds,
 * grants changing the base, and the unchanged Conway defaults.
 */

import { afterEach, describe, expect, it } from "vitest";
import { getSurvivalTier } from "../conway/credits.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";
import { currentSurvivalThresholds, installSurvivalThresholds, resolveThresholds } from "../budget/thresholds.js";
import { installBudget } from "../budget/index.js";
import { makeBudgetEnv, newBudgetGate, spendAi, type BudgetEnv } from "./budget-fixtures.js";

let env: BudgetEnv | undefined;
afterEach(() => {
  installBudget(null);
  env?.close();
  env = undefined;
});

describe("thresholds", () => {
  it("percent of allowance + grants, floored to cents", () => {
    expect(resolveThresholds({ unit: "percent", high: 50, normal: 15, lowCompute: 5 }, 2500)).toEqual({
      high: 1250,
      normal: 375,
      low_compute: 125,
    });
    expect(resolveThresholds({ unit: "cents", high: 900, normal: 300, lowCompute: 100 }, 2500)).toEqual({
      high: 900,
      normal: 300,
      low_compute: 100,
    });
  });

  it("getSurvivalTier without thresholds keeps the Conway defaults", () => {
    expect(getSurvivalTier(501)).toBe("high");
    expect(getSurvivalTier(500)).toBe("normal");
    expect(getSurvivalTier(51)).toBe("normal");
    expect(getSurvivalTier(11)).toBe("low_compute");
    expect(getSurvivalTier(0)).toBe("critical");
    expect(getSurvivalTier(-1)).toBe("dead");
    installSurvivalThresholds(null);
    expect(currentSurvivalThresholds()).toEqual({
      high: SURVIVAL_THRESHOLDS.high,
      normal: SURVIVAL_THRESHOLDS.normal,
      low_compute: SURVIVAL_THRESHOLDS.low_compute,
    });
  });
});

describe("tiers follow the budget", () => {
  it("$25 with 50/15/5 %: spending moves high -> normal -> low_compute -> critical", () => {
    env = makeBudgetEnv({ allowanceCents: 2500 });
    const gate = newBudgetGate(env);
    const tiers = [env.meter.snapshot().tier];
    spendAi(gate, 1251); // 1249 left: not above 1250
    tiers.push(env.meter.snapshot().tier);
    spendAi(gate, 875); // 374 left
    tiers.push(env.meter.snapshot().tier);
    spendAi(gate, 250); // 124 left
    tiers.push(env.meter.snapshot().tier);
    spendAi(gate, 124); // 0 left
    tiers.push(env.meter.snapshot().tier);
    expect(tiers).toEqual(["high", "normal", "low_compute", "critical", "critical"]);
  });

  it("cents thresholds are used as given", () => {
    env = makeBudgetEnv({ allowanceCents: 2500, thresholds: { unit: "cents", high: 2000, normal: 1000, lowCompute: 100 } });
    const gate = newBudgetGate(env);
    expect(env.meter.snapshot().tier).toBe("high");
    spendAi(gate, 600);
    expect(env.meter.snapshot().tier).toBe("normal");
  });

  it("a grant raises the base of percentage thresholds", () => {
    env = makeBudgetEnv({ allowanceCents: 2500 });
    const gate = newBudgetGate(env);
    spendAi(gate, 1300); // 1200 left of 2500: normal (high > 1250)
    expect(env.meter.snapshot().tier).toBe("normal");
    env.owner((w) => w.addGrant(2500, "top-up", env!.clock.now()));
    const snap = env.meter.snapshot();
    expect(snap.totalCents).toBe(5000);
    expect(snap.thresholds.high).toBe(2500);
    expect(snap.remainingCents).toBe(3700);
    expect(snap.tier).toBe("high");
  });

  it("installBudget makes the runtime's thresholds the budget's", () => {
    env = makeBudgetEnv({ allowanceCents: 2500 });
    installBudget({ budget: env.budget, meter: env.meter, owner: env.reader });
    expect(currentSurvivalThresholds()).toEqual({ high: 1250, normal: 375, low_compute: 125 });
    expect(getSurvivalTier(1000, currentSurvivalThresholds())).toBe("normal");
    installBudget(null);
    expect(currentSurvivalThresholds().high).toBe(SURVIVAL_THRESHOLDS.high);
  });
});
