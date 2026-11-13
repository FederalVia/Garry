/**
 * Setup without a Conway account: the wizard asks before signing in (default
 * no), needs an AI provider when there is no Conway key, and writes a
 * standalone-shaped install. --configure can clear the Conway key and the
 * relay so they stay cleared, the constitution re-installs over its 0444
 * copy, and the model pickers show correct prices for configured providers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  answers: [] as string[],
  rlAnswers: [] as string[],
  defaults: [] as Array<{ label: string; value: number }>,
  asked: [] as string[],
}));

function next(label: string): string {
  state.asked.push(label);
  if (state.answers.length === 0) throw new Error(`no scripted answer for prompt: ${label}`);
  return state.answers.shift()!;
}

vi.mock("../setup/prompts.js", () => ({
  promptRequired: async (label: string) => next(label),
  promptOptional: async (label: string) => next(label),
  promptMultiline: async (label: string) => next(label),
  promptAddress: async (label: string) => next(label),
  promptWithDefault: async (label: string, value: number) => {
    state.defaults.push({ label, value });
    return value;
  },
  closePrompts: () => {},
}));

// --configure reads its answers through readline.
vi.mock("readline", () => {
  const createInterface = () => ({
    question: (q: string, cb: (a: string) => void) => {
      state.asked.push(q);
      if (state.rlAnswers.length === 0) throw new Error(`no scripted readline answer for: ${q}`);
      cb(state.rlAnswers.shift()!);
    },
    close: () => {},
  });
  return { default: { createInterface }, createInterface };
});

const provisionMock = vi.hoisted(() => vi.fn());
vi.mock("../identity/provision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../identity/provision.js")>();
  return { ...actual, provision: provisionMock };
});

vi.mock("../setup/environment.js", () => ({
  detectEnvironment: () => ({ type: "linux", sandboxId: "" }),
}));

vi.mock("../setup/banner.js", () => ({ showBanner: () => {} }));

const savedHome = process.env.HOME;
const savedEnv = {
  CONWAY_API_KEY: process.env.CONWAY_API_KEY,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
};
let home: string;
let dir: string;
let wizard: typeof import("../setup/wizard.js");
let configure: typeof import("../setup/configure.js");
let picker: typeof import("../setup/model-picker.js");
let config: typeof import("../config.js");
let database: typeof import("../state/database.js");

const CREATOR = "0x" + "a".repeat(40);
const REPO_CONSTITUTION = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "constitution.md"), "utf8");

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "setup-standalone-home-")));
  process.env.HOME = home;
  dir = path.join(home, ".automaton");
  // State paths are fixed when the modules load: import after HOME is set.
  vi.resetModules();
  wizard = await import("../setup/wizard.js");
  configure = await import("../setup/configure.js");
  picker = await import("../setup/model-picker.js");
  config = await import("../config.js");
  database = await import("../state/database.js");
});

afterAll(() => {
  process.env.HOME = savedHome;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

let output: string[];

beforeEach(() => {
  delete process.env.CONWAY_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  state.answers = [];
  state.rlAnswers = [];
  state.defaults = [];
  state.asked = [];
  provisionMock.mockReset();
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function printed(): string {
  // chalk may colour the text; strip ANSI codes.
  return output.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
}

function writeJson(file: string, obj: unknown): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/** Wizard answers in prompt order; providers is one or more [openai, anthropic, ollama] rounds. */
function wizardAnswers(signIn: string, providerRounds: string[][]): string[] {
  return ["", signIn, "Agent", "Do good work", CREATOR, ...providerRounds.flat()];
}

