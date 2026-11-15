/**
 * list_models tells the truth in standalone: only models a configured
 * provider can serve, prices per 1M, unpriced rows flagged, each provider's
 * last model-list refresh, and no call to Conway. Conway mode is unchanged.
 * pickableModels follows the same provider table.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { createInferenceClient, modelRouteOf } from "../conway/inference.js";
import { ModelRegistry } from "../inference/registry.js";
import { modelRegistryGetAll } from "../state/database.js";
import { resolveProviderTable } from "../providers/table.js";
import { pickableModels } from "../setup/model-picker.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

let db: AutomatonDatabase;
let conway: MockConwayClient;

beforeEach(() => {
  db = createTestDb();
  conway = new MockConwayClient();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function listModelsTool() {
  const tool = createBuiltinTools("sandbox").find((t) => t.name === "list_models");
  if (!tool) throw new Error("list_models missing");
  return tool;
}

/** The loop's wiring: table, seeded registry, and the main client's canServe. */
function contextFor(config: AutomatonConfig): ToolContext {
  const table = resolveProviderTable(config, {});
  const registry = new ModelRegistry(db.raw, { table, config });
  registry.initialize();
  registry.seedFromPriceTable(table);
  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey: config.conwayApiKey ?? "",
    defaultModel: "x",
    maxTokens: 100,
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    conwayFallback: table.mode === "conway",
    table,
    getModelRoute: (id) => modelRouteOf(registry.get(id)),
  });
  return { identity: createTestIdentity(), config, db, conway, inference } as ToolContext;
}

describe("list_models in standalone", () => {
  it("Anthropic only: Claude rows only, priced per 1M, unpriced flagged, with the refresh status, and no Conway call", async () => {
    const listSpy = vi.spyOn(conway, "listModels");
    const config = createTestConfig({
      conwayApiKey: "",
      anthropicApiKey: "sk-ant",
      providers: { anthropic: { models: [{ id: "claude-experimental-x" }] } },
    } as any);
    const ctx = contextFor(config);
    db.setKV(
      "model_discovery:anthropic",
      JSON.stringify({ ok: true, at: Date.UTC(2026, 10, 14), count: 12, unpricedCount: 2, unpricedSample: ["claude-new-a", "claude-new-b"], urlHash: "h" }),
    );

    const out = await listModelsTool().execute({}, ctx);

    expect(listSpy).not.toHaveBeenCalled();
    expect(out).not.toContain("gpt-5.2");
    expect(out).not.toMatch(/\bgpt-/);
    expect(out).toContain("Anthropic [anthropic]");
    expect(out).toMatch(/claude-sonnet-5-5 \(anthropic\) - \$2\/\$10 per 1M \(in\/out\) \| price from table/);
    expect(out).toMatch(/claude-haiku-5-5 \(anthropic\) - \$0\.1\/\$0\.5 per 1M/);
    expect(out).toMatch(/claude-experimental-x \(anthropic\) - no price: skipped/);
    expect(out).toContain("Model list: refreshed 2026-11-14T00:00:00.000Z, 12 listed; 2 not imported for want of a price (e.g. claude-new-a, claude-new-b)");
    expect(out).not.toContain("hundredths of cents");
  });

  it("shows at most 40 models per provider and counts the rest", async () => {
    const config = createTestConfig({
      conwayApiKey: "",
      providers: {
        compatible: [
          {
            id: "agg",
            baseUrl: "https://agg.example/v1",
            apiKey: "k",
            models: Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, inputUsdPerM: 1, outputUsdPerM: 2 })),
          },
        ],
      },
    } as any);
    const out = await listModelsTool().execute({}, contextFor(config));
    expect(out).toContain("agg [agg]: 45 model(s)");
    expect((out.match(/agg\/m\d+ \(openai\)/g) ?? []).length).toBe(40);
    expect(out).toContain("... and 5 more");
  });

  it("works without a registry row and a failed refresh is reported", async () => {
    const config = createTestConfig({ conwayApiKey: "", openaiApiKey: "sk" });
    db.setKV("model_discovery:openai", JSON.stringify({ ok: false, at: Date.UTC(2026, 10, 14), count: 0, error: "provider openai rejected its key", unpricedCount: 0, unpricedSample: [], urlHash: "h" }));
    const out = await listModelsTool().execute({}, contextFor(config));
    expect(out).toContain("gpt-5.2 (openai)");
    expect(out).toContain("Model list: last refresh failed at 2026-11-14T00:00:00.000Z: provider openai rejected its key");
  });
});

describe("list_models in Conway mode", () => {
  it("prints the registry exactly as before", async () => {
    const config = createTestConfig();
    const ctx = { identity: createTestIdentity(), config, db, conway, inference: new MockInferenceClient() } as ToolContext;
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const rows = modelRegistryGetAll(db.raw);
    // The formatter as it was before the provider table.
    const expected = `Model Registry (${rows.length} models):\n${rows
      .map(
        (r: any) =>
          `${r.modelId} (${r.provider}) — tier: ${r.tierMinimum} | cost: ${r.costPer1kInput}/${r.costPer1kOutput} per 1k (in/out, hundredths of cents) | ctx: ${r.contextWindow} | tools: ${r.supportsTools ? "yes" : "no"} | ${r.enabled ? "enabled" : "disabled"}`,
      )
      .join("\n")}`;
    expect(await listModelsTool().execute({}, ctx)).toBe(expected);
  });
});

describe("pickableModels", () => {
  it("lists a compatible entry's models and not an unservable baseline row", () => {
    const config = createTestConfig({
      conwayApiKey: "",
      providers: {
        compatible: [{ id: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "g", models: [{ id: "llama-3.3-70b-versatile", inputUsdPerM: 0.59, outputUsdPerM: 0.79 }] }],
      },
    } as any);
    const table = resolveProviderTable(config, {});
    const registry = new ModelRegistry(db.raw, { table, config });
    registry.initialize();
    registry.seedFromPriceTable(table);
    const ids = pickableModels(registry.getAll().filter((m) => m.enabled), config, {}).map((m) => m.modelId);
    expect(ids).toEqual(["groq/llama-3.3-70b-versatile"]);
  });
});
