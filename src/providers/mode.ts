/**
 * Runtime mode: Conway for everything (an install with a Conway key, as
 * before), or standalone (no Conway account; the creator's own AI provider).
 *
 * resolveRuntime is pure and cheap, so every consumer (startup, loop, prompt,
 * heartbeat, skills) derives the same answer from the same config. Standalone
 * mode also forces the daily AI cap under a ceiling and fences Conway egress.
 */

import type { AutomatonConfig, ResolvedTreasuryPolicy } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { ALL_FEATURES, standaloneFeatures, FeatureDisabledError, type FeatureSet } from "./features.js";
import { resolveSurvivalSource, type SurvivalSource } from "./survival-source.js";

const logger = createLogger("providers");

export type RuntimeMode = "conway" | "standalone";

/** Where a resolved value came from. Only sources are ever logged, never values. */
export type ValueSource = "env" | "providers" | "flat" | "config.json";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_DAILY_CAP_CEILING_CENTS = 200;

/** Fields of the flat config whose value loadConfig resolved, with where it came from. */
export interface ConfigSources {
  conwayApiKey?: ValueSource;
  conwayApiUrl?: ValueSource;
  openaiApiKey?: ValueSource;
  anthropicApiKey?: ValueSource;
  ollamaBaseUrl?: ValueSource;
}

const SOURCES = Symbol.for("automaton.config.sources");

/** Attach value sources to a loaded config (non-enumerable: never saved). */
export function setConfigSources(config: AutomatonConfig, sources: ConfigSources): void {
  Object.defineProperty(config, SOURCES, { value: sources, enumerable: false, configurable: true });
}

export function configSources(config: AutomatonConfig): ConfigSources {
  return ((config as any)[SOURCES] as ConfigSources | undefined) ?? {};
}

