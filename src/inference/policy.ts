/**
 * Inference spending policy
 *
 * Resolves the caps the inference gate enforces from the model strategy and
 * the treasury policy, once, with defaults and warnings for anything missing
 * or invalid (the same approach as normalizeTreasuryPolicy).
 */

import type { ModelEntry, ModelStrategyConfig } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { STATIC_MODEL_BASELINE } from "./types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("inference.policy");

export const MICRO_USD_PER_CENT = 10_000;

export interface ModelPrice {
  inputUsdPerM: number;
  outputUsdPerM: number;
  /** A free local model: passes every monetary cap. */
  local: boolean;
}

export interface ResolvedInferencePolicy {
  /** treasury.maxInferenceDailyCents; 0 disables paid inference. */
  dailyCapCents: number;
  /** Explicit, or ceil(daily / 6); never above daily. */
  hourlyCapCents: number;
  /** 0 = none. */
  sessionCapCents: number;
  /** 0 = none. */
  perCallCeilingCents: number;
  /** 0..100. */
  orchestrationSharePct: number;
  /** 0 disables the survival allowance. */
  survivalAllowanceCents: number;
  survivalMinIntervalMs: number;
  sessionCooldownMs: number;
  maxTokensPerTurn: number;
  enableModelFallback: boolean;
  /** Charged for a non-local model with a zero or missing price. */
  unknownPrice: { inputUsdPerM: number; outputUsdPerM: number };
}

export const DEFAULT_ORCHESTRATION_SHARE_PCT = 50;
export const DEFAULT_SURVIVAL_ALLOWANCE_CENTS = 25;
export const DEFAULT_SURVIVAL_MIN_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_SESSION_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_MAX_TOKENS_PER_TURN = 4096;

/** The most expensive baseline prices, in USD per 1M tokens. */
export function maxBaselinePrice(): { inputUsdPerM: number; outputUsdPerM: number } {
  let input = 0;
  let output = 0;
  for (const m of STATIC_MODEL_BASELINE) {
    input = Math.max(input, m.costPer1kInput / 10);
    output = Math.max(output, m.costPer1kOutput / 10);
  }
  return { inputUsdPerM: input, outputUsdPerM: output };
}

type Warn = (message: string) => void;

function nonNegativeNumber(
  src: Record<string, unknown>,
  key: string,
  fallback: number,
  warn: Warn,
  opts: { integer?: boolean; max?: number } = {},
): number {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    warn(`Invalid inference value for ${key}: ${JSON.stringify(value)}; using ${fallback}`);
    return fallback;
  }
  let v = opts.integer ? Math.floor(value) : value;
  if (opts.max !== undefined && v > opts.max) {
    warn(`Inference value for ${key} (${value}) is above ${opts.max}; using ${opts.max}`);
    v = opts.max;
  }
  return v;
}

export interface InferencePolicySource {
  modelStrategy?: Partial<ModelStrategyConfig> | null;
  maxTokensPerTurn?: number;
}

/**
 * Resolve the policy. `treasuryPolicy` is normally the output of
 * normalizeTreasuryPolicy; only maxInferenceDailyCents is read from it.
 */
export function resolveInferencePolicy(
  config: InferencePolicySource | null | undefined,
  treasuryPolicy: { maxInferenceDailyCents?: number } | null | undefined,
  opts: { onWarning?: Warn } = {},
): ResolvedInferencePolicy {
  const warn: Warn = (m) => {
    logger.warn(m);
    opts.onWarning?.(m);
  };
  const ms: Record<string, unknown> =
    config?.modelStrategy && typeof config.modelStrategy === "object"
      ? (config.modelStrategy as Record<string, unknown>)
      : {};
  const tp: Record<string, unknown> =
    treasuryPolicy && typeof treasuryPolicy === "object" ? (treasuryPolicy as Record<string, unknown>) : {};

  const dailyCapCents = nonNegativeNumber(
    tp,
    "maxInferenceDailyCents",
    DEFAULT_TREASURY_POLICY.maxInferenceDailyCents,
    warn,
    { integer: true },
  );
  const hourlyExplicit = nonNegativeNumber(ms, "hourlyBudgetCents", 0, warn, { integer: true });
  const hourlyCapCents = Math.min(
    hourlyExplicit > 0 ? hourlyExplicit : Math.ceil(dailyCapCents / 6),
    dailyCapCents,
  );

  let maxTokensPerTurn = nonNegativeNumber(ms, "maxTokensPerTurn", 0, warn, { integer: true });
  if (maxTokensPerTurn <= 0) {
    const top = config?.maxTokensPerTurn;
    maxTokensPerTurn =
      typeof top === "number" && Number.isFinite(top) && top > 0 ? Math.floor(top) : DEFAULT_MAX_TOKENS_PER_TURN;
  }

  return {
    dailyCapCents,
    hourlyCapCents,
    sessionCapCents: nonNegativeNumber(ms, "sessionBudgetCents", 0, warn, { integer: true }),
    perCallCeilingCents: nonNegativeNumber(ms, "perCallCeilingCents", 0, warn),
    orchestrationSharePct: nonNegativeNumber(ms, "orchestrationSharePct", DEFAULT_ORCHESTRATION_SHARE_PCT, warn, {
      max: 100,
    }),
    survivalAllowanceCents: nonNegativeNumber(ms, "survivalAllowanceCents", DEFAULT_SURVIVAL_ALLOWANCE_CENTS, warn),
    survivalMinIntervalMs: nonNegativeNumber(ms, "survivalMinIntervalMs", DEFAULT_SURVIVAL_MIN_INTERVAL_MS, warn, {
      integer: true,
    }),
    sessionCooldownMs: nonNegativeNumber(ms, "sessionCooldownMs", DEFAULT_SESSION_COOLDOWN_MS, warn, {
      integer: true,
    }),
    maxTokensPerTurn,
    enableModelFallback: ms.enableModelFallback === undefined ? true : ms.enableModelFallback !== false,
    unknownPrice: maxBaselinePrice(),
  };
}

