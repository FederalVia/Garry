/**
 * Inference Router
 *
 * Routes main-loop inference (agent, inbox and survival turns) through the
 * model registry. Every HTTP attempt first reserves its worst case on the
 * process-wide InferenceGate and is settled afterwards; candidates honour the
 * selected model and free local models, fall back in order, and share one
 * deadline and a hard limit on HTTP attempts.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  InferenceRequest,
  InferenceResult,
  InferenceRefusal,
  ModelEntry,
  SurvivalTier,
  InferenceTaskType,
  ModelProvider,
  ChatMessage,
  ModelPreference,
  ModelStrategyConfig,
} from "../types.js";
import { ModelRegistry } from "./registry.js";
import {
  DEFAULT_ROUTING_MATRIX,
  INFERENCE_DEADLINES,
  MAX_ATTEMPT_MS,
  MAX_ATTEMPTS_PER_CALL,
  MAX_RETRY_AFTER_MS,
} from "./types.js";
import {
  InferenceGate,
  currentInferenceScope,
  runWithInferenceScope,
  type InferenceCaller,
  type InferenceScope,
} from "./gate.js";
import { registryPrice, type ModelPrice } from "./policy.js";
import { longPromptPrice } from "../providers/price-table.js";
import { currentCancellationSignal, mergeSignals } from "../runtime/cancellation.js";
import {
  InferenceCallError,
  InferenceRefusedError,
  classifyInferenceError,
  isInferenceRefusal,
  type ErrorClassification,
} from "./errors.js";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("inference.router");

const TIER_ORDER: Record<string, number> = {
  dead: 0, critical: 1, low_compute: 2, normal: 3, high: 4,
};

/** Retry delay when the provider gave no Retry-After. */
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** A NO_MODEL refusal is retried after this long. */
const NO_MODEL_RETRY_MS = 10 * 60_000;
const SURVIVAL_MAX_TOKENS = 1024;
const SURVIVAL_MIN_TOKENS = 512;
const TURN_MIN_TOKENS = 1024;

type ChatFn = (messages: any[], options: any) => Promise<any>;

export interface InferenceRouterOptions {
  /** Whether a backend can serve a model (legacy client's canServe). Default: all. */
  canServe?: (model: ModelEntry) => boolean;
  /**
   * Whether this model's provider lets its unpriced models through
   * (allowUnpriced). Default: none, so a paid model with no price is skipped.
   */
  allowUnpriced?: (model: ModelEntry) => boolean;
  /**
   * Rows the survival fallback picks by the old rule (cheapest servable paid
   * model, no tool or tier-floor check), so a Conway install without new
   * settings behaves as before. Default: none.
   */
  legacySurvivalRow?: (model: ModelEntry) => boolean;
  /** USD per 1M an allowed unpriced model reserves at. Default: the gate's unknown price. */
  unknownPrice?: () => { inputUsdPerM: number; outputUsdPerM: number };
  /** Overrides the per-caller deadline (tests). */
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutError(ms: number): Error {
  const err = new Error(`Inference deadline of ${ms}ms reached`);
  err.name = "TimeoutError";
  return err;
}

/** Latest clear time wins; a refusal that never clears on its own beats any time. */
function mostRestrictive(a: InferenceRefusedError, b: InferenceRefusedError): InferenceRefusedError {
  if (a.retryAfterMs === null) return a;
  if (b.retryAfterMs === null) return b;
  return b.retryAfterMs > a.retryAfterMs ? b : a;
}

export class InferenceRouter {
  private db: Database;
  private registry: ModelRegistry;
  private gate: InferenceGate;
  private getStrategy: () => ModelStrategyConfig;
  private opts: InferenceRouterOptions;
  private unpricedWarned = new Set<string>();

  constructor(
    db: Database,
    registry: ModelRegistry,
    gate: InferenceGate,
    getStrategy: () => ModelStrategyConfig,
    opts: InferenceRouterOptions = {},
  ) {
    this.db = db;
    this.registry = registry;
    this.gate = gate;
    this.getStrategy = getStrategy;
    this.opts = opts;
  }

