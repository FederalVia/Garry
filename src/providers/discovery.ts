/**
 * Model discovery: read each provider's model list (/v1/models, Anthropic's
 * models endpoint, Ollama's /api/tags) and apply it to the registry.
 *
 * A failed read never touches the registry. Results are cached in KV so a
 * provider is asked at most once a day after a success (once an hour after a
 * failure). Discovery bills nothing, and a key is only ever sent in its own
 * entry's header, to its own base URL.
 */

import crypto from "crypto";
import type { AutomatonDatabase, ModelCapabilities } from "../types.js";
import { isLoopbackHost } from "../conway/http-client.js";
import { createLogger } from "../observability/logger.js";
import { fetchOllamaTags } from "../ollama/discover.js";
import {
  abortableDelay,
  currentCancellationSignal,
  linkedAbortController,
  rethrowIfCancelled,
  throwIfCancelled,
} from "../runtime/cancellation.js";
import type { ModelRegistry } from "../inference/registry.js";
import { ANTHROPIC_BASE_URL, type ProviderEntry, type ProviderTable } from "./table.js";

const logger = createLogger("providers.discovery");

export interface DiscoveredModel {
  remoteId: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  listedPrice?: { inputUsdPerM: number; outputUsdPerM: number; requestFeeUsd?: number };
  capabilities?: Partial<ModelCapabilities>;
  /** false when the listing says the model takes no tools. */
  supportsTools?: boolean;
}

export type DiscoveryResult =
  | {
      ok: true;
      providerId: string;
      models: DiscoveredModel[];
      /** Set by refreshProviderModels once the list is applied. */
      imported?: number;
      unpricedCount?: number;
      unpricedSample?: string[];
    }
  | { ok: false; providerId: string; error: string; status?: number };

/** The KV row model_discovery:<id>. */
export interface DiscoveryStatus {
  ok: boolean;
  /** ms since the epoch of this attempt. */
  at: number;
  count: number;
  error?: string;
  unpricedCount: number;
  unpricedSample: string[];
  /** Hash of kind|baseUrl: a changed URL makes the provider due at once. */
  urlHash: string;
  /** ms since the epoch of the last success, kept across failures. */
  lastSuccessAt?: number;
}

export const DISCOVERY_KV_PREFIX = "model_discovery:";
export const DISCOVERY_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const DISCOVERY_FAILURE_TTL_MS = 60 * 60_000;
export const MAX_DISCOVERY_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_DISCOVERED_MODELS = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const MAX_ANTHROPIC_PAGES = 10;
const MAX_ID_LENGTH = 256;
const ANTHROPIC_VERSION = "2023-06-01";

class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface FetchOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Delay before a retry; tests pass 0. */
  retryDelayMs?: number;
}

function assertAllowedUrl(url: string): void {
  const u = new URL(url);
  if (u.username || u.password) throw new DiscoveryError("base URL carries credentials");
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return;
  throw new DiscoveryError("base URL must be https, or http on loopback");
}

