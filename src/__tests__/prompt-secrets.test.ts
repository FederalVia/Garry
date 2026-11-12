/**
 * Secrets never reach a prompt:
 * - prompt files (WORKLOG.md, SOUL.md, constitution.md) are read only as
 *   regular single-link files, so a link to wallet.json is ignored;
 * - known secret values are redacted at both inference chokepoints.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types.js";

const openAiCalls = vi.hoisted(() => [] as any[]);
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function MockOpenAI(this: any) {
    this.chat = {
      completions: {
        create: vi.fn(async (payload: any) => {
          openAiCalls.push(payload);
          return {
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        }),
      },
    };
  }),
}));

const PRIVATE_KEY_HEX = "fac2a436bd62a4ab7bd4f3cc6ccb861cda7a26396171687e5bff18025e325b7a";
const PRIVATE_KEY = `0x${PRIVATE_KEY_HEX}`;
const WALLET_JSON = JSON.stringify({ chainType: "evm", privateKey: PRIVATE_KEY }, null, 2);
const API_KEY = "cnwy_k_TESTSECRET_0123456789abcdef";

const ORIGINAL_ENV = { ...process.env };
let tmp: string;
let stateDir: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-secrets-"));
  process.env.HOME = tmp;
  stateDir = path.join(tmp, ".automaton");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "wallet.json"), WALLET_JSON, { mode: 0o600 });
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function buildPrompt(): Promise<string> {
  const { buildSystemPrompt } = await import("../agent/system-prompt.js");
  const { createTestDb, createTestIdentity, createTestConfig } = await import("./mocks.js");
  return buildSystemPrompt({
    identity: createTestIdentity(),
    config: createTestConfig(),
    financial: { creditsCents: 1000, usdcBalance: 0, lastChecked: new Date().toISOString() },
    state: "running" as any,
    db: createTestDb(),
    tools: [],
    skills: [],
    isFirstRun: false,
  });
}

function resetPromptFiles(): void {
  for (const f of ["WORKLOG.md", "SOUL.md", "constitution.md"]) {
    fs.rmSync(path.join(stateDir, f), { force: true });
  }
}

describe("N1: prompt files do not follow links", () => {
  afterEach(resetPromptFiles);

  it("ignores WORKLOG.md, SOUL.md and constitution.md that link to wallet.json", async () => {
    for (const f of ["WORKLOG.md", "SOUL.md", "constitution.md"]) {
      fs.symlinkSync("wallet.json", path.join(stateDir, f));
    }
    const prompt = await buildPrompt();
    expect(prompt).not.toContain(PRIVATE_KEY_HEX);
  });

  it("ignores a WORKLOG.md that is a hard link to wallet.json", async () => {
    fs.linkSync(path.join(stateDir, "wallet.json"), path.join(stateDir, "WORKLOG.md"));
    const prompt = await buildPrompt();
    expect(prompt).not.toContain(PRIVATE_KEY_HEX);
  });

  it("still loads a regular WORKLOG.md, keeping only its most recent part", async () => {
    const old = "OLD-ENTRY ".repeat(3000);
    fs.writeFileSync(path.join(stateDir, "WORKLOG.md"), `${old}\nLATEST-ENTRY`);
    const prompt = await buildPrompt();
    expect(prompt).toContain("LATEST-ENTRY");
    expect(prompt).toContain("earlier worklog entries omitted");
    expect(prompt.split("OLD-ENTRY").length - 1).toBeLessThan(2000);
  });

  it("keeps the newest part of a WORKLOG.md larger than 256 KiB", async () => {
    const old = "OLD-ENTRY ".repeat(30_000);
    expect(old.length).toBeGreaterThan(256 * 1024);
    fs.writeFileSync(path.join(stateDir, "WORKLOG.md"), `FIRST-ENTRY\n${old}\nLATEST-ENTRY`);
    const prompt = await buildPrompt();
    expect(prompt).toContain("LATEST-ENTRY");
    expect(prompt).toContain("earlier worklog entries omitted");
    expect(prompt).not.toContain("FIRST-ENTRY");
    expect(prompt.split("OLD-ENTRY").length - 1).toBeLessThan(2000);
  });

  it("still ignores a large WORKLOG.md reached through a link", async () => {
    fs.writeFileSync(path.join(tmp, "big.md"), "x".repeat(300 * 1024) + PRIVATE_KEY_HEX);
    fs.symlinkSync(path.join(tmp, "big.md"), path.join(stateDir, "WORKLOG.md"));
    const prompt = await buildPrompt();
    expect(prompt).not.toContain(PRIVATE_KEY_HEX);
    fs.rmSync(path.join(tmp, "big.md"));
  });
});

function base64OfFile(): string {
  return Buffer.from(WALLET_JSON, "utf-8").toString("base64");
}

function leakyMessages(): ChatMessage[] {
  return [
    { role: "system", content: `system ${API_KEY}` },
    { role: "user", content: `head wallet.json -> ${WALLET_JSON}` },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "send_message", arguments: JSON.stringify({ text: `key ${PRIVATE_KEY_HEX}` }) },
        },
      ],
    },
    { role: "tool", content: `base64 wallet.json: ${base64OfFile()}`, tool_call_id: "t1" },
    // Content-part arrays are forwarded verbatim by some callers.
    { role: "user", content: [{ type: "text", text: `parts ${PRIVATE_KEY}` }] as any },
  ];
}

function expectNoSecrets(serialized: string): void {
  expect(serialized).not.toContain(PRIVATE_KEY_HEX);
  expect(serialized.toLowerCase()).not.toContain(PRIVATE_KEY_HEX.toLowerCase());
  expect(serialized).not.toContain(API_KEY);
  // The stable middle of the base64-encoded wallet key.
  const b64 = base64OfFile();
  const keyStart = Buffer.from(WALLET_JSON).indexOf(PRIVATE_KEY_HEX);
  const fragmentStart = Math.ceil(keyStart / 3) * 4 + 4;
  expect(serialized).not.toContain(b64.slice(fragmentStart, fragmentStart + 40));
  expect(serialized).toContain("[REDACTED:");
}

/** A permissive inference gate, so both clients can send (the legacy one needs a reservation). */
async function installTestGate() {
  const { InferenceGate, installInferenceGate } = await import("../inference/gate.js");
  const { resolveInferencePolicy } = await import("../inference/policy.js");
  const { createTestDb } = await import("./mocks.js");
  const gate = new InferenceGate({
    db: createTestDb().raw,
    policy: resolveInferencePolicy({}, { maxInferenceDailyCents: 1_000_000 }),
  });
  gate.setSurvival({ tier: "high", creditsCents: 1_000_000 });
  installInferenceGate(gate);
  return gate;
}

