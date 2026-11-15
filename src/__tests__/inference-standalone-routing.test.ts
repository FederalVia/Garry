/**
 * Model routing without Conway: a model nobody can serve is refused before
 * any I/O and its reservation released; canServe is honest; an
 * OpenAI-compatible base URL (loopback http allowed) gets the requests;
 * Anthropic rows are seeded and survive initialize(); the orchestration side
 * never borrows the Conway key; unservable strategy slots are substituted;
 * x402 payees default to none in standalone.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, modelRegistryGetOrigin, modelRegistrySetEnabled } from "../state/database.js";
import type { AutomatonDatabase } from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceRouter } from "../inference/router.js";
import { InferenceGate, installInferenceGate, resetInferenceGateForTests } from "../inference/gate.js";
import { resolveInferencePolicy } from "../inference/policy.js";
import { InferenceRefusedError } from "../inference/errors.js";
import { createInferenceClient, modelRouteOf } from "../conway/inference.js";
import { buildOrchestrationRegistry, ensureServableStrategy } from "../providers/model-defaults.js";
import { canServeModel, resolveProviderTable } from "../providers/table.js";
import { createTestConfig } from "./mocks.js";

let tmp: string;
let db: AutomatonDatabase;
let gate: InferenceGate;
let fetchSpy: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-routing-"));
  db = createDatabase(path.join(tmp, "state.db"));
  gate = new InferenceGate({ db: db.raw, policy: resolveInferencePolicy({}, { maxInferenceDailyCents: 200 }), fixedTier: "normal" });
  installInferenceGate(gate);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetInferenceGateForTests();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rows = () => db.raw.prepare("SELECT model, status, error_class FROM inference_ledger ORDER BY rowid").all() as any[];

function reserve(model: string, provider = "conway"): string {
  return gate.reserve({
    callId: `c-${Math.random()}`,
    attempt: 1,
    provider: provider as any,
    model,
    price: { inputUsdPerM: 1, outputUsdPerM: 1, local: false },
    estInputTokens: 100,
    maxOutputTokens: 100,
    minOutputTokens: 100,
    scope: { caller: "agent_turn" },
  }).id;
}

const standaloneClient = (extra: Record<string, unknown> = {}) =>
  createInferenceClient({
    apiUrl: "https://api.conway.tech",
    apiKey: "",
    defaultModel: "gpt-5.2",
    maxTokens: 1000,
    conwayFallback: false,
    getModelProvider: (id) => (id.startsWith("conway-") ? "conway" : undefined),
    ...extra,
  });

describe("fallback none", () => {
  it("refuses a model no provider serves before any I/O, and releases the reservation", async () => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const client = standaloneClient();
    for (const model of ["conway-only-model", "mystery-model"]) {
      const id = reserve(model);
      const err = await client.chat([{ role: "user", content: "hi" }], { model, reservationId: id }).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(InferenceRefusedError);
      expect(err.code).toBe("NO_MODEL");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rows().map((r) => [r.status, r.error_class])).toEqual([
      ["released", "no_provider"],
      ["released", "no_provider"],
    ]);
    expect(gate.usage().last24h.cappedCents).toBe(0);
  });

  it("Conway mode keeps Conway as the fallback", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;
    const client = createInferenceClient({ apiUrl: "https://api.conway.tech", apiKey: "cnwy", defaultModel: "x", maxTokens: 10 });
    await client.chat([{ role: "user", content: "hi" }], { model: "mystery-model", reservationId: reserve("mystery-model") });
    expect(calls).toEqual(["https://api.conway.tech/v1/chat/completions"]);
  });
});

describe("canServe", () => {
  const m = (provider: string, modelId = "x") => ({ modelId, provider });

  it("standalone: each provider needs its own credential; Conway and unknown providers never", () => {
    const none = standaloneClient();
    for (const p of ["openai", "anthropic", "ollama", "conway", "other"]) expect(none.canServe!(m(p)), p).toBe(false);
    const all = standaloneClient({ openaiApiKey: "sk", anthropicApiKey: "ak", ollamaBaseUrl: "http://localhost:11434" });
    expect(all.canServe!(m("openai"))).toBe(true);
    expect(all.canServe!(m("anthropic"))).toBe(true);
    expect(all.canServe!(m("ollama"))).toBe(true);
    expect(all.canServe!(m("conway"))).toBe(false);
    expect(all.canServe!(m("other"))).toBe(false);
  });

  it("a custom OpenAI base URL with a model list serves only the listed models", () => {
    const c = standaloneClient({ openaiApiKey: "sk", openaiBaseUrl: "https://llm.example/v1", openaiModels: ["house"] });
    expect(c.canServe!(m("openai", "house"))).toBe(true);
    expect(c.canServe!(m("openai", "gpt-5.2"))).toBe(false);
    const unlisted = standaloneClient({ openaiApiKey: "sk", openaiBaseUrl: "https://llm.example/v1" });
    expect(unlisted.canServe!(m("openai", "anything"))).toBe(true);
  });

  it("Conway mode is unchanged: the Conway key serves any non-Ollama model", () => {
    const c = createInferenceClient({ apiUrl: "https://api.conway.tech", apiKey: "cnwy", defaultModel: "x", maxTokens: 10 });
    expect(c.canServe!(m("anthropic"))).toBe(true);
    expect(c.canServe!(m("other"))).toBe(true);
    expect(c.canServe!(m("ollama"))).toBe(false);
  });
});

describe("OpenAI-compatible base URL", () => {
  let server: http.Server;
  let base: string;
  const seen: Array<{ path: string; auth: string | undefined }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("posts to <baseUrl>/chat/completions with the OpenAI key; loopback http is allowed", async () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    registry.upsertConfiguredModels([{ id: "house", inputUsdPerM: 1, outputUsdPerM: 2 }]);
    const client = standaloneClient({
      openaiApiKey: "sk-local",
      openaiBaseUrl: `${base}/v1`,
      openaiModels: ["house"],
      getModelProvider: (id: string) => registry.get(id)?.provider,
    });
    const router = new InferenceRouter(db.raw, registry, gate, () => ({ ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: "house" }), {
      canServe: (e) => client.canServe!(e),
    });
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
      (msgs, opts) => client.chat(msgs, opts),
    );
    expect(result.model).toBe("house");
    expect(seen).toEqual([{ path: "/v1/chat/completions", auth: "Bearer sk-local" }]);
    expect(registry.get("house")).toMatchObject({ provider: "openai", costPer1kInput: 10, costPer1kOutput: 20 });
  });
});

describe("IPv6 loopback base URL", () => {
  it("http://[::1] passes the same loopback check config validation applies", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    registry.upsertConfiguredModels([{ id: "house", inputUsdPerM: 1, outputUsdPerM: 2 }]);
    const client = standaloneClient({
      openaiApiKey: "sk-local",
      openaiBaseUrl: "http://[::1]:8080/v1",
      openaiModels: ["house"],
      getModelProvider: (id: string) => registry.get(id)?.provider,
    });
    const router = new InferenceRouter(db.raw, registry, gate, () => ({ ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: "house" }), {
      canServe: (e) => client.canServe!(e),
    });
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
      (msgs, opts) => client.chat(msgs, opts),
    );
    expect(result.model).toBe("house");
    expect(calls).toEqual(["http://[::1]:8080/v1/chat/completions"]);
  });
});

describe("Anthropic seed", () => {
  it("seeds enabled rows that survive initialize(), re-enabling retired ones", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    registry.seedProviderModels(["anthropic"]);
    modelRegistrySetEnabled(db.raw, "claude-haiku-4-5", false);
    registry.seedProviderModels(["anthropic"]);
    registry.initialize();
    for (const id of ["claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(registry.get(id)?.enabled, id).toBe(true);
      expect(registry.get(id)?.provider).toBe("anthropic");
      expect(modelRegistryGetOrigin(db.raw, id)).not.toBe("baseline");
    }
    expect(registry.get("claude-sonnet-4-6")).toMatchObject({ costPer1kInput: 30, costPer1kOutput: 150, tierMinimum: "normal" });
    expect(registry.get("claude-haiku-4-5")).toMatchObject({ costPer1kInput: 10, costPer1kOutput: 50, tierMinimum: "critical" });
  });
});

describe("orchestration providers", () => {
  /** A registry the loop would build: baseline, price-table seeds and owner models. */
  const seeded = (config: ReturnType<typeof createTestConfig>) => {
    const table = resolveProviderTable(config, {});
    const registry = new ModelRegistry(db.raw, { table, config });
    registry.initialize();
    registry.seedFromPriceTable(table);
    return { table, registry };
  };
  const build = (config: ReturnType<typeof createTestConfig>) => {
    const { table, registry } = seeded(config);
    return buildOrchestrationRegistry({ table, registry, strategy: liveStrategyOf(config), config });
  };

  it("standalone never lends the Conway key; OpenAI uses the creator's key", () => {
    const config = createTestConfig({ conwayApiKey: "cnwy_k_SECRET", providers: { mode: "standalone" }, openaiApiKey: "sk-own" });
    const built = build(config);
    expect(built.registry).not.toBeNull();
    const resolved = built.registry!.resolveCandidates("reasoning");
    expect(resolved.length).toBeGreaterThan(0);
    for (const r of resolved) {
      expect((r.client as any).apiKey).toBe("sk-own");
    }
    expect(resolved[0].provider.baseUrl).not.toContain("conway");
  });

  // Rewritten on purpose: Anthropic-only owners now get the planner and workers.
  it("Anthropic only: a registry with Sonnet for reasoning and Haiku for workers", () => {
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "ak", inferenceModel: "gpt-5.2" });
    const built = build(config);
    expect(built.registry).not.toBeNull();
    const pick = (tier: "reasoning" | "fast" | "cheap") => built.registry!.resolveCandidates(tier)[0];
    expect(pick("reasoning").model.id).toBe("claude-sonnet-5-5");
    expect(pick("fast").model.id).toBe("claude-haiku-5-5");
    expect(pick("cheap").model.id).toBe("claude-haiku-5-5");
    expect(pick("reasoning").provider.kind).toBe("anthropic");
    expect(pick("reasoning").anthropic).toBeDefined();
    expect(pick("reasoning").client).toBeUndefined();
    // Prices are USD per 1M from the price table.
    expect(pick("reasoning").model).toMatchObject({ costPerInputToken: 2, costPerOutputToken: 10 });
    // At tier normal the planner steps down to fast, as before.
    expect(built.registry!.resolveCandidates("reasoning", true)[0].model.id).toBe("claude-haiku-5-5");
  });

  it("Ollama only: workers use the discovered models, not invented ones", () => {
    const config = createTestConfig({ conwayApiKey: "", ollamaBaseUrl: "http://localhost:11434" });
    expect(build(config).registry).toBeNull();
    const { table, registry } = seeded(config);
    registry.upsert(ollamaRow("qwen3:8b"));
    const built = buildOrchestrationRegistry({ table, registry, strategy: liveStrategyOf(config), config });
    for (const tier of ["reasoning", "fast", "cheap"] as const) {
      const [first] = built.registry!.resolveCandidates(tier);
      expect(first.provider.id).toBe("ollama");
      expect(first.provider.baseUrl).toBe("http://localhost:11434/v1");
      expect(first.model.id).toBe("qwen3:8b");
    }
  });

  it("a custom base URL serves only the listed models; without a list orchestration is off", () => {
    const listed = createTestConfig({
      conwayApiKey: "",
      openaiApiKey: "sk",
      providers: { openai: { baseUrl: "https://llm.example/v1", models: [{ id: "house", inputUsdPerM: 1, outputUsdPerM: 2 }] } },
    });
    const built = build(listed);
    for (const tier of ["reasoning", "fast", "cheap"] as const) {
      const [first] = built.registry!.resolveCandidates(tier);
      expect(first.provider.baseUrl).toBe("https://llm.example/v1");
      expect(first.model.id).toBe("house");
    }
    // The OpenAI baseline at OpenAI's prices is not sent to another host.
    const unlisted = createTestConfig({ conwayApiKey: "", openaiApiKey: "sk", providers: { openai: { baseUrl: "https://llm.example/v1" } } });
    expect(build(unlisted).registry).toBeNull();
  });

  it("a custom base URL without a list: a strategy model the endpoint priced serves planner and workers", () => {
    const config = createTestConfig({
      conwayApiKey: "",
      openaiApiKey: "sk",
      inferenceModel: "house-model",
      providers: { openai: { baseUrl: "https://llm.example/v1" } },
    });
    const { table, registry } = seeded(config);
    registry.applyDiscovery(table.get("openai")!, [{ remoteId: "house-model", listedPrice: { inputUsdPerM: 0.5, outputUsdPerM: 1 } }]);
    const built = buildOrchestrationRegistry({ table, registry, strategy: liveStrategyOf(config), config });
    for (const tier of ["reasoning", "fast", "cheap"] as const) {
      const [first] = built.registry!.resolveCandidates(tier);
      expect(first.provider.baseUrl).toBe("https://llm.example/v1");
      expect(first.model.id).toBe("house-model");
    }
  });

  it("a compatible entry takes part with its own key, qualified ids and the remote id on the wire", () => {
    const config = createTestConfig({
      conwayApiKey: "",
      providers: {
        compatible: [
          {
            id: "groq",
            baseUrl: "https://api.groq.com/openai/v1",
            apiKey: "gsk-own",
            models: [{ id: "llama-3.3-70b-versatile", inputUsdPerM: 0.59, outputUsdPerM: 0.79, tierMinimum: "critical" }],
          },
        ],
      },
    } as any);
    const built = build(config);
    const [first] = built.registry!.resolveCandidates("cheap");
    expect(first.provider.id).toBe("groq");
    expect(first.model.id).toBe("groq/llama-3.3-70b-versatile");
    expect(first.model.remoteId).toBe("llama-3.3-70b-versatile");
    expect((first.client as any).apiKey).toBe("gsk-own");
  });

  it("no usable model anywhere: null, with the reason", () => {
    const config = createTestConfig({
      conwayApiKey: "",
      providers: { compatible: [{ id: "agg", baseUrl: "https://agg.example/v1", apiKey: "k" }] },
    } as any);
    const built = build(config);
    expect(built.registry).toBeNull();
    expect(built.reason).toContain("agg");
  });
});

