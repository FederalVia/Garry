/**
 * Standalone model choices: substitute a servable model for each strategy
 * slot the creator's providers cannot serve, and build the provider table
 * the planner and workers use. Conway mode never calls these.
 */

import type { AutomatonConfig, ModelEntry, ModelRegistryRow, SurvivalTier } from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { ModelRegistry } from "../inference/registry.js";
import {
  ProviderRegistry,
  type ModelConfig,
  type ModelTier,
  type ProviderConfig,
} from "../inference/provider-registry.js";
import type { ResolvedRuntime } from "./mode.js";

/**
 * Anthropic models the raw Anthropic client can drive as it is (no thinking
 * blocks, temperature allowed). Prices are registry units: USD per 1M x 10.
 */
export const ANTHROPIC_SEED_MODELS: readonly Omit<ModelRegistryRow, "createdAt" | "updatedAt" | "enabled">[] =
  Object.freeze([
    {
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
      displayName: "Claude Sonnet 4.6",
      tierMinimum: "normal",
      costPer1kInput: 30, // $3/M
      costPer1kOutput: 150, // $15/M
      maxTokens: 8192,
      contextWindow: 200000,
      supportsTools: true,
      supportsVision: true,
      parameterStyle: "max_tokens",
    },
    {
      modelId: "claude-haiku-4-5",
      provider: "anthropic",
      displayName: "Claude Haiku 4.5",
      // The cheapest seed: an Anthropic-only agent needs one model the router
      // accepts at every tier, including a fixed critical tier.
      tierMinimum: "critical",
      costPer1kInput: 10, // $1/M
      costPer1kOutput: 50, // $5/M
      maxTokens: 8192,
      contextWindow: 200000,
      supportsTools: true,
      supportsVision: true,
      parameterStyle: "max_tokens",
    },
  ]);

const TIER_ORDER: Record<string, number> = { dead: 0, critical: 1, low_compute: 2, normal: 3, high: 4 };

type StrategySlot = "inferenceModel" | "lowComputeModel" | "criticalModel";
const SLOT_TIER: Record<StrategySlot, SurvivalTier> = {
  inferenceModel: "normal",
  lowComputeModel: "low_compute",
  criticalModel: "critical",
};

export interface Substitution {
  slot: StrategySlot;
  from: string;
  to: string;
}

function priced(m: ModelEntry): boolean {
  if (m.provider === "ollama") return true;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  return ok(m.costPer1kInput) && ok(m.costPer1kOutput);
}

/** The model a slot names today. */
function currentModel(config: AutomatonConfig, slot: StrategySlot): string {
  const ms = config.modelStrategy;
  if (slot === "inferenceModel") {
    return config.inferenceModel || ms?.inferenceModel || DEFAULT_MODEL_STRATEGY_CONFIG.inferenceModel;
  }
  return ms?.[slot] || DEFAULT_MODEL_STRATEGY_CONFIG[slot];
}

/**
 * For each strategy slot naming a model no configured provider can serve,
 * pick a provider default the router accepts at that slot's tier, in memory
 * only (the file is not rewritten). A slot with no such model is reported
 * unservable.
 * Preference: configured OpenAI-compatible models, then the Anthropic seed
 * models, then discovered Ollama models, then the OpenAI baseline.
 */
export function ensureServableStrategy(
  config: AutomatonConfig,
  registry: Pick<ModelRegistry, "get" | "getAll">,
  canServe: (m: ModelEntry) => boolean,
  runtime: ResolvedRuntime,
): { substitutions: Substitution[]; unservable: StrategySlot[] } {
  const usable = (m: ModelEntry | undefined): m is ModelEntry => !!m && m.enabled && priced(m) && canServe(m);
  // What the router accepts for a slot: a paid model only at or above its
  // tier floor; a local model at any tier.
  const accepted = (m: ModelEntry | undefined, slot: StrategySlot): m is ModelEntry =>
    usable(m) && (m.provider === "ollama" || (TIER_ORDER[m.tierMinimum] ?? 99) <= TIER_ORDER[SLOT_TIER[slot]]);
  const all = registry.getAll();
  const ordered: ModelEntry[] = [];
  const add = (m: ModelEntry | undefined) => {
    if (usable(m) && !ordered.some((o) => o.modelId === m.modelId)) ordered.push(m);
  };
  if (runtime.providers.openai?.customBaseUrl) {
    for (const id of runtime.providers.openai.models) add(registry.get(id));
  }
  if (runtime.providers.anthropic) {
    for (const s of ANTHROPIC_SEED_MODELS) add(registry.get(s.modelId));
  }
  if (runtime.providers.ollama) {
    for (const m of all) if (m.provider === "ollama") add(m);
  }
  if (runtime.providers.openai) {
    for (const m of all) if (m.provider === "openai") add(m);
  }

  const substitutions: Substitution[] = [];
  const unservable: StrategySlot[] = [];
  for (const slot of Object.keys(SLOT_TIER) as StrategySlot[]) {
    const from = currentModel(config, slot);
    if (usable(registry.get(from))) continue;
    // Never a model the router would refuse at this slot's tier.
    const pick = ordered.find((m) => accepted(m, slot));
    if (!pick) {
      unservable.push(slot);
      continue;
    }
    if (slot === "inferenceModel") {
      config.inferenceModel = pick.modelId;
      config.modelStrategy = { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...(config.modelStrategy ?? {}), inferenceModel: pick.modelId };
    } else {
      config.modelStrategy = { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...(config.modelStrategy ?? {}), [slot]: pick.modelId };
    }
    substitutions.push({ slot, from, to: pick.modelId });
  }
  return { substitutions, unservable };
}