/** Read a body, aborting past the cap. */
async function readCapped(resp: Response, controller: AbortController): Promise<string> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DISCOVERY_BODY_BYTES) {
    controller.abort();
    throw new DiscoveryError(`model list larger than ${MAX_DISCOVERY_BODY_BYTES} bytes`);
  }
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DISCOVERY_BODY_BYTES) {
      controller.abort();
      await reader.cancel().catch(() => {});
      throw new DiscoveryError(`model list larger than ${MAX_DISCOVERY_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * GET with a timeout covering the body, two retries, no redirects, a body cap.
 * A heartbeat task's cancellation aborts the request and the retry wait, and
 * surfaces as the abort itself rather than a provider failure.
 */
async function getJson(url: string, headers: Record<string, string>, opts: FetchOpts): Promise<unknown> {
  assertAllowedUrl(url);
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cancel = currentCancellationSignal();
  let lastError: DiscoveryError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = opts.retryDelayMs ?? 500 * 2 ** (attempt - 1);
      if (delay > 0) {
        if (cancel) await abortableDelay(delay, cancel);
        else await new Promise((r) => setTimeout(r, delay).unref?.());
      }
    }
    throwIfCancelled();
    const link = cancel ? linkedAbortController(cancel) : undefined;
    const controller = link?.controller ?? new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const resp = await doFetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        lastError = new DiscoveryError(`HTTP ${resp.status}`, resp.status);
        if (RETRYABLE.has(resp.status)) continue;
        throw lastError;
      }
      const text = await readCapped(resp, controller);
      try {
        return JSON.parse(text);
      } catch {
        throw new DiscoveryError("model list is not valid JSON");
      }
    } catch (err) {
      rethrowIfCancelled(err);
      if (err instanceof DiscoveryError) {
        if (err.status !== undefined && RETRYABLE.has(err.status)) continue;
        throw err;
      }
      lastError = new DiscoveryError(controller.signal.aborted ? `timed out after ${timeoutMs} ms` : errorText(err));
    } finally {
      clearTimeout(timer);
      link?.release();
    }
  }
  throw lastError ?? new DiscoveryError("request failed");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function validId(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f\s]/.test(v);
}

/** Listed prices below this (USD per 1M) are taken as unpriced. */
export const MIN_LISTED_USD_PER_M = 0.01;

/**
 * Prices a listing reports, in USD per 1M tokens. OpenRouter: pricing.prompt
 * and pricing.completion in USD per token (strings) with pricing.request a
 * per-request fee; Together: pricing.input and pricing.output in USD per 1M;
 * others: input_per_million / output_per_million. Field names do not
 * prove units, so a side below MIN_LISTED_USD_PER_M is dropped.
 */
function parseListedPrice(pricing: unknown): DiscoveredModel["listedPrice"] | undefined {
  if (!pricing || typeof pricing !== "object") return undefined;
  const p = pricing as Record<string, unknown>;
  let input: number | undefined;
  let output: number | undefined;
  if (p.prompt !== undefined || p.completion !== undefined) {
    const i = positiveNumber(p.prompt);
    const o = positiveNumber(p.completion);
    input = i !== undefined ? i * 1_000_000 : undefined;
    output = o !== undefined ? o * 1_000_000 : undefined;
  } else if (p.input_per_million !== undefined || p.output_per_million !== undefined) {
    input = positiveNumber(p.input_per_million);
    output = positiveNumber(p.output_per_million);
  } else {
    input = positiveNumber(p.input);
    output = positiveNumber(p.output);
  }
  // No paid chat model costs under $0.01 per 1M; a smaller figure is a
  // listing in other units (USD per token), so that side counts as unpriced.
  if (input !== undefined && input < MIN_LISTED_USD_PER_M) input = undefined;
  if (output !== undefined && output < MIN_LISTED_USD_PER_M) output = undefined;
  const fee = positiveNumber(p.request);
  if (input === undefined && output === undefined && fee === undefined) return undefined;
  return {
    inputUsdPerM: input ?? 0,
    outputUsdPerM: output ?? 0,
    ...(fee !== undefined ? { requestFeeUsd: fee } : {}),
  };
}

function parseOpenAiModel(raw: unknown): DiscoveredModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, any>;
  if (!validId(m.id)) return null;
  const out: DiscoveredModel = { remoteId: m.id };
  const name = typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : undefined;
  if (name && name.length <= 200) out.displayName = name;
  const ctx = positiveInt(m.context_length) ?? positiveInt(m.context_window) ?? positiveInt(m.max_model_len);
  if (ctx) out.contextWindow = ctx;
  const maxOut = positiveInt(m.top_provider?.max_completion_tokens) ?? positiveInt(m.max_output_tokens);
  if (maxOut) out.maxOutputTokens = maxOut;
  const price = parseListedPrice(m.pricing);
  if (price) out.listedPrice = price;
  if (Array.isArray(m.supported_parameters) && !m.supported_parameters.includes("tools")) out.supportsTools = false;
  return out;
}

function parseAnthropicModel(raw: unknown): DiscoveredModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, any>;
  if (!validId(m.id)) return null;
  const out: DiscoveredModel = { remoteId: m.id };
  if (typeof m.display_name === "string" && m.display_name.length <= 200) out.displayName = m.display_name;
  const ctx = positiveInt(m.max_input_tokens);
  if (ctx) out.contextWindow = ctx;
  const maxOut = positiveInt(m.max_tokens);
  if (maxOut) out.maxOutputTokens = maxOut;
  const caps = m.capabilities;
  if (caps && typeof caps === "object") {
    const c: Partial<ModelCapabilities> = {};
    if (caps.thinking && caps.thinking.supported === false) c.thinking = "none";
    if (caps.effort && typeof caps.effort.supported === "boolean") {
      c.effort = caps.effort.supported;
      if (caps.effort.supported) {
        const levels = (["low", "medium", "high", "xhigh", "max"] as const).filter((l) => caps.effort[l]?.supported === true);
        if (levels.length > 0) c.effortLevels = levels;
      }
    }
    if (Object.keys(c).length > 0) out.capabilities = c;
  }
  return out;
}

function listOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as any).data)) return (data as any).data;
  return null;
}

function tooMany(): DiscoveryError {
  return new DiscoveryError(`more than ${MAX_DISCOVERED_MODELS} models listed`);
}

/** Read one provider's model list. Throws only when its heartbeat task is cancelled. */
export async function discoverProviderModels(
  entry: ProviderEntry,
  key: string | undefined,
  opts: FetchOpts = {},
): Promise<DiscoveryResult> {
  const providerId = entry.id;
  try {
    if (entry.kind === "conway") {
      return { ok: false, providerId, error: "Conway's listing is read through the Conway client" };
    }
    if (entry.kind === "ollama") {
      const read = await fetchOllamaTags(entry.baseUrl, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
      if (!read.ok) return { ok: false, providerId, error: read.error, ...(read.status ? { status: read.status } : {}) };
      return { ok: true, providerId, models: read.names.map((remoteId) => ({ remoteId })) };
    }
    if (entry.kind === "anthropic") {
      if (!key) return { ok: false, providerId, error: "no API key" };
      const headers = { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" };
      const models: DiscoveredModel[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
        const url = `${ANTHROPIC_BASE_URL}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
        const data = (await getJson(url, headers, opts)) as Record<string, unknown>;
        const list = listOf(data);
        if (!list) throw new DiscoveryError("response has no model list");
        for (const raw of list) {
          const m = parseAnthropicModel(raw);
          if (m) models.push(m);
        }
        if (models.length > MAX_DISCOVERED_MODELS) throw tooMany();
        const last = typeof data?.last_id === "string" ? data.last_id : undefined;
        if (data?.has_more !== true || !last || last === after) break;
        after = last;
      }
      return { ok: true, providerId, models };
    }
    // OpenAI and every compatible server.
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const data = await getJson(`${entry.baseUrl}/models`, headers, opts);
    const list = listOf(data);
    if (!list) throw new DiscoveryError("response has no model list");
    if (list.length > MAX_DISCOVERED_MODELS) throw tooMany();
    const models: DiscoveredModel[] = [];
    for (const raw of list) {
      const m = parseOpenAiModel(raw);
      if (m && !models.some((o) => o.remoteId === m.remoteId)) models.push(m);
    }
    return { ok: true, providerId, models };
  } catch (err) {
    rethrowIfCancelled(err);
    const status = err instanceof DiscoveryError ? err.status : undefined;
    return { ok: false, providerId, error: errorText(err), ...(status !== undefined ? { status } : {}) };
  }
}

