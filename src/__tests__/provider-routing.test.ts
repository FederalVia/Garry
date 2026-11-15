/**
 * Main-loop routing through the provider table, router plus client, with
 * mocked HTTP: each provider kind gets its own URL, key header and wire id;
 * a tool call reaches Anthropic as tool_use then tool_result; free means a
 * loopback server marked free; an unpriced model is skipped unless its
 * provider allows it, then reserved at the highest known price; Haiku 5.5's
 * long-prompt price applies at 70% of its threshold.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../state/database.js";
import type { AutomatonConfig, AutomatonDatabase, ChatMessage, ModelStrategyConfig } from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceRouter } from "../inference/router.js";
import { InferenceGate, installInferenceGate, resetInferenceGateForTests } from "../inference/gate.js";
import { registryPrice, resolveInferencePolicy } from "../inference/policy.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { createInferenceClient, modelRouteOf } from "../conway/inference.js";
import { keepsConwaySurvivalRule, providerIdForRow, resolveProviderTable } from "../providers/table.js";
import { highestKnownPrice } from "../providers/model-defaults.js";
import { StructuredLogger } from "../observability/logger.js";
import { createTestConfig } from "./mocks.js";

const realFetch = globalThis.fetch;
let tmp: string;
let db: AutomatonDatabase;
let gate: InferenceGate;

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
}
let seen: Seen[];
let anthropicUsage: { input_tokens: number; output_tokens: number };

function stubFetch(): void {
  globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, headers, body });
    if (url.endsWith("/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "anthropic ok" }],
          stop_reason: "end_turn",
          usage: anthropicUsage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "c",
        model: body?.model,
        choices: [{ message: { role: "assistant", content: "openai-like ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "provider-routing-"));
  db = createDatabase(path.join(tmp, "state.db"));
  gate = new InferenceGate({ db: db.raw, policy: resolveInferencePolicy({}, { maxInferenceDailyCents: 500 }), fixedTier: "normal" });
  installInferenceGate(gate);
  seen = [];
  anthropicUsage = { input_tokens: 100, output_tokens: 20 };
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  StructuredLogger.resetSink();
  resetInferenceGateForTests();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The wiring index.ts and the loop use, on a test database. */
function wire(config: AutomatonConfig, strategy: Partial<ModelStrategyConfig> = {}) {
  const table = resolveProviderTable(config, {});
  const registry = new ModelRegistry(db.raw, { table, config });
  registry.initialize();
  registry.seedFromPriceTable(table);
  const client = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey: "",
    defaultModel: "x",
    maxTokens: 1000,
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    ollamaBaseUrl: config.ollamaBaseUrl,
    conwayFallback: false,
    getModelProvider: (id) => registry.get(id)?.provider,
    table,
    getModelRoute: (id) => modelRouteOf(registry.get(id)),
  });
  const router = new InferenceRouter(
    db.raw,
    registry,
    gate,
    () => ({ ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: config.inferenceModel, ...strategy }),
    {
      canServe: (m) => client.canServe!(m),
      allowUnpriced: (m) => table.get(providerIdForRow(m))?.allowUnpriced === true,
      legacySurvivalRow: (m) => keepsConwaySurvivalRule(table, m),
      unknownPrice: () => highestKnownPrice(config, registry),
    },
  );
  const route = (messages: ChatMessage[], extra: Record<string, unknown> = {}) =>
    router.route(
      { messages, taskType: "agent_turn", tier: "normal", sessionId: "s", ...extra } as any,
      (m, o) => client.chat(m, o),
    );
  return { table, registry, client, router, route };
}

const ledger = () =>
  db.raw
    .prepare(
      "SELECT provider, model, status, price_in_usd_per_m AS pin, price_out_usd_per_m AS pout FROM inference_ledger ORDER BY rowid",
    )
    .all() as Array<{ provider: string; model: string; status: string; pin: number; pout: number }>;

