import type OpenAI from "openai";
import { ulid } from "ulid";
import type { ChatMessage } from "../types.js";
import { redactChatMessages } from "../security/secret-redaction.js";
import { createLogger } from "../observability/logger.js";
import {
  currentInferenceScope,
  getInstalledInferenceGate,
  type BudgetClass,
  type InferenceCaller,
  type InferenceGate,
  type InferenceScope,
  type Reservation,
} from "./gate.js";
import {
  InferenceCallError,
  InferenceRefusedError,
  classifyInferenceError,
  type ErrorClassification,
  type RefusalCode,
} from "./errors.js";
import {
  ProviderRegistry,
  isLocalProvider,
  type ModelTier,
  type ModelConfig,
  type ResolvedModel,
} from "./provider-registry.js";
import {
  INFERENCE_DEADLINES,
  MAX_ATTEMPTS_PER_CALL,
  MAX_ATTEMPT_MS,
  MAX_RETRY_AFTER_MS,
} from "./types.js";

const logger = createLogger("inference.unified");

/** Backoff before the single same-provider retry when no Retry-After is given. */
const RETRY_BACKOFF_MS = [1000, 2000] as const;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_DISABLE_MS = 5 * 60_000;

/** What the call is for; sets default max tokens, the clamp floor and the deadline. */
export type InferencePurpose = "planner" | "classify" | "worker_turn" | "general";

interface PurposeDefaults {
  maxTokens: number;
  deadlineMs: number;
  /** Truncated JSON is worthless, so planner and classifier output is never clamped. */
  noClamp: boolean;
  /** maxTokensPerTurn applies to worker turns (as to main-loop turns). */
  turnCap: boolean;
}

const PURPOSE_DEFAULTS: Record<InferencePurpose, PurposeDefaults> = {
  planner: { maxTokens: 8192, deadlineMs: INFERENCE_DEADLINES.planner, noClamp: true, turnCap: false },
  classify: { maxTokens: 512, deadlineMs: INFERENCE_DEADLINES.classifier, noClamp: true, turnCap: false },
  worker_turn: { maxTokens: 4096, deadlineMs: INFERENCE_DEADLINES.worker_turn, noClamp: false, turnCap: true },
  general: { maxTokens: 4096, deadlineMs: 120_000, noClamp: false, turnCap: false },
};

/** Lowest output limit the gate may clamp a clampable call down to. */
const MIN_CLAMPED_OUTPUT_TOKENS = 1024;

