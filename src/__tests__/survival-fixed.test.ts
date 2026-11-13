/**
 * The fixed survival tier (standalone mode): the gate tier is never
 * "unknown", so orchestration is not paused; the heartbeat tick reads no
 * balance; the loop routes at the fixed tier, revives an agent a Conway run
 * marked dead, and tells the model the truth; the planner gets the gate tier.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InferenceGate, installInferenceGate, orchestrationPaused } from "../inference/gate.js";
import { resolveInferencePolicy } from "../inference/policy.js";
import { buildTickContext } from "../heartbeat/tick-context.js";
import { buildPlannerContext } from "../orchestration/planner-context.js";
import { runAgentLoop } from "../agent/loop.js";
import { resolveRuntime } from "../providers/mode.js";
import { resolveSurvivalSource } from "../providers/survival-source.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const standaloneConfig = (extra: Record<string, unknown> = {}) =>
  createTestConfig({ conwayApiKey: "", sandboxId: "", socialRelayUrl: "", openaiApiKey: "sk-test", ...extra });

let db: AutomatonDatabase;
let fetchSpy: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  db = createTestDb();
  fetchSpy = vi.fn(async () => {
    throw new Error("no network in this test");
  });
  globalThis.fetch = fetchSpy as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  installInferenceGate(undefined as any);
  db.close();
});

describe("survival source", () => {
  it("standalone is fixed at normal unless the creator picks a tier; Conway reads the balance", () => {
    expect(resolveSurvivalSource({ providers: undefined }, "standalone")).toEqual({ kind: "fixed", tier: "normal" });
    expect(resolveSurvivalSource({ providers: { survival: { fixedTier: "high" } } }, "standalone")).toEqual({
      kind: "fixed",
      tier: "high",
    });
    expect(resolveSurvivalSource({ providers: undefined }, "conway")).toEqual({ kind: "conway" });
    expect(resolveSurvivalSource({ providers: { survival: { source: "fixed" } } }, "conway")).toEqual({
      kind: "fixed",
      tier: "normal",
    });
  });
});

describe("inference gate under a fixed tier", () => {
  it("is never unknown: at construction and after an unknown update", () => {
    const gate = new InferenceGate({ db: db.raw, policy: resolveInferencePolicy({}, {}), fixedTier: "normal" });
    expect(gate.survival().tier).toBe("normal");
    gate.setSurvival({ tier: "unknown", creditsCents: null });
    expect(gate.survival().tier).toBe("normal");
    expect(orchestrationPaused(gate.survival().tier)).toBe(false);
    expect(gate.headroom("orchestration").allowed).toBe(true);
  });

  it("without a fixed tier it starts unknown (Conway mode, unchanged)", () => {
    const gate = new InferenceGate({ db: db.raw, policy: resolveInferencePolicy({}, {}) });
    expect(gate.survival().tier).toBe("unknown");
    expect(gate.headroom("orchestration").allowed).toBe(false);
  });
});

describe("heartbeat tick under a fixed tier", () => {
  it("reads no credit balance and no USDC balance", async () => {
    const conway = new MockConwayClient();
    const credits = vi.spyOn(conway, "getCreditsBalance");
    const ctx = await buildTickContext(db.raw, conway, { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 } as any, "0x" + "1".repeat(40), "evm", {
      survival: { kind: "fixed", tier: "normal" },
      readUsdc: false,
    });
    expect(credits).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.survivalTier).toBe("normal");
    expect(ctx.survivalTierKnown).toBe(true);
    expect(ctx.creditBalance).toBeNull();
    expect(ctx.creditRead).toMatchObject({ known: false, reason: "disabled" });
    expect(ctx.usdcRead).toMatchObject({ known: false, reason: "disabled" });
    // No outage bookkeeping for a balance that is not tracked.
    expect(db.getKV("balance_unknown_since")).toBeUndefined();
  });

  it("the scheduler takes its tick options from the runtime", async () => {
    const { tickOptionsFor } = await import("../heartbeat/scheduler.js");
    expect(tickOptionsFor({ config: standaloneConfig() } as any)).toEqual({
      survival: { kind: "fixed", tier: "normal" },
      readUsdc: false,
    });
    expect(tickOptionsFor({ config: createTestConfig() } as any)).toEqual({ survival: { kind: "conway" }, readUsdc: true });
  });
});

describe("agent loop under a fixed tier", () => {
  it("revives a dead agent, routes at normal, reads no balance and says so in the prompt", async () => {
    const conway = new MockConwayClient();
    const credits = vi.spyOn(conway, "getCreditsBalance");
    const inference = new MockInferenceClient([noToolResponse("done")]);
    db.setAgentState("dead");
    const config = standaloneConfig();
    await runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" },
      config,
      db,
      conway,
      inference,
      shouldStop: () => inference.calls.length >= 1,
    });
    expect(inference.calls.length).toBe(1);
    expect(db.getAgentState()).not.toBe("dead");
    expect(credits).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const system = String(inference.calls[0].messages[0].content);
    expect(system).toContain("Survival tier: normal (fixed)");
    expect(system).toContain("Credits: not tracked in standalone mode");
    expect(inference.lowComputeMode).toBe(false);
    const { getInstalledInferenceGate } = await import("../inference/gate.js");
    expect(getInstalledInferenceGate()?.survival().tier).toBe("normal");
  });

  it("the [THINK] log names the model the call is routed to, not the client's default", async () => {
    const { StructuredLogger } = await import("../observability/logger.js");
    const lines: string[] = [];
    StructuredLogger.setSink((entry: any) => lines.push(typeof entry === "string" ? entry : JSON.stringify(entry)));
    const inference = new MockInferenceClient([noToolResponse("done")]);
    try {
      await runAgentLoop({
        identity: { ...createTestIdentity(), sandboxId: "" },
        config: standaloneConfig(),
        db,
        conway: new MockConwayClient(),
        inference,
        shouldStop: () => inference.calls.length >= 1,
      });
    } finally {
      StructuredLogger.resetSink();
    }
    const routed = inference.calls[0].options?.model;
    expect(routed).toBeTruthy();
    expect(routed).not.toBe(inference.getDefaultModel());
    const think = lines.find((l) => l.includes("[THINK] Routing inference"));
    expect(think).toContain(`model: ${routed})`);
  });

  it("a low_compute fixed tier routes the loop in low-compute mode", async () => {
    const inference = new MockInferenceClient([noToolResponse("done")]);
    await runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" },
      config: standaloneConfig({ providers: { survival: { fixedTier: "low_compute" } } }),
      db,
      conway: new MockConwayClient(),
      inference,
      shouldStop: () => inference.calls.length >= 1,
    });
    expect(inference.lowComputeMode).toBe(true);
  });
});

describe("planner context", () => {
  it("an unread balance reports the gate tier instead of unknown", async () => {
    const config = standaloneConfig();
    const runtime = resolveRuntime(config);
    const gate = new InferenceGate({
      db: db.raw,
      policy: resolveInferencePolicy(config, {}),
      fixedTier: runtime.survival.kind === "fixed" ? runtime.survival.tier : undefined,
    });
    installInferenceGate(gate);
    const ctx = await buildPlannerContext({ db: db.raw });
    expect(ctx.creditsCents).toBeNull();
    expect(ctx.survivalTier).toBe("normal");
  });
});