describe("wizard without Conway (the default)", () => {
  it("declining sign-in provisions nothing and writes a standalone install", async () => {
    // A key from an earlier setup must not keep the next run in Conway mode.
    writeJson("config.json", { apiKey: "cnwy_k_OLD", walletAddress: "0xold", provisionedAt: "x" });
    state.answers = wizardAnswers("", [["", "", ""], ["sk-test", "", ""]]);

    const result = await wizard.runSetupWizard();

    expect(provisionMock).not.toHaveBeenCalled();
    expect(state.asked).toContain("Sign in to Conway with this wallet? [y/N]");
    expect(state.answers).toEqual([]);

    const saved = readJson("automaton.json");
    expect(saved.conwayApiKey).toBe("");
    expect(saved.registeredWithConway).toBe(false);
    expect(saved.openaiApiKey).toBe("sk-test");
    expect(saved.sandboxId).toBe("");
    expect(saved.treasuryPolicy.x402AllowedDomains).toEqual([]);
    expect(saved.treasuryPolicy.maxInferenceDailyCents).toBe(200);
    expect(state.defaults.find((d) => d.label.startsWith("Max daily inference"))?.value).toBe(200);
    expect(result.conwayApiKey).toBe("");
    // Explicit, so the sticky standalone guard applies from the first save.
    expect(saved.providers).toEqual({ mode: "standalone" });

    const stored = readJson("config.json");
    expect(stored.apiKey).toBeUndefined();
    expect(stored.walletAddress).toBe("0xold");

    expect(fs.existsSync(path.join(dir, "skills", "survival", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "skills", "conway-compute"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "skills", "conway-payments"))).toBe(false);
    const survival = fs.readFileSync(path.join(dir, "skills", "survival", "SKILL.md"), "utf8");
    expect(survival).toContain("check_inference_spending");
    expect(survival).not.toMatch(/conway|credit|transfer|spawn|child/i);

    const soul = fs.readFileSync(path.join(dir, "SOUL.md"), "utf8");
    expect(soul).toContain("Shell execution on this machine");
    expect(soul).not.toMatch(/conway/i);
    expect(soul).not.toMatch(/sandbox/i);

    const text = printed();
    expect(text).toContain("No Conway key: running standalone with your own AI provider(s)");
    expect(text).toContain("Without a Conway key the automaton needs an AI provider");
    expect(text).toContain("Default skills installed (survival)");
    expect(text).not.toContain("Fund your automaton");
    expect(text).not.toContain("Inference will default to Conway");
    expect(text).not.toContain("conway-compute");
  });

  it("a Conway key stored after a keyless setup does not switch the install to Conway mode", async () => {
    const { resolveRuntime } = await import("../providers/mode.js");
    state.answers = wizardAnswers("", [["sk-test", "", ""]]);
    await wizard.runSetupWizard();

    expect(config.setConwayApiKey("cnwy_k_LATER")).toBe(true);
    process.env.CONWAY_API_KEY = "cnwy_k_ENV";
    try {
      const runtime = resolveRuntime(config.loadConfig()!);
      expect(runtime.mode).toBe("standalone");
      expect(runtime.dailyCapCeilingCents).toBe(200);
    } finally {
      delete process.env.CONWAY_API_KEY;
    }
  });

  it("an answer other than y/yes is no", async () => {
    state.answers = wizardAnswers("maybe", [["", "", "http://localhost:11434"]]);
    await wizard.runSetupWizard();
    expect(provisionMock).not.toHaveBeenCalled();
    expect(readJson("automaton.json").ollamaBaseUrl).toBe("http://localhost:11434");
  });

  it("signing in keeps the Conway setup as before", async () => {
    provisionMock.mockResolvedValue({ apiKey: "cnwy_k_NEW", walletAddress: "0x", keyPrefix: "cnwy_k_N" });
    state.answers = wizardAnswers("y", [["", "", ""]]);

    await wizard.runSetupWizard();

    expect(provisionMock).toHaveBeenCalledTimes(1);
    const saved = readJson("automaton.json");
    expect(saved.conwayApiKey).toBe("cnwy_k_NEW");
    expect(saved.registeredWithConway).toBe(true);
    expect(saved.treasuryPolicy.x402AllowedDomains).toEqual(["conway.tech"]);
    expect(saved.treasuryPolicy.maxInferenceDailyCents).toBe(50_000);
    expect(saved.providers).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "skills", "conway-compute", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "skills", "conway-payments", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf8")).toContain("Shell execution in Conway sandbox");
    const text = printed();
    expect(text).toContain("Fund your automaton");
    expect(text).toContain("Inference will default to Conway");
    expect(text).not.toContain("running standalone");
  });
});