export interface ResolvedRuntime {
  mode: RuntimeMode;
  reason: "explicit" | "conway-key" | "no-conway-key";
  providers: {
    openai?: { keySource: ValueSource; baseUrl: string; customBaseUrl: boolean; models: string[] };
    anthropic?: { keySource: ValueSource };
    ollama?: { baseUrl: string; source: ValueSource };
    conway?: { keySource: ValueSource; apiUrl: string };
  };
  survival: SurvivalSource;
  /** Standalone: the most the daily AI cap may be. Conway mode: null (never clamped). */
  dailyCapCeilingCents: number | null;
  features: FeatureSet;
  /** The social relay URL in use; "" when the relay is off. */
  relayUrl: string;
  payments: boolean;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** The OpenAI-compatible base URL (no trailing slash). */
export function openaiBaseUrl(config: Pick<AutomatonConfig, "providers">): string {
  const custom = nonEmpty(config.providers?.openai?.baseUrl);
  return custom ? custom.replace(/\/+$/, "") : DEFAULT_OPENAI_BASE_URL;
}

/** Model ids the operator listed for the OpenAI-compatible endpoint. */
export function configuredOpenAiModelIds(config: Pick<AutomatonConfig, "providers">): string[] {
  const models = config.providers?.openai?.models;
  if (!Array.isArray(models)) return [];
  return models.map((m) => (m && typeof m.id === "string" ? m.id.trim() : "")).filter(Boolean);
}

export function resolveRuntime(config: AutomatonConfig): ResolvedRuntime {
  const p = config.providers ?? {};
  const src = configSources(config);
  const conwayKey = nonEmpty(config.conwayApiKey);

  let mode: RuntimeMode;
  let reason: ResolvedRuntime["reason"];
  if (p.mode === "conway" || p.mode === "standalone") {
    mode = p.mode;
    reason = "explicit";
  } else if (conwayKey) {
    mode = "conway";
    reason = "conway-key";
  } else {
    mode = "standalone";
    reason = "no-conway-key";
  }

  const providers: ResolvedRuntime["providers"] = {};
  if (nonEmpty(config.openaiApiKey)) {
    const baseUrl = openaiBaseUrl(config);
    providers.openai = {
      keySource: src.openaiApiKey ?? "flat",
      baseUrl,
      customBaseUrl: baseUrl !== DEFAULT_OPENAI_BASE_URL,
      models: configuredOpenAiModelIds(config),
    };
  }
  if (nonEmpty(config.anthropicApiKey)) providers.anthropic = { keySource: src.anthropicApiKey ?? "flat" };
  const ollama = nonEmpty(config.ollamaBaseUrl);
  if (ollama) providers.ollama = { baseUrl: ollama, source: src.ollamaBaseUrl ?? "flat" };
  if (conwayKey) {
    providers.conway = { keySource: src.conwayApiKey ?? "flat", apiUrl: config.conwayApiUrl };
  }

  const relayUrl = nonEmpty(config.socialRelayUrl) ?? "";
  const payments = mode === "conway" ? true : p.payments === true;
  const ceiling = p.dailyCapCeilingCents;
  return {
    mode,
    reason,
    providers,
    survival: resolveSurvivalSource(config, mode),
    dailyCapCeilingCents:
      mode === "conway"
        ? null
        : typeof ceiling === "number" && Number.isInteger(ceiling) && ceiling >= 0
          ? ceiling
          : DEFAULT_DAILY_CAP_CEILING_CENTS,
    features: mode === "conway" ? { ...ALL_FEATURES } : standaloneFeatures({ relay: relayUrl !== "", payments }),
    relayUrl,
    payments,
  };
}

/** True when some AI provider other than Conway is configured. */
export function hasOwnAiProvider(r: ResolvedRuntime): boolean {
  return !!(r.providers.openai || r.providers.anthropic || r.providers.ollama);
}

const SOURCE_LABELS: Record<keyof ConfigSources, Record<ValueSource, string>> = {
  conwayApiKey: {
    env: "CONWAY_API_KEY",
    providers: "providers.conway.apiKey",
    flat: "automaton.json",
    "config.json": "~/.automaton/config.json",
  },
  conwayApiUrl: { env: "CONWAY_API_URL", providers: "providers.conway.apiUrl", flat: "automaton.json", "config.json": "config.json" },
  openaiApiKey: { env: "OPENAI_API_KEY", providers: "providers.openai.apiKey", flat: "automaton.json", "config.json": "config.json" },
  anthropicApiKey: { env: "env", providers: "providers.anthropic.apiKey", flat: "automaton.json", "config.json": "config.json" },
  ollamaBaseUrl: { env: "OLLAMA_BASE_URL", providers: "providers.ollama.baseUrl", flat: "automaton.json", "config.json": "config.json" },
};

function cents(c: number): string {
  return `${c}c ($${(c / 100).toFixed(2)})`;
}

/**
 * The one startup line: mode, providers (key sources only), survival, cap,
 * relay, payments. `relayLabel` names the relay and its protocol when on.
 */
export function describeRuntime(r: ResolvedRuntime, relayLabel?: string): string {
  const why =
    r.reason === "explicit" ? "set in providers.mode" : r.reason === "conway-key" ? `Conway key from ${SOURCE_LABELS.conwayApiKey[r.providers.conway!.keySource]}` : "no Conway key";
  const parts: string[] = [];
  const { openai, anthropic, ollama, conway } = r.providers;
  if (openai) {
    parts.push(
      `openai (key from ${SOURCE_LABELS.openaiApiKey[openai.keySource]}, ${openai.baseUrl}` +
        `${openai.models.length > 0 ? `, ${openai.models.length} configured model(s)` : ""})`,
    );
  }
  if (anthropic) parts.push(`anthropic (key from ${SOURCE_LABELS.anthropicApiKey[anthropic.keySource]})`);
  if (ollama) parts.push(`ollama (${ollama.baseUrl}, from ${SOURCE_LABELS.ollamaBaseUrl[ollama.source]})`);
  if (conway && r.mode === "conway") parts.push(`conway (${conway.apiUrl})`);
  if (conway && r.mode === "standalone") parts.push("conway key present but unused (providers.mode is standalone)");
  const survival = r.survival.kind === "fixed" ? `fixed (${r.survival.tier})` : "Conway credit balance";
  const cap = r.dailyCapCeilingCents === null ? "from treasuryPolicy" : `at most ${cents(r.dailyCapCeilingCents)}`;
  const relay = r.relayUrl ? relayLabel || r.relayUrl : "off";
  return (
    `Mode: ${r.mode} (${why}). Providers: ${parts.length > 0 ? parts.join(", ") : "none"}. ` +
    `Survival: ${survival}. Daily AI cap: ${cap}. Relay: ${relay}. Payments: ${r.payments ? "on" : "off"}.`
  );
}

// ─── Process-wide runtime (read only by the Conway egress fence) ───

const RUNTIME_KEY = Symbol.for("automaton.runtime");

export function installRuntime(r: ResolvedRuntime | null): void {
  (globalThis as any)[RUNTIME_KEY] = r ?? undefined;
}

/** The installed runtime; null when nothing is installed (embedded use, tests), which counts as Conway. */
export function currentRuntime(): ResolvedRuntime | null {
  return ((globalThis as any)[RUNTIME_KEY] as ResolvedRuntime | undefined) ?? null;
}

/** The error a Conway call would hit in standalone mode, or null when Conway is allowed. */
export function conwayEgressBlocked(what: string): FeatureDisabledError | null {
  return currentRuntime()?.mode === "standalone" ? new FeatureDisabledError(what, "providers.conway.apiKey") : null;
}

/** Throws FeatureDisabledError when the installed runtime is standalone. */
export function assertConwayAllowed(what: string): void {
  const err = conwayEgressBlocked(what);
  if (err) throw err;
}

// ─── The hard money limit ───────────────────────────────────────

export interface ClampResult {
  policy: ResolvedTreasuryPolicy;
  clamped: boolean;
  /** The configured value before the clamp. */
  requestedCents: number;
  ceilingCents: number | null;
}

/**
 * Standalone: force treasuryPolicy.maxInferenceDailyCents under the ceiling,
 * with a loud warning every time it applies. Conway mode is never changed.
 */
export function clampForMode(policy: ResolvedTreasuryPolicy, runtime: ResolvedRuntime): ClampResult {
  const ceiling = runtime.dailyCapCeilingCents;
  const requested = policy.maxInferenceDailyCents;
  if (ceiling === null || requested <= ceiling) {
    return { policy, clamped: false, requestedCents: requested, ceilingCents: ceiling };
  }
  logger.warn(
    [
      "!!! Daily AI cap clamped !!!",
      `!!! treasuryPolicy.maxInferenceDailyCents asks for ${cents(requested)};`,
      `!!! standalone mode allows at most ${cents(ceiling)} (providers.dailyCapCeilingCents).`,
      "!!! Set a spending limit at your AI provider too.",
    ].join("\n"),
  );
  return {
    policy: { ...policy, maxInferenceDailyCents: ceiling },
    clamped: true,
    requestedCents: requested,
    ceilingCents: ceiling,
  };
}