const hi: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("main-loop routing by provider", () => {
  it("OpenAI: the default URL with the OpenAI key", async () => {
    const { route } = wire(createTestConfig({ conwayApiKey: "", openaiApiKey: "sk-openai", inferenceModel: "gpt-5.2" }));
    const r = await route(hi);
    expect(r.model).toBe("gpt-5.2");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen[0].headers.authorization).toBe("Bearer sk-openai");
    expect(seen[0].body.model).toBe("gpt-5.2");
    expect(seen[0].body).toHaveProperty("max_completion_tokens");
  });

  it("a compatible entry: its own base URL and Bearer key, the remote id on the wire, the qualified id in the ledger", async () => {
    const config = createTestConfig({
      conwayApiKey: "",
      inferenceModel: "lab/house-model",
      providers: {
        compatible: [
          { id: "lab", baseUrl: "https://lab.example/v1", apiKey: "lab-key", models: [{ id: "house-model", inputUsdPerM: 1, outputUsdPerM: 2 }] },
        ],
      },
    } as any);
    const { route } = wire(config);
    const r = await route(hi);
    expect(r.model).toBe("lab/house-model");
    expect(seen.map((s) => s.url)).toEqual(["https://lab.example/v1/chat/completions"]);
    expect(seen[0].headers.authorization).toBe("Bearer lab-key");
    expect(seen[0].body.model).toBe("house-model");
    expect(ledger()).toEqual([{ provider: "openai", model: "lab/house-model", status: "committed", pin: 1, pout: 2 }]);
  });

  it("Ollama: its /v1 endpoint, reserved at price 0", async () => {
    const config = createTestConfig({ conwayApiKey: "", ollamaBaseUrl: "http://localhost:11434", inferenceModel: "llama3.2:latest" });
    const { registry, route } = wire(config);
    const now = new Date().toISOString();
    registry.upsert({
      modelId: "llama3.2:latest",
      provider: "ollama",
      displayName: "Llama",
      tierMinimum: "critical",
      costPer1kInput: 0,
      costPer1kOutput: 0,
      maxTokens: 4096,
      contextWindow: 8192,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: null,
      createdAt: now,
      updatedAt: now,
    });
    await route(hi);
    expect(seen.map((s) => s.url)).toEqual(["http://localhost:11434/v1/chat/completions"]);
    expect(ledger()[0]).toMatchObject({ model: "llama3.2:latest", pin: 0, pout: 0 });
  });

  it("Anthropic: /v1/messages with x-api-key; a tool call and its result arrive as tool_use then tool_result", async () => {
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "sk-ant-x", inferenceModel: "claude-sonnet-5-5" });
    const { route } = wire(config);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are an agent." },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "toolu_1", type: "function", function: { name: "exec", arguments: '{"command":"ls"}' } }],
      },
      { role: "tool", content: "file.txt", tool_call_id: "toolu_1" },
    ];
    const r = await route(messages);
    expect(r.content).toBe("anthropic ok");
    expect(seen).toHaveLength(1);
    const { url, headers, body } = seen[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("sk-ant-x");
    expect(headers.authorization).toBeUndefined();
    expect(body.system).toBe("You are an agent.");
    expect(body.messages).toEqual([
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "exec", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" }] },
    ]);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
    // A thinking model gets the output floor, and the reservation matches.
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(ledger()[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", pin: 2, pout: 10 });
  });

  it("a survival turn asks Anthropic for low effort", async () => {
    const config = createTestConfig({
      conwayApiKey: "",
      anthropicApiKey: "sk-ant-x",
      inferenceModel: "claude-sonnet-5-5",
      modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG, criticalModel: "claude-haiku-5-5" },
    });
    const { route } = wire(config, { criticalModel: "claude-haiku-5-5" });
    await route(hi, { survival: true });
    expect(seen[0].body.model).toBe("claude-haiku-5-5");
    expect(seen[0].body.output_config).toEqual({ effort: "low" });
  });
});

describe("free loopback servers", () => {
  const lab = (extra: Record<string, unknown>, baseUrl = "http://[::1]:1234/v1") =>
    createTestConfig({
      conwayApiKey: "",
      inferenceModel: "lmstudio/qwen3",
      providers: { compatible: [{ id: "lmstudio", baseUrl, models: [{ id: "qwen3" }], ...extra }] },
    } as any);

  it("a compatible entry marked free on http://[::1] reserves at 0 and sends no key", async () => {
    const { route } = wire(lab({ free: true }));
    await route(hi);
    expect(seen.map((s) => s.url)).toEqual(["http://[::1]:1234/v1/chat/completions"]);
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].body.model).toBe("qwen3");
    expect(ledger()[0]).toMatchObject({ model: "lmstudio/qwen3", pin: 0, pout: 0 });
  });

  it("the same server without free is charged at its price", async () => {
    const config = createTestConfig({
      conwayApiKey: "",
      inferenceModel: "lmstudio/qwen3",
      providers: { compatible: [{ id: "lmstudio", baseUrl: "http://[::1]:1234/v1", models: [{ id: "qwen3", inputUsdPerM: 1, outputUsdPerM: 2 }] }] },
    } as any);
    const { route } = wire(config);
    await route(hi);
    expect(ledger()[0]).toMatchObject({ model: "lmstudio/qwen3", pin: 1, pout: 2 });
  });

  it("a LAN server cannot be marked free", () => {
    const config = lab({ free: true, apiKey: "k" }, "http://192.168.1.5:1234/v1");
    const { table, registry } = wire(config);
    expect(table.get("lmstudio")!.free).toBe(false);
    expect(registryPrice(registry.get("lmstudio/qwen3")!).local).toBe(false);
  });
});