export interface UnifiedInferenceResult {
  content: string;
  toolCalls?: unknown[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Committed cost of the successful attempt (fractional cents; 1 cent = 10,000 micro-USD). */
  cost: {
    inputCostCents: number;
    outputCostCents: number;
    totalCostCents: number;
    costMicroUsd: number;
  };
  metadata: {
    providerId: string;
    modelId: string;
    tier: ModelTier;
    latencyMs: number;
    retries: number;
    failedProviders: string[];
  };
}

interface SharedChatParams {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  toolChoice?: "auto" | "none" | "required" | Record<string, unknown>;
  responseFormat?: { type: "json_object" | "text" };
  stream?: boolean;
  /** Defaults from the inference scope's caller. */
  purpose?: InferencePurpose;
  /** Caller cancellation (shutdown). Not used for deadlines. */
  signal?: AbortSignal;
}

interface UnifiedChatParams extends SharedChatParams {
  tier: ModelTier;
}

interface UnifiedChatDirectParams extends SharedChatParams {
  providerId: string;
  modelId: string;
}

export interface UnifiedInferenceClientOptions {
  /** Upper bound per HTTP attempt (also bounded by the remaining deadline). */
  attemptTimeoutMs?: number;
  deadlineMs?: Partial<Record<InferencePurpose, number>>;
  sleep?: (ms: number) => Promise<void>;
}

interface CallContext {
  gate: InferenceGate | undefined;
  scope: InferenceScope;
  purpose: InferencePurpose;
  tier: ModelTier;
  deadlineAt: number;
}

interface RawCompletion {
  content: string;
  toolCalls?: unknown[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  hasChoice: boolean;
}

// ─── Process-wide circuit breaker ────────────────────────────────
// Clients are re-created every wake cycle and workers outlive cycles, so
// breaker state lives on a globalThis symbol, not on the instance.

interface CircuitBreakerState {
  failures: number;
  disabledUntil: number;
}

const BREAKER_KEY = Symbol.for("automaton.inference.circuit-breaker");

function breakers(): Map<string, CircuitBreakerState> {
  const g = globalThis as unknown as Record<symbol, Map<string, CircuitBreakerState> | undefined>;
  let map = g[BREAKER_KEY];
  if (!map) {
    map = new Map();
    g[BREAKER_KEY] = map;
  }
  return map;
}

export function isProviderCircuitOpen(providerId: string): boolean {
  const state = breakers().get(providerId);
  if (!state) return false;
  if (state.disabledUntil > Date.now()) return true;
  if (state.disabledUntil > 0) breakers().delete(providerId);
  return false;
}

export function resetProviderCircuitBreakers(): void {
  breakers().clear();
}

const TIMEOUT_CLASSIFICATION: ErrorClassification = {
  kind: "ambiguous",
  settle: "unknown",
  retrySameProvider: false,
  failover: true,
  countsForBreaker: true,
};

const NO_CHOICE_CLASSIFICATION: ErrorClassification = {
  kind: "server",
  settle: "none",
  retrySameProvider: false,
  failover: true,
  countsForBreaker: true,
};

export class UnifiedInferenceClient {
  private readonly registry: ProviderRegistry;
  private readonly attemptTimeoutMs: number;
  private readonly deadlines: Record<InferencePurpose, number>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(registry: ProviderRegistry, options: UnifiedInferenceClientOptions = {}) {
    this.registry = registry;
    this.attemptTimeoutMs = Math.min(options.attemptTimeoutMs ?? MAX_ATTEMPT_MS, MAX_ATTEMPT_MS);
    this.deadlines = {
      planner: options.deadlineMs?.planner ?? PURPOSE_DEFAULTS.planner.deadlineMs,
      classify: options.deadlineMs?.classify ?? PURPOSE_DEFAULTS.classify.deadlineMs,
      worker_turn: options.deadlineMs?.worker_turn ?? PURPOSE_DEFAULTS.worker_turn.deadlineMs,
      general: options.deadlineMs?.general ?? PURPOSE_DEFAULTS.general.deadlineMs,
    };
    this.sleep = options.sleep ?? sleep;
  }

  async chat(params: UnifiedChatParams): Promise<UnifiedInferenceResult> {
    const ctx = this.createContext(params, params.tier);
    const budgetClass = budgetClassOf(ctx.scope.caller);

    // Survival tier from the gate (owner decision D8): normal steps the tier
    // down, low tiers and an unknown balance pause orchestration entirely.
    let downgrade = false;
    if (ctx.gate && budgetClass === "orchestration") {
      const { tier } = ctx.gate.survival();
      if (tier === "low_compute" || tier === "critical" || tier === "dead" || tier === "unknown") {
        throw refusal(
          "SURVIVAL_TIER",
          `Orchestration inference paused at survival tier '${tier}'`,
          null,
          budgetClass,
        );
      }
      downgrade = tier === "normal";
    }

    let candidates = this.registry.resolveCandidates(params.tier, downgrade);
    if (!ctx.gate) {
      // No gate: paid models fail closed, free local ones still serve.
      candidates = candidates.filter((c) => isLocalProvider(c.provider));
      if (candidates.length === 0) {
        throw refusal("GATE_UNAVAILABLE", "No inference gate installed; paid inference refused", null, budgetClass);
      }
    }
    if (candidates.length === 0) {
      throw new Error(`No providers available for tier '${params.tier}'`);
    }

    return this.runAttempts(candidates, params, ctx);
  }

  async chatDirect(params: UnifiedChatDirectParams): Promise<UnifiedInferenceResult> {
    if (isProviderCircuitOpen(params.providerId)) {
      throw new Error(`Provider '${params.providerId}' circuit is open`);
    }

    const resolved = this.registry.getModel(params.providerId, params.modelId);
    const ctx = this.createContext(params, resolved.model.tier);
    if (!ctx.gate && !isLocalProvider(resolved.provider)) {
      throw refusal(
        "GATE_UNAVAILABLE",
        "No inference gate installed; paid inference refused",
        null,
        budgetClassOf(ctx.scope.caller),
      );
    }
    return this.runAttempts([resolved], params, ctx);
  }

