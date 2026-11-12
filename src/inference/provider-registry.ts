import path from "node:path";
import OpenAI from "openai";
import { readRegularFileNoFollow } from "../security/secure-fs.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("inference.providers");

export type ModelTier = "reasoning" | "fast" | "cheap";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  models: ModelConfig[];
  maxRequestsPerMinute: number;
  maxTokensPerMinute: number;
  priority: number;
  enabled: boolean;
}

export interface ModelConfig {
  id: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
}

export interface ResolvedModel {
  provider: ProviderConfig;
  model: ModelConfig;
  client: OpenAI;
}

interface TierDefault {
  preferredProvider: string;
  fallbackOrder: string[];
}

interface ProviderDisablement {
  reason: string;
  disabledUntil: number;
}

interface ProviderConfigFile {
  providers?: unknown;
  tierDefaults?: Partial<Record<ModelTier, Partial<TierDefault>>>;
  globalRateLimits?: {
    /** Deprecated: survival-tier pausing in the inference gate replaces it. */
    emergencyStopCredits?: number;
  };
}

/** SDK-level timeout; callers also pass a per-attempt timeout and signal. */
export const PROVIDER_CLIENT_TIMEOUT_MS = 120_000;

const DEFAULT_TIER_DEFAULTS: Record<ModelTier, TierDefault> = {
  reasoning: {
    preferredProvider: "openai",
    fallbackOrder: ["groq", "together"],
  },
  fast: {
    preferredProvider: "groq",
    fallbackOrder: ["openai", "together", "local"],
  },
  cheap: {
    preferredProvider: "groq",
    fallbackOrder: ["together", "local", "openai"],
  },
};

