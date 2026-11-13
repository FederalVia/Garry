/**
 * Golden system prompts. The Conway-mode text is pinned to the output from
 * before standalone mode existed; the standalone text must not claim a
 * Conway account or a cloud sandbox.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AutomatonTool, FinancialState } from "../types.js";

const ORIGINAL_HOME = process.env.HOME;
let tmp: string;

const CONSTITUTION = "Constitution (test copy)\nI. Never harm.\nII. Earn your existence.\nIII. Never deceive.";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-golden-"));
  process.env.HOME = tmp;
  fs.mkdirSync(path.join(tmp, ".automaton"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".automaton", "constitution.md"), CONSTITUTION);
});

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Fixed tool rows, so tool description edits elsewhere do not move the golden text.
const TOOLS = [
  { name: "exec", category: "vm", description: "Run a shell command.", riskLevel: "caution" },
  { name: "write_file", category: "vm", description: "Write a file.", riskLevel: "caution" },
  { name: "sleep", category: "survival", description: "Sleep for a while.", riskLevel: "safe" },
] as unknown as AutomatonTool[];

const FIXED_DATE = "2026-01-01T00:00:00.000Z";

async function build(kind: "conway" | "standalone", opts: { firstRun?: boolean } = {}) {
  const { buildSystemPrompt, buildWakeupPrompt } = await import("../agent/system-prompt.js");
  const { createTestDb, createTestIdentity, createTestConfig } = await import("./mocks.js");
  const identity = { ...createTestIdentity(), createdAt: FIXED_DATE };
  const config =
    kind === "conway"
      ? createTestConfig({ creatorMessage: "Hello from the creator." })
      : createTestConfig({
          conwayApiKey: undefined,
          sandboxId: "",
          socialRelayUrl: "",
          openaiApiKey: "sk-test-openai",
          creatorMessage: "Hello from the creator.",
        });
  if (kind === "standalone") identity.sandboxId = "";
  const financial: FinancialState =
    kind === "conway"
      ? { creditsCents: 1234, usdcBalance: 1.5, credits: "live", usdc: "live", lastChecked: FIXED_DATE }
      : {
          creditsCents: null,
          usdcBalance: null,
          credits: "fixed",
          usdc: "unknown",
          fixedTier: "normal",
          lastChecked: FIXED_DATE,
        } as FinancialState;
  const db = createTestDb();
  try {
    const system = buildSystemPrompt({
      identity,
      config,
      financial,
      state: "running",
      db,
      tools: TOOLS,
      skills: [],
      isFirstRun: opts.firstRun ?? true,
    });
    const wakeup = buildWakeupPrompt({ identity, config, financial, db });
    return { system, wakeup };
  } finally {
    db.close();
  }
}

describe("system prompt golden text", () => {
  it("Conway mode is unchanged", async () => {
    const { system, wakeup } = await build("conway");
    expect(system).toMatchSnapshot("conway-system");
    expect(wakeup).toMatchSnapshot("conway-wakeup");
  });

  it("standalone mode claims no Conway account and no cloud sandbox", async () => {
    const { system, wakeup } = await build("standalone");
    for (const text of [system, wakeup]) {
      expect(text).not.toMatch(/conway/i);
      expect(text).not.toMatch(/sandbox/i);
      expect(text).not.toMatch(/credit balance|compute credits/i);
    }
    expect(system).toContain("You run on a machine your creator provides");
    expect(system).toContain("daily cap of $2.00");
    expect(system).toContain("Survival tier: normal (fixed)");
    expect(system).toContain("Credits: not tracked in standalone mode");
    expect(system).toContain("payments are off");
    expect(system).not.toContain("spawn_child");
    expect(system).toMatchSnapshot("standalone-system");
    expect(wakeup).toMatchSnapshot("standalone-wakeup");
  });

  it("standalone with payments on describes the x402 wallet, still without Conway", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const { createTestDb, createTestIdentity, createTestConfig } = await import("./mocks.js");
    const db = createTestDb();
    try {
      const prompt = buildSystemPrompt({
        identity: { ...createTestIdentity(), sandboxId: "" },
        config: createTestConfig({
          conwayApiKey: undefined,
          sandboxId: "",
          openaiApiKey: "sk-x",
          socialRelayUrl: "https://relay.example",
          providers: { payments: true, dailyCapCeilingCents: 150 },
        }),
        financial: { creditsCents: null, usdcBalance: 2, credits: "fixed", fixedTier: "normal", lastChecked: FIXED_DATE },
        state: "running",
        db,
        tools: TOOLS,
        isFirstRun: false,
      });
      expect(prompt).not.toMatch(/conway|sandbox/i);
      expect(prompt).toContain("x402");
      expect(prompt).toContain("Social relay");
      expect(prompt).toContain("daily cap of $1.50");
    } finally {
      db.close();
    }
  });

  it("standalone with the real built-in tool list mentions neither Conway nor a sandbox", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const { createBuiltinTools } = await import("../agent/tools.js");
    const { visibleTools, standaloneFeatures } = await import("../providers/features.js");
    const { createTestDb, createTestIdentity, createTestConfig } = await import("./mocks.js");
    const tools = visibleTools(
      createBuiltinTools("", { standalone: true }),
      standaloneFeatures({ relay: false, payments: false }),
    );
    const db = createTestDb();
    try {
      const prompt = buildSystemPrompt({
        identity: { ...createTestIdentity(), sandboxId: "" },
        config: createTestConfig({ conwayApiKey: undefined, sandboxId: "", socialRelayUrl: "", openaiApiKey: "sk-x" }),
        financial: { creditsCents: null, usdcBalance: null, credits: "fixed", fixedTier: "normal", lastChecked: FIXED_DATE },
        state: "running",
        db,
        tools,
        isFirstRun: false,
      });
      const offending = prompt.split("\n").filter((l) => /conway|sandbox|conserve credits/i.test(l));
      expect(offending).toEqual([]);
      expect(prompt).toContain("- list_models (inference):");
    } finally {
      db.close();
    }
  });

  it("with orchestration off the prompt drops the orchestrator role and the goal tools", async () => {
    const { standaloneOperationalContext } = await import("../agent/system-prompt.js");
    const { standaloneFeatures, visibleTools } = await import("../providers/features.js");
    const off = standaloneOperationalContext(standaloneFeatures({ relay: false, payments: false, orchestration: false }));
    expect(off).not.toContain("<orchestration>");
    expect(off).not.toMatch(/parent orchestrator|create_goal|orchestrator_status|local workers/i);
    expect(off).toContain("Orchestration is off");
    expect(off).toContain("<persistence>");
    const on = standaloneOperationalContext(standaloneFeatures({ relay: false, payments: false }));
    expect(on).toContain("<orchestration>");
    const names = ["create_goal", "list_goals", "cancel_goal", "get_plan", "complete_task", "orchestrator_status", "exec"];
    const shown = visibleTools(
      names.map((name) => ({ name })),
      standaloneFeatures({ relay: false, payments: false, orchestration: false }),
    ).map((t) => t.name);
    expect(shown).toEqual(["exec"]);
  });

  it("every standalone edit of the operational context still matches", async () => {
    const { standaloneOperationalContext } = await import("../agent/system-prompt.js");
    const { standaloneFeatures } = await import("../providers/features.js");
    expect(() => standaloneOperationalContext(standaloneFeatures({ relay: false, payments: false }))).not.toThrow();
  });
});
