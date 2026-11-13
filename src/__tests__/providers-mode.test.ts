/**
 * The providers block and mode resolution: precedence of every provider
 * value (environment, providers block, flat field, config.json), the flat
 * aliases loadConfig fills in, saveConfig keeping the block in sync without
 * writing environment values or mode defaults, validation, and a startup
 * line that names key sources but never key values.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfig } from "./mocks.js";
import { resolveRuntime, describeRuntime, DEFAULT_OPENAI_BASE_URL } from "../providers/mode.js";

const savedHome = process.env.HOME;
let home: string;
let dir: string;
let cfg: typeof import("../config.js");

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "providers-mode-")));
  process.env.HOME = home;
  dir = path.join(home, ".automaton");
  vi.resetModules();
  cfg = await import("../config.js");
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

const BASE = {
  name: "agent",
  genesisPrompt: "g",
  creatorAddress: "0x" + "1".repeat(40),
  walletAddress: "0x" + "2".repeat(40),
  sandboxId: "",
};

function write(obj: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "automaton.json"), JSON.stringify({ ...BASE, ...obj }, null, 2));
}
function writeProvisioned(key: string): void {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ apiKey: key }));
}
function disk(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, "automaton.json"), "utf8"));
}
const load = (env: NodeJS.ProcessEnv = {}) => cfg.loadConfig(env)!;

describe("precedence", () => {
  it("Conway key: env, then providers block, then flat field, then config.json", () => {
    writeProvisioned("cnwy_k_FILE");
    write({ conwayApiKey: "cnwy_k_FLAT", providers: { conway: { apiKey: "cnwy_k_BLOCK" } } });
    expect(load({ CONWAY_API_KEY: "cnwy_k_ENV" }).conwayApiKey).toBe("cnwy_k_ENV");
    expect(load().conwayApiKey).toBe("cnwy_k_BLOCK");
    write({ conwayApiKey: "cnwy_k_FLAT" });
    expect(load().conwayApiKey).toBe("cnwy_k_FLAT");
    write({});
    expect(load().conwayApiKey).toBe("cnwy_k_FILE");
  });

  it("CONWAY_API_KEY in the environment selects Conway mode and is named as the source", () => {
    write({ openaiApiKey: "sk-flat" });
    const config = load({ CONWAY_API_KEY: "cnwy_k_ENV" });
    const runtime = resolveRuntime(config);
    expect(runtime.mode).toBe("conway");
    expect(describeRuntime(runtime)).toContain("Mode: conway (Conway key from CONWAY_API_KEY)");
  });

  it("Conway URL: CONWAY_API_URL, then providers block, then flat field, then the default", () => {
    write({ conwayApiUrl: "https://flat.example", providers: { conway: { apiUrl: "https://block.example" } } });
    expect(load({ CONWAY_API_URL: "https://env.example" }).conwayApiUrl).toBe("https://env.example");
    expect(load().conwayApiUrl).toBe("https://block.example");
    write({ conwayApiUrl: "https://flat.example" });
    expect(load().conwayApiUrl).toBe("https://flat.example");
    write({});
    expect(load().conwayApiUrl).toBe("https://api.conway.tech");
  });

  it("OpenAI key: providers block, then flat field, then OPENAI_API_KEY (standalone only)", () => {
    write({ openaiApiKey: "sk-flat", providers: { openai: { apiKey: "sk-block" } } });
    expect(load({ OPENAI_API_KEY: "sk-env" }).openaiApiKey).toBe("sk-block");
    write({ openaiApiKey: "sk-flat" });
    expect(load({ OPENAI_API_KEY: "sk-env" }).openaiApiKey).toBe("sk-flat");
    write({});
    expect(load({ OPENAI_API_KEY: "sk-env" }).openaiApiKey).toBe("sk-env");
    // In Conway mode the environment key would move OpenAI calls off Conway.
    write({ conwayApiKey: "cnwy_k_x" });
    expect(load({ OPENAI_API_KEY: "sk-env" }).openaiApiKey).toBeUndefined();
  });

  it("Anthropic key: providers block, then flat field, no environment fallback", () => {
    write({ anthropicApiKey: "sk-ant-flat", providers: { anthropic: { apiKey: "sk-ant-block" } } });
    expect(load().anthropicApiKey).toBe("sk-ant-block");
    write({});
    expect(load({ ANTHROPIC_API_KEY: "sk-ant-env" }).anthropicApiKey).toBeUndefined();
  });

  it("Ollama URL: OLLAMA_BASE_URL, then providers block, then flat field", () => {
    write({ ollamaBaseUrl: "http://localhost:1", providers: { ollama: { baseUrl: "http://localhost:2" } } });
    expect(load({ OLLAMA_BASE_URL: "http://localhost:3" }).ollamaBaseUrl).toBe("http://localhost:3");
    expect(load().ollamaBaseUrl).toBe("http://localhost:2");
  });

  it("OpenAI base URL: providers.openai.baseUrl, else the public endpoint", () => {
    write({ openaiApiKey: "sk", providers: { openai: { baseUrl: "https://llm.example/v1/" } } });
    const r = resolveRuntime(load());
    expect(r.providers.openai?.baseUrl).toBe("https://llm.example/v1");
    expect(r.providers.openai?.customBaseUrl).toBe(true);
    write({ openaiApiKey: "sk" });
    expect(resolveRuntime(load()).providers.openai?.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
  });
});

describe("mode resolution", () => {
  it("explicit mode wins; otherwise a Conway key means Conway, none means standalone", () => {
    expect(resolveRuntime(createTestConfig()).mode).toBe("conway");
    expect(resolveRuntime(createTestConfig({ conwayApiKey: "" })).mode).toBe("standalone");
    expect(resolveRuntime(createTestConfig({ providers: { mode: "standalone" } })).reason).toBe("explicit");
    expect(resolveRuntime(createTestConfig({ providers: { mode: "standalone" } })).mode).toBe("standalone");
  });

  it("standalone defaults: fixed normal tier, 200c ceiling, relay and payments off", () => {
    const r = resolveRuntime(createTestConfig({ conwayApiKey: "", socialRelayUrl: "", openaiApiKey: "sk" }));
    expect(r.survival).toEqual({ kind: "fixed", tier: "normal" });
    expect(r.dailyCapCeilingCents).toBe(200);
    expect(r.features.relay).toBe(false);
    expect(r.features.payments).toBe(false);
    expect(r.features.children).toBe(false);
  });

  it("Conway mode reads the balance, is never clamped and hides nothing", () => {
    const r = resolveRuntime(createTestConfig());
    expect(r.survival).toEqual({ kind: "conway" });
    expect(r.dailyCapCeilingCents).toBeNull();
    expect(Object.values(r.features).every(Boolean)).toBe(true);
  });
});

describe("aliases and saving", () => {
  it("loadConfig fills the flat aliases from the providers block", () => {
    write({
      providers: {
        openai: { apiKey: "sk-block" },
        anthropic: { apiKey: "sk-ant-block" },
        ollama: { baseUrl: "http://localhost:11434" },
        conway: { apiKey: "cnwy_k_block", apiUrl: "https://c.example" },
      },
    });
    const c = load();
    expect(c.openaiApiKey).toBe("sk-block");
    expect(c.anthropicApiKey).toBe("sk-ant-block");
    expect(c.ollamaBaseUrl).toBe("http://localhost:11434");
    expect(c.conwayApiKey).toBe("cnwy_k_block");
    expect(c.conwayApiUrl).toBe("https://c.example");
  });

  it("an edited flat value replaces the block value, so it is never shadowed", () => {
    write({ providers: { openai: { apiKey: "sk-old" } } });
    const c = load();
    c.openaiApiKey = "sk-new";
    cfg.saveConfig(c);
    expect(disk().providers.openai.apiKey).toBe("sk-new");
    expect(disk().openaiApiKey).toBeUndefined();
    expect(load().openaiApiKey).toBe("sk-new");
  });

  it("an unchanged save writes no environment key and no mode default into the file", () => {
    write({ openaiApiKey: "sk-flat" });
    const c = load({ CONWAY_API_KEY: "cnwy_k_ENV_SECRET", CONWAY_API_URL: "https://env.example" });
    cfg.saveConfig(c);
    const text = fs.readFileSync(path.join(dir, "automaton.json"), "utf8");
    expect(text).not.toContain("cnwy_k_ENV_SECRET");
    expect(text).not.toContain("env.example");

    write({ openaiApiKey: "sk-flat" });
    cfg.saveConfig(load({ OPENAI_API_KEY: "sk-env" }));
    const saved = disk();
    expect(saved.socialRelayUrl).toBeUndefined();
    expect(saved.treasuryPolicy.x402AllowedDomains).toBeUndefined();
    expect(saved.openaiApiKey).toBe("sk-flat");
  });

  it("setConwayApiKey: a new key replaces the runtime key; an empty one switches to standalone, which a new key never lifts", () => {
    writeProvisioned("cnwy_k_PROVISIONED");
    write({ conwayApiKey: "cnwy_k_OLD", openaiApiKey: "sk" });
    cfg.setConwayApiKey("cnwy_k_NEW");
    expect(load().conwayApiKey).toBe("cnwy_k_NEW");
    cfg.setConwayApiKey("");
    expect(disk().conwayApiKey).toBeUndefined();
    expect(resolveRuntime(load()).mode).toBe("standalone");
    cfg.setConwayApiKey("cnwy_k_AGAIN");
    expect(load().conwayApiKey).toBe("cnwy_k_AGAIN");
    expect(disk().providers.mode).toBe("standalone");
    expect(resolveRuntime(load()).mode).toBe("standalone");
    // Only the operator changing the mode leaves standalone.
    const edited = disk();
    delete edited.providers.mode;
    fs.writeFileSync(path.join(dir, "automaton.json"), JSON.stringify(edited));
    expect(resolveRuntime(load()).mode).toBe("conway");
  });

  it("Conway-mode defaults are never saved, and clearing the key drops ones an older save wrote", () => {
    write({ conwayApiKey: "cnwy_k_OLD", openaiApiKey: "sk" });
    cfg.saveConfig(load());
    expect(disk().socialRelayUrl).toBeUndefined();
    expect(disk().treasuryPolicy.x402AllowedDomains).toBeUndefined();

    write({
      conwayApiKey: "cnwy_k_OLD",
      openaiApiKey: "sk",
      socialRelayUrl: "https://social.conway.tech",
      treasuryPolicy: { x402AllowedDomains: ["conway.tech"] },
    });
    cfg.setConwayApiKey("");
    expect(disk().socialRelayUrl).toBeUndefined();
    expect(disk().treasuryPolicy.x402AllowedDomains).toBeUndefined();
    const runtime = resolveRuntime(load());
    expect(runtime.mode).toBe("standalone");
    expect(runtime.features.relay).toBe(false);

    // An operator's own relay is kept.
    write({ conwayApiKey: "cnwy_k_OLD", openaiApiKey: "sk", socialRelayUrl: "https://relay.example" });
    cfg.setConwayApiKey("");
    expect(disk().socialRelayUrl).toBe("https://relay.example");
  });
});

describe("validation", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown mode", { mode: "cloud" }],
    ["http base URL off loopback", { openai: { baseUrl: "http://llm.example/v1" } }],
    ["dead fixed tier", { survival: { fixedTier: "dead" } }],
    ["fractional ceiling", { dailyCapCeilingCents: 1.5 }],
    ["negative ceiling", { dailyCapCeilingCents: -1 }],
    ["model without id", { openai: { models: [{ inputUsdPerM: 1 }] } }],
    ["http relay URL off loopback", { relayUrl: "http://relay.example" }],
  ];
  for (const [what, providers] of bad) {
    it(`refuses ${what}`, () => {
      write({ providers });
      expect(() => load()).toThrow(cfg.ConfigError);
    });
  }

  it("accepts loopback http and a valid block", () => {
    write({
      providers: {
        mode: "standalone",
        openai: { apiKey: "k", baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "m", inputUsdPerM: 0.5 }] },
        survival: { fixedTier: "low_compute" },
        dailyCapCeilingCents: 0,
        payments: false,
      },
    });
    const r = resolveRuntime(load());
    expect(r.survival).toEqual({ kind: "fixed", tier: "low_compute" });
    expect(r.dailyCapCeilingCents).toBe(0);
  });
});

describe("describeRuntime", () => {
  it("names sources and never prints a key", () => {
    write({
      conwayApiKey: "cnwy_k_SECRET_VALUE",
      openaiApiKey: "sk-SECRET-OPENAI",
      anthropicApiKey: "sk-ant-SECRET",
      providers: { mode: "standalone" },
    });
    const line = describeRuntime(resolveRuntime(load({ OLLAMA_BASE_URL: "http://localhost:11434" })));
    expect(line).toContain("Mode: standalone (set in providers.mode)");
    expect(line).toContain("openai (key from automaton.json");
    expect(line).toContain("ollama (http://localhost:11434, from OLLAMA_BASE_URL)");
    expect(line).not.toMatch(/SECRET/);
  });
});