describe("ensureServableStrategy", () => {
  const seeded = (config: ReturnType<typeof createTestConfig>) => {
    const table = resolveProviderTable(config, {});
    const registry = new ModelRegistry(db.raw, { table, config });
    registry.initialize();
    registry.seedFromPriceTable(table);
    return { table, registry };
  };

  // Rewritten on purpose: the substitution defaults are now Sonnet 5.5 and Haiku 5.5.
  it("Anthropic only: Sonnet 5.5 for the main model, Haiku 5.5 for the cheaper slots", () => {
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "ak", inferenceModel: "gpt-5.2" });
    const { table, registry } = seeded(config);
    const { substitutions } = ensureServableStrategy(config, registry, (e) => canServeModel(table, e), table);
    expect(config.inferenceModel).toBe("claude-sonnet-5-5");
    expect(config.modelStrategy?.lowComputeModel).toBe("claude-haiku-5-5");
    expect(config.modelStrategy?.criticalModel).toBe("claude-haiku-5-5");
    expect(substitutions.map((s) => s.slot)).toEqual(["inferenceModel", "lowComputeModel", "criticalModel"]);
  });

  it("keeps the owner's own servable Anthropic choice", () => {
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "ak", inferenceModel: "claude-sonnet-4-6" });
    const { table, registry } = seeded(config);
    ensureServableStrategy(config, registry, (e) => canServeModel(table, e), table);
    expect(config.inferenceModel).toBe("claude-sonnet-4-6");
  });

  it("Anthropic only at a fixed critical tier: the router has a model to run", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;
    const critGate = new InferenceGate({ db: db.raw, policy: resolveInferencePolicy({}, { maxInferenceDailyCents: 200 }), fixedTier: "critical" });
    installInferenceGate(critGate);
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "ak", inferenceModel: "gpt-5.2" });
    const { table, registry } = seeded(config);
    const client = standaloneClient({
      anthropicApiKey: "ak",
      table,
      getModelRoute: (id: string) => modelRouteOf(registry.get(id)),
    });
    ensureServableStrategy(config, registry, (e) => client.canServe!(e), table);
    const router = new InferenceRouter(db.raw, registry, critGate, () => config.modelStrategy!, {
      canServe: (e) => client.canServe!(e),
    });
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "critical", sessionId: "s" },
      (msgs, opts) => client.chat(msgs, opts),
    );
    expect(result.model).toBe("claude-haiku-5-5");
  });

  it("never substitutes a paid model below its tier floor; such a slot is reported unservable", () => {
    const mk = (tierMinimum?: string) =>
      createTestConfig({
        conwayApiKey: "",
        openaiApiKey: "sk",
        inferenceModel: "gpt-5.2",
        providers: { openai: { baseUrl: "https://llm.example/v1", models: [{ id: "my-model", inputUsdPerM: 1, outputUsdPerM: 2, ...(tierMinimum ? { tierMinimum } : {}) }] } },
      } as any);
    const normal = mk();
    const { table, registry } = seeded(normal);
    const r = ensureServableStrategy(normal, registry, (e) => canServeModel(table, e), table);
    expect(normal.inferenceModel).toBe("my-model");
    expect(r.unservable).toEqual(["lowComputeModel", "criticalModel"]);
    expect(r.substitutions.map((s) => s.slot)).toEqual(["inferenceModel"]);

    const critical = mk("critical");
    const t2 = resolveProviderTable(critical, {});
    const reg2 = new ModelRegistry(db.raw, { table: t2, config: critical });
    reg2.seedFromPriceTable(t2);
    const r2 = ensureServableStrategy(critical, reg2, (e) => canServeModel(t2, e), t2);
    expect(r2.unservable).toEqual([]);
    expect(critical.modelStrategy?.criticalModel).toBe("my-model");
  });

  it("leaves a servable strategy alone, and reports a slot nothing can serve", () => {
    const openai = createTestConfig({ conwayApiKey: "", openaiApiKey: "sk", inferenceModel: "gpt-5.2" });
    const { table, registry } = seeded(openai);
    expect(ensureServableStrategy(openai, registry, (e) => canServeModel(table, e), table).substitutions).toEqual([]);
    const nothing = createTestConfig({ conwayApiKey: "", inferenceModel: "gpt-5.2" });
    const empty = resolveProviderTable(nothing, {});
    expect(ensureServableStrategy(nothing, registry, (e) => canServeModel(empty, e), empty).unservable).toContain(
      "inferenceModel",
    );
    expect(nothing.inferenceModel).toBe("gpt-5.2");
  });

  it("keeps an unpriced model the owner names when its provider sets allowUnpriced, and only then", () => {
    const mk = (allowUnpriced: boolean) =>
      createTestConfig({
        conwayApiKey: "",
        ollamaBaseUrl: "http://127.0.0.1:11434",
        inferenceModel: "agg/vendor/mystery-2",
        providers: { compatible: [{ id: "agg", baseUrl: "https://agg.example/v1", apiKey: "agg-key-0123456789", allowUnpriced }] },
      } as any);
    for (const allow of [true, false]) {
      const config = mk(allow);
      const { table, registry } = seeded(config);
      registry.upsert(ollamaRow("llama3.1:8b"));
      registry.applyDiscovery(table.get("agg")!, [{ remoteId: "vendor/mystery-2" }]);
      const r = ensureServableStrategy(config, registry, (e) => canServeModel(table, e), table);
      expect(config.inferenceModel).toBe(allow ? "agg/vendor/mystery-2" : "llama3.1:8b");
      expect(r.substitutions.some((s) => s.slot === "inferenceModel")).toBe(!allow);
    }
  });

  it("an allowed unpriced owner model still fills no slot below its tier floor", () => {
    const config = createTestConfig({
      conwayApiKey: "",
      inferenceModel: "gpt-5.2",
      providers: {
        compatible: [{ id: "agg", baseUrl: "https://agg.example/v1", apiKey: "agg-key-0123456789", allowUnpriced: true, models: [{ id: "mystery" }] }],
      },
    } as any);
    const { table, registry } = seeded(config);
    registry.upsertOwnerModels(table.get("agg")!);
    const r = ensureServableStrategy(config, registry, (e) => canServeModel(table, e), table);
    expect(config.inferenceModel).toBe("agg/mystery");
    expect(r.unservable).toEqual(["lowComputeModel", "criticalModel"]);
  });

  it("Ollama: the first discovered model", () => {
    const config = createTestConfig({ conwayApiKey: "", ollamaBaseUrl: "http://localhost:11434" });
    const { table, registry } = seeded(config);
    registry.upsert(ollamaRow("llama3.2:latest"));
    ensureServableStrategy(config, registry, (e) => canServeModel(table, e), table);
    expect(config.inferenceModel).toBe("llama3.2:latest");
  });
});

