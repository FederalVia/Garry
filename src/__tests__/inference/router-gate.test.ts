/**
 * Main-loop router through the inference gate, driving the real legacy
 * client against a loopback stub standing in for Conway and Ollama.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../state/database.js";
import type { AutomatonDatabase, ModelStrategyConfig, InferenceToolDefinition } from "../../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../../types.js";
import { ModelRegistry } from "../../inference/registry.js";
import { InferenceRouter } from "../../inference/router.js";
import { InferenceGate, installInferenceGate, resetInferenceGateForTests } from "../../inference/gate.js";
import { resolveInferencePolicy } from "../../inference/policy.js";
import { InferenceCallError } from "../../inference/errors.js";
import { createInferenceClient } from "../../conway/inference.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Hit {
  backend: "conway" | "ollama";
  body: any;
  auth?: string;
}
type Reply = { status?: number; body?: unknown };
type Handler = (hit: Hit, index: number) => Reply;

let server: http.Server;
let base: string;
let hits: Hit[];
let handler: Handler;
let tmp: string;
let db: AutomatonDatabase;
let clock: number;
let strategy: ModelStrategyConfig;
let gate: InferenceGate;

const ok = (hit: Hit): Reply => ({
  body: {
    id: "r",
    model: hit.body.model,
    choices: [{ message: { role: "assistant", content: `hello from ${hit.body.model}` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  },
});

beforeEach(async () => {
  hits = [];
  handler = ok;
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const hit: Hit = {
        backend: req.url!.startsWith("/ollama") ? "ollama" : "conway",
        body: JSON.parse(data || "{}"),
        auth: req.headers.authorization,
      };
      hits.push(hit);
      const reply = handler(hit, hits.length - 1);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "router-gate-"));
  db = createDatabase(path.join(tmp, "state.db"));
  clock = Date.UTC(2026, 10, 1, 12);
  strategy = { ...DEFAULT_MODEL_STRATEGY_CONFIG };
});

afterEach(async () => {
  resetInferenceGateForTests();
  db.close();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function setup(opts: { daily?: number; strategy?: Partial<ModelStrategyConfig>; apiKey?: string } = {}) {
  strategy = { ...strategy, ...(opts.strategy ?? {}) };
  gate = new InferenceGate({
    db: db.raw,
    policy: resolveInferencePolicy({ modelStrategy: strategy }, { maxInferenceDailyCents: opts.daily ?? 50_000 }),
    now: () => clock,
  });
  gate.setSurvival({ tier: "high", creditsCents: 100_000 });
  installInferenceGate(gate);
  const registry = new ModelRegistry(db.raw);
  registry.initialize();
  const client = createInferenceClient({
    apiUrl: `${base}/conway`,
    apiKey: opts.apiKey ?? "conway-key",
    defaultModel: "gpt-5.2",
    maxTokens: 4096,
    ollamaBaseUrl: `${base}/ollama`,
    getModelProvider: (id) => registry.get(id)?.provider,
  });
  const router = new InferenceRouter(db.raw, registry, gate, () => strategy, {
    canServe: (m) => client.canServe!(m),
    sleep: async () => {},
  });
  const route = (tier: "high" | "normal" | "low_compute" | "critical" | "dead", extra: Record<string, unknown> = {}) =>
    router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier, sessionId: "s", ...extra } as any,
      (msgs, o) => client.chat(msgs, o),
    );
  return { registry, client, router, route };
}

const ledger = () =>
  db.raw.prepare("SELECT model, status, reserved_micro_usd, cost_micro_usd, max_output_tokens FROM inference_ledger ORDER BY rowid").all() as any[];

/** Commit `cents` of main-class spend at the current clock. */
function commitSpend(cents: number): void {
  const r = gate.reserve({
    callId: `seed-${clock}`,
    attempt: 1,
    provider: "openai",
    model: "seed",
    price: { inputUsdPerM: 2, outputUsdPerM: 8, local: false },
    estInputTokens: cents * 5000,
    maxOutputTokens: 0,
    minOutputTokens: 0,
    scope: { caller: "agent_turn" },
  });
  gate.commit(r.id, { inputTokens: cents * 5000, outputTokens: 0 }, 1);
}

function registerLlama(registry: ModelRegistry): void {
  const now = new Date().toISOString();
  registry.upsert({
    modelId: "llama3.2:latest",
    provider: "ollama",
    displayName: "Llama 3.2",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 4096,
    contextWindow: 128_000,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
    lastSeen: null,
    createdAt: now,
    updatedAt: now,
  });
}

function tools(n: number): InferenceToolDefinition[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "function" as const,
    function: {
      name: `tool_${i}`,
      description: `Tool number ${i}. `.repeat(20),
      parameters: { type: "object", properties: { arg: { type: "string", description: "An argument. ".repeat(5) } } },
    },
  }));
}

