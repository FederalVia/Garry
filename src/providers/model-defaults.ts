/**
 * Standalone model choices from the provider table: substitute a servable
 * model for each strategy slot the owner's providers cannot serve, and build
 * the provider registry the planner and workers use. Conway mode never calls
 * these.
 */

import type { AutomatonConfig, ModelEntry, ModelStrategyConfig, SurvivalTier } from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { ModelRegistry } from "../inference/registry.js";
import { registryPrice } from "../inference/policy.js";
import {
  ProviderRegistry,
  customProviderKeyEnvVar,
  stockProviderModels,
  type ModelConfig,
  type ModelTier,
  type ProviderConfig,
} from "../inference/provider-registry.js";
import {
  allowsUnpriced,
  canServeModel,
  isCompatible,
  openAiProtocolBase,
  providerIdForRow,
  registryIdFor,
  remoteIdForRow,
  type ProviderEntry,
  type ProviderTable,
} from "./table.js";
import { DEFAULT_OPENAI_BASE_URL } from "./mode.js";
import { maxKnownPrice } from "./price-table.js";

/**
 * Anthropic models that fill a slot the owner's providers cannot serve:
 * Sonnet for the normal tiers, Haiku (allowed at critical) for the rest.
 */
export const ANTHROPIC_DEFAULT_NORMAL = "claude-sonnet-5-5";
export const ANTHROPIC_DEFAULT_CRITICAL = "claude-haiku-5-5";

/**
 * The other seeded Anthropic models, tried when the two defaults are not
 * usable (for example still held by a proxy the owner listed them on).
 * Opus last: it costs the most.
 */
const ANTHROPIC_FALLBACK_NORMAL = ["claude-sonnet-4-6", "claude-opus-5-5"];
const ANTHROPIC_FALLBACK_CRITICAL = ["claude-haiku-4-5"];

/** The stock OpenAI models of the default endpoint, one per planner tier. */
const OPENAI_ORCHESTRATION_DEFAULTS = ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"];

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

type RegistryView = Pick<ModelRegistry, "get" | "getAll">;

function hasPrice(m: Pick<ModelEntry, "costPer1kInput" | "costPer1kOutput">): boolean {
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  return ok(m.costPer1kInput) && ok(m.costPer1kOutput);
}

function isFree(m: ModelEntry): boolean {
  return registryPrice(m).local;
}

/** The model a slot names today. */
function currentModel(config: AutomatonConfig, slot: StrategySlot): string {
  const ms = config.modelStrategy;
  if (slot === "inferenceModel") {
    return config.inferenceModel || ms?.inferenceModel || DEFAULT_MODEL_STRATEGY_CONFIG.inferenceModel;
  }
  return ms?.[slot] || DEFAULT_MODEL_STRATEGY_CONFIG[slot];
}

/** Rows an entry serves, in registry order. */
function rowsOf(entry: ProviderEntry, all: readonly ModelEntry[]): ModelEntry[] {
  return all.filter((m) => providerIdForRow(m) === entry.id);
}

/** The entry's owner models as registry rows, in the owner's order. */
function ownerRows(entry: ProviderEntry, registry: RegistryView): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const m of entry.models) {
    const row = registry.get(registryIdFor(entry, m.id));
    if (row) out.push(row);
  }
  return out;
}

/**
 * For each strategy slot naming a model no configured provider can serve,
 * pick a provider default the router accepts at that slot's tier, in memory
 * only (the file is not rewritten). A slot with no such model is reported
 * unservable. The owner's own choices are never changed when servable.
 *
 * Preference: every entry's owner models, then Anthropic Sonnet 5.5 and
 * Haiku 5.5, then discovered Ollama models, then the OpenAI baseline, then
 * the models of free loopback compatible entries. A paid compatible entry
 * without a models list contributes nothing: its catalog can hold thousands
 * of models and nothing says which one the owner wants.
 */