describe("unpriced models", () => {
  const agg = (extra: Record<string, unknown> = {}) =>
    createTestConfig({
      conwayApiKey: "",
      inferenceModel: "agg/mystery",
      providers: {
        compatible: [
          {
            id: "agg",
            baseUrl: "https://agg.example/v1",
            apiKey: "agg-key",
            models: [{ id: "mystery" }, { id: "known", inputUsdPerM: 1, outputUsdPerM: 3 }],
            ...extra,
          },
        ],
      },
    } as any);

  it("are skipped with one warning, and the call goes to the next candidate", async () => {
    const logs: string[] = [];
    StructuredLogger.setSink((e) => logs.push(e.message));
    const { route } = wire(agg(), { lowComputeModel: "agg/known" });
    const r = await route(hi);
    await route(hi);
    expect(r.model).toBe("agg/known");
    expect(seen.map((s) => s.body.model)).toEqual(["known", "known"]);
    expect(logs.filter((m) => m.includes("agg/mystery") && m.includes("no known price"))).toHaveLength(1);
  });

  it("with allowUnpriced, are reserved at the highest known price", async () => {
    // A discovered model priced above anything in the table or config: the
    // gate's own fallback ($10/$50) would charge less than the highest known price.
    const config = agg({
      allowUnpriced: true,
      models: [{ id: "mystery" }, { id: "known", inputUsdPerM: 1, outputUsdPerM: 3 }, { id: "pricey/pro" }],
    });
    const { route, registry, table } = wire(config);
    registry.applyDiscovery(table.get("agg")!, [
      { remoteId: "mystery" },
      { remoteId: "known" },
      { remoteId: "pricey/pro", listedPrice: { inputUsdPerM: 30, outputUsdPerM: 120 } },
    ]);
    const r = await route(hi);
    expect(r.model).toBe("agg/mystery");
    expect(highestKnownPrice(config)).toMatchObject({ inputUsdPerM: 10, outputUsdPerM: 50 });
    expect(highestKnownPrice(config, registry)).toEqual({ inputUsdPerM: 30, outputUsdPerM: 120 });
    expect(ledger()[0]).toMatchObject({ model: "agg/mystery", pin: 30, pout: 120 });
  });
});

describe("survival fallback with an imported catalog", () => {
  it("the cheapest-row fallback needs tool support and a tier floor at or below the turn's tier", () => {
    const config = createTestConfig({
      conwayApiKey: "",
      anthropicApiKey: "sk-ant-x",
      providers: { compatible: [{ id: "agg", baseUrl: "https://aggregator.example/api/v1", apiKey: "agg-key-0123456789" }] },
    } as any);
    const { table, registry, router } = wire(config, { inferenceModel: "claude-sonnet-5-5", lowComputeModel: "claude-haiku-5-5", criticalModel: "claude-haiku-5-5" });
    registry.applyDiscovery(table.get("agg")!, [
      { remoteId: "tiny/no-tools", supportsTools: false, listedPrice: { inputUsdPerM: 0.01, outputUsdPerM: 0.02 } },
      { remoteId: "small/tools", supportsTools: true, listedPrice: { inputUsdPerM: 0.02, outputUsdPerM: 0.04 } },
    ]);
    expect(registry.get("agg/small/tools")?.tierMinimum).toBe("normal");
    const ids = (tier: "critical" | "low_compute" | "normal") => router.survivalCandidates(tier).map((m) => m.modelId);
    expect(ids("critical")).toEqual(["claude-haiku-5-5"]);
    expect(ids("low_compute")).toEqual(["claude-haiku-5-5"]);
    expect(ids("normal")).toEqual(["claude-haiku-5-5", "agg/small/tools"]);
  });

  it("Conway mode without new settings keeps the old pick: the cheapest paid Conway row, whatever its tier floor", () => {
    const config = createTestConfig({ conwayApiKey: "cnwy_key_0123456789", conwayApiUrl: "https://api.conway.tech" });
    const { registry, router } = wire(config, { criticalModel: "not-in-registry" });
    registry.refreshFromApi([{ id: "cheap-x", owned_by: "meta", pricing: { input_per_million: 0.02, output_per_million: 0.05 } }]);
    expect(registry.get("cheap-x")).toMatchObject({ providerId: "conway", tierMinimum: "normal" });
    expect(router.survivalCandidates("critical").map((m) => m.modelId)).toEqual(["cheap-x"]);
  });
});

