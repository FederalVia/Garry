/**
 * Model Registry
 *
 * DB-backed registry of available models with capabilities and pricing.
 * Seeded from the static baseline and the price table, and updated from each
 * provider's model list (discovery) and Conway's listing.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonConfig, ConfiguredModel, ModelEntry, ModelRegistryRow } from "../types.js";
import { STATIC_MODEL_BASELINE } from "./types.js";
import {
  modelRegistryUpsert,
  modelRegistryGet,
  modelRegistryGetAll,
  modelRegistryGetAvailable,
  modelRegistrySetEnabled,
  modelRegistrySetListed,
  modelRegistryGetOrigin,
  modelRegistryHasOrigin,
  modelRegistryOrigins,
} from "../state/database.js";
import {
  canServeModel,
  isCompatible,
  providerIdForRow,
  registryIdFor,
  type ProviderEntry,
  type ProviderTable,
} from "../providers/table.js";
import { lookupPrice, resolvePrice, seedRows, toRegistryUnits, type PriceRow } from "../providers/price-table.js";
import type { DiscoveredModel } from "../providers/discovery.js";
import { applyOllamaListing } from "../ollama/discover.js";
import { DEFAULT_OPENAI_BASE_URL } from "../providers/mode.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("inference.registry");

/** Seeds Phase 1 created: the old seedProviderModels keeps exactly these. */
const LEGACY_ANTHROPIC_SEEDS = new Set(["claude-sonnet-4-6", "claude-haiku-4-5"]);

/** At most this many unpriced ids are kept as a sample for list_models. */
const UNPRICED_SAMPLE = 5;

export interface ApplyDiscoveryResult {
  imported: number;
  /** Listed models not imported because no price is known (built-in entries only). */
  unpricedCount: number;
  unpricedSample: string[];
  /** Ids skipped because a row of another provider holds them. */
  conflicts: string[];
  /** Rows marked listed = 0. */
  unlisted: string[];
}

type Database = BetterSqlite3.Database;

const TIER_ORDER: Record<string, number> = {
  dead: 0,
  critical: 1,
  low_compute: 2,
  normal: 3,
  high: 4,
};

export class ModelRegistry {
  private db: Database;
  private readonly table?: ProviderTable;
  private readonly config?: AutomatonConfig;
  private readonly warnedConflicts = new Set<string>();

  /**
   * With a table, entries carry `free` from it; without one (heartbeat,
   * tests) a model is free only when it is an Ollama model, as before.
   */
  constructor(db: Database, opts: { table?: ProviderTable; config?: AutomatonConfig } = {}) {
    this.db = db;
    this.table = opts.table;
    this.config = opts.config;
  }

  /**
   * Upsert the static model baseline into the registry on every startup.
   * New models are added, existing models get updated pricing/capabilities,
   * and baseline models removed from the baseline are disabled. Models from
   * the Conway API, Ollama or a manual upsert are left alone, so calling
   * this before refreshFromApi (as refresh_models does) is harmless.
   */
  initialize(): void {
    const now = new Date().toISOString();
    const baselineIds = new Set(STATIC_MODEL_BASELINE.map((m) => m.modelId));

    // Upsert all baseline models
    for (const model of STATIC_MODEL_BASELINE) {
      const existing = modelRegistryGet(this.db, model.modelId);
      const row: ModelRegistryRow = {
        modelId: model.modelId,
        provider: model.provider,
        displayName: model.displayName,
        tierMinimum: model.tierMinimum,
        costPer1kInput: model.costPer1kInput,
        costPer1kOutput: model.costPer1kOutput,
        maxTokens: model.maxTokens,
        contextWindow: model.contextWindow,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        parameterStyle: model.parameterStyle,
        enabled: existing?.enabled ?? true,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        priceSource: "baseline",
      };
      modelRegistryUpsert(this.db, row, "baseline");
    }

    // Disable baseline models that left the baseline (e.g., removed Anthropic
    // models). Discovered models (API, Ollama, manual) manage their own
    // lifecycle. Without the origin column (pre-15 schema) every non-local
    // row counts as baseline, as before.
    const hasOrigin = modelRegistryHasOrigin(this.db);
    const allModels = modelRegistryGetAll(this.db);
    for (const existing of allModels) {
      if (baselineIds.has(existing.modelId) || !existing.enabled) continue;
      if (existing.provider === "ollama" || existing.provider === "other") continue;
      const origin = hasOrigin ? modelRegistryGetOrigin(this.db, existing.modelId) : "baseline";
      if (origin === "baseline") {
        modelRegistrySetEnabled(this.db, existing.modelId, false);
      }
    }
  }