export function ensureServableStrategy(
  config: AutomatonConfig,
  registry: RegistryView,
  canServe: (m: ModelEntry) => boolean,
  table: ProviderTable,
): { substitutions: Substitution[]; unservable: StrategySlot[] } {
  // An unpriced model counts when its provider opted in, as the router
  // accepts it then (at the highest known price).
  const usable = (m: ModelEntry | undefined): m is ModelEntry =>
    !!m && m.enabled && m.listed !== false && (hasPrice(m) || isFree(m) || allowsUnpriced(table, m)) && canServe(m);
  // What the router accepts for a slot: a paid model only at or above its
  // tier floor; a free model at any tier.
  const accepted = (m: ModelEntry | undefined, slot: StrategySlot): m is ModelEntry =>
    usable(m) && (isFree(m) || (TIER_ORDER[m.tierMinimum] ?? 99) <= TIER_ORDER[SLOT_TIER[slot]]);
  const all = registry.getAll();
  const ordered: ModelEntry[] = [];
  const add = (m: ModelEntry | undefined) => {
    if (usable(m) && !ordered.some((o) => o.modelId === m.modelId)) ordered.push(m);
  };

  for (const entry of table.entries) for (const m of ownerRows(entry, registry)) add(m);
  if (table.get("anthropic")) {
    add(registry.get(ANTHROPIC_DEFAULT_NORMAL));
    add(registry.get(ANTHROPIC_DEFAULT_CRITICAL));
    for (const id of [ANTHROPIC_FALLBACK_NORMAL[0], ...ANTHROPIC_FALLBACK_CRITICAL, ...ANTHROPIC_FALLBACK_NORMAL.slice(1)]) {
      add(registry.get(id));
    }
  }
  const ollama = table.get("ollama");
  if (ollama) for (const m of rowsOf(ollama, all)) add(m);
  const openai = table.get("openai");
  if (openai) for (const m of rowsOf(openai, all)) add(m);
  for (const entry of table.entries) {
    if (isCompatible(entry) && entry.free) for (const m of rowsOf(entry, all)) add(m);
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

const TIERS: ModelTier[] = ["reasoning", "fast", "cheap"];

interface PricedRow {
  row: ModelEntry;
  inputUsdPerM: number;
  outputUsdPerM: number;
}

function toModelConfig(entry: ProviderEntry, p: PricedRow, tier: ModelTier): ModelConfig {
  const caps = p.row.capabilities ?? undefined;
  const remote = remoteIdForRow(p.row, entry.id);
  return {
    id: p.row.modelId,
    ...(remote !== p.row.modelId ? { remoteId: remote } : {}),
    tier,
    contextWindow: p.row.contextWindow || 128000,
    maxOutputTokens: p.row.maxTokens || 4096,
    costPerInputToken: p.inputUsdPerM,
    costPerOutputToken: p.outputUsdPerM,
    supportsTools: p.row.supportsTools,
    supportsVision: p.row.supportsVision,
    supportsStreaming: true,
    ...(caps?.minOutputTokens ? { minOutputTokens: caps.minOutputTokens } : {}),
    ...(caps
      ? {
          capabilities: {
            ...(caps.effort !== undefined ? { effort: caps.effort } : {}),
            ...(caps.minOutputTokens ? { minOutputTokens: caps.minOutputTokens } : {}),
            ...(caps.longPrompt ? { longPrompt: { ...caps.longPrompt } } : {}),
          },
        }
      : {}),
  };
}

function entryProvider(entry: ProviderEntry, models: ModelConfig[]): { provider: ProviderConfig; keyVar: string } {
  const keyVar =
    entry.id === "openai"
      ? "OPENAI_API_KEY"
      : entry.id === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : entry.id === "ollama"
          ? "LOCAL_API_KEY"
          : customProviderKeyEnvVar(entry.id);
  return {
    keyVar,
    provider: {
      id: entry.id,
      name: entry.label,
      baseUrl: entry.kind === "anthropic" ? entry.baseUrl : openAiProtocolBase(entry),
      apiKeyEnvVar: keyVar,
      models,
      maxRequestsPerMinute: 500,
      maxTokensPerMinute: 2_000_000,
      priority: entry.priority,
      enabled: true,
      kind: entry.kind === "anthropic" ? "anthropic" : "openai",
      free: entry.free,
      noKeyRequired: !entry.hasKey && (entry.loopback || entry.kind === "ollama"),
      ...(entry.effort ? { effort: entry.effort } : {}),
    },
  };
}

/**
 * The planner and workers' provider registry in standalone mode, built from
 * the table. Every entry with orchestration on and a usable model takes
 * part; tier models are the strategy's own models where the entry serves
 * them, otherwise the entry's defaults (never its most expensive model).
 * The Conway key is never used here. null when no entry has a usable model.
 */
export function buildOrchestrationRegistry(params: {
  table: ProviderTable;
  registry: RegistryView & Partial<Pick<ModelRegistry, "maxListedPrice">>;
  strategy: Pick<ModelStrategyConfig, "inferenceModel" | "lowComputeModel" | "criticalModel">;
  config: AutomatonConfig;
}): { registry: ProviderRegistry; reason: string } | { registry: null; reason: string } {
  const { table, registry, strategy, config } = params;
  const all = registry.getAll();
  const unknown = highestKnownPrice(config, registry);
  const providers: ProviderConfig[] = [];
  const keys: Record<string, string | undefined> = {};
  const servesSlot = new Map<StrategySlot, string>();
  const skipped: string[] = [];

  for (const entry of [...table.entries].sort((a, b) => a.priority - b.priority)) {
    if (!entry.orchestration || entry.kind === "conway") continue;
    // OpenAI's baseline prices hold only on OpenAI's own endpoint: a custom
    // providers.openai.baseUrl serves planner and workers only models priced
    // for that endpoint (listed, discovered or matched in the price table).
    const customOpenAi = entry.id === "openai" && entry.baseUrl !== DEFAULT_OPENAI_BASE_URL;

    const priced = (row: ModelEntry | undefined): PricedRow | undefined => {
      if (!row || providerIdForRow(row) !== entry.id) return undefined;
      if (!row.enabled || row.listed === false || !row.supportsTools || !canServeModel(table, row)) return undefined;
      if (isFree(row)) return { row, inputUsdPerM: 0, outputUsdPerM: 0 };
      if (customOpenAi && !(row.priceSource === "owner" || row.priceSource === "listed" || row.priceSource === "table")) {
        return undefined;
      }
      if (hasPrice(row)) return { row, inputUsdPerM: row.costPer1kInput / 10, outputUsdPerM: row.costPer1kOutput / 10 };
      // An allowed unpriced model reserves at the highest known price.
      if (entry.allowUnpriced) return { row, ...unknown };
      return undefined;
    };

    // Defaults for tiers the strategy does not fill on this entry.
    let defaults: PricedRow[] = [];
    if (entry.models.length > 0) {
      defaults = ownerRows(entry, registry).map((r) => priced(r)).filter((p): p is PricedRow => !!p);
    }
    if (defaults.length === 0 && entry.id === "anthropic") {
      const first = (ids: string[]) => ids.map((id) => priced(registry.get(id))).find((p): p is PricedRow => !!p);
      const n = first([ANTHROPIC_DEFAULT_NORMAL, ...ANTHROPIC_FALLBACK_NORMAL]);
      const c = first([ANTHROPIC_DEFAULT_CRITICAL, ...ANTHROPIC_FALLBACK_CRITICAL]);
      defaults = [n ?? c, c ?? n, c ?? n].filter((p): p is PricedRow => !!p);
    }
    if (defaults.length === 0 && (entry.kind === "ollama" || (isCompatible(entry) && entry.free))) {
      defaults = rowsOf(entry, all).map((r) => priced(r)).filter((p): p is PricedRow => !!p);
    }
    const stockOpenAi = defaults.length === 0 && entry.id === "openai" && entry.baseUrl === DEFAULT_OPENAI_BASE_URL;

    const slots: StrategySlot[] = ["inferenceModel", "lowComputeModel", "criticalModel"];
    const fromStrategy = slots.map((slot) => priced(registry.get(strategy[slot])));
    if (defaults.length === 0 && !stockOpenAi) {
      // Fill missing tiers with whatever strategy models this entry serves.
      defaults = fromStrategy.filter((p): p is PricedRow => !!p);
    }
    const stock = stockOpenAi ? stockProviderModels("openai") : [];
    const tierModels: ModelConfig[] = [];
    TIERS.forEach((tier, i) => {
      const pick = fromStrategy[i] ?? defaults[Math.min(i, defaults.length - 1)];
      if (pick) {
        tierModels.push(toModelConfig(entry, pick, tier));
        return;
      }
      // The default OpenAI endpoint: its stock gpt-4.1 family at the stock prices.
      const m = stock.find((s) => s.id === OPENAI_ORCHESTRATION_DEFAULTS[i] && s.tier === tier);
      if (m) tierModels.push(m);
    });

    if (tierModels.length < TIERS.length) {
      skipped.push(entry.id);
      continue;
    }
    for (const [i, slot] of slots.entries()) {
      if (fromStrategy[i] && !servesSlot.has(slot)) servesSlot.set(slot, entry.id);
    }
    const { provider, keyVar } = entryProvider(entry, tierModels);
    providers.push(provider);
    keys[keyVar] = table.key(entry.id);
  }

  if (providers.length === 0) {
    const names = table.entries.filter((e) => e.kind !== "conway").map((e) => e.id);
    const reason =
      names.length === 0
        ? "planner and workers need an AI provider (none is configured)"
        : `planner and workers found no usable model at ${names.join(", ")}: a model needs tool support and a price ` +
          "(or a free loopback server); list models with prices on the provider";
    return { registry: null, reason };
  }

  const ids = providers.map((p) => p.id);
  const order = (preferred: string | undefined) => {
    const first = preferred && ids.includes(preferred) ? preferred : ids[0];
    return { preferredProvider: first, fallbackOrder: ids.filter((id) => id !== first) };
  };
  const tierDefaults = {
    reasoning: order(servesSlot.get("inferenceModel")),
    fast: order(servesSlot.get("lowComputeModel")),
    cheap: order(servesSlot.get("criticalModel")),
  };
  const reason = ids.join("+") + (skipped.length > 0 ? ` (no usable models at ${skipped.join(", ")})` : "");
  return { registry: new ProviderRegistry(providers, tierDefaults, { keys }), reason };
}

/**
 * The price an allowed unpriced model is charged at: the larger of the
 * table's highest price and the most expensive priced listed registry row.
 */
export function highestKnownPrice(
  config: AutomatonConfig,
  registry?: Partial<Pick<ModelRegistry, "maxListedPrice">>,
): { inputUsdPerM: number; outputUsdPerM: number } {
  const known = maxKnownPrice(config);
  const listed = registry?.maxListedPrice?.();
  return {
    inputUsdPerM: Math.max(known.inputUsdPerM, listed?.inputUsdPerM ?? 0),
    outputUsdPerM: Math.max(known.outputUsdPerM, listed?.outputUsdPerM ?? 0),
  };
}