function urlHash(entry: Pick<ProviderEntry, "kind" | "baseUrl">): string {
  return crypto.createHash("sha256").update(`${entry.kind}|${entry.baseUrl}`).digest("hex").slice(0, 16);
}

/** The stored status of a provider's last discovery, if any. */
export function readDiscoveryStatus(db: Pick<AutomatonDatabase, "getKV">, providerId: string): DiscoveryStatus | undefined {
  const raw = db.getKV(`${DISCOVERY_KV_PREFIX}${providerId}`);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && typeof v.at === "number" ? (v as DiscoveryStatus) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an entry should be asked now. */
export function discoveryDue(entry: ProviderEntry, status: DiscoveryStatus | undefined, now: number): boolean {
  if (!status) return true;
  if (status.urlHash !== urlHash(entry)) return true;
  const age = now - status.at;
  if (age < 0) return true;
  return age >= (status.ok ? DISCOVERY_SUCCESS_TTL_MS : DISCOVERY_FAILURE_TTL_MS);
}

/** Whether a request to this entry could authenticate at all. */
function canAsk(entry: ProviderEntry, key: string | undefined): boolean {
  if (entry.kind === "ollama") return true;
  if (entry.kind === "anthropic") return !!key;
  if (entry.kind === "openai") return !!key || entry.loopback;
  return false;
}

/**
 * Discover every due entry in parallel and apply the results to the
 * registry. Only entries with `discover` are asked (in Conway mode that is
 * compatible entries and entries with discover: true); `force` skips the
 * cache, not `discover`. A failure keeps the known models, unless the
 * entry's base URL changed since the last read: then the rows it discovered
 * are unlisted. Conway's own listing is not read here: the
 * refresh_models task reads it through the Conway client. One provider
 * failing never stops the others.
 */
export async function refreshProviderModels(
  table: ProviderTable,
  registry: Pick<ModelRegistry, "applyDiscovery">,
  db: Pick<AutomatonDatabase, "getKV" | "setKV">,
  opts: { providerIds?: string[]; force?: boolean; now?: () => number } & FetchOpts = {},
): Promise<DiscoveryResult[]> {
  const now = opts.now ?? Date.now;
  const due = table.entries.filter((e) => {
    if (opts.providerIds && !opts.providerIds.includes(e.id)) return false;
    if (!e.discover || e.kind === "conway") return false;
    if (!canAsk(e, table.key(e.id))) return false;
    return opts.force || discoveryDue(e, readDiscoveryStatus(db, e.id), now());
  });
  return Promise.all(
    due.map(async (entry): Promise<DiscoveryResult> => {
      const previous = readDiscoveryStatus(db, entry.id);
      const result = await discoverProviderModels(entry, table.key(entry.id), opts);
      // A cancelled task records nothing: a cut-off read is not the provider's failure.
      throwIfCancelled();
      const base = { at: now(), urlHash: urlHash(entry) };
      if (!result.ok) {
        const why =
          result.status === 401 || result.status === 403 ? `provider ${entry.id} rejected its key` : result.error;
        // Rows listed (and priced) by an earlier endpoint are not offered
        // at the new one until it lists them.
        const moved = previous !== undefined && previous.urlHash !== base.urlHash && entry.kind !== "ollama";
        if (moved) {
          try {
            registry.applyDiscovery(entry, []);
          } catch (err) {
            logger.warn(`Could not unlist ${entry.id}'s models after its base URL changed: ${errorText(err)}`);
          }
        }
        logger.warn(
          `Model discovery for ${entry.id} failed: ${why}. ` +
            (moved ? "Its base URL changed, so the models it listed before are unlisted." : "Keeping the models already known."),
        );
        writeStatus(db, entry.id, {
          ...base,
          ok: false,
          count: previous?.count ?? 0,
          error: why,
          unpricedCount: previous?.unpricedCount ?? 0,
          unpricedSample: previous?.unpricedSample ?? [],
          ...(previous?.lastSuccessAt !== undefined ? { lastSuccessAt: previous.lastSuccessAt } : {}),
        });
        return { ...result, error: why };
      }
      try {
        const applied = registry.applyDiscovery(entry, result.models);
        writeStatus(db, entry.id, {
          ...base,
          ok: true,
          count: result.models.length,
          unpricedCount: applied.unpricedCount,
          unpricedSample: applied.unpricedSample,
          lastSuccessAt: base.at,
        });
        return {
          ...result,
          imported: applied.imported,
          unpricedCount: applied.unpricedCount,
          unpricedSample: applied.unpricedSample,
        };
      } catch (err) {
        const why = `could not store the model list: ${errorText(err)}`;
        logger.warn(`Model discovery for ${entry.id} failed: ${why}`);
        writeStatus(db, entry.id, {
          ...base,
          ok: false,
          count: previous?.count ?? 0,
          error: why,
          unpricedCount: previous?.unpricedCount ?? 0,
          unpricedSample: previous?.unpricedSample ?? [],
        });
        return { ok: false, providerId: entry.id, error: why };
      }
    }),
  );
}

function writeStatus(db: Pick<AutomatonDatabase, "setKV">, providerId: string, status: DiscoveryStatus): void {
  try {
    db.setKV(`${DISCOVERY_KV_PREFIX}${providerId}`, JSON.stringify(status));
  } catch (err) {
    logger.warn(`Could not record model discovery status for ${providerId}: ${errorText(err)}`);
  }
}