describe("known secrets are redacted at the inference boundary", () => {
  let gate: Awaited<ReturnType<typeof installTestGate>>;

  beforeAll(async () => {
    const { registerSecret } = await import("../security/secret-redaction.js");
    registerSecret(PRIVATE_KEY, "wallet");
    registerSecret(API_KEY, "conway-api-key");
  });

  beforeEach(async () => {
    gate = await installTestGate();
  });

  afterEach(async () => {
    const { resetInferenceGateForTests } = await import("../inference/gate.js");
    resetInferenceGateForTests();
  });

  afterAll(async () => {
    const { clearRegisteredSecrets } = await import("../security/secret-redaction.js");
    clearRegisteredSecrets();
  });

  const reservation = (model: string) =>
    gate.reserve({
      callId: `t-${model}`,
      attempt: 1,
      provider: "conway",
      model,
      price: { inputUsdPerM: 1, outputUsdPerM: 1, local: false },
      estInputTokens: 10,
      maxOutputTokens: 100,
      minOutputTokens: 100,
      scope: { caller: "agent_turn" },
    }).id;

  it("createInferenceClient (OpenAI-compatible and Anthropic backends)", async () => {
    const { ResilientHttpClient } = await import("../conway/http-client.js");
    const bodies: string[] = [];
    const spy = vi.spyOn(ResilientHttpClient.prototype, "request").mockImplementation(async (url: any, init: any) => {
      bodies.push(String(init?.body ?? ""));
      const anthropic = String(url).includes("anthropic");
      const payload = anthropic
        ? { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { choices: [{ message: { role: "assistant", content: "ok" } }], usage: {} };
      return { ok: true, status: 200, json: async () => payload, text: async () => "" } as any;
    });
    try {
      const { createInferenceClient } = await import("../conway/inference.js");
      const client = createInferenceClient({
        apiUrl: "https://api.conway.example",
        apiKey: "k",
        defaultModel: "some-model",
        maxTokens: 100,
        anthropicApiKey: "sk-ant-test-anthropic-key-000000",
      });
      await client.chat(leakyMessages(), { reservationId: reservation("some-model") });
      await client.chat(leakyMessages(), { model: "claude-test", reservationId: reservation("claude-test") });
    } finally {
      spy.mockRestore();
    }
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expectNoSecrets(body);
  });

  it("redacts the wrapped output of the base64 CLI (76 columns) and of openssl (64 columns)", async () => {
    const { redactChatMessages } = await import("../security/secret-redaction.js");
    const walletPath = path.join(stateDir, "wallet.json");
    const wrapAt = (s: string, n: number) => s.match(new RegExp(`.{1,${n}}`, "g"))!.join("\n") + "\n";
    const outputs = {
      cli: execFileSync("base64", [walletPath], { encoding: "utf8" }),
      cliKeyOnly: execFileSync("base64", { input: PRIVATE_KEY, encoding: "utf8" }),
      wrap64: wrapAt(base64OfFile(), 64),
      wrap64Crlf: wrapAt(base64OfFile(), 64).replace(/\n/g, "\r\n"),
    };
    expect(outputs.cli).toContain("\n");
    for (const [name, out] of Object.entries(outputs)) {
      const [msg] = redactChatMessages([{ role: "tool", content: out, tool_call_id: "t" }]);
      const redacted = String(msg.content);
      expect(redacted, name).toContain("[REDACTED:wallet]");
      const decoded = Buffer.from(redacted.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("latin1");
      expect(decoded, name).not.toContain(PRIVATE_KEY_HEX);
    }
  });

  it("UnifiedInferenceClient", async () => {
    const { ProviderRegistry } = await import("../inference/provider-registry.js");
    const { UnifiedInferenceClient } = await import("../inference/inference-client.js");
    const registry = new ProviderRegistry([
      {
        id: "p1",
        name: "P1",
        baseUrl: "https://p1.example/v1",
        apiKeyEnvVar: "P1_KEY",
        models: [
          {
            id: "m1",
            tier: "fast",
            contextWindow: 1000,
            maxOutputTokens: 100,
            // A paid model needs a known price to be served at all.
            costPerInputToken: 1,
            costPerOutputToken: 2,
            supportsTools: true,
            supportsVision: false,
            supportsStreaming: false,
          },
        ],
        maxRequestsPerMinute: 10,
        maxTokensPerMinute: 1000,
        priority: 1,
        enabled: true,
      },
    ]);
    openAiCalls.length = 0;
    // Providers without a configured key are skipped, so give p1 one.
    const previousKey = process.env.P1_KEY;
    process.env.P1_KEY = "p1-test-key";
    try {
      await new UnifiedInferenceClient(registry).chat({ tier: "fast", messages: leakyMessages() });
    } finally {
      if (previousKey === undefined) delete process.env.P1_KEY;
      else process.env.P1_KEY = previousKey;
    }
    expect(openAiCalls).toHaveLength(1);
    expectNoSecrets(JSON.stringify(openAiCalls[0].messages));
  });
});
