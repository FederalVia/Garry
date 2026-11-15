/**
 * The provider table: every AI provider this agent may call, in one place,
 * shared by the main loop and orchestration. Built from the config (and the
 * environment for per-provider keys); keys are held in a closure, never in
 * the entries, so logging or serialising the table cannot leak them.
 */

import type { AutomatonConfig, ConfiguredModel, Effort, ModelEntry } from "../types.js";
import { isLoopbackHost } from "../conway/http-client.js";
import { registerSecret } from "../security/secret-redaction.js";
import { createLogger } from "../observability/logger.js";
import {
  configSources,
  openaiBaseUrl,
  resolveRuntime,
  DEFAULT_OPENAI_BASE_URL,
  PROVIDER_ID_PATTERN,
  RESERVED_PROVIDER_IDS,
  providerKeyEnvVar,
  type KeySource,
  type RuntimeMode,
} from "./mode.js";

const logger = createLogger("providers.table");

export type ProviderKind = "openai" | "anthropic" | "ollama" | "conway";

/** Pinned: an Anthropic key is only ever sent here. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export { RESERVED_PROVIDER_IDS, PROVIDER_ID_PATTERN, providerKeyEnvVar };

export type { KeySource };

export interface ProviderEntry {
  /** "openai" | "anthropic" | "ollama" | "conway" | a compatible id. */
  id: string;
  /** Wire protocol; "openai" covers every compatible entry. */
  kind: ProviderKind;
  label: string;
  /**
   * No trailing slash. openai kind: the API root holding /chat/completions
   * and /models (includes /v1). ollama: the server root (the client adds
   * /v1, discovery reads /api/tags). anthropic: the pinned API host.
   */
  baseUrl: string;
  /** Logged; the key never is. */
  keySource: KeySource | null;
  hasKey: boolean;
  loopback: boolean;
  free: boolean;
  discover: boolean;
  allowUnpriced: boolean;
  orchestration: boolean;
  priority: number;
  models: readonly ConfiguredModel[];
  /** models is non-empty and the endpoint is not the built-in default: only these models are served. */
  allowlist: boolean;
  /** Anthropic only. */
  effort?: Effort;
}