// Prices are USD per 1M tokens at the providers' public list prices, rounded
// up. The gate caps spend with them, so a stale low price lets real spend
// exceed every cap; provider-registry.test.ts pins each one.
const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    models: [
      {
        id: "gpt-4.1",
        tier: "reasoning",
        contextWindow: 128000,
        maxOutputTokens: 32768,
        costPerInputToken: 2.0,
        costPerOutputToken: 8.0,
        supportsTools: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: "gpt-4.1-mini",
        tier: "fast",
        contextWindow: 128000,
        maxOutputTokens: 16384,
        costPerInputToken: 0.4,
        costPerOutputToken: 1.6,
        supportsTools: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: "gpt-4.1-nano",
        tier: "cheap",
        contextWindow: 128000,
        maxOutputTokens: 16384,
        costPerInputToken: 0.1,
        costPerOutputToken: 0.4,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 500,
    maxTokensPerMinute: 2_000_000,
    priority: 1,
    enabled: true,
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    models: [
      {
        id: "llama-3.3-70b-versatile",
        tier: "reasoning",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0.59,
        costPerOutputToken: 0.79,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "llama-3.3-70b-versatile",
        tier: "fast",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0.59,
        costPerOutputToken: 0.79,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "llama-3.1-8b-instant",
        tier: "cheap",
        contextWindow: 131072,
        maxOutputTokens: 4096,
        costPerInputToken: 0.05,
        costPerOutputToken: 0.08,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 14400,
    maxTokensPerMinute: 500000,
    priority: 2,
    enabled: true,
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnvVar: "TOGETHER_API_KEY",
    models: [
      {
        id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        tier: "reasoning",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0.88,
        costPerOutputToken: 0.88,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        tier: "fast",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0.88,
        costPerOutputToken: 0.88,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
        tier: "cheap",
        contextWindow: 131072,
        maxOutputTokens: 4096,
        costPerInputToken: 0.18,
        costPerOutputToken: 0.18,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 600,
    maxTokensPerMinute: 1_000_000,
    priority: 3,
    enabled: false,
  },
  {
    id: "local",
    name: "Local (Ollama/vLLM)",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnvVar: "LOCAL_API_KEY",
    models: [
      {
        id: "llama3.3:70b",
        tier: "fast",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "llama3.1:8b",
        tier: "cheap",
        contextWindow: 131072,
        maxOutputTokens: 4096,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 100,
    maxTokensPerMinute: 200000,
    priority: 10,
    enabled: false,
  },
];

/**
 * Known providers keep their endpoint and key variable whatever the config
 * file says: the file is not trusted to redirect a credential elsewhere.
 */
const KNOWN_PROVIDER_PINS: Record<string, { baseUrl: string; apiKeyEnvVar: string }> = Object.fromEntries(
  DEFAULT_PROVIDERS.map((p) => [p.id, { baseUrl: p.baseUrl, apiKeyEnvVar: p.apiKeyEnvVar }]),
);

/** Credentials the runtime itself holds; never handed to a configured provider. */
const RESERVED_KEY_VARS = new Set([
  "CONWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
]);

/** Operator opt-in (process environment) before unknown provider ids are honoured. */
export const CUSTOM_PROVIDERS_ENV = "AUTOMATON_ALLOW_CUSTOM_PROVIDERS";
const CUSTOM_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PROVIDER_CONFIG_BYTES = 256 * 1024;

/** Env var an unknown provider must use: a dedicated prefix, so it can never name an operator key. */
export function customProviderKeyEnvVar(id: string): string {
  return `AUTOMATON_PROVIDER_${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** https with no userinfo, or http on loopback. */
function isAcceptableBaseUrl(raw: unknown, allowLoopbackHttp: boolean, requireLoopback = false): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const loopback = isLoopbackHost(url.hostname);
  if (requireLoopback && !loopback) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && allowLoopbackHttp && loopback;
}

/**
 * True for the built-in "local" provider on a loopback address. Only such a
 * provider is free; a zero price anywhere else is treated as unknown.
 */
export function isLocalProvider(provider: Pick<ProviderConfig, "id" | "baseUrl">): boolean {
  if (provider.id !== "local") return false;
  try {
    return isLoopbackHost(new URL(provider.baseUrl).hostname);
  } catch {
    return false;
  }
}

export class ProviderRegistry {
  private readonly providers: ProviderConfig[];
  private readonly tierDefaults: Record<ModelTier, TierDefault>;
  private readonly disablements = new Map<string, ProviderDisablement>();

  constructor(
    providers: ProviderConfig[],
    tierDefaults: Record<ModelTier, TierDefault> = DEFAULT_TIER_DEFAULTS,
  ) {
    this.providers = providers
      .map((provider) => deepCloneProvider(provider))
      .sort((a, b) => a.priority - b.priority);
    this.tierDefaults = {
      reasoning: normalizeTierDefault(tierDefaults.reasoning, DEFAULT_TIER_DEFAULTS.reasoning),
      fast: normalizeTierDefault(tierDefaults.fast, DEFAULT_TIER_DEFAULTS.fast),
      cheap: normalizeTierDefault(tierDefaults.cheap, DEFAULT_TIER_DEFAULTS.cheap),
    };
  }

  overrideBaseUrl(providerId: string, baseUrl: string): void {
    const provider = this.providers.find((p) => p.id === providerId);
    if (provider) {
      provider.baseUrl = baseUrl;
    }
  }

  static fromConfig(configPath: string): ProviderRegistry {
    let providers = DEFAULT_PROVIDERS.map((provider) => deepCloneProvider(provider));
    let tierDefaults = DEFAULT_TIER_DEFAULTS;

    // No-follow read: a link or hard link at the config path is ignored.
    const text = readRegularFileNoFollow(configPath, {
      root: path.dirname(path.resolve(configPath)),
      maxBytes: MAX_PROVIDER_CONFIG_BYTES,
    });
    if (text === null) {
      return new ProviderRegistry(providers, tierDefaults);
    }

    try {
      const raw = JSON.parse(text) as ProviderConfigFile;
      const configuredProviders = normalizeProviders(raw.providers);
      if (configuredProviders.length > 0) {
        providers = configuredProviders;
      }

      if (raw.tierDefaults && typeof raw.tierDefaults === "object") {
        tierDefaults = {
          reasoning: normalizeTierDefault(raw.tierDefaults.reasoning, DEFAULT_TIER_DEFAULTS.reasoning),
          fast: normalizeTierDefault(raw.tierDefaults.fast, DEFAULT_TIER_DEFAULTS.fast),
          cheap: normalizeTierDefault(raw.tierDefaults.cheap, DEFAULT_TIER_DEFAULTS.cheap),
        };
      }

      if (raw.globalRateLimits?.emergencyStopCredits !== undefined) {
        logger.warn(
          "globalRateLimits.emergencyStopCredits is deprecated and ignored; orchestration pauses at low survival tiers instead",
        );
      }
    } catch {
      // Keep defaults if config is invalid.
    }

    return new ProviderRegistry(providers, tierDefaults);
  }

  /** `downgrade` steps the tier down once (reasoning to fast, fast to cheap). */
  resolveModel(tier: ModelTier, downgrade = false): ResolvedModel {
    const candidates = this.resolveCandidates(tier, downgrade);
    if (candidates.length === 0) {
      throw new Error(`No provider/model available for tier '${tier}'`);
    }
    return candidates[0];
  }

  /**
   * Providers for a tier in preference order. A provider with no API key is
   * skipped rather than called with a placeholder, so a prompt never goes to
   * a provider that cannot serve it.
   */
  resolveCandidates(tier: ModelTier, downgrade = false): ResolvedModel[] {
    const effectiveTier = this.applySurvivalTier(tier, downgrade);
    const orderedProviders = this.getProviderOrderForTier(effectiveTier);
    const results: ResolvedModel[] = [];

    for (const provider of orderedProviders) {
      if (!this.isProviderUsable(provider)) {
        continue;
      }

      const model = provider.models.find((candidate) => candidate.tier === effectiveTier);
      if (!model) {
        continue;
      }

      results.push(this.buildResolvedModel(provider, model));
    }

    if (results.length > 0) {
      return results;
    }

    if (effectiveTier !== tier) {
      for (const provider of this.getProviderOrderForTier(tier)) {
        if (!this.isProviderUsable(provider)) {
          continue;
        }

        const model = provider.models.find((candidate) => candidate.tier === tier);
        if (!model) {
          continue;
        }

        results.push(this.buildResolvedModel(provider, model));
      }
    }

    return results;
  }

  getModel(providerId: string, modelId: string): ResolvedModel {
    const provider = this.providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new Error(`Unknown provider '${providerId}'`);
    }

    if (!this.isProviderActive(provider)) {
      throw new Error(`Provider '${providerId}' is disabled`);
    }

    if (this.resolveApiKey(provider) === null) {
      throw new Error(`Provider '${providerId}' has no API key (${provider.apiKeyEnvVar} is not set)`);
    }

    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error(`Unknown model '${modelId}' on provider '${providerId}'`);
    }

    return this.buildResolvedModel(provider, model);
  }

  getProviders(): ProviderConfig[] {
    return this.providers
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((provider) => ({
        ...deepCloneProvider(provider),
        enabled: this.isProviderActive(provider),
      }));
  }

  disableProvider(id: string, reason: string, durationMs: number): void {
    const provider = this.providers.find((candidate) => candidate.id === id);
    if (!provider) {
      return;
    }

    this.disablements.set(id, {
      reason,
      disabledUntil: Date.now() + Math.max(0, durationMs),
    });
  }

  enableProvider(id: string): void {
    this.disablements.delete(id);
  }

  private getProviderOrderForTier(tier: ModelTier): ProviderConfig[] {
    const preferred = this.tierDefaults[tier];
    const orderedIds = [
      preferred.preferredProvider,
      ...preferred.fallbackOrder,
      ...this.providers
        .slice()
        .sort((a, b) => a.priority - b.priority)
        .map((provider) => provider.id),
    ];

    const seen = new Set<string>();
    const orderedProviders: ProviderConfig[] = [];

    for (const id of orderedIds) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      const provider = this.providers.find((candidate) => candidate.id === id);
      if (!provider) {
        continue;
      }

      orderedProviders.push(provider);
    }

    return orderedProviders;
  }

  private buildResolvedModel(provider: ProviderConfig, model: ModelConfig): ResolvedModel {
    const apiKey = this.resolveApiKey(provider);
    if (apiKey === null) {
      throw new Error(`Provider '${provider.id}' has no API key`);
    }
    // Retries live in exactly one layer (the unified client), never in the SDK.
    const client = new OpenAI({
      apiKey,
      baseURL: provider.baseUrl,
      maxRetries: 0,
      timeout: PROVIDER_CLIENT_TIMEOUT_MS,
    });

    return {
      provider: deepCloneProvider(provider),
      model: { ...model },
      client,
    };
  }

  private resolveApiKey(provider: ProviderConfig): string | null {
    const configured = process.env[provider.apiKeyEnvVar];
    if (typeof configured === "string" && configured.trim().length > 0) {
      return configured;
    }

    // Local servers usually need no key; "local" must still be enabled explicitly.
    if (provider.id === "local") {
      return "local";
    }

    return null;
  }

  private isProviderUsable(provider: ProviderConfig): boolean {
    return this.isProviderActive(provider) && this.resolveApiKey(provider) !== null;
  }

  private isProviderActive(provider: ProviderConfig): boolean {
    if (!provider.enabled) {
      return false;
    }

    const disabled = this.disablements.get(provider.id);
    if (!disabled) {
      return true;
    }

    if (disabled.disabledUntil <= Date.now()) {
      this.disablements.delete(provider.id);
      return true;
    }

    return false;
  }

  private applySurvivalTier(tier: ModelTier, downgrade: boolean): ModelTier {
    if (!downgrade) {
      return tier;
    }

    if (tier === "reasoning") {
      return "fast";
    }

    if (tier === "fast") {
      return "cheap";
    }

    return tier;
  }
}

function normalizeProviders(input: unknown): ProviderConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const defaultsById = new Map(DEFAULT_PROVIDERS.map((provider) => [provider.id, provider]));
  const normalized: ProviderConfig[] = [];

  for (const rawProvider of input) {
    if (!rawProvider || typeof rawProvider !== "object") {
      continue;
    }

    const candidate = rawProvider as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : null;
    if (!id) {
      continue;
    }

    const endpoint = resolveProviderEndpoint(id, candidate);
    if (!endpoint) {
      continue;
    }

    const fallback = defaultsById.get(id);
    const models = normalizeModels(candidate.models, fallback?.models ?? []);
    if (models.length === 0) {
      continue;
    }

    normalized.push({
      id,
      name: stringOr(candidate.name, fallback?.name ?? id),
      baseUrl: endpoint.baseUrl,
      apiKeyEnvVar: endpoint.apiKeyEnvVar,
      models,
      maxRequestsPerMinute: numberOr(candidate.maxRequestsPerMinute, fallback?.maxRequestsPerMinute ?? 600),
      maxTokensPerMinute: numberOr(candidate.maxTokensPerMinute, fallback?.maxTokensPerMinute ?? 200000),
      priority: numberOr(candidate.priority, fallback?.priority ?? 100),
      enabled: booleanOr(candidate.enabled, fallback?.enabled ?? true),
    });
  }

  return normalized.sort((a, b) => a.priority - b.priority);
}

/**
 * Decide where a file-configured provider may send requests and which env
 * var it may read. Returns null to drop the provider.
 */
function resolveProviderEndpoint(
  id: string,
  candidate: Record<string, unknown>,
): { baseUrl: string; apiKeyEnvVar: string } | null {
  const pin = KNOWN_PROVIDER_PINS[id];
  if (pin) {
    let baseUrl = pin.baseUrl;
    if (id === "local" && candidate.baseUrl !== undefined) {
      if (isAcceptableBaseUrl(candidate.baseUrl, true, true)) {
        baseUrl = candidate.baseUrl;
      } else {
        logger.warn(`Ignoring non-loopback baseUrl for provider "local"`);
      }
    } else if (candidate.baseUrl !== undefined && candidate.baseUrl !== pin.baseUrl) {
      logger.warn(`Ignoring baseUrl override for known provider "${id}"`);
    }
    if (candidate.apiKeyEnvVar !== undefined && candidate.apiKeyEnvVar !== pin.apiKeyEnvVar) {
      logger.warn(`Ignoring apiKeyEnvVar override for known provider "${id}"`);
    }
    return { baseUrl, apiKeyEnvVar: pin.apiKeyEnvVar };
  }

  if (process.env[CUSTOM_PROVIDERS_ENV] !== "1") {
    logger.warn(`Dropping unknown provider "${id.slice(0, 40)}": set ${CUSTOM_PROVIDERS_ENV}=1 to allow custom providers`);
    return null;
  }
  if (!CUSTOM_PROVIDER_ID_RE.test(id)) {
    logger.warn(`Dropping provider with invalid id "${id.slice(0, 40)}"`);
    return null;
  }
  const expectedEnv = customProviderKeyEnvVar(id);
  const apiKeyEnvVar = candidate.apiKeyEnvVar === undefined ? expectedEnv : candidate.apiKeyEnvVar;
  if (apiKeyEnvVar !== expectedEnv || RESERVED_KEY_VARS.has(apiKeyEnvVar)) {
    logger.warn(`Dropping provider "${id}": apiKeyEnvVar must be ${expectedEnv}`);
    return null;
  }
  if (!isAcceptableBaseUrl(candidate.baseUrl, true)) {
    logger.warn(`Dropping provider "${id}": baseUrl must be https (or http on loopback) without credentials`);
    return null;
  }
  return { baseUrl: candidate.baseUrl, apiKeyEnvVar };
}

function normalizeModels(input: unknown, fallbackModels: ModelConfig[]): ModelConfig[] {
  if (!Array.isArray(input)) {
    return fallbackModels.map((model) => ({ ...model }));
  }

  const models: ModelConfig[] = [];

  for (const rawModel of input) {
    if (!rawModel || typeof rawModel !== "object") {
      continue;
    }

    const candidate = rawModel as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : null;
    if (!id) {
      continue;
    }

    const fallbackById = fallbackModels.find((model) => model.id === id);
    const tier = normalizeTier(candidate.tier, fallbackById?.tier);
    const fallback =
      fallbackModels.find((model) => model.id === id && model.tier === tier) ||
      fallbackModels.find((model) => model.id === id) ||
      fallbackById;

    models.push({
      id,
      tier,
      contextWindow: numberOr(candidate.contextWindow, fallback?.contextWindow ?? 128000),
      maxOutputTokens: numberOr(candidate.maxOutputTokens, fallback?.maxOutputTokens ?? 8192),
      costPerInputToken: numberOr(candidate.costPerInputToken, fallback?.costPerInputToken ?? 0),
      costPerOutputToken: numberOr(candidate.costPerOutputToken, fallback?.costPerOutputToken ?? 0),
      supportsTools: booleanOr(candidate.supportsTools, fallback?.supportsTools ?? true),
      supportsVision: booleanOr(candidate.supportsVision, fallback?.supportsVision ?? false),
      supportsStreaming: booleanOr(candidate.supportsStreaming, fallback?.supportsStreaming ?? true),
    });
  }

  return models;
}

function normalizeTier(input: unknown, fallback: ModelTier | undefined): ModelTier {
  if (input === "reasoning" || input === "fast" || input === "cheap") {
    return input;
  }

  if (fallback) {
    return fallback;
  }

  return "fast";
}

function normalizeTierDefault(input: Partial<TierDefault> | undefined, fallback: TierDefault): TierDefault {
  const preferredProvider =
    typeof input?.preferredProvider === "string" && input.preferredProvider.length > 0
      ? input.preferredProvider
      : fallback.preferredProvider;

  const fallbackOrder = Array.isArray(input?.fallbackOrder)
    ? input.fallbackOrder.filter((id): id is string => typeof id === "string")
    : fallback.fallbackOrder;

  return {
    preferredProvider,
    fallbackOrder: fallbackOrder.filter((id) => id !== preferredProvider),
  };
}

function deepCloneProvider(provider: ProviderConfig): ProviderConfig {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