  private createContext(params: SharedChatParams, tier: ModelTier): CallContext {
    const scope = currentInferenceScope();
    const purpose = params.purpose ?? purposeFromCaller(scope.caller);
    return {
      gate: getInstalledInferenceGate(),
      scope,
      purpose,
      tier,
      deadlineAt: Date.now() + this.deadlines[purpose],
    };
  }

  /**
   * One logical call: every HTTP attempt reserves through the gate first and
   * is settled afterwards, with at most MAX_ATTEMPTS_PER_CALL attempts, one
   * same-provider retry on 429/500/503, and a deadline for the whole call.
   */
  private async runAttempts(
    candidates: ResolvedModel[],
    params: SharedChatParams,
    ctx: CallContext,
  ): Promise<UnifiedInferenceResult> {
    if (params.signal?.aborted) {
      throw abortError("Inference call aborted before it was sent");
    }

    const callId = ulid();
    const failedProviders: string[] = [];
    const refusals: InferenceRefusedError[] = [];
    let attempts = 0;
    let sameProviderRetries = 0;
    let lastError: unknown;
    const estInputTokens = ctx.gate ? ctx.gate.estimateInputTokens(params.messages, params.tools) : 0;

    candidateLoop: for (const resolved of candidates) {
      const providerId = resolved.provider.id;
      const local = isLocalProvider(resolved.provider);
      const bounds = this.outputBounds(resolved.model, params, ctx);
      let retriedThisProvider = false;

      while (true) {
        if (attempts >= MAX_ATTEMPTS_PER_CALL) break candidateLoop;
        // The breaker may have opened on this provider's previous attempt.
        if (isProviderCircuitOpen(providerId)) {
          failedProviders.push(providerId);
          continue candidateLoop;
        }
        const remainingMs = ctx.deadlineAt - Date.now();
        if (remainingMs <= 0) break candidateLoop;

        // A paid model without a known price cannot be capped: any assumed
        // price may be below the real one (the router skips these too).
        if (!local && !hasKnownPrice(resolved.model)) {
          warnUnpriced(providerId, resolved.model.id);
          refusals.push(
            refusal(
              "NO_MODEL",
              `${providerId}/${resolved.model.id} has no configured price, so its spend cannot be capped`,
              null,
              budgetClassOf(ctx.scope.caller),
            ),
          );
          continue candidateLoop;
        }

        let reservation: Reservation | null = null;
        if (ctx.gate) {
          try {
            reservation = ctx.gate.reserve({
              callId,
              attempt: attempts + 1,
              provider: providerId,
              model: resolved.model.id,
              tier: resolved.model.tier,
              price: {
                inputUsdPerM: resolved.model.costPerInputToken,
                outputUsdPerM: resolved.model.costPerOutputToken,
                local,
              },
              estInputTokens,
              maxOutputTokens: bounds.maxTokens,
              minOutputTokens: bounds.minTokens,
              scope: ctx.scope,
            });
          } catch (error) {
            // A cheaper candidate may still fit; nothing was reserved or sent.
            if (error instanceof InferenceRefusedError) {
              refusals.push(error);
            } else {
              lastError = error;
              failedProviders.push(providerId);
            }
            continue candidateLoop;
          }
        }

        attempts += 1;
        const attemptMs = Math.max(1, Math.min(remainingMs, this.attemptTimeoutMs));
        const timeoutSignal = AbortSignal.timeout(attemptMs);
        const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
        const startedAt = Date.now();
        const maxTokens = reservation?.maxOutputTokens ?? bounds.maxTokens;

        let classification: ErrorClassification;
        let attemptError: unknown;
        try {
          const raw = await raceAbort(
            this.executeSingleRequest(resolved, params, maxTokens, signal, attemptMs),
            signal,
          );
          const latencyMs = Date.now() - startedAt;
          const usage = raw.usage.inputTokens + raw.usage.outputTokens > 0
            ? { inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens }
            : null;
          // A 200 is billed even without a usable choice: commit either way.
          const costMicroUsd = reservation && ctx.gate
            ? ctx.gate.commit(reservation.id, usage, latencyMs, {
                outputText:
                  (raw.content ?? "") + (raw.toolCalls ?? []).map((tc: any) => String(tc?.function?.arguments ?? "")).join(""),
              }).costMicroUsd
            : 0;

          if (raw.hasChoice) {
            markProviderSuccess(this.registry, providerId);
            return buildUnifiedResult({
              providerId,
              model: resolved.model,
              requestedTier: ctx.tier,
              latencyMs,
              content: raw.content,
              toolCalls: raw.toolCalls,
              usage: raw.usage,
              costMicroUsd,
              retries: attempts - 1,
              failedProviders,
            });
          }

          classification = NO_CHOICE_CLASSIFICATION;
          attemptError = new Error(`No completion choice returned from provider '${providerId}'`);
        } catch (error) {
          const callerAborted = params.signal?.aborted === true;
          classification = !callerAborted && timeoutSignal.aborted
            ? TIMEOUT_CLASSIFICATION
            : classifyInferenceError(error, { callerAborted });
          attemptError = error;
          if (reservation && ctx.gate) {
            settleFailedAttempt(ctx.gate, reservation.id, classification);
          }
        }

        lastError = attemptError;
        if (classification.disableProviderMs) {
          disableProvider(this.registry, providerId, classification.disableProviderMs);
        } else if (classification.countsForBreaker) {
          markProviderFailure(this.registry, providerId);
        }

        if (classification.kind === "aborted") {
          throw attemptError;
        }

        if (classification.retrySameProvider && !retriedThisProvider && attempts < MAX_ATTEMPTS_PER_CALL) {
          const delayMs = Math.min(
            classification.retryAfterMs ?? RETRY_BACKOFF_MS[Math.min(sameProviderRetries, RETRY_BACKOFF_MS.length - 1)],
            MAX_RETRY_AFTER_MS,
          );
          if (Date.now() + delayMs < ctx.deadlineAt) {
            retriedThisProvider = true;
            sameProviderRetries += 1;
            await this.sleep(delayMs);
            continue;
          }
        }

        if (!classification.failover) {
          throw attemptError;
        }

        failedProviders.push(providerId);
        logger.warn(
          `Provider ${providerId} failed (${classification.kind}${classification.status ? ` ${classification.status}` : ""}); trying next candidate`,
        );
        continue candidateLoop;
      }
    }

    if (refusals.length > 0) {
      throw mostRestrictiveRefusal(refusals);
    }

    const lastMessage = lastError instanceof Error ? lastError.message : lastError === undefined ? "" : String(lastError);
    throw new InferenceCallError(
      `All providers failed for tier '${ctx.tier}'. Failed providers: ${failedProviders.join(", ")}` +
        (attempts >= MAX_ATTEMPTS_PER_CALL ? ` (attempt limit ${MAX_ATTEMPTS_PER_CALL} reached)` : "") +
        (lastMessage ? `. Last error: ${lastMessage}` : ""),
      { attempts, cause: lastError },
    );
  }