/** One model per planner tier: the first for reasoning, the next ones for fast and cheap. */
function tierModels(ids: string[], price: (id: string) => { input: number; output: number }): ModelConfig[] {
  const tiers: ModelTier[] = ["reasoning", "fast", "cheap"];
  return tiers.map((tier, i) => {
    const id = ids[Math.min(i, ids.length - 1)];
    const p = price(id);
    return {
      id,
      tier,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      costPerInputToken: p.input,
      costPerOutputToken: p.output,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
    };
  });
}

/**
 * The planner and workers' provider table in standalone mode, or null when
 * no OpenAI-compatible or Ollama provider exists (an Anthropic-only creator).
 * A custom OpenAI base URL serves only the models the creator listed, and
 * Ollama serves what discovery found, so no tier names a model the server
 * does not have. The Conway key is never used here.
 */
export function buildStandaloneProviderRegistry(params: {
  config: AutomatonConfig;
  runtime: ResolvedRuntime;
  ollamaModelIds: string[];
  providersPath: string;
}): { registry: ProviderRegistry; reason: string } | { registry: null; reason: string } {
  const { config, runtime, ollamaModelIds, providersPath } = params;
  const openai = runtime.providers.openai;
  const ollama = runtime.providers.ollama;
  const keys: Record<string, string | undefined> = {};
  if (openai) keys.OPENAI_API_KEY = config.openaiApiKey;

  // The default OpenAI endpoint (and no Ollama models): today's provider table.
  if (openai && !openai.customBaseUrl && ollamaModelIds.length === 0) {
    const registry = ProviderRegistry.fromConfig(providersPath, { keys });
    if (process.env.OPENAI_BASE_URL) registry.overrideBaseUrl("openai", process.env.OPENAI_BASE_URL);
    return { registry, reason: "openai" };
  }

  const providers: ProviderConfig[] = [];
  if (openai && openai.customBaseUrl) {
    const listed = config.providers?.openai?.models ?? [];
    if (openai.models.length > 0) {
      const byId = new Map(listed.filter((m) => m && typeof m.id === "string").map((m) => [m.id.trim(), m]));
      providers.push({
        id: "openai",
        name: "OpenAI-compatible",
        baseUrl: openai.baseUrl,
        apiKeyEnvVar: "OPENAI_API_KEY",
        models: tierModels(openai.models, (id) => ({
          input: Number(byId.get(id)?.inputUsdPerM ?? 0),
          output: Number(byId.get(id)?.outputUsdPerM ?? 0),
        })),
        maxRequestsPerMinute: 500,
        maxTokensPerMinute: 2_000_000,
        priority: 1,
        enabled: true,
      });
    }
  } else if (openai) {
    // Default endpoint alongside Ollama: keep the stock OpenAI models.
    const stock = ProviderRegistry.fromConfig(providersPath, { keys }).getProviders().find((p) => p.id === "openai");
    if (stock) providers.push({ ...stock, enabled: true });
  }
  if (ollama && ollamaModelIds.length > 0) {
    providers.push({
      id: "local",
      name: "Local (Ollama)",
      baseUrl: `${ollama.baseUrl.replace(/\/+$/, "")}/v1`,
      apiKeyEnvVar: "LOCAL_API_KEY",
      models: tierModels(ollamaModelIds, () => ({ input: 0, output: 0 })),
      maxRequestsPerMinute: 100,
      maxTokensPerMinute: 200000,
      priority: 10,
      enabled: true,
    });
  }
  if (providers.length === 0) {
    const why = runtime.providers.anthropic && !openai && !ollama
      ? "planner and workers need an OpenAI-compatible or Ollama provider; Anthropic support for them comes with the shared provider table"
      : openai?.customBaseUrl
        ? "planner and workers need providers.openai.models for a custom OpenAI-compatible base URL"
        : "planner and workers need an OpenAI-compatible provider or Ollama models (none were discovered)";
    return { registry: null, reason: why };
  }
  const ids = providers.map((p) => p.id);
  const tierDefaults = {
    reasoning: { preferredProvider: ids[0], fallbackOrder: ids.slice(1) },
    fast: { preferredProvider: ids[0], fallbackOrder: ids.slice(1) },
    cheap: { preferredProvider: ids[ids.length - 1], fallbackOrder: ids.slice(0, -1) },
  };
  return { registry: new ProviderRegistry(providers, tierDefaults, { keys }), reason: ids.join("+") };
}