describe("daily cap through the router (F124)", () => {
  it("refuses an agent turn once 24 h spend reaches maxInferenceDailyCents, and allows it after the window", async () => {
    const { route } = setup({ daily: 500, strategy: { hourlyBudgetCents: 500 } });
    commitSpend(300);
    clock += 3 * HOUR;
    commitSpend(199);
    clock += HOUR;
    const refused = await route("normal");
    expect(refused.finishReason).toBe("budget_exceeded");
    expect(refused.refusal?.code).toBe("DAILY_CAP");
    // 1c left fits no candidate (gpt-5-mini's worst case is ~1.3c). The
    // 300c row ages out 24 h after it was spent: 20 h from now.
    expect(refused.refusal!.retryAfterMs!).toBeGreaterThan(20 * HOUR - 1000);
    expect(refused.refusal!.retryAfterMs!).toBeLessThanOrEqual(20 * HOUR + 1000);
    expect(hits).toHaveLength(0);
    clock += DAY;
    const allowed = await route("normal");
    expect(allowed.finishReason).toBe("stop");
    expect(hits).toHaveLength(1);
  });
});

describe("selected model (F126)", () => {
  it("sends every tier to the selected free Ollama model, never to Conway", async () => {
    const { registry, route } = setup();
    registerLlama(registry);
    // What --pick-model and switch_model write: only inferenceModel.
    strategy.inferenceModel = "llama3.2:latest";
    expect(strategy.lowComputeModel).toBe("gpt-5-mini");
    expect(strategy.criticalModel).toBe("gpt-5-mini");
    for (const tier of ["high", "normal", "low_compute", "critical", "dead"] as const) {
      const r = await route(tier);
      expect(r.model, tier).toBe("llama3.2:latest");
    }
    expect(hits.map((h) => h.backend)).toEqual(["ollama", "ollama", "ollama", "ollama", "ollama"]);
    expect(ledger().every((r) => r.cost_micro_usd === 0)).toBe(true);
  });

  it("a local critical model does not displace a paid model selected for high and normal", async () => {
    const { registry, route } = setup();
    registerLlama(registry);
    strategy.criticalModel = "llama3.2:latest";
    expect((await route("high")).model).toBe("gpt-5.2");
    expect((await route("low_compute")).model).toBe("llama3.2:latest");
    expect((await route("critical")).model).toBe("llama3.2:latest");
  });

  it("never routes to a paid model whose price is unknown, so no assumed price can undercount it", async () => {
    const { registry, route } = setup();
    const now = new Date().toISOString();
    registry.upsert({
      modelId: "unpriced-remote",
      provider: "anthropic",
      displayName: "Unpriced",
      tierMinimum: "normal",
      costPer1kInput: 0,
      costPer1kOutput: 0,
      maxTokens: 8192,
      contextWindow: 200_000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: null,
      createdAt: now,
      updatedAt: now,
    });
    strategy.inferenceModel = "unpriced-remote";
    const r = await route("normal");
    expect(r.model).toBe("gpt-5.2");
    expect(hits.map((h) => h.body.model)).toEqual(["gpt-5.2"]);
    expect(ledger().map((row) => row.model)).toEqual(["gpt-5.2"]);
  });

  it("a model switch mid-cycle changes the next route", async () => {
    const { registry, route } = setup();
    registerLlama(registry);
    strategy.inferenceModel = "llama3.2:latest";
    expect((await route("normal")).model).toBe("llama3.2:latest");
    strategy.inferenceModel = "gpt-5.3";
    expect((await route("normal")).model).toBe("gpt-5.3");
    expect(hits.map((h) => h.backend)).toEqual(["ollama", "conway"]);
  });

  it("free local models are still served when the paid caps are exhausted", async () => {
    const { registry, route } = setup({ daily: 0 });
    registerLlama(registry);
    expect((await route("normal")).refusal?.code).toBeDefined();
    strategy.inferenceModel = "llama3.2:latest";
    const r = await route("normal");
    expect(r.finishReason).toBe("stop");
    expect(r.model).toBe("llama3.2:latest");
  });

  it("skips a model no configured backend can serve", async () => {
    const { registry, route } = setup({ apiKey: "" });
    const now = new Date().toISOString();
    registry.upsert({
      modelId: "claude-x",
      provider: "anthropic",
      displayName: "Claude X",
      tierMinimum: "normal",
      costPer1kInput: 30,
      costPer1kOutput: 150,
      maxTokens: 8192,
      contextWindow: 200_000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: null,
      createdAt: now,
      updatedAt: now,
    });
    strategy.inferenceModel = "claude-x";
    const r = await route("normal");
    expect(r.refusal?.code).toBe("NO_MODEL");
    expect(hits).toHaveLength(0);
  });
});