describe("constitution re-install over the read-only copy", () => {
  it("never opens the 0444 file for writing and leaves the new content at 0444", async () => {
    const dst = path.join(dir, "constitution.md");
    fs.writeFileSync(dst, "old constitution\n");
    fs.chmodSync(dst, 0o444);
    // As a non-root owner, copying onto a 0444 file fails with EACCES.
    const copy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, copyfile"), { code: "EACCES" });
    });
    state.answers = wizardAnswers("", [["sk-test", "", ""]]);

    await wizard.runSetupWizard();

    expect(copy).not.toHaveBeenCalled();
    expect(fs.readFileSync(dst, "utf8")).toBe(REPO_CONSTITUTION);
    expect(fs.statSync(dst).mode & 0o777).toBe(0o444);
    expect(fs.existsSync(path.join(dir, "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "skills", "survival", "SKILL.md"))).toBe(true);
  });

  it("is skipped when the content is the same", () => {
    const src = path.join(home, "constitution-src.md");
    const dst = path.join(dir, "constitution.md");
    fs.writeFileSync(src, "laws\n");
    expect(wizard.installConstitution(src, dst)).toBe(true);
    const inode = fs.statSync(dst).ino;
    expect(wizard.installConstitution(src, dst)).toBe(false);
    expect(fs.statSync(dst).ino).toBe(inode);
    expect(fs.statSync(dst).mode & 0o777).toBe(0o444);
  });
});

const BASE_CONFIG = {
  name: "agent",
  genesisPrompt: "purpose",
  creatorAddress: CREATOR,
  registeredWithConway: true,
  sandboxId: "",
  conwayApiUrl: "https://api.conway.tech",
  inferenceModel: "gpt-5.2",
  maxTokensPerTurn: 4096,
  heartbeatConfigPath: "~/.automaton/heartbeat.yml",
  dbPath: "~/.automaton/state.db",
  logLevel: "info",
  walletAddress: "0x" + "1".repeat(40),
  version: "0.2.1",
  skillsDir: "~/.automaton/skills",
  maxChildren: 3,
};

describe("--configure", () => {
  it("clears the Conway key (here and in config.json) and stores a cleared relay as \"\"", async () => {
    writeJson("automaton.json", {
      ...BASE_CONFIG,
      conwayApiKey: "cnwy_k_FILE",
      openaiApiKey: "sk-x",
      socialRelayUrl: "https://social.conway.tech",
    });
    writeJson("config.json", { apiKey: "cnwy_k_FILE", walletAddress: "0xw" });
    state.rlAnswers = [
      "1", "-", "", "", "", "", // providers: clear Conway, keep the mode and the rest
      "4", "", "", "", "-", "", // general: clear the relay
      "q",
    ];

    await configure.runConfigure();

    const saved = readJson("automaton.json");
    expect(saved.conwayApiKey).toBe("");
    expect(saved.openaiApiKey).toBe("sk-x");
    expect(saved.socialRelayUrl).toBe("");
    expect(readJson("config.json").apiKey).toBeUndefined();
    expect(printed()).toContain("the next run is standalone");

    // Both stay cleared after a reload.
    const reloaded = config.loadConfig()!;
    expect(reloaded.socialRelayUrl).toBe("");
    expect(reloaded.conwayApiKey || "").toBe("");
  });

  it("clearing the Conway key leaves no Conway relay or payee behind (the next run polls nothing)", async () => {
    const { resolveRuntime } = await import("../providers/mode.js");
    const policy = { x402AllowedDomains: ["conway.tech"], maxSingleTransferCents: 5000 };
    // As older saves wrote it: the Conway defaults are spelled out in the file.
    writeJson("automaton.json", {
      ...BASE_CONFIG,
      conwayApiKey: "cnwy_k_FILE",
      openaiApiKey: "sk-x",
      socialRelayUrl: "https://social.conway.tech",
      treasuryPolicy: policy,
    });
    state.rlAnswers = ["1", "-", "", "", "", "", "q"];
    await configure.runConfigure();

    const saved = readJson("automaton.json");
    expect(saved.socialRelayUrl).toBeUndefined();
    expect(saved.treasuryPolicy.x402AllowedDomains).toBeUndefined();
    expect(saved.treasuryPolicy.maxSingleTransferCents).toBe(5000);
    const runtime = resolveRuntime(config.loadConfig()!);
    expect(runtime.mode).toBe("standalone");
    expect(runtime.features.relay).toBe(false);
    expect(config.loadConfig()!.treasuryPolicy!.x402AllowedDomains).toEqual([]);
  });

  it("a save made while CONWAY_API_KEY is set writes no Conway defaults", async () => {
    const { resolveRuntime } = await import("../providers/mode.js");
    writeJson("automaton.json", { ...BASE_CONFIG, openaiApiKey: "sk-x" });
    process.env.CONWAY_API_KEY = "cnwy_k_ENV";
    state.rlAnswers = ["4", "", "", "", "", "", "q"];
    await configure.runConfigure();
    delete process.env.CONWAY_API_KEY;

    const saved = readJson("automaton.json");
    expect(saved.socialRelayUrl).toBeUndefined();
    expect(saved.treasuryPolicy?.x402AllowedDomains).toBeUndefined();
    const runtime = resolveRuntime(config.loadConfig()!);
    expect(runtime.mode).toBe("standalone");
    expect(runtime.features.relay).toBe(false);
  });

  it("accepts an install with no Conway key at all", async () => {
    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "", anthropicApiKey: "sk-ant-x" });
    state.rlAnswers = ["1", "", "", "", "", "", "q"];

    await configure.runConfigure();

    const saved = readJson("automaton.json");
    expect(saved.conwayApiKey || "").toBe("");
    expect(saved.anthropicApiKey).toBe("sk-ant-x");
    expect(saved.providers.mode).toBe("standalone");
    expect(printed()).not.toContain("No AI provider configured");
    // Enter on an unset key keeps it unset; it is not a clear.
    expect(printed()).not.toContain("Conway key cleared");
  });

  it("Enter on an unset Conway key leaves the stored key file and an explicit relay alone", async () => {
    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "", openaiApiKey: "sk-x", providers: { mode: "standalone" } });
    writeJson("config.json", { walletAddress: "0xw", apiKey: "cnwy_k_STORED" });
    state.rlAnswers = ["1", "", "", "", "", "", "q"];
    await configure.runConfigure();
    expect(readJson("config.json").apiKey).toBe("cnwy_k_STORED");
    expect(printed()).not.toContain("Conway key cleared");
  });

  it("a new Conway key keeps an explicit standalone mode; only the mode question leaves it", async () => {
    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "", openaiApiKey: "sk-x", providers: { mode: "standalone" } });
    state.rlAnswers = ["1", "cnwy_k_NEW", "", "", "", "", "q"];
    await configure.runConfigure();
    let saved = readJson("automaton.json");
    expect(saved.conwayApiKey).toBe("cnwy_k_NEW");
    expect(saved.providers.mode).toBe("standalone");
    expect(printed()).toContain("the Conway key is kept but not used");

    state.rlAnswers = ["1", "", "auto", "", "", "", "q"];
    await configure.runConfigure();
    saved = readJson("automaton.json");
    expect(saved.providers.mode).toBeUndefined();
    const { resolveRuntime } = await import("../providers/mode.js");
    expect(resolveRuntime(config.loadConfig()!).mode).toBe("conway");
  });

  it("any save that leaves no Conway key pins standalone; a key in the file or the environment does not", async () => {
    const { resolveRuntime } = await import("../providers/mode.js");
    writeJson("automaton.json", { ...BASE_CONFIG, openaiApiKey: "sk-x" });
    state.rlAnswers = ["4", "", "", "", "", "", "q"];
    await configure.runConfigure();
    expect(readJson("automaton.json").providers).toEqual({ mode: "standalone" });
    expect(printed()).toContain('providers.mode saved as "standalone"');
    // A key stored afterwards is kept but unused.
    config.setConwayApiKey("cnwy_k_LATER");
    expect(resolveRuntime(config.loadConfig()!).mode).toBe("standalone");

    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "cnwy_k_FILE" });
    state.rlAnswers = ["4", "", "", "", "", "", "q"];
    await configure.runConfigure();
    expect(readJson("automaton.json").providers).toBeUndefined();

    writeJson("automaton.json", { ...BASE_CONFIG, openaiApiKey: "sk-x" });
    process.env.CONWAY_API_KEY = "cnwy_k_ENV";
    state.rlAnswers = ["4", "", "", "", "", "", "q"];
    await configure.runConfigure();
    delete process.env.CONWAY_API_KEY;
    expect(readJson("automaton.json").providers).toBeUndefined();
  });

  it("clearing the key pins standalone even with CONWAY_API_KEY set", async () => {
    const { resolveRuntime } = await import("../providers/mode.js");
    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "cnwy_k_FILE", openaiApiKey: "sk-x" });
    state.rlAnswers = ["1", "-", "", "", "", "", "q"];
    await configure.runConfigure();
    expect(readJson("automaton.json").providers.mode).toBe("standalone");
    process.env.CONWAY_API_KEY = "cnwy_k_ENV";
    try {
      expect(resolveRuntime(config.loadConfig()!).mode).toBe("standalone");
    } finally {
      delete process.env.CONWAY_API_KEY;
    }
  });

  it("warns when the last provider is gone", async () => {
    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "cnwy_k_FILE" });
    state.rlAnswers = ["1", "-", "", "", "", "", "q"];
    await configure.runConfigure();
    expect(printed()).toContain("No AI provider configured: the automaton will not start until you add one.");
  });
});