export interface ProviderTable {
  readonly mode: RuntimeMode;
  readonly entries: readonly ProviderEntry[];
  get(id: string): ProviderEntry | undefined;
  /** The key for an entry. Held in a closure: not enumerable, never in JSON or logs. */
  key(id: string): string | undefined;
  isFree(id: string): boolean;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function hostLoopback(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function modelList(models: unknown): ConfiguredModel[] {
  if (!Array.isArray(models)) return [];
  return models.filter((m): m is ConfiguredModel => !!m && typeof m.id === "string" && m.id.trim() !== "")
    .map((m) => ({ ...m, id: m.id.trim() }));
}

const warnedLanOllama = new Set<string>();

/**
 * Build the table. `env` supplies OLLAMA_BASE_URL and the per-provider
 * AUTOMATON_PROVIDER_<ID>_API_KEY keys; the rest comes from the loaded config.
 */
export function resolveProviderTable(config: AutomatonConfig, env: NodeJS.ProcessEnv = process.env): ProviderTable {
  const mode = resolveRuntime(config, env).mode;
  const p = config.providers ?? {};
  const src = configSources(config);
  const keys = new Map<string, string>();
  const entries: ProviderEntry[] = [];
  // Built-in entries discover by default only in standalone: a Conway
  // install sends no new requests unless the owner asks.
  const builtinDiscover = (explicit: unknown): boolean =>
    typeof explicit === "boolean" ? explicit : mode === "standalone";

  const openaiKey = nonEmpty(config.openaiApiKey);
  if (openaiKey) {
    const baseUrl = openaiBaseUrl(config);
    const loopback = hostLoopback(baseUrl);
    const models = modelList(p.openai?.models);
    keys.set("openai", openaiKey);
    entries.push({
      id: "openai",
      kind: "openai",
      label: baseUrl === DEFAULT_OPENAI_BASE_URL ? "OpenAI" : "OpenAI-compatible",
      baseUrl,
      keySource: src.openaiApiKey ?? "flat",
      hasKey: true,
      loopback,
      free: loopback && p.openai?.free === true,
      discover: builtinDiscover(p.openai?.discover),
      allowUnpriced: false,
      orchestration: true,
      priority: 1,
      models,
      allowlist: models.length > 0 && baseUrl !== DEFAULT_OPENAI_BASE_URL,
    });
  }

  const anthropicKey = nonEmpty(config.anthropicApiKey);
  if (anthropicKey) {
    keys.set("anthropic", anthropicKey);
    const effort = p.anthropic?.effort;
    entries.push({
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      baseUrl: ANTHROPIC_BASE_URL,
      keySource: src.anthropicApiKey ?? "flat",
      hasKey: true,
      loopback: false,
      free: false,
      discover: builtinDiscover(p.anthropic?.discover),
      allowUnpriced: false,
      orchestration: true,
      priority: 2,
      models: modelList(p.anthropic?.models),
      allowlist: false,
      ...(effort ? { effort } : {}),
    });
  }

  const ollamaUrl = nonEmpty(env.OLLAMA_BASE_URL) ?? nonEmpty(config.ollamaBaseUrl);
  if (ollamaUrl) {
    const baseUrl = ollamaUrl.replace(/\/+$/, "");
    const loopback = hostLoopback(baseUrl);
    if (!loopback && !warnedLanOllama.has(baseUrl)) {
      warnedLanOllama.add(baseUrl);
      logger.warn(
        `Ollama at ${baseUrl} is not on this machine, but its models are still treated as free. ` +
          "If that server costs money, give its models prices through a providers.compatible entry instead.",
      );
    }
    entries.push({
      id: "ollama",
      kind: "ollama",
      label: "Ollama",
      baseUrl,
      keySource: null,
      hasKey: false,
      loopback,
      // Kept for compatibility: Ollama is free on any host.
      free: true,
      discover: builtinDiscover(p.ollama?.discover),
      allowUnpriced: false,
      orchestration: true,
      priority: 10,
      models: [],
      allowlist: false,
    });
  }

  for (const c of Array.isArray(p.compatible) ? p.compatible : []) {
    if (!c || typeof c.id !== "string" || !PROVIDER_ID_PATTERN.test(c.id) || RESERVED_PROVIDER_IDS.has(c.id)) continue;
    if (entries.some((e) => e.id === c.id)) continue;
    const baseUrl = nonEmpty(c.baseUrl)?.replace(/\/+$/, "");
    if (!baseUrl) continue;
    const loopback = hostLoopback(baseUrl);
    const fileKey = nonEmpty(c.apiKey);
    const envKey = nonEmpty(env[providerKeyEnvVar(c.id)]);
    const key = fileKey ?? envKey;
    if (key) {
      keys.set(c.id, key);
      registerSecret(key, `provider-${c.id}-api-key`);
    }
    const models = modelList(c.models);
    entries.push({
      id: c.id,
      kind: "openai",
      label: nonEmpty(c.name) ?? c.id,
      baseUrl,
      keySource: fileKey ? "providers" : envKey ? "provider-env" : null,
      hasKey: !!key,
      loopback,
      free: loopback && c.free === true,
      discover: c.discover !== false,
      allowUnpriced: c.allowUnpriced === true,
      orchestration: c.orchestration !== false,
      priority: typeof c.priority === "number" && Number.isInteger(c.priority) && c.priority >= 0 ? c.priority : 100,
      models,
      allowlist: models.length > 0,
    });
  }

  const conwayKey = nonEmpty(config.conwayApiKey);
  if (mode === "conway" && conwayKey) {
    keys.set("conway", conwayKey);
    entries.push({
      id: "conway",
      kind: "conway",
      label: "Conway",
      baseUrl: (config.conwayApiUrl || "").replace(/\/+$/, ""),
      keySource: src.conwayApiKey ?? "flat",
      hasKey: true,
      loopback: false,
      free: false,
      // Conway's own listing runs from the refresh_models task, as before.
      discover: false,
      allowUnpriced: false,
      orchestration: false,
      priority: 1000,
      models: [],
      allowlist: false,
    });
  }

  const byId = new Map(entries.map((e) => [e.id, Object.freeze({ ...e, models: Object.freeze([...e.models]) })]));
  const frozen = Object.freeze([...byId.values()]);
  return Object.freeze({
    mode,
    entries: frozen,
    get: (id: string) => byId.get(id),
    key: (id: string) => keys.get(id),
    isFree: (id: string) => byId.get(id)?.free === true,
  });
}

/** The table id serving a registry row; legacy rows (no provider_id) map by their provider label. */
export function providerIdForRow(row: { provider: string; providerId?: string | null }): string {
  const explicit = nonEmpty(row.providerId);
  if (explicit) return explicit;
  switch (row.provider) {
    case "openai":
    case "anthropic":
    case "ollama":
      return row.provider;
    default:
      // "conway", "other" and anything else came from Conway's listing.
      return "conway";
  }
}

/** The id an entry knows a row by: remote_id, else the model id without the entry prefix. */
export function remoteIdForRow(row: { modelId: string; remoteId?: string | null }, entryId?: string): string {
  const remote = nonEmpty(row.remoteId);
  if (remote) return remote;
  if (entryId && row.modelId.startsWith(`${entryId}/`)) return row.modelId.slice(entryId.length + 1);
  return row.modelId;
}

/** The registry id for a model of an entry: bare for built-in entries, `<id>/<remote>` for compatible ones. */
export function registryIdFor(entry: Pick<ProviderEntry, "id" | "kind">, remoteId: string): string {
  return isCompatible(entry) ? `${entry.id}/${remoteId}` : remoteId;
}

export function isCompatible(entry: Pick<ProviderEntry, "id" | "kind">): boolean {
  return entry.kind === "openai" && entry.id !== "openai";
}

/** The OpenAI-protocol root of an entry (Ollama serves it under /v1). */
export function openAiProtocolBase(entry: Pick<ProviderEntry, "kind" | "baseUrl">): string {
  return entry.kind === "ollama" ? `${entry.baseUrl}/v1` : entry.baseUrl;
}

type ServeRow = Pick<ModelEntry, "modelId" | "provider"> &
  Partial<Pick<ModelEntry, "enabled" | "listed" | "providerId" | "remoteId">>;

/**
 * Whether the row's provider opted in to serving models with no known price
 * (reserved at the highest known price). One rule for the router and startup.
 */
export function allowsUnpriced(table: ProviderTable, row: { provider: string; providerId?: string | null }): boolean {
  return table.get(providerIdForRow(row))?.allowUnpriced === true;
}

/**
 * The one serve rule: the main client's canServe, list_models, the model
 * picker and orchestration all use it. In Conway mode a row without a
 * provider_id keeps the old rule (a provider key, else Conway).
 */
export function canServeModel(table: ProviderTable, model: ServeRow): boolean {
  if (model.enabled === false || model.listed === false) return false;
  if (table.mode === "conway" && !nonEmpty(model.providerId)) {
    if (model.provider === "ollama") return !!table.get("ollama");
    if (model.provider === "anthropic" && table.get("anthropic")) return true;
    if (model.provider === "openai" && table.get("openai")) return true;
    return !!table.get("conway");
  }
  const id = providerIdForRow(model);
  const entry = table.get(id);
  if (!entry) return false;
  if (entry.kind === "conway") return table.mode === "conway";
  // Ollama needs no key, on any host.
  if (entry.kind !== "ollama" && !entry.hasKey && !entry.loopback) return false;
  if (entry.allowlist) {
    const remote = remoteIdForRow(model, entry.id);
    return entry.models.some((m) => m.id === remote);
  }
  return true;
}

/**
 * Whether the survival fallback picks this row by the old rule (cheapest
 * paid model, no tool or tier-floor check): Conway's own rows in Conway
 * mode, so an install without new settings keeps its old fallback.
 */
export function keepsConwaySurvivalRule(table: ProviderTable, row: Pick<ModelEntry, "providerId">): boolean {
  return table.mode === "conway" && (!nonEmpty(row.providerId) || row.providerId === "conway");
}