/** Registry prices are hundredths of a cent per 1k tokens, which is USD per 1M x 10. */
export function registryPrice(entry: Pick<ModelEntry, "provider" | "costPer1kInput" | "costPer1kOutput">): ModelPrice {
  return {
    inputUsdPerM: Number(entry.costPer1kInput) / 10,
    outputUsdPerM: Number(entry.costPer1kOutput) / 10,
    local: entry.provider === "ollama",
  };
}

/**
 * The price the gate charges: as given for a local model (always free), and
 * for a remote model any missing, zero or invalid component is replaced by
 * the conservative price, since unknown is not free.
 */
export function effectivePrice(price: ModelPrice, policy: Pick<ResolvedInferencePolicy, "unknownPrice">): ModelPrice {
  if (price.local) return { inputUsdPerM: 0, outputUsdPerM: 0, local: true };
  const ok = (v: number) => typeof v === "number" && Number.isFinite(v) && v > 0;
  return {
    inputUsdPerM: ok(price.inputUsdPerM) ? price.inputUsdPerM : policy.unknownPrice.inputUsdPerM,
    outputUsdPerM: ok(price.outputUsdPerM) ? price.outputUsdPerM : policy.unknownPrice.outputUsdPerM,
    local: false,
  };
}

/** Worst-case micro-USD of an attempt, rounded up once. */
export function costMicroUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  if (price.local) return 0;
  return Math.ceil(inputTokens * price.inputUsdPerM + outputTokens * price.outputUsdPerM);
}

/**
 * Rough cost of the smallest useful main-loop turn (system prompt plus tool
 * schemas, 1024 output tokens), used only for startup warnings.
 */
export function estimateMinimumTurnCostCents(price: ModelPrice, inputTokens = 10_000, outputTokens = 1024): number {
  return costMicroUsd(price, inputTokens, outputTokens) / MICRO_USD_PER_CENT;
}

/**
 * Startup warnings for settings that refuse paid inference without any time
 * bound. Returns the messages (also logged).
 */
export function checkPolicySanity(
  policy: ResolvedInferencePolicy,
  minTurn: { model: string; price: ModelPrice; matrixCeilings?: Record<string, number> } | null,
): string[] {
  const out: string[] = [];
  if (policy.dailyCapCents === 0) {
    const m =
      "treasuryPolicy.maxInferenceDailyCents is 0: paid inference is disabled, only free local models can run.";
    logger.error(m);
    out.push(m);
  }
  if (minTurn && !minTurn.price.local) {
    const minCost = estimateMinimumTurnCostCents(effectivePrice(minTurn.price, policy));
    if (policy.perCallCeilingCents > 0 && policy.perCallCeilingCents < minCost) {
      const m =
        `modelStrategy.perCallCeilingCents (${policy.perCallCeilingCents}c) is below the estimated minimum turn ` +
        `cost on ${minTurn.model} (~${minCost.toFixed(2)}c): most agent turns will be refused.`;
      logger.warn(m);
      out.push(m);
    }
    for (const [tier, ceiling] of Object.entries(minTurn.matrixCeilings ?? {})) {
      if (ceiling >= 0 && ceiling < minCost) {
        const m =
          `The ${tier} routing ceiling (${ceiling}c per turn) is below the estimated minimum turn cost on ` +
          `${minTurn.model} (~${minCost.toFixed(2)}c): turns at that tier may be refused.`;
        logger.warn(m);
        out.push(m);
      }
    }
  }
  return out;
}
