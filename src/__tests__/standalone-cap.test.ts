/**
 * The standalone daily AI cap is forced, not advised: the treasury policy is
 * clamped (with a loud warning), the inference policy clamps on its own, the
 * survival allowance only gets room left under the ceiling, the spend rules
 * see the clamped number, and no config edit, tool call or stored Conway key
 * can raise it.
 * Conway mode is never clamped.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clampForMode, resolveRuntime } from "../providers/mode.js";
import { normalizeTreasuryPolicy } from "../treasury/policy.js";
import { resolveInferencePolicy } from "../inference/policy.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { StructuredLogger } from "../observability/logger.js";
import { createTestConfig } from "./mocks.js";

const standalone = (extra: Record<string, unknown> = {}) =>
  createTestConfig({ conwayApiKey: "", openaiApiKey: "sk", socialRelayUrl: "", ...extra });

function captureLogs<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  StructuredLogger.setSink((entry: any) => lines.push(typeof entry === "string" ? entry : JSON.stringify(entry)));
  try {
    return { result: fn(), lines };
  } finally {
    StructuredLogger.resetSink();
  }
}

describe("clampForMode", () => {
  it("clamps 50000c to the 200c default ceiling with a loud warning", () => {
    const runtime = resolveRuntime(standalone());
    const { result, lines } = captureLogs(() => clampForMode(normalizeTreasuryPolicy({}), runtime));
    expect(result.clamped).toBe(true);
    expect(result.policy.maxInferenceDailyCents).toBe(200);
    const text = lines.join("\n");
    expect(text).toContain("Daily AI cap clamped");
    expect(text).toContain("50000c ($500.00)");
    expect(text).toContain("200c ($2.00)");
  });

  it("uses a configured ceiling and leaves a lower cap alone", () => {
    const runtime = resolveRuntime(standalone({ providers: { dailyCapCeilingCents: 500 } }));
    expect(clampForMode(normalizeTreasuryPolicy({ maxInferenceDailyCents: 900 }), runtime).policy.maxInferenceDailyCents).toBe(500);
    const low = clampForMode(normalizeTreasuryPolicy({ maxInferenceDailyCents: 100 }), runtime);
    expect(low.clamped).toBe(false);
    expect(low.policy.maxInferenceDailyCents).toBe(100);
  });

  it("never clamps Conway mode", () => {
    const runtime = resolveRuntime(createTestConfig());
    const r = clampForMode(normalizeTreasuryPolicy({}), runtime);
    expect(r.clamped).toBe(false);
    expect(r.policy.maxInferenceDailyCents).toBe(50000);
  });
});

describe("resolveInferencePolicy with a ceiling", () => {
  it("clamps the daily cap and the derived hourly cap on its own", () => {
    const p = resolveInferencePolicy({}, { maxInferenceDailyCents: 50000 }, { ceilingCents: 200 });
    expect(p.dailyCapCents).toBe(200);
    expect(p.hourlyCapCents).toBe(34);
    expect(resolveInferencePolicy({ modelStrategy: { hourlyBudgetCents: 5000 } as any }, {}, { ceilingCents: 200 }).hourlyCapCents).toBe(200);
  });

  it("the survival allowance gets only the room the daily cap leaves under the ceiling", () => {
    expect(resolveInferencePolicy({}, { maxInferenceDailyCents: 50000 }, { ceilingCents: 200 }).survivalAllowanceCents).toBe(0);
    expect(resolveInferencePolicy({}, { maxInferenceDailyCents: 190 }, { ceilingCents: 200 }).survivalAllowanceCents).toBe(10);
    expect(resolveInferencePolicy({}, { maxInferenceDailyCents: 100 }, { ceilingCents: 200 }).survivalAllowanceCents).toBe(25);
  });

  it("without a ceiling (Conway mode) nothing changes", () => {
    const p = resolveInferencePolicy({}, { maxInferenceDailyCents: 50000 });
    expect(p.dailyCapCents).toBe(50000);
    expect(p.survivalAllowanceCents).toBe(25);
  });
});

describe("the spend rules see the clamped number", () => {
  it("createDefaultRules and a later normalize of the in-memory policy", () => {
    const config = standalone();
    const runtime = resolveRuntime(config);
    // What run() does: clamp, then put it back into the config in memory.
    const clamped = clampForMode(normalizeTreasuryPolicy(config.treasuryPolicy), runtime).policy;
    config.treasuryPolicy = clamped;
    const rule = createDefaultRules(clamped).find((r) => r.id === "financial.inference_daily_cap");
    expect(rule?.description).toContain("200 cents");
    expect(normalizeTreasuryPolicy(config.treasuryPolicy).maxInferenceDailyCents).toBe(200);
  });
});

describe("no edit and no tool call raises the cap", () => {
  const savedHome = process.env.HOME;
  let home: string;
  let configPath: string;

  beforeAll(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "standalone-cap-")));
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    configPath = path.join(home, ".automaton", "automaton.json");
    vi.resetModules();
  });

  afterAll(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("updateConfigFile writes neither providers nor treasuryPolicy", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ name: "a", genesisPrompt: "g", treasuryPolicy: { maxInferenceDailyCents: 100 } }));
    const { updateConfigFile } = await import("../config.js");
    updateConfigFile({
      genesisPrompt: "new",
      providers: { dailyCapCeilingCents: 999999 },
      treasuryPolicy: { maxInferenceDailyCents: 999999 },
    } as any);
    const disk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(disk.genesisPrompt).toBe("new");
    expect(disk.providers).toBeUndefined();
    expect(disk.treasuryPolicy).toEqual({ maxInferenceDailyCents: 100 });
  });

  it("a Conway key stored by --provision or --configure keeps an explicit standalone mode and its cap", async () => {
    delete process.env.CONWAY_API_KEY;
    fs.writeFileSync(configPath, JSON.stringify({
      name: "a",
      genesisPrompt: "g",
      openaiApiKey: "sk-test",
      providers: { mode: "standalone", dailyCapCeilingCents: 200 },
      treasuryPolicy: { maxInferenceDailyCents: 50000 },
    }));
    const { setConwayApiKey, loadConfig } = await import("../config.js");
    // What provision() does after signing in with the agent's wallet.
    expect(setConwayApiKey("cnwy_k_agentmade")).toBe(true);
    const config = loadConfig()!;
    const runtime = resolveRuntime(config);
    expect(runtime.mode).toBe("standalone");
    expect(runtime.dailyCapCeilingCents).toBe(200);
    expect(runtime.relayUrl).toBe("");
    expect(runtime.payments).toBe(false);
    expect(clampForMode(normalizeTreasuryPolicy(config.treasuryPolicy), runtime).policy.maxInferenceDailyCents).toBe(200);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).providers.mode).toBe("standalone");
  });

  it("switch_model and update_genesis_prompt leave the gate's policy unchanged", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ name: "a", genesisPrompt: "g", inferenceModel: "gpt-5.2" }));
    const { createBuiltinTools } = await import("../agent/tools.js");
    const { InferenceGate, installInferenceGate } = await import("../inference/gate.js");
    const mocks = await import("./mocks.js");
    const { modelRegistryUpsert } = await import("../state/database.js");
    const db = mocks.createTestDb();
    const config = mocks.createTestConfig({ conwayApiKey: "", openaiApiKey: "sk", socialRelayUrl: "" });
    const runtime = resolveRuntime(config);
    const gate = new InferenceGate({
      db: db.raw,
      policy: resolveInferencePolicy(config, normalizeTreasuryPolicy({}), { ceilingCents: runtime.dailyCapCeilingCents }),
      fixedTier: "normal",
    });
    installInferenceGate(gate);
    const before = JSON.stringify(gate.policy);
    const now = new Date().toISOString();
    modelRegistryUpsert(db.raw, {
      modelId: "gpt-5-mini",
      provider: "openai",
      displayName: "mini",
      tierMinimum: "critical",
      costPer1kInput: 1,
      costPer1kOutput: 1,
      maxTokens: 4096,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_completion_tokens",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const ctx = {
      identity: mocks.createTestIdentity(),
      config,
      db,
      conway: new mocks.MockConwayClient(),
      inference: new mocks.MockInferenceClient(),
    } as any;
    const tools = createBuiltinTools("");
    await tools.find((t) => t.name === "switch_model")!.execute({ model_id: "gpt-5-mini" }, ctx);
    await tools.find((t) => t.name === "update_genesis_prompt")!.execute({ new_prompt: "x", reason: "y" }, ctx);
    expect(JSON.stringify(gate.policy)).toBe(before);
    expect(gate.policy.dailyCapCents).toBe(200);
    expect(config.treasuryPolicy).toBeUndefined();
    expect(config.providers).toBeUndefined();
    db.close();
  });
});