function ollamaRow(modelId: string) {
  const now = new Date().toISOString();
  return {
    modelId,
    provider: "ollama" as const,
    displayName: modelId,
    tierMinimum: "critical" as const,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 4096,
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens" as const,
    enabled: true,
    lastSeen: null,
    createdAt: now,
    updatedAt: now,
  };
}

function liveStrategyOf(config: ReturnType<typeof createTestConfig>) {
  return {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...(config.modelStrategy ?? {}),
    inferenceModel: config.inferenceModel || DEFAULT_MODEL_STRATEGY_CONFIG.inferenceModel,
  };
}

describe("x402 payees", () => {
  const savedHome = process.env.HOME;
  let home: string;

  beforeAll(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x402-defaults-")));
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    vi.resetModules();
  });

  afterAll(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  const write = (obj: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(home, ".automaton", "automaton.json"),
      JSON.stringify({ name: "a", genesisPrompt: "g", creatorAddress: "0x" + "1".repeat(40), ...obj }),
    );

  it("default to [] in standalone and ['conway.tech'] in Conway mode; an explicit list is kept", async () => {
    const { loadConfig } = await import("../config.js");
    write({ openaiApiKey: "sk" });
    expect(loadConfig({})!.treasuryPolicy!.x402AllowedDomains).toEqual([]);
    write({ conwayApiKey: "cnwy" });
    expect(loadConfig({})!.treasuryPolicy!.x402AllowedDomains).toEqual(["conway.tech"]);
    write({ openaiApiKey: "sk", treasuryPolicy: { x402AllowedDomains: ["pay.example"] } });
    expect(loadConfig({})!.treasuryPolicy!.x402AllowedDomains).toEqual(["pay.example"]);
  });
});

describe("long-prompt settlement in the main loop", () => {
  it("settles at the tier price when the reported input crosses the threshold the estimate missed", async () => {
    const config = createTestConfig({
      conwayApiKey: undefined as unknown as string,
      anthropicApiKey: "sk-ant-longprompt-0123456789",
      providers: { mode: "standalone" },
    });
    const table = resolveProviderTable(config, {});
    const registry = new ModelRegistry(db.raw, { table, config });
    registry.initialize();
    registry.seedFromPriceTable(table);
    const router = new InferenceRouter(
      db.raw,
      registry,
      gate,
      () => ({ ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: "claude-haiku-5-5" }),
      { canServe: () => true },
    );
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
      async () => ({ message: { role: "assistant", content: "ok" }, usage: { promptTokens: 140_000, completionTokens: 1000 } }) as any,
    );
    expect(result.model).toBe("claude-haiku-5-5");
    const row = db.raw.prepare("SELECT price_in_usd_per_m AS pin, cost_micro_usd AS cost FROM inference_ledger").get() as any;
    expect(row.pin).toBe(0.1);
    expect(row.cost).toBe(140_000 * 0.5 + 1000 * 2.5);
  });
});
