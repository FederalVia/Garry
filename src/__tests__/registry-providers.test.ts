/**
 * The registry on the provider table: applying a discovered list (qualified
 * ids, prices, no overwrite across providers, listed reconciliation, no
 * "conway" label), seeding from the price table, owner models, the free flag
 * the gate reads, the highest listed price, Ollama rows, and the provider-column
 * migration.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestConfig } from "./mocks.js";
import {
  createDatabase,
  migrateModelRegistryProviders,
  modelRegistryGetOrigin,
  modelRegistryUpsert,
} from "../state/database.js";
import { MIGRATION_V6, SCHEMA_VERSION } from "../state/schema.js";
import { ModelRegistry } from "../inference/registry.js";
import { registryPrice } from "../inference/policy.js";
import { STATIC_MODEL_BASELINE } from "../inference/types.js";
import { StructuredLogger } from "../observability/logger.js";
import { applyOllamaListing } from "../ollama/discover.js";
import { resetPriceWarningsForTests } from "../providers/price-table.js";
import { canServeModel, resolveProviderTable, type ProviderTable } from "../providers/table.js";
import { buildOrchestrationRegistry, ensureServableStrategy } from "../providers/model-defaults.js";
import type { AutomatonConfig, AutomatonDatabase, LogEntry } from "../types.js";

let tmp: string;
let db: AutomatonDatabase;
const logs: LogEntry[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "registry-providers-"));
  db = createDatabase(path.join(tmp, "state.db"));
  StructuredLogger.setSink((e) => logs.push(e));
});

afterEach(() => {
  StructuredLogger.resetSink();
  logs.length = 0;
  resetPriceWarningsForTests();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function standalone(over: Partial<AutomatonConfig> = {}): AutomatonConfig {
  return createTestConfig({
    conwayApiKey: undefined as unknown as string,
    ...over,
    providers: { mode: "standalone", ...(over.providers ?? {}) },
  });
}

function table(over: Partial<AutomatonConfig> = {}): ProviderTable {
  return resolveProviderTable(standalone(over), {});
}

const compat = (c: Record<string, unknown>) => ({ providers: { compatible: [{ id: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_0123456789abcdef", ...c }] } });

describe("applyDiscovery", () => {
  it("qualifies compatible ids, stores the remote id, labels the row openai, never conway", () => {
    const t = table(compat({}));
    const reg = new ModelRegistry(db.raw, { table: t });
    const r = reg.applyDiscovery(t.get("groq")!, [{ remoteId: "llama-3.3-70b-versatile" }, { remoteId: "brand-new" }]);
    expect(r.imported).toBe(2);
    const row = reg.get("groq/llama-3.3-70b-versatile")!;
    expect(row).toMatchObject({ provider: "openai", providerId: "groq", remoteId: "llama-3.3-70b-versatile", listed: true });
    // Table host price.
    expect([row.costPer1kInput, row.costPer1kOutput, row.priceSource]).toEqual([5.9, 7.9, "table"]);
    expect(modelRegistryGetOrigin(db.raw, "groq/llama-3.3-70b-versatile")).toBe("api");
    // Imported unpriced: the router skips it.
    expect(reg.get("groq/brand-new")).toMatchObject({ costPer1kInput: 0, costPer1kOutput: 0, priceSource: null });
    expect(reg.getAll().some((m) => m.provider === "conway")).toBe(false);
  });

  it("the larger of the reported and the table price; a request fee or a zero price leaves the model unpriced", () => {
    const t = table(compat({}));
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.applyDiscovery(t.get("groq")!, [
      { remoteId: "llama-3.3-70b-versatile", listedPrice: { inputUsdPerM: 1, outputUsdPerM: 0.5 } },
      { remoteId: "fee", listedPrice: { inputUsdPerM: 1, outputUsdPerM: 1, requestFeeUsd: 0.01 } },
      { remoteId: "zero", listedPrice: { inputUsdPerM: 0, outputUsdPerM: 0 } },
      { remoteId: "listed", listedPrice: { inputUsdPerM: 0.25, outputUsdPerM: 1.5 } },
    ]);
    expect(reg.get("groq/llama-3.3-70b-versatile")).toMatchObject({ costPer1kInput: 10, costPer1kOutput: 7.9, priceSource: "listed" });
    expect(reg.get("groq/fee")).toMatchObject({ costPer1kInput: 0, costPer1kOutput: 0, priceSource: null });
    expect(reg.get("groq/zero")).toMatchObject({ costPer1kInput: 0, costPer1kOutput: 0 });
    expect(reg.get("groq/listed")).toMatchObject({ costPer1kInput: 2.5, costPer1kOutput: 15, priceSource: "listed" });
  });

  it("the owner price wins, logging once when below the list price", () => {
    const t = table(compat({ models: [{ id: "llama-3.3-70b-versatile", inputUsdPerM: 0.1, outputUsdPerM: 0.2, tierMinimum: "critical" }] }));
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.applyDiscovery(t.get("groq")!, [{ remoteId: "llama-3.3-70b-versatile", listedPrice: { inputUsdPerM: 5, outputUsdPerM: 5 } }]);
    reg.applyDiscovery(t.get("groq")!, [{ remoteId: "llama-3.3-70b-versatile", listedPrice: { inputUsdPerM: 5, outputUsdPerM: 5 } }]);
    expect(reg.get("groq/llama-3.3-70b-versatile")).toMatchObject({
      costPer1kInput: 1,
      costPer1kOutput: 2,
      priceSource: "owner",
      tierMinimum: "critical",
    });
    expect(logs.filter((l) => l.message.includes("below the list price"))).toHaveLength(1);
  });

  it("an allowlist entry updates only its listed models", () => {
    const t = table(compat({ models: [{ id: "a", inputUsdPerM: 1, outputUsdPerM: 1 }] }));
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.applyDiscovery(t.get("groq")!, [{ remoteId: "a" }, { remoteId: "b" }]);
    expect(reg.get("groq/a")).toBeDefined();
    expect(reg.get("groq/b")).toBeUndefined();
  });

  it("never overwrites a row of another provider, and warns once", () => {
    const t = table({
      anthropicApiKey: "sk-ant-0123456789",
      openaiApiKey: "k",
      providers: { openai: { baseUrl: "http://127.0.0.1:8080/v1", free: true } },
    });
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.seedFromPriceTable(t);
    const before = reg.get("claude-sonnet-5-5")!;
    const r1 = reg.applyDiscovery(t.get("openai")!, [{ remoteId: "claude-sonnet-5-5" }, { remoteId: "local-model" }]);
    reg.applyDiscovery(t.get("openai")!, [{ remoteId: "claude-sonnet-5-5" }]);
    expect(r1.conflicts).toEqual(["claude-sonnet-5-5"]);
    expect(reg.get("claude-sonnet-5-5")).toEqual(before);
    expect(reg.get("local-model")).toMatchObject({ providerId: "openai", free: true });
    expect(logs.filter((l) => l.level === "warn" && l.message.includes("claude-sonnet-5-5"))).toHaveLength(1);
  });

  it("unlists a vanished model and lists it again when it comes back; seeded and owner rows are never unlisted", () => {
    const t = table({ anthropicApiKey: "sk-ant-0123456789", providers: { anthropic: { models: [{ id: "claude-opus-4-8" }] } } });
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.seedFromPriceTable(t);
    const anth = t.get("anthropic")!;
    reg.applyDiscovery(anth, [{ remoteId: "claude-opus-5" }, { remoteId: "claude-fable-5-2" }]);
    expect(reg.get("claude-fable-5-2")?.listed).toBe(true);
    const r = reg.applyDiscovery(anth, [{ remoteId: "claude-opus-5" }]);
    expect(r.unlisted).toEqual(["claude-fable-5-2"]);
    expect(reg.get("claude-fable-5-2")?.listed).toBe(false);
    expect(canServeModel(t, reg.get("claude-fable-5-2")!)).toBe(false);
    // Seeds (claude-sonnet-5-5 ...) and the owner row are not in the list but stay listed.
    expect(reg.get("claude-sonnet-5-5")?.listed).toBe(true);
    expect(reg.get("claude-opus-4-8")?.listed).toBe(true);
    reg.applyDiscovery(anth, [{ remoteId: "claude-opus-5" }, { remoteId: "claude-fable-5-2" }]);
    expect(reg.get("claude-fable-5-2")?.listed).toBe(true);
  });

  it("keeps an owner's disable", () => {
    const t = table(compat({}));
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.applyDiscovery(t.get("groq")!, [{ remoteId: "m" }]);
    reg.setEnabled("groq/m", false);
    reg.applyDiscovery(t.get("groq")!, [{ remoteId: "m" }]);
    expect(reg.get("groq/m")?.enabled).toBe(false);
  });

  it("built-in OpenAI and Anthropic import only priced models", () => {
    const t = table({ openaiApiKey: "k", anthropicApiKey: "sk-ant-0123456789" });
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.initialize();
    const o = reg.applyDiscovery(t.get("openai")!, [{ remoteId: "gpt-5.2" }, { remoteId: "gpt-image-9" }]);
    expect(o).toMatchObject({ imported: 1, unpricedCount: 1, unpricedSample: ["gpt-image-9"] });
    expect(reg.get("gpt-image-9")).toBeUndefined();
    // The baseline row is updated in place and keeps its origin.
    expect(modelRegistryGetOrigin(db.raw, "gpt-5.2")).toBe("baseline");
    expect(reg.get("gpt-5.2")).toMatchObject({ providerId: "openai", costPer1kInput: 18, costPer1kOutput: 140 });
    const a = reg.applyDiscovery(t.get("anthropic")!, [{ remoteId: "claude-haiku-5-5", maxOutputTokens: 128000 }, { remoteId: "claude-unknown-9" }]);
    expect(a).toMatchObject({ imported: 1, unpricedCount: 1 });
    expect(reg.get("claude-haiku-5-5")).toMatchObject({
      provider: "anthropic",
      costPer1kInput: 1,
      costPer1kOutput: 5,
      tierMinimum: "critical",
      capabilities: expect.objectContaining({ thinking: "default-on", minOutputTokens: 2048 }),
    });
  });
});

describe("refreshFromApi (Conway's listing)", () => {
  it("labels unlabelled models 'other' with provider_id conway; labelled ones keep a NULL provider_id", () => {
    const reg = new ModelRegistry(db.raw);
    reg.refreshFromApi([
      { id: "kimi-k2" },
      { id: "conway-x", provider: "conway" },
      { id: "gpt-9", owned_by: "openai" },
    ]);
    expect(reg.get("kimi-k2")).toMatchObject({ provider: "other", providerId: "conway" });
    expect(reg.get("conway-x")).toMatchObject({ provider: "other", providerId: "conway" });
    expect(reg.get("gpt-9")).toMatchObject({ provider: "openai", providerId: null });
    expect(reg.getAll().some((m) => m.provider === "conway")).toBe(false);
  });

  it("leaves rows another provider's discovery owns", () => {
    const t = table(compat({}));
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.applyDiscovery(t.get("groq")!, [{ remoteId: "m" }]);
    const before = reg.get("groq/m");
    reg.refreshFromApi([{ id: "groq/m", provider: "other", pricing: { inputPerMillion: 9, outputPerMillion: 9 } }]);
    expect(reg.get("groq/m")).toEqual(before);
  });
});

describe("seeding and owner models", () => {
  it("standalone seeds the Anthropic rows from the price table; Conway mode seeds nothing", () => {
    const t = table({ anthropicApiKey: "sk-ant-0123456789" });
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.seedFromPriceTable(t);
    const ids = reg.getAll().map((m) => m.modelId).sort();
    expect(ids).toEqual(["claude-haiku-4-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5-5"]);
    expect(reg.get("claude-opus-5-5")).toMatchObject({
      providerId: "anthropic",
      priceSource: "table",
      costPer1kInput: 40,
      costPer1kOutput: 200,
      enabled: true,
      listed: true,
    });
    expect(modelRegistryGetOrigin(db.raw, "claude-opus-5-5")).toBe("manual");

    const conway = resolveProviderTable(createTestConfig({ conwayApiKey: "cnwy_k_x", anthropicApiKey: "sk-ant-0123456789" }), {});
    const db2 = createDatabase(path.join(tmp, "conway.db"));
    try {
      const reg2 = new ModelRegistry(db2.raw, { table: conway });
      reg2.seedFromPriceTable(conway);
      expect(reg2.getAll()).toEqual([]);
    } finally {
      db2.close();
    }
  });

  it("re-enables a retired baseline Claude row, as Phase 1 seeding did", () => {
    modelRegistryUpsert(
      db.raw,
      {
        modelId: "claude-sonnet-4-6",
        provider: "anthropic",
        displayName: "old",
        tierMinimum: "normal",
        costPer1kInput: 30,
        costPer1kOutput: 150,
        maxTokens: 8192,
        contextWindow: 200000,
        supportsTools: true,
        supportsVision: true,
        parameterStyle: "max_tokens",
        enabled: false,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      "baseline",
    );
    const t = table({ anthropicApiKey: "sk-ant-0123456789" });
    new ModelRegistry(db.raw, { table: t }).seedFromPriceTable(t);
    expect(new ModelRegistry(db.raw).get("claude-sonnet-4-6")).toMatchObject({ enabled: true, providerId: "anthropic" });
  });

  it("compatible owner models get qualified ids, the owner tier and price; unpriced stays unpriced", () => {
    const t = table(
      compat({ models: [{ id: "llama-3.3-70b-versatile", tierMinimum: "low_compute" }, { id: "x", inputUsdPerM: 1, outputUsdPerM: 3 }, { id: "y" }] }),
    );
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.seedFromPriceTable(t);
    expect(reg.get("groq/llama-3.3-70b-versatile")).toMatchObject({ tierMinimum: "low_compute", costPer1kInput: 5.9, priceSource: "table" });
    expect(reg.get("groq/x")).toMatchObject({ costPer1kInput: 10, costPer1kOutput: 30, priceSource: "owner", remoteId: "x" });
    expect(reg.get("groq/y")).toMatchObject({ costPer1kInput: 0, costPer1kOutput: 0, priceSource: null });
  });

  it("a row left by a provider no longer configured gives way: an OpenAI-proxy owner who switches to Anthropic gets the seeds and the planner", () => {
    // A LiteLLM proxy as the OpenAI endpoint, with Claude ids listed and priced.
    const proxy = standalone({
      openaiApiKey: "sk-litellm-0123456789",
      providers: {
        openai: {
          baseUrl: "http://127.0.0.1:4000/v1",
          models: [
            { id: "claude-sonnet-5-5", inputUsdPerM: 2, outputUsdPerM: 10 },
            { id: "claude-haiku-5-5", inputUsdPerM: 0.1, outputUsdPerM: 0.5, tierMinimum: "critical" },
          ],
        },
      },
    });
    const t1 = resolveProviderTable(proxy, {});
    new ModelRegistry(db.raw, { table: t1, config: proxy }).seedFromPriceTable(t1);
    expect(new ModelRegistry(db.raw).get("claude-sonnet-5-5")?.providerId).toBe("openai");

    // The OpenAI key is removed and an Anthropic key added.
    const direct = standalone({
      anthropicApiKey: "sk-ant-0123456789abcdef",
      inferenceModel: "claude-sonnet-5-5",
      modelStrategy: { inferenceModel: "claude-sonnet-5-5", lowComputeModel: "claude-haiku-5-5", criticalModel: "claude-haiku-5-5" } as any,
    });
    const t2 = resolveProviderTable(direct, {});
    const reg = new ModelRegistry(db.raw, { table: t2, config: direct });
    reg.initialize();
    reg.seedFromPriceTable(t2);
    for (const id of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
      const row = reg.get(id)!;
      expect(row).toMatchObject({ providerId: "anthropic", provider: "anthropic", priceSource: "table" });
      expect(canServeModel(t2, row)).toBe(true);
    }
    expect(ensureServableStrategy(direct, reg, (m) => canServeModel(t2, m), t2)).toEqual({ substitutions: [], unservable: [] });
    const orch = buildOrchestrationRegistry({ table: t2, registry: reg, strategy: direct.modelStrategy!, config: direct });
    expect(orch.registry?.resolveCandidates("reasoning")[0].model.id).toBe("claude-sonnet-5-5");
  });

  it("discovery takes over a row whose provider left the table, as a discovered row; a configured holder still blocks", () => {
    const proxy = standalone({ openaiApiKey: "sk-litellm-0123456789", providers: { openai: { baseUrl: "http://127.0.0.1:4000/v1", models: [{ id: "claude-opus-5-5", inputUsdPerM: 1, outputUsdPerM: 1 }] } } });
    const t1 = resolveProviderTable(proxy, {});
    new ModelRegistry(db.raw, { table: t1 }).seedFromPriceTable(t1);
    const t2 = table({ anthropicApiKey: "sk-ant-0123456789" });
    const reg = new ModelRegistry(db.raw, { table: t2 });
    const r = reg.applyDiscovery(t2.get("anthropic")!, [{ remoteId: "claude-opus-5-5" }]);
    expect(r.conflicts).toEqual([]);
    expect(reg.get("claude-opus-5-5")).toMatchObject({ providerId: "anthropic", costPer1kInput: 40, costPer1kOutput: 200 });
    expect(modelRegistryGetOrigin(db.raw, "claude-opus-5-5")).toBe("api");

    // With the proxy still configured, its row stays its own.
    const both = resolveProviderTable(standalone({ ...proxy, anthropicApiKey: "sk-ant-0123456789" }), {});
    const db2 = createDatabase(path.join(tmp, "both.db"));
    try {
      new ModelRegistry(db2.raw, { table: both }).seedFromPriceTable(both);
      expect(new ModelRegistry(db2.raw).get("claude-opus-5-5")?.providerId).toBe("openai");
    } finally {
      db2.close();
    }
  });

  it("Anthropic only, with the 5.5 defaults unusable: the other seeded Claude models fill the strategy and the planner", () => {
    const config = standalone({ anthropicApiKey: "sk-ant-0123456789abcdef", inferenceModel: "gpt-5.2" });
    const t = resolveProviderTable(config, {});
    const reg = new ModelRegistry(db.raw, { table: t, config });
    reg.initialize();
    reg.seedFromPriceTable(t);
    reg.setEnabled("claude-sonnet-5-5", false);
    reg.setEnabled("claude-haiku-5-5", false);
    const res = ensureServableStrategy(config, reg, (m) => canServeModel(t, m), t);
    expect(res.unservable).toEqual([]);
    expect(config.inferenceModel).toBe("claude-sonnet-4-6");
    expect(config.modelStrategy?.criticalModel).toBe("claude-haiku-4-5");
    const orch = buildOrchestrationRegistry({
      table: t,
      registry: reg,
      strategy: { inferenceModel: "gpt-5.2", lowComputeModel: "gpt-5-mini", criticalModel: "gpt-5-mini" },
      config,
    });
    expect(orch.registry?.resolveCandidates("reasoning")[0].model.id).toBe("claude-sonnet-4-6");
    expect(orch.registry?.resolveCandidates("cheap")[0].model.id).toBe("claude-haiku-4-5");
  });

  it("the legacy seedProviderModels keeps exactly the Phase 1 pair", () => {
    new ModelRegistry(db.raw).seedProviderModels(["anthropic"]);
    expect(new ModelRegistry(db.raw).getAll().map((m) => m.modelId).sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
  });
});

describe("free models and prices the gate reads", () => {
  it("a free loopback entry's rows are local; the same server on a LAN host is paid", () => {
    const local = table({ providers: { compatible: [{ id: "lm", baseUrl: "http://[::1]:1234/v1", free: true }] } });
    const reg = new ModelRegistry(db.raw, { table: local });
    reg.applyDiscovery(local.get("lm")!, [{ remoteId: "qwen" }]);
    expect(reg.get("lm/qwen")?.free).toBe(true);
    expect(registryPrice(reg.get("lm/qwen")!).local).toBe(true);

    // A config that slipped past validation still cannot make a LAN server free.
    const lan = table({ providers: { compatible: [{ id: "lm", baseUrl: "https://192.168.1.5/v1", free: true }] } });
    const regLan = new ModelRegistry(db.raw, { table: lan });
    expect(regLan.get("lm/qwen")?.free).toBe(false);
    expect(registryPrice(regLan.get("lm/qwen")!).local).toBe(false);
  });

  it("without a table, only Ollama models are free (as before)", () => {
    applyOllamaListing(db.raw, ["llama3"]);
    const reg = new ModelRegistry(db.raw);
    expect(reg.get("llama3")?.free).toBeUndefined();
    expect(registryPrice(reg.get("llama3")!).local).toBe(true);
  });

  it("maxListedPrice: the priciest priced, enabled, listed row a configured provider serves", () => {
    const t = table({ anthropicApiKey: "sk-ant-0123456789", ...compat({ models: [{ id: "big", inputUsdPerM: 12, outputUsdPerM: 30 }] }) });
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.initialize(); // OpenAI baseline rows: no OpenAI key, so not counted.
    reg.seedFromPriceTable(t);
    expect(reg.maxListedPrice()).toEqual({ inputUsdPerM: 12, outputUsdPerM: 30 });
    reg.setEnabled("groq/big", false);
    expect(reg.maxListedPrice()).toEqual({ inputUsdPerM: 4, outputUsdPerM: 20 });
  });
});

describe("Ollama rows", () => {
  it("set provider_id ollama, unlist models the server dropped, and skip another provider's id", () => {
    const reg = new ModelRegistry(db.raw);
    reg.initialize();
    const first = applyOllamaListing(db.raw, ["llama3", "qwen3:8b", "gpt-5.2"]);
    expect(first.conflicts).toEqual(["gpt-5.2"]);
    expect(reg.get("gpt-5.2")?.provider).toBe("openai");
    expect(reg.get("llama3")).toMatchObject({ provider: "ollama", providerId: "ollama", listed: true });
    const second = applyOllamaListing(db.raw, ["llama3"]);
    expect(second.unlisted).toEqual(["qwen3:8b"]);
    expect(reg.get("qwen3:8b")?.listed).toBe(false);
    applyOllamaListing(db.raw, ["llama3", "qwen3:8b"]);
    expect(reg.get("qwen3:8b")?.listed).toBe(true);
  });
});

describe("model_registry provider columns migration", () => {
  /** A database as version `from` left it: model_registry without the provider columns. */
  function makeOld(dbPath: string, from: number): void {
    createDatabase(dbPath).close();
    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM schema_version WHERE version > ?").run(from);
    raw.exec("DROP TABLE model_registry;");
    raw.exec(MIGRATION_V6.slice(MIGRATION_V6.indexOf("CREATE TABLE IF NOT EXISTS model_registry")));
    raw.exec(
      "ALTER TABLE model_registry ADD COLUMN origin TEXT NOT NULL DEFAULT 'baseline' CHECK(origin IN ('baseline','api','ollama','manual'))",
    );
    const insert = raw.prepare(
      `INSERT INTO model_registry (model_id, provider, display_name, cost_per_1k_input, cost_per_1k_output, enabled, created_at, updated_at, origin)
       VALUES (?, ?, ?, 18, 140, 1, '2026-01-01', '2026-01-01', ?)`,
    );
    insert.run("gpt-5.2", "openai", "GPT-5.2", "baseline");
    insert.run("claude-sonnet-4-6", "anthropic", "Claude", "manual");
    insert.run("kimi", "conway", "Conway model", "api");
    insert.run("llama3", "ollama", "Llama", "ollama");
    raw.close();
  }

  // 16 and 17 also run the version 17 and 18 migrations on the way up.
  it.each([16, 17, 18])("a version %i database gains the columns once; legacy rows keep provider_id NULL and route as before", (from) => {
    const dbPath = path.join(tmp, `v${from}.db`);
    makeOld(dbPath, from);
    const migrated = createDatabase(dbPath);
    try {
      const cols = (migrated.raw.prepare("PRAGMA table_info(model_registry)").all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of ["provider_id", "remote_id", "listed", "price_source", "capabilities"]) {
        expect(cols.filter((n) => n === c), c).toHaveLength(1);
      }
      // Version 19 adds them (20, the budget and approvals tables, follows);
      // every later version on the way up is recorded once.
      expect(SCHEMA_VERSION).toBe(20);
      const v = migrated.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(v.v).toBe(SCHEMA_VERSION);
      const applied = (
        migrated.raw.prepare("SELECT version FROM schema_version WHERE version > ? ORDER BY version").all(from) as { version: number }[]
      ).map((r) => r.version);
      expect(applied).toEqual(Array.from({ length: 20 - from }, (_, i) => from + 1 + i));
      // Running it again is a no-op.
      migrateModelRegistryProviders(migrated.raw);
      const again = (migrated.raw.prepare("PRAGMA table_info(model_registry)").all() as Array<{ name: string }>).length;
      expect(again).toBe(cols.length);

      const reg = new ModelRegistry(migrated.raw);
      for (const id of ["gpt-5.2", "claude-sonnet-4-6", "kimi", "llama3"]) {
        expect(reg.get(id)?.providerId ?? null, id).toBeNull();
        expect(reg.get(id)?.listed, id).toBe(true);
      }
      // Routing is unchanged: Conway mode serves every legacy row as before; standalone never a Conway one.
      const conway = resolveProviderTable(createTestConfig({ conwayApiKey: "cnwy_k_x", openaiApiKey: "k", ollamaBaseUrl: "http://localhost:11434" }), {});
      for (const id of ["gpt-5.2", "claude-sonnet-4-6", "kimi", "llama3"]) expect(canServeModel(conway, reg.get(id)!), id).toBe(true);
      const sa = table({ openaiApiKey: "k", anthropicApiKey: "sk-ant-0123456789" });
      expect(canServeModel(sa, reg.get("gpt-5.2")!)).toBe(true);
      expect(canServeModel(sa, reg.get("claude-sonnet-4-6")!)).toBe(true);
      expect(canServeModel(sa, reg.get("kimi")!)).toBe(false);
    } finally {
      migrated.close();
    }
    // A second open changes nothing.
    const reopened = createDatabase(dbPath);
    reopened.close();
  });

  it("an upsert without the provider fields keeps the stored ones", () => {
    const t = table(compat({}));
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.applyDiscovery(t.get("groq")!, [{ remoteId: "m", contextWindow: 9 }]);
    const row = reg.get("groq/m")!;
    modelRegistryUpsert(db.raw, { ...row, displayName: "renamed", providerId: undefined, remoteId: undefined, listed: undefined, priceSource: undefined, capabilities: undefined });
    expect(reg.get("groq/m")).toMatchObject({ displayName: "renamed", providerId: "groq", remoteId: "m", listed: true });
    expect(STATIC_MODEL_BASELINE.length).toBeGreaterThan(0);
  });
});
