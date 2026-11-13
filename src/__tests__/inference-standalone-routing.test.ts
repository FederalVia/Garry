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
import { createInferenceClient } from "../conway/inference.js";
import { resolveRuntime } from "../providers/mode.js";
import { buildStandaloneProviderRegistry, ensureServableStrategy } from "../providers/model-defaults.js";
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
  const providersPath = () => path.join(tmp, "inference-providers.json");

  it("standalone never lends the Conway key; OpenAI uses the creator's key", () => {
    const config = createTestConfig({ conwayApiKey: "cnwy_k_SECRET", providers: { mode: "standalone" }, openaiApiKey: "sk-own" });
    const built = buildStandaloneProviderRegistry({ config, runtime: resolveRuntime(config), ollamaModelIds: [], providersPath: providersPath() });
    expect(built.registry).not.toBeNull();
    const resolved = built.registry!.resolveCandidates("reasoning");
    expect(resolved.length).toBeGreaterThan(0);
    for (const r of resolved) {
      expect((r.client as any).apiKey).not.toBe("cnwy_k_SECRET");
    }
    expect(resolved[0].provider.baseUrl).not.toContain("conway");
  });

  it("Anthropic only: no registry, with the reason", () => {
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "ak" });
    const built = buildStandaloneProviderRegistry({ config, runtime: resolveRuntime(config), ollamaModelIds: [], providersPath: providersPath() });
    expect(built.registry).toBeNull();
    expect(built.reason).toContain("OpenAI-compatible or Ollama");
  });

  it("Ollama only: workers use the discovered models, not invented ones", () => {
    const config = createTestConfig({ conwayApiKey: "", ollamaBaseUrl: "http://localhost:11434" });
    const runtime = resolveRuntime(config);
    expect(buildStandaloneProviderRegistry({ config, runtime, ollamaModelIds: [], providersPath: providersPath() }).registry).toBeNull();
    const built = buildStandaloneProviderRegistry({ config, runtime, ollamaModelIds: ["qwen3:8b"], providersPath: providersPath() });
    for (const tier of ["reasoning", "fast", "cheap"] as const) {
      const [first] = built.registry!.resolveCandidates(tier);
      expect(first.provider.id).toBe("local");
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
    const built = buildStandaloneProviderRegistry({ config: listed, runtime: resolveRuntime(listed), ollamaModelIds: [], providersPath: providersPath() });
    const [first] = built.registry!.resolveCandidates("cheap");
    expect(first.provider.baseUrl).toBe("https://llm.example/v1");
    expect(first.model.id).toBe("house");
    const unlisted = createTestConfig({ conwayApiKey: "", openaiApiKey: "sk", providers: { openai: { baseUrl: "https://llm.example/v1" } } });
    expect(
      buildStandaloneProviderRegistry({ config: unlisted, runtime: resolveRuntime(unlisted), ollamaModelIds: [], providersPath: providersPath() })
        .registry,
    ).toBeNull();
  });
});

describe("ensureServableStrategy", () => {
  it("Anthropic only: sonnet for the main model, haiku for the cheaper slots", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    registry.seedProviderModels(["anthropic"]);
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "ak", inferenceModel: "gpt-5.2" });
    const client = standaloneClient({ anthropicApiKey: "ak" });
    const { substitutions } = ensureServableStrategy(config, registry, (e) => client.canServe!(e), resolveRuntime(config));
    expect(config.inferenceModel).toBe("claude-sonnet-4-6");
    expect(config.modelStrategy?.lowComputeModel).toBe("claude-haiku-4-5");
    expect(config.modelStrategy?.criticalModel).toBe("claude-haiku-4-5");
    expect(substitutions.map((s) => s.slot)).toEqual(["inferenceModel", "lowComputeModel", "criticalModel"]);
  });

  it("Anthropic only at a fixed critical tier: the router has a model to run", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;
    const critGate = new InferenceGate({ db: db.raw, policy: resolveInferencePolicy({}, { maxInferenceDailyCents: 200 }), fixedTier: "critical" });
    installInferenceGate(critGate);
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    registry.seedProviderModels(["anthropic"]);
    const config = createTestConfig({ conwayApiKey: "", anthropicApiKey: "ak", inferenceModel: "gpt-5.2" });
    const client = standaloneClient({ anthropicApiKey: "ak", getModelProvider: (id: string) => registry.get(id)?.provider });
    ensureServableStrategy(config, registry, (e) => client.canServe!(e), resolveRuntime(config));
    const router = new InferenceRouter(db.raw, registry, critGate, () => config.modelStrategy!, {
      canServe: (e) => client.canServe!(e),
    });
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "critical", sessionId: "s" },
      (msgs, opts) => client.chat(msgs, opts),
    );
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("never substitutes a paid model below its tier floor; such a slot is reported unservable", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const mk = (tierMinimum?: string) =>
      createTestConfig({
        conwayApiKey: "",
        openaiApiKey: "sk",
        inferenceModel: "gpt-5.2",
        providers: { openai: { baseUrl: "https://llm.example/v1", models: [{ id: "my-model", inputUsdPerM: 1, outputUsdPerM: 2, ...(tierMinimum ? { tierMinimum } : {}) }] } },
      } as any);
    const normal = mk();
    registry.upsertConfiguredModels(normal.providers!.openai!.models!);
    const client = standaloneClient({ openaiApiKey: "sk", openaiBaseUrl: "https://llm.example/v1", openaiModels: ["my-model"], getModelProvider: (id: string) => registry.get(id)?.provider });
    const r = ensureServableStrategy(normal, registry, (e) => client.canServe!(e), resolveRuntime(normal));
    expect(normal.inferenceModel).toBe("my-model");
    expect(r.unservable).toEqual(["lowComputeModel", "criticalModel"]);
    expect(r.substitutions.map((s) => s.slot)).toEqual(["inferenceModel"]);

    const critical = mk("critical");
    registry.upsertConfiguredModels(critical.providers!.openai!.models!);
    const r2 = ensureServableStrategy(critical, registry, (e) => client.canServe!(e), resolveRuntime(critical));
    expect(r2.unservable).toEqual([]);
    expect(critical.modelStrategy?.criticalModel).toBe("my-model");
  });

  it("leaves a servable strategy alone, and reports a slot nothing can serve", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const openai = createTestConfig({ conwayApiKey: "", openaiApiKey: "sk", inferenceModel: "gpt-5.2" });
    const client = standaloneClient({ openaiApiKey: "sk" });
    expect(ensureServableStrategy(openai, registry, (e) => client.canServe!(e), resolveRuntime(openai)).substitutions).toEqual([]);
    const nothing = createTestConfig({ conwayApiKey: "", inferenceModel: "gpt-5.2" });
    const none = standaloneClient();
    expect(ensureServableStrategy(nothing, registry, (e) => none.canServe!(e), resolveRuntime(nothing)).unservable).toContain(
      "inferenceModel",
    );
    expect(nothing.inferenceModel).toBe("gpt-5.2");
  });

  it("Ollama: the first discovered model", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
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
    const config = createTestConfig({ conwayApiKey: "", ollamaBaseUrl: "http://localhost:11434" });
    const client = standaloneClient({ ollamaBaseUrl: "http://localhost:11434" });
    ensureServableStrategy(config, registry, (e) => client.canServe!(e), resolveRuntime(config));
    expect(config.inferenceModel).toBe("llama3.2:latest");
  });
});

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
