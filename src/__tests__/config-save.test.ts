/**
 * Config saves by the running agent change only the keys the tool changed,
 * re-read from disk, so an operator's edit since startup is never undone.
 * loadConfig normalizes the treasury policy and refuses a corrupt file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";

const savedHome = process.env.HOME;
let home: string;
let configPath: string;
let cfg: typeof import("../config.js");
let tools: typeof import("../agent/tools.js");
let mocks: typeof import("./mocks.js");
let modelRegistryUpsert: typeof import("../state/database.js").modelRegistryUpsert;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "config-save-home-")));
  process.env.HOME = home;
  // The automaton dir is fixed when identity/wallet loads: import after HOME is set.
  vi.resetModules();
  cfg = await import("../config.js");
  tools = await import("../agent/tools.js");
  mocks = await import("./mocks.js");
  ({ modelRegistryUpsert } = await import("../state/database.js"));
  configPath = path.join(home, ".automaton", "automaton.json");
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(home, ".automaton"), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
});

function writeConfig(obj: Record<string, unknown>): void {
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

function readDisk(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

const BASE = {
  name: "agent",
  genesisPrompt: "original purpose",
  creatorAddress: "0x" + "1".repeat(40),
  registeredWithConway: true,
  sandboxId: "sbx",
  conwayApiUrl: "https://api.conway.tech",
  conwayApiKey: "cnwy_in_file",
  inferenceModel: "gpt-5.2",
  walletAddress: "0x" + "2".repeat(40),
  treasuryPolicy: { maxSingleTransferCents: 5000, maxDailyTransferCents: 25000 },
  modelStrategy: { inferenceModel: "gpt-5.2" },
};

function toolCtx(config: AutomatonConfig): { ctx: ToolContext; db: AutomatonDatabase } {
  const db = mocks.createTestDb();
  const ctx = {
    identity: mocks.createTestIdentity(),
    config,
    db,
    conway: new mocks.MockConwayClient(),
    inference: new mocks.MockInferenceClient(),
  } as ToolContext;
  return { ctx, db };
}

function tool(name: string) {
  return tools.createBuiltinTools("sbx").find((t) => t.name === name)!;
}

describe("runtime config saves", () => {
  it("switch_model keeps a treasury limit the operator changed on disk", async () => {
    writeConfig(BASE);
    const snapshot = cfg.loadConfig()!;
    // The operator tightens the limit while the agent runs.
    writeConfig({ ...readDisk(), treasuryPolicy: { maxSingleTransferCents: 100, maxDailyTransferCents: 500 } });

    const { ctx, db } = toolCtx(snapshot);
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
    const out = await tool("switch_model").execute({ model_id: "gpt-5-mini" }, ctx);
    db.close();

    expect(out).toContain("Change persisted");
    const disk = readDisk();
    expect(disk.treasuryPolicy.maxSingleTransferCents).toBe(100);
    expect(disk.treasuryPolicy.maxDailyTransferCents).toBe(500);
    expect(disk.inferenceModel).toBe("gpt-5-mini");
    expect(disk.modelStrategy.inferenceModel).toBe("gpt-5-mini");
  });

  it("update_genesis_prompt does not write the config.json fallback key into automaton.json", async () => {
    const { conwayApiKey: _omit, ...withoutKey } = BASE;
    writeConfig(withoutKey);
    fs.writeFileSync(path.join(home, ".automaton", "config.json"), JSON.stringify({ apiKey: "cnwy_fallback_key" }));
    const snapshot = cfg.loadConfig()!;
    expect(snapshot.conwayApiKey).toBe("cnwy_fallback_key");

    const { ctx, db } = toolCtx(snapshot);
    const out = await tool("update_genesis_prompt").execute({ new_prompt: "a new purpose", reason: "test" }, ctx);
    db.close();

    expect(out).toContain("Genesis prompt updated");
    const disk = readDisk();
    expect(disk.genesisPrompt).toBe("a new purpose");
    expect(disk.conwayApiKey).toBeUndefined();
    expect(JSON.stringify(disk)).not.toContain("cnwy_fallback_key");
  });

  it("a corrupt file is not overwritten; the tool says the change applies until restart", async () => {
    writeConfig(BASE);
    const snapshot = cfg.loadConfig()!;
    fs.writeFileSync(configPath, '{"name":"agent","sandboxId":"sb');

    const { ctx, db } = toolCtx(snapshot);
    const out = await tool("update_genesis_prompt").execute({ new_prompt: "x", reason: "test" }, ctx);
    db.close();

    expect(out).toContain("applies until restart");
    expect(fs.readFileSync(configPath, "utf8")).toBe('{"name":"agent","sandboxId":"sb');
  });
});

describe("loadConfig", () => {
  it("replaces a malformed treasury value with the default number", () => {
    writeConfig({ ...BASE, treasuryPolicy: { maxSingleTransferCents: "5,000", maxHourlyTransferCents: "10,000" } });
    const config = cfg.loadConfig()!;
    expect(config.treasuryPolicy?.maxSingleTransferCents).toBe(DEFAULT_TREASURY_POLICY.maxSingleTransferCents);
    expect(typeof config.treasuryPolicy?.maxHourlyTransferCents).toBe("number");
  });

  it("throws ConfigError on a truncated file and returns null only when the file is missing", () => {
    expect(cfg.loadConfig()).toBeNull();
    fs.writeFileSync(configPath, '{"name":"parent","sandboxId":"sb');
    expect(() => cfg.loadConfig()).toThrow(cfg.ConfigError);
  });
});

describe("pinStandaloneModeInFile", () => {
  const HAND_WRITTEN = { name: "agent", creatorAddress: "0x" + "1".repeat(40), providers: { openai: { apiKey: "sk-x" } } };

  it("pins a config that sets no mode and holds no Conway key, keeping everything else", () => {
    writeConfig({ ...HAND_WRITTEN, treasuryPolicy: { maxInferenceDailyCents: 150 } });
    expect(cfg.pinStandaloneModeInFile()).toBe(true);
    expect(readDisk()).toEqual({
      ...HAND_WRITTEN,
      treasuryPolicy: { maxInferenceDailyCents: 150 },
      providers: { openai: { apiKey: "sk-x" }, mode: "standalone" },
    });
    // A Conway key stored later no longer selects Conway mode.
    fs.writeFileSync(path.join(home, ".automaton", "config.json"), JSON.stringify({ apiKey: "cnwy_k_later" }));
    expect(cfg.loadConfig({})!.providers?.mode).toBe("standalone");
    expect(cfg.pinStandaloneModeInFile()).toBe(false);
  });

  it("leaves an explicit mode and a Conway key in the file alone", () => {
    writeConfig({ ...HAND_WRITTEN, providers: { mode: "conway" }, conwayApiKey: "cnwy_k" });
    expect(cfg.pinStandaloneModeInFile()).toBe(false);
    writeConfig({ ...HAND_WRITTEN, conwayApiKey: "cnwy_k" });
    expect(cfg.pinStandaloneModeInFile()).toBe(false);
    expect(readDisk().providers.mode).toBeUndefined();
  });
});