  /**
   * Route one logical call. Returns the completion, or a result with
   * finishReason "budget_exceeded" and `refusal` when the gate refused every
   * candidate. Throws InferenceCallError when the attempts failed with errors.
   */
  async route(request: InferenceRequest, inferenceChat: ChatFn): Promise<InferenceResult> {
    // A heartbeat task's cancellation acts as the caller's signal, so an
    // abort is classified as the caller's (no failover), not a provider fault.
    const merged = mergeSignals(request.signal, currentCancellationSignal());
    if (merged !== request.signal) request = { ...request, signal: merged };
    const { messages, taskType, tier, tools } = request;
    const survival = request.survival === true;
    const caller: InferenceCaller = survival ? "survival_turn" : request.caller ?? "agent_turn";
    const outer = currentInferenceScope();
    const scope: InferenceScope = {
      ...outer,
      caller,
      sessionId: request.sessionId ?? outer.sessionId,
      turnId: request.turnId ?? outer.turnId,
    };
    if (messages.length === 0) throw new Error("Cannot route inference with empty message array");
    if (request.signal?.aborted) {
      throw new InferenceCallError("Inference aborted before routing", { attempts: 0, cause: request.signal.reason });
    }

    const candidates = survival ? this.survivalCandidates(tier) : this.candidates(tier, taskType);
    if (candidates.length === 0) {
      return this.refusalResult(
        new InferenceRefusedError("NO_MODEL", `No servable model for tier ${tier}`, {
          retryAfterMs: NO_MODEL_RETRY_MS,
          budgetClass: survival ? "survival" : "main",
        }),
      );
    }
    const strategy = this.getStrategy();
    const policy = this.gate.policy;
    const tried = policy.enableModelFallback && strategy.enableModelFallback !== false ? candidates : candidates.slice(0, 1);
    const preference = this.getPreference(tier, taskType);

    const now = this.opts.now ?? Date.now;
    const deadlineMs = this.opts.deadlineMs ?? (survival ? INFERENCE_DEADLINES.survival_turn : INFERENCE_DEADLINES.agent_turn);
    const startedAt = now();
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(timeoutError(deadlineMs)), deadlineMs);
    const onCallerAbort = () => deadline.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const sleep = this.opts.sleep ?? abortableSleep;

    const callId = ulid();
    let attempts = 0;
    let refusal: InferenceRefusedError | undefined;
    let lastError: unknown;
    let lastClass: ErrorClassification | undefined;

