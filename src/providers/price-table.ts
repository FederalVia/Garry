/**
 * Model prices the inference gate charges, maintained by hand in code.
 * Nothing is fetched from the internet for prices. Units: USD per 1M
 * tokens, as in the config; the registry stores USD per 1M x 10 and the
 * conversion happens only at the registry boundary.
 */

import type { AutomatonConfig, ConfiguredModel, ModelCapabilities, PriceSource, SurvivalTier } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { DEFAULT_OPENAI_BASE_URL } from "./mode.js";
import type { ProviderEntry } from "./table.js";

export type { ModelCapabilities };

const logger = createLogger("providers.prices");

export interface PriceRow {
  servedBy: "openai" | "anthropic" | { host: string };
  /** Exact remote id; Anthropic dated ids (...-YYYYMMDD) match their alias. */
  id: string;
  inputUsdPerM: number;
  outputUsdPerM: number;
  tierMinimum: SurvivalTier;
  maxOutputTokens?: number;
  contextWindow?: number;
  capabilities?: Partial<ModelCapabilities>;
  /** Created when the provider is configured, before discovery. */
  seed?: boolean;
  displayName?: string;
}

export const PRICES_AS_OF = "2026-11-03";

const ALL_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_ON: Partial<ModelCapabilities> = {
  thinking: "default-on",
  effort: true,
  effortLevels: [...ALL_EFFORT],
  sampling: false,
  // Thinking counts toward max_tokens: too small a limit leaves no answer.
  minOutputTokens: 2048,
};
const OPT_IN_NO_SAMPLING: Partial<ModelCapabilities> = {
  thinking: "opt-in",
  effort: true,
  effortLevels: [...ALL_EFFORT],
  sampling: false,
};

function anthropic(
  id: string,
  displayName: string,
  inputUsdPerM: number,
  outputUsdPerM: number,
  tierMinimum: SurvivalTier,
  capabilities: Partial<ModelCapabilities>,
  extra: Partial<PriceRow> = {},
): PriceRow {
  return {
    servedBy: "anthropic",
    id,
    displayName,
    inputUsdPerM,
    outputUsdPerM,
    tierMinimum,
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    capabilities,
    ...extra,
  };
}

function openai(id: string, displayName: string, inputUsdPerM: number, outputUsdPerM: number, tierMinimum: SurvivalTier): PriceRow {
  return {
    servedBy: "openai",
    id,
    displayName,
    inputUsdPerM,
    outputUsdPerM,
    tierMinimum,
    maxOutputTokens: id.startsWith("gpt-4.1-") || id === "gpt-5-mini" ? 16_384 : 32_768,
    contextWindow: 1_047_576,
  };
}

function hosted(host: string, id: string, inputUsdPerM: number, outputUsdPerM: number, tierMinimum: SurvivalTier): PriceRow {
  return { servedBy: { host }, id, inputUsdPerM, outputUsdPerM, tierMinimum, contextWindow: 131_072 };
}