  private outputBounds(
    model: ModelConfig,
    params: SharedChatParams,
    ctx: CallContext,
  ): { maxTokens: number; minTokens: number } {
    const defaults = PURPOSE_DEFAULTS[ctx.purpose];
    let maxTokens = params.maxTokens !== undefined && params.maxTokens > 0
      ? Math.floor(params.maxTokens)
      : defaults.maxTokens;
    if (model.maxOutputTokens > 0) {
      maxTokens = Math.min(maxTokens, model.maxOutputTokens);
    }
    const turnCap = ctx.gate?.policy.maxTokensPerTurn ?? 0;
    if (defaults.turnCap && turnCap > 0) {
      maxTokens = Math.min(maxTokens, turnCap);
    }
    maxTokens = Math.max(1, maxTokens);
    const minTokens = defaults.noClamp ? maxTokens : Math.min(MIN_CLAMPED_OUTPUT_TOKENS, maxTokens);
    return { maxTokens, minTokens };
  }

  private async executeSingleRequest(
    resolved: ResolvedModel,
    params: SharedChatParams,
    maxTokens: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<RawCompletion> {
    const client: OpenAI = resolved.client;
    const payload = this.buildChatCompletionRequest(resolved.model.id, params, maxTokens);
    const requestOptions = { signal, timeout: timeoutMs, maxRetries: 0 };

    if (params.stream) {
      const stream = await client.chat.completions.create({
        ...payload,
        stream: true,
        // Without this the provider sends no usage and the call is charged at its reservation.
        stream_options: { include_usage: true },
      } as any, requestOptions);
      const streamed = await consumeStreamResponse(stream as any);
      return { ...streamed, hasChoice: true };
    }

    const completion = await client.chat.completions.create({
      ...payload,
      stream: false,
    } as any, requestOptions);

    const usage = {
      inputTokens: (completion as any).usage?.prompt_tokens ?? 0,
      outputTokens: (completion as any).usage?.completion_tokens ?? 0,
      totalTokens: (completion as any).usage?.total_tokens ?? 0,
    };
    const choice = (completion as any).choices?.[0];
    if (!choice?.message) {
      return { content: "", usage, hasChoice: false };
    }

    return {
      content: extractText(choice.message.content),
      toolCalls: normalizeToolCalls(choice.message.tool_calls),
      usage,
      hasChoice: true,
    };
  }

  private buildChatCompletionRequest(
    modelId: string,
    params: SharedChatParams,
    maxTokens: number,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: modelId,
      // Known secret values never leave for a provider.
      messages: redactChatMessages(params.messages).map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      })),
      // Always sent: the reservation priced exactly this many output tokens.
      max_tokens: maxTokens,
    };

