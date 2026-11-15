/**
 * Dead and revival with the owner's budget: check_budget marks the agent
 * dead after an hour at zero, wakes it when the owner adds budget or a new
 * period starts, and never kills it when the owner switched dead off; the
 * loop runs a dead agent again once the budget has money (or dead is off).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { installBudget } from "../budget/index.js";
import { createStandaloneClient } from "../providers/standalone-client.js";
import { installInferenceGate } from "../inference/gate.js";
import { runAgentLoop } from "../agent/loop.js";
import { MockInferenceClient, createTestConfig, createTestIdentity, noToolResponse } from "./mocks.js";
import { HOUR, makeBudgetEnv, newBudgetGate, spendAi, type BudgetEnv } from "./budget-fixtures.js";
import type { HeartbeatLegacyContext, TickContext } from "../types.js";

let env: BudgetEnv;
const realFetch = globalThis.fetch;

function setup(raw: Record<string, unknown> = { allowanceCents: 100 }) {
  env = makeBudgetEnv(raw);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(env.clock.now());
  installBudget({ budget: env.budget, meter: env.meter, owner: env.reader });
  return env;
}

function advance(ms: number) {
  env.clock.advance(ms);
  vi.setSystemTime(env.clock.now());
}

function config(budget: Record<string, unknown>) {
  return createTestConfig({
    conwayApiKey: "",
    sandboxId: "",
    socialRelayUrl: "",
    openaiApiKey: "sk-test",
    providers: { mode: "standalone" },
    budget: budget as never,
  });
}

function taskCtx(budget: Record<string, unknown>): HeartbeatLegacyContext {
  return {
    identity: createTestIdentity(),
    config: config(budget),
    db: env.db,
    conway: createStandaloneClient({ budget: env.meter }),
  };
}

const tick = {} as TickContext;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("no network in this test");
  }) as never;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  installBudget(null);
  installInferenceGate(undefined as never);
  env?.close();
});

describe("check_budget", () => {
  it("at zero: starts the timer, an hour later marks the agent dead and wakes it", async () => {
    setup();
    const ctx = taskCtx({ allowanceCents: 100 });
    spendAi(newBudgetGate(env), 100);
    const first = await BUILTIN_TASKS.check_budget!(tick, ctx);
    expect(env.db.getKV("zero_credits_since")).toBeDefined();
    expect(env.db.getAgentState()).not.toBe("dead");
    expect(first.shouldWake).toBe(false);

    advance(59 * 60_000);
    await BUILTIN_TASKS.check_budget!(tick, ctx);
    expect(env.db.getAgentState()).not.toBe("dead");

    advance(60_000);
    const dead = await BUILTIN_TASKS.check_budget!(tick, ctx);
    expect(env.db.getAgentState()).toBe("dead");
    expect(dead.shouldWake).toBe(true);
    expect(dead.message).toContain("Dead");
    expect(dead.message).toContain("automaton-cli budget add");
  });

  it("the owner adds budget: the next run says so, wakes the agent and clears the timer", async () => {
    setup();
    const ctx = taskCtx({ allowanceCents: 100 });
    spendAi(newBudgetGate(env), 100);
    await BUILTIN_TASKS.check_budget!(tick, ctx);
    advance(HOUR);
    await BUILTIN_TASKS.check_budget!(tick, ctx);
    expect(env.db.getAgentState()).toBe("dead");

    env.owner((w) => w.addGrant(500, "top-up", env.clock.now()));
    advance(5 * 60_000);
    const r = await BUILTIN_TASKS.check_budget!(tick, ctx);
    expect(r.shouldWake).toBe(true);
    expect(r.message).toContain("Your owner added $5.00 to your budget");
    expect(r.message).toContain("Budget restored: $5.00 available");
    expect(env.db.getKV("zero_credits_since")).toBeUndefined();
    const seen = JSON.parse(env.db.getKV("budget.last_seen")!);
    expect(seen).toMatchObject({ grantCount: 1, grantsCents: 500 });
  });

  it("a new period wakes a dead agent", async () => {
    setup();
    const ctx = taskCtx({ allowanceCents: 100 });
    spendAi(newBudgetGate(env), 100);
    await BUILTIN_TASKS.check_budget!(tick, ctx);
    advance(HOUR);
    await BUILTIN_TASKS.check_budget!(tick, ctx);
    expect(env.db.getAgentState()).toBe("dead");
    env.clock.set(Date.UTC(2026, 3, 1, 0, 5));
    vi.setSystemTime(env.clock.now());
    const r = await BUILTIN_TASKS.check_budget!(tick, ctx);
    expect(r.message).toContain("A new budget period started: $1.00 available");
    expect(r.message).toContain("Budget restored");
  });

  it("dead switched off: never marks the agent dead, and wakes one marked dead earlier", async () => {
    setup({ allowanceCents: 100, dead: false });
    const ctx = taskCtx({ allowanceCents: 100, dead: false });
    spendAi(newBudgetGate(env), 100);
    for (let i = 0; i < 20; i++) {
      await BUILTIN_TASKS.check_budget!(tick, ctx);
      advance(10 * 60_000);
    }
    expect(env.db.getAgentState()).not.toBe("dead");
    expect(env.db.getKV("zero_credits_since")).toBeUndefined();
    env.db.setAgentState("dead");
    const r = await BUILTIN_TASKS.check_budget!(tick, ctx);
    expect(r.shouldWake).toBe(true);
    expect(r.message).toContain("Dead is switched off");
  });

  it("a fixed survival tier with a budget never marks the agent dead (the loop would revive it at once)", async () => {
    setup({ allowanceCents: 100 });
    const ctx = taskCtx({ allowanceCents: 100 });
    ctx.config.providers = { mode: "standalone", survival: { source: "fixed", fixedTier: "normal" } };
    spendAi(newBudgetGate(env), 100);
    const wakes: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await BUILTIN_TASKS.check_budget!(tick, ctx);
      if (r.message) wakes.push(r.message);
      advance(10 * 60_000);
    }
    expect(env.db.getAgentState()).not.toBe("dead");
    expect(wakes.join(" ")).not.toMatch(/Dead:/);
  });

  it("does nothing without a budget", async () => {
    setup();
    installBudget(null);
    expect(await BUILTIN_TASKS.check_budget!(tick, taskCtx({ allowanceCents: 100 }))).toEqual({ shouldWake: false });
  });
});

describe("the loop revives a dead agent", () => {
  async function runOnce(budget: Record<string, unknown>) {
    const inference = new MockInferenceClient([noToolResponse("done")]);
    await runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" },
      config: config(budget),
      db: env.db,
      conway: createStandaloneClient({ budget: env.meter }),
      inference,
      shouldStop: () => inference.calls.length >= 1 || env.db.getAgentState() === "sleeping",
    });
    return inference;
  }

  it("dead with budget left: runs again", async () => {
    setup({ allowanceCents: 2500 });
    env.db.setAgentState("dead");
    const inference = await runOnce({ allowanceCents: 2500 });
    expect(inference.calls.length).toBe(1);
    expect(env.db.getAgentState()).not.toBe("dead");
    const system = String(inference.calls[0].messages[0].content);
    expect(system).toContain("Budget: $25.00 remaining of $25.00 this period (resets 2026-04-01 UTC)");
  });

  it("dead with nothing left: stays dead, no inference", async () => {
    setup({ allowanceCents: 100 });
    spendAi(newBudgetGate(env), 100);
    env.db.setAgentState("dead");
    const inference = await runOnce({ allowanceCents: 100 });
    expect(inference.calls.length).toBe(0);
    expect(env.db.getAgentState()).toBe("dead");
  });

  it("a new period revives it", async () => {
    setup({ allowanceCents: 100 });
    spendAi(newBudgetGate(env), 100);
    env.db.setAgentState("dead");
    env.clock.set(Date.UTC(2026, 3, 2));
    vi.setSystemTime(env.clock.now());
    installInferenceGate(undefined as never);
    const inference = await runOnce({ allowanceCents: 100 });
    expect(env.db.getAgentState()).not.toBe("dead");
    expect(inference.calls.length).toBeLessThanOrEqual(1);
  });

  it("a gate the loop builds itself gets the budget from the config (no installed gate or budget)", async () => {
    setup({ allowanceCents: 100 });
    spendAi(newBudgetGate(env), 100);
    installBudget(null);
    installInferenceGate(undefined as never);
    const inference = new MockInferenceClient([noToolResponse("done")]);
    const cfg = { ...config({ allowanceCents: 100 }), ownerDbPath: env.ownerPath };
    await runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" },
      config: cfg,
      db: env.db,
      conway: createStandaloneClient({ budget: env.meter }),
      inference,
      shouldStop: () => inference.calls.length >= 1 || env.db.getAgentState() === "sleeping",
    });
    const { getInstalledInferenceGate } = await import("../inference/gate.js");
    const gate = getInstalledInferenceGate()!;
    expect(gate.headroom("main")).toMatchObject({ allowed: false, code: "PERIOD_CAP" });
    expect(gate.survival().tier).not.toBe("unknown");
    expect(inference.calls.length).toBe(0);
  });

  it("dead switched off: an agent marked dead runs again even at zero (paid calls wait for budget)", async () => {
    setup({ allowanceCents: 100, dead: false });
    spendAi(newBudgetGate(env), 100);
    env.db.setAgentState("dead");
    installInferenceGate(undefined as never);
    const inference = await runOnce({ allowanceCents: 100, dead: false });
    expect(env.db.getAgentState()).not.toBe("dead");
    // The paid model is refused by the period cap before any call is made.
    expect(inference.calls.length).toBe(0);
  });
});

describe("messages point the agent at its owner's budget", () => {
  it("check_credits, distress_signal and the heartbeat distress name automaton-cli budget add", async () => {
    setup({ allowanceCents: 100 });
    spendAi(newBudgetGate(env), 100);
    const { createBuiltinTools } = await import("../agent/tools.js");
    const ctx = {
      identity: createTestIdentity(),
      config: config({ allowanceCents: 100 }),
      db: env.db,
      conway: createStandaloneClient({ budget: env.meter }),
      inference: new MockInferenceClient(),
    } as never;
    const tools = createBuiltinTools("", { standalone: true });
    const credits = await tools.find((t) => t.name === "check_credits")!.execute({}, ctx);
    expect(credits).toBe(
      "Remaining budget this period: $0.00 of $1.00 (resets 2026-04-01 UTC). Survival tier: critical. Ask your owner to run: automaton-cli budget add <usd>",
    );
    await tools.find((t) => t.name === "distress_signal")!.execute({}, ctx);
    expect(JSON.parse(env.db.getKV("last_distress")!).fundingHint).toBe("Ask your owner to run: automaton-cli budget add <usd>");
    env.db.deleteKV("last_distress");
    const ping = await BUILTIN_TASKS.heartbeat_ping!(
      { creditBalance: 0, survivalTier: "critical" } as TickContext,
      taskCtx({ allowanceCents: 100 }),
    );
    expect(ping.shouldWake).toBe(true);
    expect(JSON.parse(env.db.getKV("last_distress")!).fundingHint).toBe("Ask your owner to run: automaton-cli budget add <usd>");
  });
});