export const PRICE_TABLE: readonly PriceRow[] = Object.freeze([
  // Anthropic first-party list prices. Mythos rows price only: never seeded
  // (verified organisations only).
  anthropic("claude-fable-5-2", "Claude Fable 5.2", 8, 40, "normal", DEFAULT_ON),
  anthropic("claude-mythos-5-2", "Claude Mythos 5.2", 8, 40, "normal", DEFAULT_ON),
  anthropic("claude-fable-5-1", "Claude Fable 5.1", 10, 50, "normal", DEFAULT_ON),
  anthropic("claude-mythos-5-1", "Claude Mythos 5.1", 10, 50, "normal", DEFAULT_ON),
  anthropic("claude-fable-5", "Claude Fable 5", 10, 50, "normal", DEFAULT_ON),
  anthropic("claude-mythos-5", "Claude Mythos 5", 10, 50, "normal", DEFAULT_ON),
  anthropic("claude-opus-5-5", "Claude Opus 5.5", 4, 20, "normal", DEFAULT_ON, { seed: true }),
  anthropic("claude-opus-5", "Claude Opus 5", 5, 25, "normal", DEFAULT_ON),
  anthropic("claude-opus-4-8", "Claude Opus 4.8", 5, 25, "normal", OPT_IN_NO_SAMPLING),
  anthropic("claude-opus-4-7", "Claude Opus 4.7", 5, 25, "normal", OPT_IN_NO_SAMPLING),
  anthropic("claude-opus-4-6", "Claude Opus 4.6", 5, 25, "normal", {
    thinking: "opt-in",
    effort: true,
    effortLevels: ["low", "medium", "high", "max"],
    sampling: true,
  }),
  anthropic("claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, "normal", DEFAULT_ON, { seed: true }),
  anthropic("claude-sonnet-5", "Claude Sonnet 5", 2, 10, "normal", DEFAULT_ON),
  anthropic(
    "claude-sonnet-4-6",
    "Claude Sonnet 4.6",
    3,
    15,
    "normal",
    { thinking: "opt-in", effort: true, effortLevels: ["low", "medium", "high", "max"], sampling: true },
    { seed: true },
  ),
  anthropic(
    "claude-haiku-5-5",
    "Claude Haiku 5.5",
    0.1,
    0.5,
    "critical",
    { ...DEFAULT_ON, longPrompt: { aboveInputTokens: 100_000, inputUsdPerM: 0.5, outputUsdPerM: 2.5 } },
    { seed: true },
  ),
  anthropic(
    "claude-haiku-4-5",
    "Claude Haiku 4.5",
    1,
    5,
    "critical",
    { thinking: "opt-in", effort: false, sampling: true },
    { seed: true, maxOutputTokens: 64_000, contextWindow: 200_000 },
  ),

  // OpenAI: the static baseline models at the prices the baseline charges.
  openai("gpt-5.2", "GPT-5.2", 1.8, 14, "normal"),
  openai("gpt-5.3", "GPT-5.3", 2, 8, "normal"),
  openai("gpt-4.1", "GPT-4.1", 2, 8, "normal"),
  openai("gpt-4.1-mini", "GPT-4.1 Mini", 0.4, 1.6, "low_compute"),
  openai("gpt-4.1-nano", "GPT-4.1 Nano", 0.1, 0.4, "critical"),
  openai("gpt-5-mini", "GPT-5 Mini", 0.8, 3.2, "low_compute"),

  // Hosted open models, as the orchestration defaults price them.
  hosted("api.groq.com", "llama-3.3-70b-versatile", 0.59, 0.79, "normal"),
  hosted("api.groq.com", "llama-3.1-8b-instant", 0.05, 0.08, "critical"),
  hosted("api.together.xyz", "meta-llama/Llama-3.3-70B-Instruct-Turbo", 0.88, 0.88, "normal"),
  hosted("api.together.xyz", "meta-llama/Llama-3.1-8B-Instruct-Turbo", 0.18, 0.18, "critical"),
]);

const DATED = /-\d{8}$/;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function rowServes(row: PriceRow, entry: Pick<ProviderEntry, "kind" | "id" | "baseUrl">): boolean {
  if (row.servedBy === "anthropic") return entry.kind === "anthropic";
  // OpenAI's prices hold only on OpenAI's own endpoint.
  if (row.servedBy === "openai") return entry.kind === "openai" && hostOf(entry.baseUrl) === hostOf(DEFAULT_OPENAI_BASE_URL);
  return entry.kind === "openai" && hostOf(entry.baseUrl) === row.servedBy.host;
}

/** The table row pricing `remoteId` on this entry, if any. */
export function lookupPrice(entry: Pick<ProviderEntry, "kind" | "id" | "baseUrl">, remoteId: string): PriceRow | undefined {
  const id = remoteId.trim();
  const exact = PRICE_TABLE.find((r) => r.id === id && rowServes(r, entry));
  if (exact) return exact;
  if (entry.kind === "anthropic" && DATED.test(id)) {
    const alias = id.replace(DATED, "");
    return PRICE_TABLE.find((r) => r.id === alias && rowServes(r, entry));
  }
  return undefined;
}

function validPrice(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function ownerModels(config?: Pick<AutomatonConfig, "providers"> | null): ConfiguredModel[] {
  const p = config?.providers;
  if (!p) return [];
  const out: ConfiguredModel[] = [];
  for (const list of [p.openai?.models, p.anthropic?.models, ...(p.compatible ?? []).map((c) => c?.models)]) {
    if (Array.isArray(list)) out.push(...list.filter((m) => m && typeof m === "object"));
  }
  return out;
}

/**
 * The highest known price, per side: every table row (long-prompt tiers
 * included) and every owner price. Charged for a price nobody knows.
 */
export function maxKnownPrice(config?: Pick<AutomatonConfig, "providers"> | null): { inputUsdPerM: number; outputUsdPerM: number } {
  let input = 0;
  let output = 0;
  for (const r of PRICE_TABLE) {
    input = Math.max(input, r.inputUsdPerM, r.capabilities?.longPrompt?.inputUsdPerM ?? 0);
    output = Math.max(output, r.outputUsdPerM, r.capabilities?.longPrompt?.outputUsdPerM ?? 0);
  }
  for (const m of ownerModels(config)) {
    if (validPrice(m.inputUsdPerM)) input = Math.max(input, m.inputUsdPerM);
    if (validPrice(m.outputUsdPerM)) output = Math.max(output, m.outputUsdPerM);
  }
  return { inputUsdPerM: input, outputUsdPerM: output };
}

/**
 * The price an allowUnpriced model is reserved at: the larger of
 * maxKnownPrice(config) and the priciest priced, listed row a configured
 * provider serves.
 */
export function highestKnownPrice(
  config: Pick<AutomatonConfig, "providers"> | null | undefined,
  registry?: { maxListedPrice(): { inputUsdPerM: number; outputUsdPerM: number } } | null,
): { inputUsdPerM: number; outputUsdPerM: number } {
  const known = maxKnownPrice(config);
  const listed = registry?.maxListedPrice() ?? { inputUsdPerM: 0, outputUsdPerM: 0 };
  return {
    inputUsdPerM: Math.max(known.inputUsdPerM, listed.inputUsdPerM),
    outputUsdPerM: Math.max(known.outputUsdPerM, listed.outputUsdPerM),
  };
}

/**
 * A long-prompt tier applies once the estimated prompt reaches this share of
 * its threshold: the local estimate runs up to about 1.4x short on current
 * Claude tokenizers, so the trigger sits at 100%/1.4. Settlement re-prices
 * at the tier when the reported input crosses the threshold anyway.
 */
export const LONG_PROMPT_THRESHOLD_FRACTION = 0.7;

/**
 * The long-prompt price for a reservation, or null when the model has no
 * such tier or the estimated prompt is below 70% of its threshold.
 */
export function longPromptPrice(
  capabilities: Partial<ModelCapabilities> | null | undefined,
  estimatedInputTokens: number,
): { inputUsdPerM: number; outputUsdPerM: number } | null {
  const tier = capabilities?.longPrompt;
  if (!tier || !(tier.aboveInputTokens > 0)) return null;
  if (!(estimatedInputTokens >= tier.aboveInputTokens * LONG_PROMPT_THRESHOLD_FRACTION)) return null;
  return { inputUsdPerM: tier.inputUsdPerM, outputUsdPerM: tier.outputUsdPerM };
}

/** Rows created as soon as the provider is configured. */
export function seedRows(kind: "anthropic" | "openai"): PriceRow[] {
  return PRICE_TABLE.filter((r) => r.seed === true && r.servedBy === kind);
}

export interface ListedPrice {
  inputUsdPerM: number;
  outputUsdPerM: number;
  requestFeeUsd?: number;
}

export interface ResolvedPrice {
  inputUsdPerM: number;
  outputUsdPerM: number;
  source: PriceSource;
}

const warnedBelowTable = new Set<string>();

/**
 * One row's price: the owner's price wins (even below the table, with a
 * one-time warning); otherwise the larger of the reported and the table
 * price, per side. A per-request fee, here or in the table, makes the model
 * unpriced (the gate charges tokens only), unless the owner priced it.
 * Returns null when either side has no price.
 */
export function resolvePrice(p: {
  owner?: Pick<ConfiguredModel, "inputUsdPerM" | "outputUsdPerM"> | null;
  listed?: ListedPrice | null;
  table?: PriceRow | null;
  /** For the warning: "<entry>/<model>". */
  label?: string;
}): ResolvedPrice | null {
  const owner = p.owner ?? undefined;
  const table = p.table ?? undefined;
  if (owner && validPrice(owner.inputUsdPerM) && validPrice(owner.outputUsdPerM)) {
    if (table && (owner.inputUsdPerM < table.inputUsdPerM || owner.outputUsdPerM < table.outputUsdPerM)) {
      const key = p.label ?? table.id;
      if (!warnedBelowTable.has(key)) {
        warnedBelowTable.add(key);
        logger.warn(
          `Owner price for ${key} ($${owner.inputUsdPerM}/$${owner.outputUsdPerM} per M) is below the list price ` +
            `($${table.inputUsdPerM}/$${table.outputUsdPerM} per M, as of ${PRICES_AS_OF}); the owner price is charged.`,
        );
      }
    }
    return { inputUsdPerM: owner.inputUsdPerM, outputUsdPerM: owner.outputUsdPerM, source: "owner" };
  }
  const fee = (p.listed?.requestFeeUsd ?? 0) > 0 || (table?.capabilities?.requestFeeUsd ?? 0) > 0;
  if (fee) return null;
  const listed = p.listed ?? undefined;
  const side = (k: "inputUsdPerM" | "outputUsdPerM"): { v: number; from: "listed" | "table" } | null => {
    const l = listed && validPrice(listed[k]) ? listed[k] : 0;
    const t = table && validPrice(table[k]) ? table[k] : 0;
    if (l <= 0 && t <= 0) return null;
    return l > t ? { v: l, from: "listed" } : { v: t, from: "table" };
  };
  const input = side("inputUsdPerM");
  const output = side("outputUsdPerM");
  if (!input || !output) return null;
  const source: PriceSource = input.from === "listed" || output.from === "listed" ? "listed" : "table";
  return { inputUsdPerM: input.v, outputUsdPerM: output.v, source };
}

/**
 * USD per 1M tokens to registry units (USD per 1M x 10). Fractions are kept;
 * only binary float dust (0.59 x 10 = 5.8999...) is cleared.
 */
export function toRegistryUnits(usdPerM: number): number {
  return Math.round(usdPerM * 10 * 1e9) / 1e9;
}

/** Test helper: forget the one-time warnings. */
export function resetPriceWarningsForTests(): void {
  warnedBelowTable.clear();
}
