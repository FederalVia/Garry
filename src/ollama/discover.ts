/**
 * Ollama Model Discovery
 *
 * Fetches available models from a local Ollama instance and registers
 * them in the model registry so they can be used for inference.
 */

import type BetterSqlite3 from "better-sqlite3";
import {
  modelRegistryUpsert,
  modelRegistryGet,
  modelRegistryGetAll,
  modelRegistryOrigins,
  modelRegistrySetListed,
} from "../state/database.js";
import type { ModelRegistryRow } from "../types.js";
import { providerIdForRow } from "../providers/table.js";
import { createLogger } from "../observability/logger.js";
import { currentCancellationSignal, mergeSignals, rethrowIfCancelled } from "../runtime/cancellation.js";

const logger = createLogger("ollama");

interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

/** At most this many models are read from one server. */
const MAX_OLLAMA_MODELS = 2000;

export type OllamaTagsResult = { ok: true; names: string[] } | { ok: false; error: string; status?: number };

/** Read the model names from Ollama's /api/tags. Throws only when its heartbeat task is cancelled. */
export async function fetchOllamaTags(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OllamaTagsResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
  const doFetch = opts.fetchImpl ?? fetch;
  let data: OllamaTagsResponse;
  try {
    const signal = mergeSignals(AbortSignal.timeout(opts.timeoutMs ?? 5_000), currentCancellationSignal());
    const resp = await doFetch(url, { signal, redirect: "manual" });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      return { ok: false, error: `Ollama /api/tags returned ${resp.status}`, status: resp.status };
    }
    data = (await resp.json()) as OllamaTagsResponse;
  } catch (err: any) {
    rethrowIfCancelled(err);
    return { ok: false, error: `Ollama not reachable at ${baseUrl}: ${err?.message ?? String(err)}` };
  }
  if (!data || !Array.isArray(data.models)) return { ok: false, error: "Ollama /api/tags response has no models array" };
  if (data.models.length > MAX_OLLAMA_MODELS) return { ok: false, error: `Ollama lists more than ${MAX_OLLAMA_MODELS} models` };
  const names: string[] = [];
  for (const m of data.models) {
    const id = m && (typeof m.name === "string" && m.name ? m.name : typeof m.model === "string" ? m.model : "");
    if (id && !names.includes(id)) names.push(id);
  }
  return { ok: true, names };
}

/**
 * Write a successful /api/tags read: upsert each model as a free Ollama row
 * (provider_id "ollama"), skipping ids another provider holds, and unlist
 * Ollama rows the server no longer has. Returns what changed.
 */
export function applyOllamaListing(
  db: BetterSqlite3.Database,
  names: readonly string[],
): { registered: string[]; conflicts: string[]; unlisted: string[] } {
  const now = new Date().toISOString();
  const registered: string[] = [];
  const conflicts: string[] = [];
  const unlisted: string[] = [];
  const seen = new Set<string>();
  db.transaction(() => {
    for (const modelId of names) {
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      const existing = modelRegistryGet(db, modelId);
      if (existing && providerIdForRow(existing) !== "ollama") {
        conflicts.push(modelId);
        continue;
      }
      const row: ModelRegistryRow = {
        modelId,
        provider: "ollama",
        displayName: formatDisplayName(modelId),
        // Ollama models are local — no cost
        tierMinimum: existing?.tierMinimum ?? "critical",
        costPer1kInput: 0,
        costPer1kOutput: 0,
        maxTokens: existing?.maxTokens ?? 4096,
        contextWindow: existing?.contextWindow ?? 8192,
        // Most modern Ollama models support tools; default true
        supportsTools: existing?.supportsTools ?? true,
        supportsVision: existing?.supportsVision ?? false,
        parameterStyle: "max_tokens",
        enabled: existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        providerId: "ollama",
        remoteId: modelId,
        listed: true,
        priceSource: null,
      };
      modelRegistryUpsert(db, row, "ollama");
      registered.push(modelId);
    }
    const origins = modelRegistryOrigins(db);
    for (const row of modelRegistryGetAll(db)) {
      if (seen.has(row.modelId) || row.listed === false) continue;
      if (origins.get(row.modelId) !== "ollama" || providerIdForRow(row) !== "ollama") continue;
      modelRegistrySetListed(db, row.modelId, false);
      unlisted.push(row.modelId);
    }
  })();
  if (conflicts.length > 0) {
    logger.warn(`Ollama: skipped ${conflicts.join(", ")}: another provider's model has the same id.`);
  }
  return { registered, conflicts, unlisted };
}

/**
 * Fetch all available models from Ollama's /api/tags endpoint
 * and upsert them into the model registry.
 *
 * Returns the list of discovered model IDs, or an empty array if
 * Ollama is unreachable (treated as a soft failure).
 */
export async function discoverOllamaModels(
  baseUrl: string,
  db: BetterSqlite3.Database,
): Promise<string[]> {
  const read = await fetchOllamaTags(baseUrl);
  if (!read.ok) {
    logger.warn(`${read.error} — skipping discovery`);
    return [];
  }
  const { registered } = applyOllamaListing(db, read.names);
  if (registered.length > 0) {
    logger.info(`Ollama: registered ${registered.length} model(s): ${registered.join(", ")}`);
  }
  return registered;
}

function formatDisplayName(modelId: string): string {
  // "llama3.2:latest" → "Llama 3.2 (latest)"
  const [name, tag] = modelId.split(":");
  const pretty = name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return tag && tag !== "latest" ? `${pretty} (${tag})` : pretty;
}