describe("estimate and per-call ceiling (F125)", () => {
  it("counts tools in the estimate, clamps output to fit the ceiling and falls back to a cheaper model", async () => {
    const { router, client } = setup({ strategy: { perCallCeilingCents: 2.5 } });
    handler = (hit) => {
      // Usage equal to the estimate: the worst case the gate reserved.
      const row = db.raw
        .prepare("SELECT est_input_tokens FROM inference_ledger WHERE status = 'reserved' ORDER BY rowid DESC LIMIT 1")
        .get() as { est_input_tokens: number };
      const out = hit.body.max_completion_tokens ?? hit.body.max_tokens;
      return {
        body: {
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: row.est_input_tokens, completion_tokens: out },
        },
      };
    };
    const t = tools(70);
    const result = await router.route(
      {
        messages: [
          { role: "system", content: "The quick brown fox jumps over the lazy dog. ".repeat(728).slice(0, 32_000) },
          { role: "user", content: "go" },
        ],
        taskType: "agent_turn",
        tier: "normal",
        sessionId: "s",
        tools: t,
      },
      (msgs, o) => client.chat(msgs, { ...o, tools: t }),
    );
    // About 24k input tokens with the tool schemas: gpt-5.2 cannot fit 2.5c
    // even at 1024 output tokens; gpt-5-mini can, with output clamped.
    expect(result.model).toBe("gpt-5-mini");
    expect(hits).toHaveLength(1);
    const sent = hits[0].body.max_completion_tokens;
    expect(sent).toBeLessThan(4096);
    expect(sent).toBeGreaterThanOrEqual(1024);
    const [row] = ledger();
    expect(row.model).toBe("gpt-5-mini");
    expect(row.max_output_tokens).toBe(sent);
    expect(row.reserved_micro_usd).toBeLessThanOrEqual(25_000);
    expect(row.cost_micro_usd).toBeLessThanOrEqual(25_000);
  });
});

describe("input estimate at the critical ceiling", () => {
  it("serves a critical-tier turn of about 100k characters whose real cost fits the 3c matrix ceiling", async () => {
    const { router, client } = setup();
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    const messages: any[] = [{ role: "system", content: sentence.repeat(220) }];
    for (let i = 0; i < 9; i++) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `c${i}`, type: "function", function: { name: "exec", arguments: `{"command":"cat f${i}"}` } }],
      });
      messages.push({ role: "tool", content: sentence.repeat(220), tool_call_id: `c${i}` });
    }
    messages.push({ role: "user", content: "go" });
    expect(JSON.stringify(messages).length).toBeGreaterThan(95_000);
    const result = await router.route(
      { messages, taskType: "agent_turn", tier: "critical", sessionId: "s" },
      (msgs, o) => client.chat(msgs, o),
    );
    // About 22k real tokens: 1.8c of input plus 1024 output tokens at
    // gpt-5-mini prices fits 3c; counting bytes past a prefix did not.
    expect(result.finishReason).toBe("stop");
    expect(result.model).toBe("gpt-5-mini");
    const [row] = ledger();
    expect(row.reserved_micro_usd).toBeLessThanOrEqual(30_000);
  });
});

describe("fallback (F135)", () => {
  it("falls back to the next candidate when the first model is not found", async () => {
    const { route } = setup();
    handler = (hit) =>
      hit.body.model === "gpt-5.2"
        ? { status: 404, body: { error: { code: "model_not_found", message: "no such model" } } }
        : ok(hit);
    const r = await route("normal");
    expect(r.model).toBe("gpt-5-mini");
    expect(ledger().map((x) => [x.model, x.status])).toEqual([
      ["gpt-5.2", "released"],
      ["gpt-5-mini", "committed"],
    ]);
  });

  it("with enableModelFallback=false the call fails on the first model", async () => {
    const { route } = setup({ strategy: { enableModelFallback: false } });
    handler = () => ({ status: 404, body: { error: { code: "model_not_found" } } });
    await expect(route("normal")).rejects.toBeInstanceOf(InferenceCallError);
    expect(hits.map((h) => h.body.model)).toEqual(["gpt-5.2"]);
  });

  it("makes at most 4 HTTP attempts per call", async () => {
    const { route } = setup();
    strategy.inferenceModel = "gpt-4.1";
    strategy.lowComputeModel = "gpt-4.1-mini";
    strategy.criticalModel = "gpt-4.1-nano";
    handler = () => ({ status: 503, body: { error: "busy" } });
    await expect(route("normal")).rejects.toBeInstanceOf(InferenceCallError);
    expect(hits).toHaveLength(4);
  });
});

describe("maxTokensPerTurn (F136)", () => {
  it("caps the request's max_completion_tokens at normal and high tiers", async () => {
    const { route } = setup({ strategy: { maxTokensPerTurn: 1024 } });
    await route("normal");
    await route("high");
    expect(hits.map((h) => h.body.max_completion_tokens)).toEqual([1024, 1024]);
  });
});