    if (params.temperature !== undefined) {
      payload.temperature = params.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      payload.tools = params.tools;
    }

    if (params.toolChoice !== undefined) {
      payload.tool_choice = params.toolChoice;
    }

    if (params.responseFormat !== undefined) {
      payload.response_format = params.responseFormat;
    }

    return payload;
  }
}

function budgetClassOf(caller: InferenceCaller): BudgetClass {
  if (caller === "agent_turn" || caller === "inbox_turn") return "main";
  if (caller === "survival_turn") return "survival";
  return "orchestration";
}

function purposeFromCaller(caller: InferenceCaller): InferencePurpose {
  switch (caller) {
    case "orchestrator.plan":
    case "orchestrator.replan":
      return "planner";
    case "orchestrator.classify":
      return "classify";
    case "worker":
      return "worker_turn";
    default:
      return "general";
  }
}

const unpricedWarned = new Set<string>();

function warnUnpriced(providerId: string, modelId: string): void {
  const key = `${providerId}/${modelId}`;
  if (unpricedWarned.has(key)) return;
  unpricedWarned.add(key);
  logger.warn(`Skipping ${key}: no known price, so its spend cannot be capped`);
}

/** Both per-token prices are finite and above zero. */
function hasKnownPrice(model: { costPerInputToken: number; costPerOutputToken: number }): boolean {
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  return ok(model.costPerInputToken) && ok(model.costPerOutputToken);
}

function refusal(
  code: RefusalCode,
  message: string,
  retryAfterMs: number | null,
  budgetClass: BudgetClass,
): InferenceRefusedError {
  return new InferenceRefusedError(code, message, { retryAfterMs, budgetClass });
}

/** The refusal that clears last; one with no time bound wins. */
function mostRestrictiveRefusal(refusals: InferenceRefusedError[]): InferenceRefusedError {
  return refusals.reduce((worst, current) => {
    if (worst.retryAfterMs === null) return worst;
    if (current.retryAfterMs === null) return current;
    return current.retryAfterMs > worst.retryAfterMs ? current : worst;
  });
}

/** Never leave a reservation open: anything not provably unbilled is held as unknown. */
function settleFailedAttempt(gate: InferenceGate, reservationId: string, classification: ErrorClassification): void {
  if (classification.settle === "release") {
    gate.release(reservationId, classification.kind);
  } else if (classification.settle === "unknown" || gate.isOpen(reservationId)) {
    gate.markUnknown(reservationId, classification.kind);
  }
}