describe("Conway mode wire", () => {
  it("a model from Conway's listing goes out with its registry id and the token field the id alone picks", async () => {
    const config = createTestConfig({ conwayApiKey: "cnwy_key_0123456789", conwayApiUrl: "https://api.conway.tech", inferenceModel: "conway/kimi-k2" });
    const table = resolveProviderTable(config, {});
    const registry = new ModelRegistry(db.raw, { table, config });
    registry.initialize();
    registry.refreshFromApi([
      { id: "conway/kimi-k2", owned_by: "moonshot", parameter_style: "max_completion_tokens", pricing: { input_per_million: 1, output_per_million: 3 } },
    ]);
    const client = createInferenceClient({
      apiUrl: config.conwayApiUrl,
      apiKey: config.conwayApiKey,
      defaultModel: "x",
      maxTokens: 1000,
      conwayFallback: true,
      getModelProvider: (id) => registry.get(id)?.provider,
      table,
      getModelRoute: (id) => modelRouteOf(registry.get(id)),
    });
    const router = new InferenceRouter(db.raw, registry, gate, () => ({ ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: "conway/kimi-k2" }), {
      canServe: (m) => client.canServe!(m),
    });
    await router.route({ messages: hi, taskType: "agent_turn", tier: "normal", sessionId: "s" } as any, (m, o) => client.chat(m, o));
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.conway.tech/v1/chat/completions");
    expect(seen[0].headers.authorization).toBe("cnwy_key_0123456789");
    expect(seen[0].body).toEqual({
      model: "conway/kimi-k2",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: seen[0].body.max_tokens,
    });
    expect(typeof seen[0].body.max_tokens).toBe("number");
  });
});

describe("long-prompt price", () => {
  it("Haiku 5.5 reserves at its long-prompt price once the estimate reaches 80% of 100K", async () => {
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "sk-ant-x", inferenceModel: "claude-haiku-5-5" });
    const { route } = wire(config);
    await route(hi, { maxTokens: 2048 });
    const long = "word ".repeat(64_000);
    const est = gate.estimateInputTokens([{ role: "user", content: long }], undefined);
    expect(est).toBeGreaterThanOrEqual(80_000);
    expect(est).toBeLessThan(100_000);
    await route([{ role: "user", content: long }], { maxTokens: 2048 });
    const rows = ledger();
    expect(rows[0]).toMatchObject({ pin: 0.1, pout: 0.5 });
    expect(rows[1]).toMatchObject({ pin: 0.5, pout: 2.5 });
  });

  it("a prompt the estimate puts under 80% but Anthropic counts over 100K is charged the long-prompt price", async () => {
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "sk-ant-x", inferenceModel: "claude-haiku-5-5" });
    const { route } = wire(config);
    const long = "word ".repeat(55_000);
    const est = gate.estimateInputTokens([{ role: "user", content: long }], undefined);
    expect(est).toBeLessThan(80_000);
    anthropicUsage = { input_tokens: 105_000, output_tokens: 100 };
    await route([{ role: "user", content: long }], { maxTokens: 2048 });
    const row = db.raw.prepare("SELECT price_in_usd_per_m AS pin, price_out_usd_per_m AS pout, cost_micro_usd AS cost FROM inference_ledger").get() as any;
    expect(row).toMatchObject({ pin: 0.5, pout: 2.5 });
    // 105K x $0.50/M + 100 x $2.50/M
    expect(row.cost).toBe(52_750);
  });
});

describe("IPv6 loopback in the orchestration registry", () => {
  it("the resolved OpenAI client posts to http://[::1]:<port>/v1/...", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: any) => {
      urls.push(String(typeof input === "string" ? input : input.url));
      return new Response(
        JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const registry = new ProviderRegistry(
      [
        {
          id: "local",
          name: "Local",
          baseUrl: "http://[::1]:8080/v1",
          apiKeyEnvVar: "LOCAL_API_KEY",
          models: [{ id: "qwen3", tier: "fast", contextWindow: 8000, maxOutputTokens: 1000, costPerInputToken: 0, costPerOutputToken: 0, supportsTools: true, supportsVision: false, supportsStreaming: true }],
          maxRequestsPerMinute: 10,
          maxTokensPerMinute: 1000,
          priority: 1,
          enabled: true,
        },
      ],
      undefined,
      { fetch: fetchImpl },
    );
    const [resolved] = registry.resolveCandidates("fast");
    expect(resolved.client).toBeInstanceOf(OpenAI);
    await resolved.client!.chat.completions.create({ model: "qwen3", messages: [{ role: "user", content: "hi" }] });
    expect(urls).toEqual(["http://[::1]:8080/v1/chat/completions"]);
  });
});