describe("model pickers", () => {
  function seedRegistry(): void {
    const db = database.createDatabase(path.join(dir, "state.db"));
    const now = new Date().toISOString();
    const row = (modelId: string, provider: string, cost: number) => ({
      modelId,
      provider,
      displayName: modelId,
      tierMinimum: "normal",
      costPer1kInput: cost,
      costPer1kOutput: cost * 4,
      maxTokens: 4096,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    database.modelRegistryUpsert(db.raw, row("conway-hosted-model", "conway", 30) as any, "api");
    database.modelRegistryUpsert(db.raw, row("claude-manual-model", "anthropic", 30) as any, "manual");
    db.close();
  }

  // A numbered table row, not the menu line that names the active model.
  const gptLine = (text: string) => text.split("\n").find((l) => /^\s*\d+\.\s+gpt-5\.2\s/.test(l)) ?? "";

  it("--pick-model shows $1.80/M for gpt-5.2 and only the configured providers", async () => {
    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "", openaiApiKey: "sk-x" });
    seedRegistry();
    state.answers = [""];

    await picker.runModelPicker();

    const text = printed();
    expect(gptLine(text)).toContain("$1.80/M in");
    expect(text).not.toContain("$180.00");
    expect(text).not.toContain("conway-hosted-model");
    expect(text).not.toContain("claude-manual-model");
    expect(text).not.toMatch(/Conway/);
  });

  it("--configure's model strategy shows the same price and list", async () => {
    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "", openaiApiKey: "sk-x" });
    seedRegistry();
    state.rlAnswers = ["2", ...Array(10).fill(""), "q"];

    await configure.runConfigure();

    const text = printed();
    expect(gptLine(text)).toContain("$1.80/M in");
    expect(text).not.toContain("$180.00");
    expect(text).not.toContain("conway-hosted-model");
    expect(text).not.toMatch(/Conway/);
  });

  it("with a Conway key every model is listed and Conway rows are labelled, as before", async () => {
    writeJson("automaton.json", { ...BASE_CONFIG, conwayApiKey: "cnwy_k_FILE" });
    seedRegistry();
    state.answers = [""];

    await picker.runModelPicker();

    const text = printed();
    const conwayLine = text.split("\n").find((l) => l.includes("conway-hosted-model")) ?? "";
    expect(conwayLine).toContain("Conway");
    expect(conwayLine).toContain("$3.00/M in");
    expect(text).toContain("claude-manual-model");
  });

  it("pickableModels and formatInputPrice", () => {
    const m = (provider: string) => ({ modelId: provider, provider }) as any;
    const all = [m("openai"), m("anthropic"), m("ollama"), m("conway"), m("other")];
    expect(picker.pickableModels(all, { conwayApiKey: "k" }, {}).length).toBe(5);
    expect(picker.pickableModels(all, { anthropicApiKey: "a" }, {}).map((x) => x.provider)).toEqual(["anthropic"]);
    expect(picker.pickableModels(all, {}, { OLLAMA_BASE_URL: "http://localhost:11434" }).map((x) => x.provider)).toEqual([
      "ollama",
    ]);
    expect(picker.pickableModels(all, {}, {})).toEqual([]);
    expect(picker.formatInputPrice(18)).toBe("$1.80/M in");
    expect(picker.formatInputPrice(20)).toBe("$2.00/M in");
  });
});