  /**
   * Seed the Phase 1 Anthropic rows (Claude Sonnet 4.6 and Haiku 4.5) from
   * the price table. Kept for callers that do not have a provider table yet;
   * seedFromPriceTable seeds the current models too.
   */
  seedProviderModels(providers: readonly "anthropic"[]): void {
    if (!providers.includes("anthropic")) return;
    for (const seed of seedRows("anthropic")) {
      if (!LEGACY_ANTHROPIC_SEEDS.has(seed.id)) continue;
      this.upsertSeed({ id: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" }, seed, this.table);
    }
  }

  /**
   * Standalone: for each configured Anthropic or OpenAI entry, upsert its
   * seed rows from the price table ('manual' origin, enabled, which also
   * re-enables retired baseline rows), then every entry's owner models.
   * Conway mode seeds nothing new for the built-in providers (a Conway
   * install behaves as before); only compatible entries' owner models.
   */
  seedFromPriceTable(table: ProviderTable): void {
    for (const entry of table.entries) {
      if (table.mode === "standalone" && (entry.kind === "anthropic" || entry.id === "openai")) {
        const seeds = seedRows(entry.kind === "anthropic" ? "anthropic" : "openai");
        for (const seed of seeds) {
          if (entry.allowlist && !entry.models.some((m) => m.id === seed.id)) continue;
          if (lookupPrice(entry, seed.id) !== seed) continue;
          this.upsertSeed(entry, seed, table);
        }
      }
      if (table.mode === "standalone" || isCompatible(entry)) this.upsertOwnerModels(entry, table);
    }
  }

  private upsertSeed(entry: Pick<ProviderEntry, "id" | "kind" | "baseUrl">, seed: PriceRow, table?: ProviderTable): void {
    const stored = modelRegistryGet(this.db, seed.id);
    if (stored && this.heldByOther(stored, entry.id, table)) {
      this.warnConflict(entry.id, seed.id, stored);
      return;
    }
    const existing = stored && this.ownedBy(stored, entry.id) ? stored : undefined;
    const now = new Date().toISOString();
    modelRegistryUpsert(
      this.db,
      {
        modelId: seed.id,
        provider: entry.kind === "anthropic" ? "anthropic" : "openai",
        displayName: seed.displayName ?? seed.id,
        tierMinimum: seed.tierMinimum,
        costPer1kInput: toRegistryUnits(seed.inputUsdPerM),
        costPer1kOutput: toRegistryUnits(seed.outputUsdPerM),
        maxTokens: seed.maxOutputTokens ?? existing?.maxTokens ?? 8192,
        contextWindow: seed.contextWindow ?? existing?.contextWindow ?? 200000,
        supportsTools: true,
        supportsVision: true,
        parameterStyle: entry.kind === "anthropic" ? "max_tokens" : "max_completion_tokens",
        enabled: true,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        providerId: entry.id,
        remoteId: seed.id,
        listed: true,
        priceSource: "table",
        capabilities: seed.capabilities ?? null,
      },
      "manual",
    );
  }

  /**
   * Upsert an entry's owner models (its config models[]), priced by the
   * owner, else by the table; an unpriced row stays unpriced and the router
   * skips it. Compatible entries get qualified ids (<entry>/<model>).
   */
  upsertOwnerModels(entry: ProviderEntry, providers: ProviderTable | undefined = this.table): void {
    const now = new Date().toISOString();
    for (const m of entry.models) {
      const remoteId = typeof m?.id === "string" ? m.id.trim() : "";
      if (!remoteId) continue;
      const id = registryIdFor(entry, remoteId);
      const stored = modelRegistryGet(this.db, id);
      if (stored && this.heldByOther(stored, entry.id, providers)) {
        this.warnConflict(entry.id, id, stored);
        continue;
      }
      const existing = stored && this.ownedBy(stored, entry.id) ? stored : undefined;
      const table = lookupPrice(entry, remoteId);
      const price = resolvePrice({ owner: m, table, label: `${entry.id}/${remoteId}` });
      modelRegistryUpsert(
        this.db,
        {
          modelId: id,
          provider: entry.kind === "anthropic" ? "anthropic" : "openai",
          displayName: table?.displayName ?? existing?.displayName ?? remoteId,
          tierMinimum: m.tierMinimum ?? table?.tierMinimum ?? "normal",
          costPer1kInput: price ? toRegistryUnits(price.inputUsdPerM) : 0,
          costPer1kOutput: price ? toRegistryUnits(price.outputUsdPerM) : 0,
          maxTokens: existing?.maxTokens ?? table?.maxOutputTokens ?? 4096,
          contextWindow: existing?.contextWindow ?? table?.contextWindow ?? 128000,
          supportsTools: true,
          supportsVision: existing?.supportsVision ?? false,
          parameterStyle: this.parameterStyleFor(entry),
          enabled: true,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
          providerId: entry.id,
          remoteId,
          listed: true,
          priceSource: price?.source ?? null,
          capabilities: table?.capabilities ?? existing?.capabilities ?? null,
        },
        "manual",
      );
    }
  }

  /**
   * Upsert the models listed for an OpenAI-compatible endpoint
   * (providers.openai.models) as provider "openai", priced from the config.
   * An unpriced row stays unpriced: the router skips it, since its spend
   * cannot be capped.
   */
  upsertConfiguredModels(models: readonly ConfiguredModel[]): void {
    const now = new Date().toISOString();
    for (const m of models) {
      const id = typeof m?.id === "string" ? m.id.trim() : "";
      if (!id) continue;
      const existing = modelRegistryGet(this.db, id);
      const price = (usdPerM: unknown) =>
        typeof usdPerM === "number" && Number.isFinite(usdPerM) && usdPerM >= 0 ? usdPerM * 10 : 0;
      const input = price(m.inputUsdPerM);
      const output = price(m.outputUsdPerM);
      modelRegistryUpsert(
        this.db,
        {
          modelId: id,
          provider: "openai",
          displayName: id,
          tierMinimum: m.tierMinimum ?? "normal",
          costPer1kInput: input,
          costPer1kOutput: output,
          maxTokens: existing?.maxTokens ?? 4096,
          contextWindow: existing?.contextWindow ?? 128000,
          supportsTools: true,
          supportsVision: false,
          parameterStyle: "max_tokens",
          enabled: true,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
          providerId: "openai",
          remoteId: id,
          listed: true,
          priceSource: input > 0 && output > 0 ? "owner" : null,
        },
        "manual",
      );
    }
  }

  /**
   * Apply one provider's model list. Never touches a row of another
   * provider; built-in OpenAI and Anthropic import only priced models; an
   * allowlist entry updates only its listed models. Discovered rows this
   * provider no longer lists are unlisted (seeded and owner rows never are),
   * and come back listed when the provider lists them again. An owner's
   * disable is never undone.
   */
  applyDiscovery(entry: ProviderEntry, models: readonly DiscoveredModel[]): ApplyDiscoveryResult {
    const result: ApplyDiscoveryResult = { imported: 0, unpricedCount: 0, unpricedSample: [], conflicts: [], unlisted: [] };
    if (entry.kind === "ollama") {
      const r = applyOllamaListing(this.db, models.map((m) => m.remoteId));
      return { ...result, imported: r.registered.length, conflicts: r.conflicts, unlisted: r.unlisted };
    }
    if (entry.kind === "conway") return result;

    const builtin = !isCompatible(entry);
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const write = this.db.transaction(() => {
      for (const m of models) {
        const remoteId = m.remoteId;
        if (seen.has(registryIdFor(entry, remoteId))) continue;
        if (entry.allowlist && !entry.models.some((o) => o.id === remoteId)) continue;
        const id = registryIdFor(entry, remoteId);
        const stored = modelRegistryGet(this.db, id);
        if (stored && this.heldByOther(stored, entry.id, this.table)) {
          result.conflicts.push(id);
          this.warnConflict(entry.id, id, stored);
          continue;
        }
        // A row left by a provider no longer configured is taken over as new.
        const takeover = !!stored && !this.ownedBy(stored, entry.id);
        const existing = takeover ? undefined : stored;
        const owner = entry.models.find((o) => o.id === remoteId);
        const table = lookupPrice(entry, remoteId);
        const price = resolvePrice({ owner, listed: m.listedPrice, table, label: `${entry.id}/${remoteId}` });
        if (!price && builtin && !entry.free) {
          result.unpricedCount++;
          if (result.unpricedSample.length < UNPRICED_SAMPLE) result.unpricedSample.push(remoteId);
          // A row we hold from earlier stays (and counts as listed).
          if (existing) seen.add(id);
          continue;
        }
        seen.add(id);
        const capabilities = { ...(table?.capabilities ?? {}), ...(m.capabilities ?? {}) };
        modelRegistryUpsert(
          this.db,
          {
            modelId: id,
            provider: entry.kind === "anthropic" ? "anthropic" : "openai",
            displayName: m.displayName ?? existing?.displayName ?? table?.displayName ?? remoteId,
            tierMinimum: owner?.tierMinimum ?? existing?.tierMinimum ?? table?.tierMinimum ?? "normal",
            costPer1kInput: price ? toRegistryUnits(price.inputUsdPerM) : 0,
            costPer1kOutput: price ? toRegistryUnits(price.outputUsdPerM) : 0,
            maxTokens: m.maxOutputTokens ?? existing?.maxTokens ?? table?.maxOutputTokens ?? 4096,
            contextWindow: m.contextWindow ?? table?.contextWindow ?? existing?.contextWindow ?? 128000,
            supportsTools: m.supportsTools ?? existing?.supportsTools ?? true,
            supportsVision: existing?.supportsVision ?? false,
            parameterStyle: existing?.parameterStyle ?? this.parameterStyleFor(entry),
            enabled: existing?.enabled ?? true,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            providerId: entry.id,
            remoteId,
            listed: true,
            priceSource: price?.source ?? null,
            capabilities: Object.keys(capabilities).length > 0 ? capabilities : null,
          },
          existing ? undefined : "api",
        );
        if (takeover) logger.info(`Model ${id} now served by ${entry.id}: ${providerIdForRow(stored!)} is no longer configured.`);
        result.imported++;
      }
      // Reconcile: only rows this provider discovered ('api') are unlisted.
      const origins = modelRegistryOrigins(this.db);
      for (const row of modelRegistryGetAll(this.db)) {
        if (!this.ownedBy(row, entry.id)) continue;
        const origin = origins.get(row.modelId);
        if (origin !== "api") continue;
        if (!seen.has(row.modelId) && row.listed !== false) {
          modelRegistrySetListed(this.db, row.modelId, false);
          result.unlisted.push(row.modelId);
        }
      }
    });
    write();
    return result;
  }

  /**
   * The most expensive priced, enabled, listed row a configured provider
   * can serve, in USD per 1M tokens (per side). Free rows do not count.
   */
  maxListedPrice(): { inputUsdPerM: number; outputUsdPerM: number } {
    let input = 0;
    let output = 0;
    for (const m of this.getAll()) {
      if (!m.enabled || m.listed === false || m.free) continue;
      if (!(m.costPer1kInput > 0 && m.costPer1kOutput > 0)) continue;
      if (this.table && !canServeModel(this.table, m)) continue;
      input = Math.max(input, m.costPer1kInput / 10);
      output = Math.max(output, m.costPer1kOutput / 10);
    }
    return { inputUsdPerM: input, outputUsdPerM: output };
  }

  private ownedBy(row: Pick<ModelRegistryRow, "provider" | "providerId">, entryId: string): boolean {
    return providerIdForRow(row) === entryId;
  }

  /**
   * Another provider holds the row and is still configured. A row whose
   * provider left the table (a key removed) blocks nothing: otherwise a
   * model once listed on a proxy would shadow the real provider's seed.
   * Without a table every foreign row counts, as before.
   */
  private heldByOther(row: Pick<ModelRegistryRow, "provider" | "providerId">, entryId: string, table?: ProviderTable): boolean {
    if (this.ownedBy(row, entryId)) return false;
    return table ? table.get(providerIdForRow(row)) !== undefined : true;
  }

  private warnConflict(entryId: string, id: string, existing: Pick<ModelRegistryRow, "provider" | "providerId">): void {
    const key = `${entryId}:${id}`;
    if (this.warnedConflicts.has(key)) return;
    this.warnedConflicts.add(key);
    logger.warn(`Model ${id} from ${entryId} skipped: the registry already holds it for ${providerIdForRow(existing)}.`);
  }

  private parameterStyleFor(entry: Pick<ProviderEntry, "id" | "baseUrl">): ModelEntry["parameterStyle"] {
    // OpenAI's own endpoint wants max_completion_tokens on current models.
    return entry.id === "openai" && entry.baseUrl === DEFAULT_OPENAI_BASE_URL ? "max_completion_tokens" : "max_tokens";
  }

  /**
   * Get a single model by ID.
   */
  get(modelId: string): ModelEntry | undefined {
    const row = modelRegistryGet(this.db, modelId);
    return row ? this.rowToEntry(row) : undefined;
  }

  /**
   * Get all registered models.
   */
  getAll(): ModelEntry[] {
    return modelRegistryGetAll(this.db).map((r) => this.rowToEntry(r));
  }

  /**
   * Get available (enabled) models, optionally filtering by tier minimum.
   */
  getAvailable(tierMinimum?: string): ModelEntry[] {
    return modelRegistryGetAvailable(this.db, tierMinimum).map((r) => this.rowToEntry(r));
  }

  /**
   * Insert or update a model entry.
   */
  upsert(entry: ModelEntry): void {
    const row: ModelRegistryRow = {
      modelId: entry.modelId,
      provider: entry.provider,
      displayName: entry.displayName,
      tierMinimum: entry.tierMinimum,
      costPer1kInput: entry.costPer1kInput,
      costPer1kOutput: entry.costPer1kOutput,
      maxTokens: entry.maxTokens,
      contextWindow: entry.contextWindow,
      supportsTools: entry.supportsTools,
      supportsVision: entry.supportsVision,
      parameterStyle: entry.parameterStyle,
      enabled: entry.enabled,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      providerId: entry.providerId,
      remoteId: entry.remoteId,
      listed: entry.listed,
      priceSource: entry.priceSource,
      capabilities: entry.capabilities,
    };
    // A new row added by hand is 'manual'; an existing row keeps its origin.
    const exists = modelRegistryGet(this.db, entry.modelId) !== undefined;
    modelRegistryUpsert(this.db, row, exists ? undefined : "manual");
  }

  /**
   * Enable or disable a model.
   */
  setEnabled(modelId: string, enabled: boolean): void {
    modelRegistrySetEnabled(this.db, modelId, enabled);
  }

  /**
   * Refresh the registry from Conway's /v1/models listing. A model is
   * labelled by the listing (provider or owned_by), else "other", never
   * "conway"; an unlabelled one is pinned to Conway with provider_id
   * "conway". Rows labelled openai or anthropic keep a NULL provider_id, so
   * a Conway install routes them exactly as before. Rows another provider's
   * discovery owns are left alone.
   */
  refreshFromApi(models: any[]): void {
    const now = new Date().toISOString();
    for (const m of models) {
      if (!m || typeof m.id !== "string" || m.id === "") continue;
      const existing = modelRegistryGet(this.db, m.id);
      if (existing?.providerId && existing.providerId !== "conway") continue;
      const listedLabel = typeof m.provider === "string" && m.provider ? m.provider : typeof m.owned_by === "string" && m.owned_by ? m.owned_by : "";
      const label = listedLabel && listedLabel !== "conway" ? listedLabel : "other";
      const pinned = label !== "openai" && label !== "anthropic" && label !== "ollama";
      const input = listedPrice(m, "input");
      const output = listedPrice(m, "output");
      const row: ModelRegistryRow = {
        modelId: m.id,
        provider: label,
        displayName: m.display_name || m.id,
        tierMinimum: existing?.tierMinimum || "normal",
        costPer1kInput: input ?? existing?.costPer1kInput ?? 0,
        costPer1kOutput: output ?? existing?.costPer1kOutput ?? 0,
        maxTokens: m.max_tokens ?? existing?.maxTokens ?? 4096,
        contextWindow: m.context_window ?? existing?.contextWindow ?? 128000,
        supportsTools: m.supports_tools ?? existing?.supportsTools ?? true,
        supportsVision: m.supports_vision ?? existing?.supportsVision ?? false,
        parameterStyle: m.parameter_style ?? existing?.parameterStyle ?? "max_tokens",
        enabled: existing?.enabled ?? true,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        ...(pinned ? { providerId: "conway" } : {}),
        ...(input !== undefined && output !== undefined ? { priceSource: "conway" as const } : {}),
        listed: true,
      };
      // New rows are 'api'; an existing row (baseline included) keeps its origin.
      modelRegistryUpsert(this.db, row, existing ? undefined : "api");
    }
  }

  /**
   * Get cost per 1k tokens for a model.
   */
  getCostPer1k(modelId: string): { input: number; output: number } {
    const entry = this.get(modelId);
    if (!entry) return { input: 0, output: 0 };
    return { input: entry.costPer1kInput, output: entry.costPer1kOutput };
  }

  private rowToEntry(row: ModelRegistryRow): ModelEntry {
    return {
      modelId: row.modelId,
      provider: row.provider as ModelEntry["provider"],
      displayName: row.displayName,
      tierMinimum: row.tierMinimum as ModelEntry["tierMinimum"],
      costPer1kInput: row.costPer1kInput,
      costPer1kOutput: row.costPer1kOutput,
      maxTokens: row.maxTokens,
      contextWindow: row.contextWindow,
      supportsTools: row.supportsTools,
      supportsVision: row.supportsVision,
      parameterStyle: row.parameterStyle as ModelEntry["parameterStyle"],
      enabled: row.enabled,
      lastSeen: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.providerId !== undefined ? { providerId: row.providerId } : {}),
      ...(row.remoteId !== undefined ? { remoteId: row.remoteId } : {}),
      ...(row.listed !== undefined ? { listed: row.listed } : {}),
      ...(row.priceSource !== undefined ? { priceSource: row.priceSource } : {}),
      ...(row.capabilities !== undefined ? { capabilities: row.capabilities } : {}),
      ...(this.table ? { free: this.isFree(row) } : {}),
    };
  }

  /** Free per the table; a row whose provider is not configured keeps the old Ollama rule. */
  private isFree(row: Pick<ModelRegistryRow, "provider" | "providerId">): boolean {
    const entry = this.table?.get(providerIdForRow(row));
    return entry ? entry.free : row.provider === "ollama";
  }
}

/**
 * A listed price in registry units (hundredths of a cent per 1k tokens,
 * which is USD per 1M x 10). listModels reports USD per 1M; a zero or
 * missing price is treated as unknown so a known price is not overwritten.
 */
function listedPrice(m: any, side: "input" | "output"): number | undefined {
  const perMillion = Number(m?.pricing?.[`${side}PerMillion`] ?? m?.pricing?.[`${side}_per_million`]);
  if (Number.isFinite(perMillion) && perMillion > 0) return perMillion * 10;
  const per1k = Number(m?.pricing?.[`${side}_per_1k`]);
  if (Number.isFinite(per1k) && per1k > 0) return per1k;
  return undefined;
}