function markProviderFailure(registry: ProviderRegistry, providerId: string): void {
  const map = breakers();
  const state = map.get(providerId) ?? { failures: 0, disabledUntil: 0 };
  state.failures += 1;
  if (state.failures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    state.disabledUntil = Date.now() + CIRCUIT_BREAKER_DISABLE_MS;
    registry.disableProvider(
      providerId,
      "circuit-breaker: too many consecutive inference failures",
      CIRCUIT_BREAKER_DISABLE_MS,
    );
  }
  map.set(providerId, state);
}

function disableProvider(registry: ProviderRegistry, providerId: string, durationMs: number): void {
  breakers().set(providerId, { failures: 0, disabledUntil: Date.now() + durationMs });
  registry.disableProvider(providerId, "provider rejected the API key", durationMs);
}

function markProviderSuccess(registry: ProviderRegistry, providerId: string): void {
  breakers().delete(providerId);
  registry.enableProvider(providerId);
}

function buildUnifiedResult(params: {
  providerId: string;
  model: ModelConfig;
  requestedTier: ModelTier;
  latencyMs: number;
  content: string;
  toolCalls?: unknown[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  costMicroUsd: number;
  retries: number;
  failedProviders: string[];
}): UnifiedInferenceResult {
  // Prices are USD per 1M tokens: cents = tokens * usdPerM / 10_000.
  const rawInput = (params.usage.inputTokens * params.model.costPerInputToken) / 10_000;
  const rawOutput = (params.usage.outputTokens * params.model.costPerOutputToken) / 10_000;
  const totalCostCents = params.costMicroUsd / 10_000;
  // The gate's committed amount is authoritative (it may use a conservative
  // price or the reservation); split it in the same proportion.
  const rawTotal = rawInput + rawOutput;
  const inputCostCents = rawTotal > 0 ? totalCostCents * (rawInput / rawTotal) : 0;
  const outputCostCents = rawTotal > 0 ? totalCostCents - inputCostCents : totalCostCents;

  return {
    content: params.content,
    toolCalls: params.toolCalls,
    usage: params.usage,
    cost: {
      inputCostCents,
      outputCostCents,
      totalCostCents,
      costMicroUsd: params.costMicroUsd,
    },
    metadata: {
      providerId: params.providerId,
      modelId: params.model.id,
      tier: params.requestedTier,
      latencyMs: params.latencyMs,
      retries: params.retries,
      failedProviders: [...params.failedProviders],
    },
  };
}

async function consumeStreamResponse(stream: AsyncIterable<any>): Promise<{
  content: string;
  toolCalls?: unknown[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
  let content = "";
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const toolCallsByIndex = new Map<number, any>();

  for await (const chunk of stream) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;

    if (typeof delta?.content === "string") {
      content += delta.content;
    }

    if (Array.isArray(delta?.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        const index = typeof rawCall?.index === "number" ? rawCall.index : toolCallsByIndex.size;
        const existing = toolCallsByIndex.get(index) ?? {
          id: rawCall?.id ?? `tool-${index}`,
          type: "function",
          function: { name: "", arguments: "" },
        };

        if (typeof rawCall?.id === "string") {
          existing.id = rawCall.id;
        }
        if (typeof rawCall?.type === "string") {
          existing.type = rawCall.type;
        }
        if (typeof rawCall?.function?.name === "string") {
          existing.function.name = `${existing.function.name || ""}${rawCall.function.name}`;
        }
        if (typeof rawCall?.function?.arguments === "string") {
          existing.function.arguments = `${existing.function.arguments || ""}${rawCall.function.arguments}`;
        }

        toolCallsByIndex.set(index, existing);
      }
    }

    if (chunk?.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? usage.inputTokens,
        outputTokens: chunk.usage.completion_tokens ?? usage.outputTokens,
        totalTokens: chunk.usage.total_tokens ?? usage.totalTokens,
      };
    }
  }

  return {
    content,
    toolCalls: normalizeToolCalls(Array.from(toolCallsByIndex.values())),
    usage,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type?: unknown }).type === "text" &&
          "text" in part
        ) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }

        return "";
      })
      .join("");
  }

  return "";
}

function normalizeToolCalls(toolCalls: unknown): unknown[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Settle with the signal even if the transport ignores it (a stalled body
 * read, a mocked client), so the deadline always holds.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError("Inference attempt aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError("Inference attempt aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