describe("Conway defaults left by an older setup", () => {
  it("replaces the unmodified Conway survival skill and SOUL.md capability lines, and keeps edited ones", async () => {
    const defaults = await import("../setup/defaults.js");
    const skillsDir = path.join(dir, "skills");
    defaults.installDefaultSkills(skillsDir, { conway: true });
    const soulPath = path.join(dir, "SOUL.md");
    fs.writeFileSync(soulPath, defaults.generateSoulMd("a", "0xa", CREATOR, "Build.", { conway: true }));

    const first = defaults.migrateConwayDefaultsForStandalone(dir, skillsDir);
    expect(first.changed).toHaveLength(2);
    const survival = fs.readFileSync(path.join(skillsDir, "survival", "SKILL.md"), "utf8");
    expect(survival).toContain("check_inference_spending");
    expect(survival).not.toMatch(/credit transfer|spawn a backup child|Check credits/);
    const soul = fs.readFileSync(soulPath, "utf8");
    expect(soul).not.toMatch(/Conway sandbox|Conway API integration|x402 payments/);
    expect(soul).toContain("- Shell execution on this machine");
    expect(soul).toContain("- Self-modification with audit trail");
    expect(soul).toContain("Build.");

    // Edited files are not touched; a SOUL.md that still names Conway is reported.
    const edited = "---\nname: survival\nauto-activate: true\n---\nMy own text.\n";
    fs.writeFileSync(path.join(skillsDir, "survival", "SKILL.md"), edited);
    fs.writeFileSync(soulPath, "# a\n## Capabilities\n- Shell execution in Conway sandbox (my notes)\n");
    const second = defaults.migrateConwayDefaultsForStandalone(dir, skillsDir);
    expect(second.changed).toEqual([]);
    expect(second.warnings).toHaveLength(1);
    expect(fs.readFileSync(path.join(skillsDir, "survival", "SKILL.md"), "utf8")).toBe(edited);
  });
});