    try {
      candidateLoop: for (const model of tried) {
        let retried = false;
        while (true) {
          if (attempts >= MAX_ATTEMPTS_PER_CALL || deadline.signal.aborted) break candidateLoop;

          // Thinking counts toward max_tokens, so a thinking model gets a
          // floor; the gate may clamp the reservation but not below it.
          const floor = outputFloor(model);
          const desired = Math.max(
            survival ? SURVIVAL_MAX_TOKENS : request.maxTokens || preference?.maxTokens || model.maxTokens,
            floor,
          );
          const maxTokens = Math.max(1, Math.min(desired, policy.maxTokensPerTurn, model.maxTokens || desired));
          const minTokens = Math.min(Math.max(survival ? SURVIVAL_MIN_TOKENS : TURN_MIN_TOKENS, floor), maxTokens);
          const transformed = this.transformMessagesForProvider(messages, model.provider);
          const estInputTokens = this.gate.estimateInputTokens(transformed, tools);

          let reservation;
          try {
            reservation = this.gate.reserve({
              callId,
              attempt: attempts + 1,
              provider: model.provider,
              model: model.modelId,
              tier,
              price: this.reservationPrice(model, estInputTokens),
              estInputTokens,
              maxOutputTokens: maxTokens,
              minOutputTokens: minTokens,
              extraCeilingCents:
                !survival && preference && preference.ceilingCents >= 0 ? preference.ceilingCents : undefined,
              scope,
            });
          } catch (err) {
            if (!isInferenceRefusal(err)) throw err;
            refusal = refusal ? mostRestrictive(refusal, err) : err;
            continue candidateLoop;
          }

          attempts++;
          const attemptStart = now();
          const remaining = Math.max(1, deadlineMs - (attemptStart - startedAt));
          // A second timer for the remaining deadline could fire first, look
          // like a plain attempt timeout and start a doomed failover attempt.
          const attemptSignal =
            remaining > MAX_ATTEMPT_MS
              ? AbortSignal.any([deadline.signal, AbortSignal.timeout(MAX_ATTEMPT_MS)])
              : deadline.signal;
          try {
            // Raced as well as signalled: once headers arrive the transport
            // may no longer watch the signal, and a trickling body would hold
            // the turn past its deadline.
            const response = await raceAbort(
              runWithInferenceScope(scope, () =>
                inferenceChat(transformed, {
                  model: model.modelId,
                  maxTokens: reservation.maxOutputTokens,
                  tools,
                  signal: attemptSignal,
                  reservationId: reservation.id,
                  // Survival turns think as little as the model allows.
                  ...(survival ? { effort: "low" } : {}),
                }),
              ),
              attemptSignal,
            );
            const inputTokens = response?.usage?.promptTokens || 0;
            const outputTokens = response?.usage?.completionTokens || 0;
            const usage = response?.usage ? { inputTokens, outputTokens } : null;
            const outputText =
              (response?.message?.content || "") +
              (response?.toolCalls ?? []).map((tc: any) => String(tc?.function?.arguments ?? "")).join("");
            const { costMicroUsd } = this.gate.commit(reservation.id, usage, now() - attemptStart, {
              outputText,
              longPrompt: capabilitiesOf(model).longPrompt,
            });
            return {
              content: response?.message?.content || "",
              model: model.modelId,
              provider: model.provider,
              inputTokens,
              outputTokens,
              costCents: costMicroUsd / 10_000,
              costMicroUsd,
              latencyMs: now() - startedAt,
              toolCalls: response?.toolCalls,
              finishReason: response?.finishReason || "stop",
            };
          } catch (err) {
            const callerAborted = request.signal?.aborted === true;
            const cls = classifyInferenceError(err, { callerAborted });
            this.settle(reservation.id, err, cls, capabilitiesOf(model).longPrompt);
            lastError = err;
            lastClass = cls;
            logger.warn(`Inference attempt failed on ${model.modelId}: ${cls.kind}${cls.status ? ` ${cls.status}` : ""}`);
            if (cls.kind === "refused") {
              refusal = refusal ? mostRestrictive(refusal, err as InferenceRefusedError) : (err as InferenceRefusedError);
              continue candidateLoop;
            }
            if (cls.kind === "aborted" || cls.kind === "caller") break candidateLoop;
            if (cls.retrySameProvider && !retried && attempts < MAX_ATTEMPTS_PER_CALL) {
              const wait = cls.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS;
              const left = deadlineMs - (now() - startedAt);
              if (wait <= MAX_RETRY_AFTER_MS && wait < left) {
                retried = true;
                try {
                  await sleep(wait, deadline.signal);
                } catch {
                  break candidateLoop;
                }
                continue;
              }
            }
            if (!cls.failover) break candidateLoop;
            continue candidateLoop;
          }
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
      request.signal?.removeEventListener("abort", onCallerAbort);
    }

    // Every viable candidate was refused by the gate (possibly after others
    // failed): report the refusal so the loop sleeps instead of erroring.
    if (refusal && (!lastClass || (lastClass.kind !== "caller" && lastClass.kind !== "aborted"))) {
      return this.refusalResult(refusal);
    }
    const reason = deadline.signal.aborted && !request.signal?.aborted
      ? `deadline of ${deadlineMs}ms reached`
      : lastError instanceof Error
        ? lastError.message
        : String(lastError ?? "no attempt made");
    throw new InferenceCallError(`Inference failed after ${attempts} attempt(s): ${reason}`, {
      attempts,
      cause: lastError,
      classification: lastClass,
    });
  }

  private settle(
    reservationId: string,
    err: unknown,
    cls: ErrorClassification,
    longPrompt?: RouteCapabilities["longPrompt"],
  ): void {
    const usage = (err as any)?.usage;
    if (cls.settle === "release") {
      this.gate.release(reservationId, cls.kind + (cls.status ? `:${cls.status}` : ""));
    } else if (cls.settle === "unknown") {
      if (usage && typeof usage.inputTokens === "number") {
        // A 2xx with usage but no usable completion: billed at its usage.
        this.gate.commit(reservationId, usage, 0, { longPrompt });
      } else {
        this.gate.markUnknown(reservationId, cls.kind + (cls.status ? `:${cls.status}` : ""));
      }
    }
  }

  private refusalResult(r: InferenceRefusedError): InferenceResult {
    const refusal: InferenceRefusal = { code: r.code, retryAfterMs: r.retryAfterMs, message: r.message };
    return {
      content: `Inference refused (${r.code}): ${r.message}`,
      model: "none",
      provider: "other",
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      costMicroUsd: 0,
      latencyMs: 0,
      finishReason: "budget_exceeded",
      refusal,
    };
  }

  private servable(entry: ModelEntry | undefined): entry is ModelEntry {
    if (!entry || !entry.enabled) return false;
    // A paid model without a known price cannot be capped: any assumed price
    // may be below the real one. Its provider may opt in (allowUnpriced); it
    // then reserves at the highest known price.
    if (!this.isLocal(entry) && !hasKnownPrice(entry) && !this.opts.allowUnpriced?.(entry)) {
      if (!this.unpricedWarned.has(entry.modelId)) {
        this.unpricedWarned.add(entry.modelId);
        logger.warn(`Skipping ${entry.modelId}: no known price, so its spend cannot be capped`);
      }
      return false;
    }
    return this.opts.canServe ? this.opts.canServe(entry) : true;
  }

  private isLocal(entry: ModelEntry): boolean {
    return registryPrice(entry).local;
  }

  /**
   * The price an attempt reserves at: the registry price, the highest known
   * price for an allowed unpriced model, and a long-prompt tier once the
   * estimated prompt reaches 70% of its threshold.
   */
  reservationPrice(entry: ModelEntry, estInputTokens: number): ModelPrice {
    const base = registryPrice(entry);
    if (base.local) return base;
    if (!hasKnownPrice(entry)) {
      const unknown = this.opts.unknownPrice?.() ?? this.gate.policy.unknownPrice;
      return { inputUsdPerM: unknown.inputUsdPerM, outputUsdPerM: unknown.outputUsdPerM, local: false };
    }
    const tier = longPromptPrice(capabilitiesOf(entry), estInputTokens);
    if (tier) {
      return {
        inputUsdPerM: Math.max(base.inputUsdPerM, tier.inputUsdPerM),
        outputUsdPerM: Math.max(base.outputUsdPerM, tier.outputUsdPerM),
        local: false,
      };
    }
    return base;
  }

  /**
   * Candidate order for (tier, taskType):
   *   1. the configured model for the tier when it is a free local model
   *      (below normal, any configured local model; nothing else at dead)
   *   2. the configured model for the tier, if allowed at this tier
   *   3. the routing-matrix candidates
   *   4. the other configured models (free ones at any tier)
   * Disabled and unservable models are skipped; duplicates removed.
   */
  candidates(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry[] {
    const strategy = this.getStrategy();
    const tierRank = TIER_ORDER[tier] ?? 0;
    const configured =
      tier === "high" || tier === "normal"
        ? strategy.inferenceModel
        : tier === "low_compute"
          ? strategy.lowComputeModel
          : strategy.criticalModel;
    const others = [strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel];
    const out: ModelEntry[] = [];
    const seen = new Set<string>();
    const push = (e: ModelEntry) => {
      if (seen.has(e.modelId)) return;
      seen.add(e.modelId);
      out.push(e);
    };
    const tierOk = (e: ModelEntry) => tierRank >= (TIER_ORDER[e.tierMinimum] ?? 0);

    // Below normal money is scarce: any configured free local model beats
    // the tier's paid default (the picker sets only inferenceModel).
    const scarce = tier !== "high" && tier !== "normal";
    for (const id of scarce ? [configured, ...others] : [configured]) {
      if (!id) continue;
      const e = this.registry.get(id);
      if (this.servable(e) && this.isLocal(e)) push(e);
    }
    if (tier === "dead") return out;

    if (configured) {
      const e = this.registry.get(configured);
      if (this.servable(e) && (tierOk(e) || this.isLocal(e))) push(e);
    }

    const preference = this.getPreference(tier, taskType);
    for (const id of preference?.candidates ?? []) {
      const e = this.registry.get(id);
      if (this.servable(e)) push(e);
    }

    for (const id of others) {
      if (!id) continue;
      const e = this.registry.get(id);
      if (this.servable(e) && (tierOk(e) || this.isLocal(e))) push(e);
    }
    return out;
  }

  /** Survival turn: configured local models, then criticalModel, then the cheapest paid model. */
  survivalCandidates(tier: SurvivalTier): ModelEntry[] {
    const strategy = this.getStrategy();
    const out: ModelEntry[] = [];
    const seen = new Set<string>();
    const push = (e: ModelEntry) => {
      if (!seen.has(e.modelId)) {
        seen.add(e.modelId);
        out.push(e);
      }
    };
    for (const id of [strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel]) {
      const e = id ? this.registry.get(id) : undefined;
      if (this.servable(e) && this.isLocal(e)) push(e);
    }
    if (tier === "dead") return out;
    const critical = strategy.criticalModel ? this.registry.get(strategy.criticalModel) : undefined;
    if (this.servable(critical)) push(critical);
    // Cheap checks first, so a large imported catalog is sorted once and
    // canServe runs only until the first servable row. A survival turn
    // needs tools, and a model below its own tier floor is no fallback:
    // otherwise any imported catalog's cheapest model would be picked.
    const tierRank = TIER_ORDER[tier] ?? 0;
    const cheapest = this.registry
      .getAll()
      .filter(
        (e) =>
          e.enabled &&
          hasKnownPrice(e) &&
          !this.isLocal(e) &&
          (this.opts.legacySurvivalRow?.(e) === true ||
            (e.supportsTools && tierRank >= (TIER_ORDER[e.tierMinimum] ?? 99))),
      )
      .sort((a, b) => a.costPer1kOutput - b.costPer1kOutput || a.costPer1kInput - b.costPer1kInput)
      .find((e) => this.servable(e));
    if (cheapest) push(cheapest);
    return out;
  }

  /** First candidate for (tier, taskType), or null. */
  selectModel(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry | null {
    return this.candidates(tier, taskType)[0] ?? null;
  }

  /**
   * Merge consecutive same-role messages for every provider. Tool messages
   * stay tool messages: the Anthropic codec turns them into tool_result
   * blocks, which the API requires after a tool_use.
   */
  transformMessagesForProvider(messages: ChatMessage[], _provider: ModelProvider): ChatMessage[] {
    if (messages.length === 0) {
      throw new Error("Cannot route inference with empty message array");
    }
    return this.mergeConsecutiveSameRole(messages);
  }

  /**
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && msg.role !== "system" && msg.role !== "tool") {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }
      result.push({ ...msg });
    }

    return result;
  }

  private getPreference(tier: SurvivalTier, taskType: InferenceTaskType): ModelPreference | undefined {
    return DEFAULT_ROUTING_MATRIX[tier]?.[taskType];
  }
}

interface RouteCapabilities {
  minOutputTokens?: number;
  longPrompt?: { aboveInputTokens: number; inputUsdPerM: number; outputUsdPerM: number };
}

/** The capability fields routing reads (stored as JSON on the registry row). */
function capabilitiesOf(entry: ModelEntry): RouteCapabilities {
  let caps: unknown = (entry as { capabilities?: unknown }).capabilities;
  if (typeof caps === "string") {
    try {
      caps = JSON.parse(caps);
    } catch {
      caps = undefined;
    }
  }
  return caps && typeof caps === "object" ? (caps as RouteCapabilities) : {};
}

function outputFloor(entry: ModelEntry): number {
  const floor = Number(capabilitiesOf(entry).minOutputTokens ?? 0);
  return Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 0;
}

function hasKnownPrice(entry: ModelEntry): boolean {
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  return ok(Number(entry.costPer1kInput)) && ok(Number(entry.costPer1kOutput));
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = () => {
    const err = new Error("Inference attempt aborted");
    err.name = "AbortError";
    return err;
  };
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(aborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(aborted());
    };
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
