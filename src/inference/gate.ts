/**
 * Inference spend gate
 *
 * The one process-wide enforcement point for inference spend. Every HTTP
 * attempt, from the main loop's router and from the unified client used by
 * the planner, the orchestrator and workers, first reserves its worst-case
 * cost here, in one immediate SQLite transaction that checks every cap, and
 * afterwards settles it: committed at actual usage, released when the
 * provider provably did not bill, or held as 'unknown' at the reserved amount.
 *
 * Every cap is bounded by time, session or task. Nothing sums a lifetime, so
 * no bookkeeping state can lock the agent out for good.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { ChatMessage, SurvivalTier } from "../types.js";
import { estimateTokens } from "../agent/context.js";
import { ensureInferenceLedger } from "../state/database.js";
import { createLogger } from "../observability/logger.js";
import {
  InferenceRefusedError,
  isInferenceRefusal,
  type BudgetClass,
  type RefusalCode,
} from "./errors.js";
import {
  MICRO_USD_PER_CENT,
  costMicroUsd,
  effectivePrice,
  type ModelPrice,
  type ResolvedInferencePolicy,
} from "./policy.js";

export type { BudgetClass, RefusalCode } from "./errors.js";
export type { ModelPrice, ResolvedInferencePolicy } from "./policy.js";
export { ensureInferenceLedger } from "../state/database.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("inference.gate");

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** Rows older than this are pruned at startup; history past 24 h is reporting only. */
export const PRUNE_AFTER_MS = 30 * DAY_MS;
/** A row stamped further than this in the future means the clock moved back. */
const FUTURE_SKEW_MS = 60_000;

// ─── Scope ─────────────────────────────────────────────────────

export type InferenceCaller =
  | "agent_turn"
  | "inbox_turn"
  | "survival_turn"
  | "orchestrator.classify"
  | "orchestrator.plan"
  | "orchestrator.replan"
  | "worker"
  | "unattributed";

export interface InferenceScope {
  caller: InferenceCaller;
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  goalId?: string;
  workerId?: string;
  /** Cumulative cap for taskId, across retries. */
  taskCapCents?: number;
}

export type GateSurvivalTier = SurvivalTier | "unknown";

export interface SurvivalState {
  tier: GateSurvivalTier;
  creditsCents: number | null;
}

/** Main-loop turns are 'main', survival turns 'survival', everything else 'orchestration'. */
export function budgetClassFor(caller: InferenceCaller): BudgetClass {
  if (caller === "agent_turn" || caller === "inbox_turn") return "main";
  if (caller === "survival_turn") return "survival";
  return "orchestration";
}

/** Orchestration inference does not run at these tiers (owner decision D8). */
export function orchestrationPaused(tier: GateSurvivalTier): boolean {
  return tier === "low_compute" || tier === "critical" || tier === "dead" || tier === "unknown";
}

interface RegistryState {
  gate: InferenceGate | undefined;
  readonly scope: AsyncLocalStorage<InferenceScope>;
  readonly bootId: string;
}

const REGISTRY_KEY = Symbol.for("automaton.inference-gate");

function registry(): RegistryState {
  const g = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  let s = g[REGISTRY_KEY];
  if (!s) {
    s = { gate: undefined, scope: new AsyncLocalStorage<InferenceScope>(), bootId: ulid() };
    g[REGISTRY_KEY] = s;
  }
  return s;
}

const UNATTRIBUTED: InferenceScope = Object.freeze({ caller: "unattributed" as const });

/** Merges with the outer scope; a key present with value undefined clears it. */
export function runWithInferenceScope<T>(
  scope: Partial<InferenceScope> & { caller: InferenceCaller },
  fn: () => Promise<T>,
): Promise<T> {
  const outer = registry().scope.getStore() ?? UNATTRIBUTED;
  const merged: Record<string, unknown> = { ...outer, ...scope };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return registry().scope.run(merged as unknown as InferenceScope, fn);
}

/** { caller: "unattributed" } outside any scope. */
export function currentInferenceScope(): InferenceScope {
  return registry().scope.getStore() ?? UNATTRIBUTED;
}

export function installInferenceGate(g: InferenceGate): void {
  registry().gate = g;
}

export function getInstalledInferenceGate(): InferenceGate | undefined {
  return registry().gate;
}

/** The installed gate, or GATE_UNAVAILABLE so nothing paid is sent. */
export function requireInferenceGate(): InferenceGate {
  const g = registry().gate;
  if (!g) {
    throw new InferenceRefusedError("GATE_UNAVAILABLE", "No inference gate is installed", {
      retryAfterMs: null,
      budgetClass: budgetClassFor(currentInferenceScope().caller),
    });
  }
  return g;
}

export function resetInferenceGateForTests(): void {
  registry().gate = undefined;
}

export function inferenceGateBootId(): string {
  return registry().bootId;
}

// ─── Ledger SQL ────────────────────────────────────────────────

/** What a row holds against caps. */
const HELD =
  "CASE status WHEN 'committed' THEN COALESCE(cost_micro_usd, reserved_micro_usd) WHEN 'released' THEN 0 ELSE reserved_micro_usd END";

/**
 * Every statement the gate runs. Each SUM is bounded by a time window, a
 * session id or a task id (a test checks this).
 */
export const GATE_SQL = {
  recoverOrphans:
    "UPDATE inference_ledger SET status = 'unknown', error_class = 'orphaned', settled_at_ms = @now WHERE status = 'reserved' AND boot_id != @bootId",
  clampFuture: "UPDATE inference_ledger SET created_at_ms = @now WHERE created_at_ms > @limit",
  prune: "DELETE FROM inference_ledger WHERE created_at_ms < @before",
  sumWindowSpend: `SELECT COALESCE(SUM(${HELD}), 0) AS held FROM inference_ledger WHERE created_at_ms > @since AND budget_class IN ('main','orchestration')`,
  rowsWindowSpend: `SELECT created_at_ms AS t, ${HELD} AS held FROM inference_ledger WHERE created_at_ms > @since AND budget_class IN ('main','orchestration') ORDER BY created_at_ms ASC`,
  sumWindowOrchestration: `SELECT COALESCE(SUM(${HELD}), 0) AS held FROM inference_ledger WHERE created_at_ms > @since AND budget_class = 'orchestration'`,
  rowsWindowOrchestration: `SELECT created_at_ms AS t, ${HELD} AS held FROM inference_ledger WHERE created_at_ms > @since AND budget_class = 'orchestration' ORDER BY created_at_ms ASC`,
  sumWindowSurvival: `SELECT COALESCE(SUM(${HELD}), 0) AS held FROM inference_ledger WHERE created_at_ms > @since AND budget_class = 'survival'`,
  rowsWindowSurvival: `SELECT created_at_ms AS t, ${HELD} AS held FROM inference_ledger WHERE created_at_ms > @since AND budget_class = 'survival' ORDER BY created_at_ms ASC`,
  lastSurvival:
    "SELECT MAX(created_at_ms) AS t FROM inference_ledger WHERE created_at_ms > @since AND budget_class = 'survival' AND call_id != @callId",
  sumSession: `SELECT COALESCE(SUM(${HELD}), 0) AS held FROM inference_ledger WHERE session_id = @sessionId AND created_at_ms > @since AND budget_class != 'survival'`,
  sumTask: `SELECT COALESCE(SUM(${HELD}), 0) AS held FROM inference_ledger WHERE task_id = @taskId`,
  sumWindowByClass: `SELECT budget_class AS cls, COALESCE(SUM(${HELD}), 0) AS held, COUNT(*) AS n FROM inference_ledger WHERE created_at_ms > @since GROUP BY budget_class`,
  sumWindowUnknown:
    "SELECT COALESCE(SUM(reserved_micro_usd), 0) AS held FROM inference_ledger WHERE created_at_ms > @since AND status = 'unknown'",
  sumWindowByModel: `SELECT model, COALESCE(SUM(${HELD}), 0) AS held, COUNT(*) AS n FROM inference_ledger WHERE created_at_ms > @since GROUP BY model ORDER BY held DESC LIMIT 10`,
  countOpen: "SELECT COUNT(*) AS n FROM inference_ledger WHERE status = 'reserved'",
  insert: `INSERT INTO inference_ledger (id, call_id, attempt, status, budget_class, caller, session_id, task_id,
    goal_id, worker_id, turn_id, provider, model, tier, survival_tier, price_in_usd_per_m, price_out_usd_per_m,
    est_input_tokens, max_output_tokens, reserved_micro_usd, boot_id, created_at_ms)
    VALUES (@id, @callId, @attempt, 'reserved', @cls, @caller, @sessionId, @taskId, @goalId, @workerId, @turnId,
    @provider, @model, @tier, @survivalTier, @priceIn, @priceOut, @estIn, @maxOut, @reserved, @bootId, @now)`,
  get: "SELECT * FROM inference_ledger WHERE id = ?",
  commit: `UPDATE inference_ledger SET status = 'committed', input_tokens = @inTok, output_tokens = @outTok,
    cost_micro_usd = @cost, latency_ms = @latency, settled_at_ms = @now
    WHERE id = @id AND status IN ('reserved','unknown')`,
  release:
    "UPDATE inference_ledger SET status = 'released', error_class = @errorClass, settled_at_ms = @now WHERE id = @id AND status = 'reserved'",
  markUnknown:
    "UPDATE inference_ledger SET status = 'unknown', error_class = @errorClass, settled_at_ms = @now WHERE id = @id AND status = 'reserved'",
} as const;

// ─── Gate ──────────────────────────────────────────────────────

export interface ReserveRequest {
  callId: string;
  attempt: number;
  provider: string;
  model: string;
  tier?: string;
  /** The gate replaces a non-local zero price with the conservative price. */
  price: ModelPrice;
  estInputTokens: number;
  /** Desired. */
  maxOutputTokens: number;
  /** The gate may clamp down to this, never below. */
  minOutputTokens: number;
  /** For example the routing-matrix ceilingCents. */
  extraCeilingCents?: number;
  /** Default currentInferenceScope(). */
  scope?: InferenceScope;
}

export interface Reservation {
  id: string;
  maxOutputTokens: number;
  reservedMicroUsd: number;
}

export interface Headroom {
  allowed: boolean;
  code?: RefusalCode;
  retryAfterMs: number | null;
}

export interface ClassSpend {
  mainCents: number;
  orchestrationCents: number;
  survivalCents: number;
  /** main + orchestration: what the hourly and daily caps count. */
  cappedCents: number;
  calls: number;
}

export interface InferenceUsageReport {
  nowMs: number;
  caps: {
    hourlyCents: number;
    dailyCents: number;
    sessionCents: number;
    perCallCents: number;
    orchestrationSharePct: number;
    survivalAllowanceCents: number;
  };
  lastHour: ClassSpend;
  last24h: ClassSpend;
  remaining: { hourlyCents: number; dailyCents: number; survivalCents: number };
  unknownCents24h: number;
  openReservations: number;
  byModel24h: Array<{ model: string; cents: number; attempts: number }>;
  session?: { id: string; cents: number; capCents: number };
  survival: SurvivalState;
}

interface Refusal {
  code: RefusalCode;
  message: string;
  retryAfterMs: number | null;
}

interface EvalInput {
  cls: BudgetClass;
  scope: InferenceScope;
  needed: number;
  callId: string;
  now: number;
}

const cents = (micro: number): number => micro / MICRO_USD_PER_CENT;
const fmt = (micro: number): string => `${cents(micro).toFixed(2)}c`;

/** Pieces stay under the tokenizer's exact prefix, so long text is counted, not byte-bounded. */
const ESTIMATE_CHUNK_CHARS = 32_000;
/**
 * Time one input estimate may spend tokenizing. Ordinary text (prose, code,
 * JSON) tokenizes at well under a millisecond per thousand characters and is
 * always counted exactly. Dense text such as long CJK runs takes about 17 ms
 * per thousand characters. Once the budget is spent, the remaining text
 * counts one token per UTF-8 byte, which is an upper bound, so a large batch
 * of such text cannot block the event loop for seconds.
 */
const ESTIMATE_TIME_BUDGET_MS = 500;
/** Share of the locally counted output tokens that reported usage may not fall below. */
const OUTPUT_FLOOR_FACTOR = 0.75;

function estimateChunk(chunk: string, deadline: number): number {
  return performance.now() > deadline ? Buffer.byteLength(chunk, "utf8") : estimateTokens(chunk);
}

function estimatePiece(text: string, deadline: number): number {
  if (text.length === 0) return 0;
  if (text.length <= ESTIMATE_CHUNK_CHARS) return estimateChunk(text, deadline);
  let total = 0;
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + ESTIMATE_CHUNK_CHARS);
    // Do not split a surrogate pair.
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end += 1;
    total += estimateChunk(text.slice(start, end), deadline);
    start = end;
  }
  return total;
}

export class InferenceGate {
  readonly policy: ResolvedInferencePolicy;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly bootId: string;
  private survivalState: SurvivalState = { tier: "unknown", creditsCents: null };
  /** Free local reservations made while the ledger was unavailable (D9). */
  private readonly unrecordedLocal = new Set<string>();
  private readonly stmt: { [K in keyof typeof GATE_SQL]: BetterSqlite3.Statement };

  constructor(deps: { db: Database; policy: ResolvedInferencePolicy; now?: () => number; bootId?: string }) {
    this.db = deps.db;
    this.policy = deps.policy;
    this.now = deps.now ?? Date.now;
    this.bootId = deps.bootId ?? inferenceGateBootId();
    const now = this.now();
    ensureInferenceLedger(this.db, now);
    const stmt = {} as Record<string, BetterSqlite3.Statement>;
    for (const [k, sql] of Object.entries(GATE_SQL)) stmt[k] = this.db.prepare(sql);
    this.stmt = stmt as typeof this.stmt;

    // A process that died mid-call left 'reserved' rows: hold them as
    // unknown until they age out of the window.
    const orphans = this.stmt.recoverOrphans.run({ now, bootId: this.bootId }).changes;
    if (orphans > 0) logger.warn(`Held ${orphans} inference reservation(s) from a previous run as unknown`);
    this.clampFuture(now);
    this.stmt.prune.run({ before: now - PRUNE_AFTER_MS });
  }

  /** True when this gate keeps its ledger in `db`. */
  usesDatabase(db: Database): boolean {
    return this.db === db;
  }

  /** Input tokens of a request: the whole serialized payload, including tool schemas and tool calls. */
  estimateInputTokens(messages: ChatMessage[], tools?: unknown[]): number {
    // Count piece by piece: the tokenizer counts only a bounded prefix of one
    // text exactly and every byte after it as a token, so one serialized
    // payload would be overestimated several times over.
    const deadline = performance.now() + ESTIMATE_TIME_BUDGET_MS;
    let tokens = 0;
    for (const message of messages as unknown[]) {
      if (!message || typeof message !== "object") {
        tokens += estimatePiece(JSON.stringify(message) ?? "", deadline);
        continue;
      }
      for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
        if (key === "tool_calls" && Array.isArray(value)) {
          for (const call of value) tokens += estimatePiece(JSON.stringify(call) ?? "", deadline);
        } else if (typeof value === "string") {
          tokens += estimatePiece(value, deadline);
        } else if (Array.isArray(value)) {
          for (const part of value) tokens += estimatePiece(JSON.stringify(part) ?? "", deadline);
        } else if (value !== undefined) {
          tokens += estimatePiece(JSON.stringify(value) ?? "", deadline);
        }
      }
    }
    for (const tool of tools ?? []) tokens += estimatePiece(JSON.stringify(tool) ?? "", deadline);
    return Math.ceil(1.1 * tokens) + 8 * messages.length;
  }

  /** Reserve an attempt's worst case, or throw InferenceRefusedError. */
  reserve(req: ReserveRequest): Reservation {
    const scope = req.scope ?? currentInferenceScope();
    const cls = budgetClassFor(scope.caller);
    const price = effectivePrice(req.price, this.policy);
    let maxOut = Math.max(0, Math.floor(req.maxOutputTokens));
    const minOut = Math.min(Math.max(0, Math.floor(req.minOutputTokens)), maxOut);
    const estIn = Math.max(0, Math.ceil(req.estInputTokens));

    try {
      // Outside the reservation transaction, so a refusal does not roll the
      // clamp back and keep future-stamped rows held indefinitely.
      this.clampFuture(this.now());
      return this.db
        .transaction((): Reservation => {
          const now = this.now();

          if (!price.local) {
            const tierRefusal = this.tierRefusal(cls);
            if (tierRefusal) throw this.refuse(tierRefusal, cls);

            // Per call: clamp output so the worst case fits, refuse only if
            // the minimum does not.
            const ceilingCents = this.perCallCeilingCents(req.extraCeilingCents);
            if (ceilingCents !== null) {
              const ceiling = ceilingCents * MICRO_USD_PER_CENT;
              const inMicro = estIn * price.inputUsdPerM;
              if (inMicro + minOut * price.outputUsdPerM > ceiling) {
                throw this.refuse(
                  {
                    code: "PER_CALL_CEILING",
                    message:
                      `Per-call ceiling ${ceilingCents}c: ${req.model} needs at least ` +
                      `${fmt(Math.ceil(inMicro + minOut * price.outputUsdPerM))} (${estIn} input tokens + ${minOut} output)`,
                    retryAfterMs: null,
                  },
                  cls,
                );
              }
              if (inMicro + maxOut * price.outputUsdPerM > ceiling) {
                maxOut = Math.max(minOut, Math.floor((ceiling - inMicro) / price.outputUsdPerM));
              }
            }
          }

          const needed = costMicroUsd(price, estIn, maxOut);
          if (!price.local) {
            const refusal = this.evaluate({ cls, scope, needed, callId: req.callId, now });
            if (refusal) throw this.refuse(refusal, cls);
          }

          const id = ulid();
          this.stmt.insert.run({
            id,
            callId: req.callId,
            attempt: req.attempt,
            cls,
            caller: scope.caller,
            sessionId: scope.sessionId ?? null,
            taskId: scope.taskId ?? null,
            goalId: scope.goalId ?? null,
            workerId: scope.workerId ?? null,
            turnId: scope.turnId ?? null,
            provider: req.provider,
            model: req.model,
            tier: req.tier ?? null,
            survivalTier: this.survivalState.tier,
            priceIn: price.inputUsdPerM,
            priceOut: price.outputUsdPerM,
            estIn,
            maxOut,
            reserved: needed,
            bootId: this.bootId,
            now,
          });
          return { id, maxOutputTokens: maxOut, reservedMicroUsd: needed };
        })
        .immediate();
    } catch (err) {
      if (isInferenceRefusal(err)) throw err;
      logger.error("Inference ledger unavailable", err instanceof Error ? err : undefined);
      if (price.local) {
        // D9: free local models stay available when the ledger is not.
        const id = `local-${ulid()}`;
        this.unrecordedLocal.add(id);
        return { id, maxOutputTokens: maxOut, reservedMicroUsd: 0 };
      }
      throw new InferenceRefusedError(
        "GATE_UNAVAILABLE",
        `Inference ledger unavailable: ${err instanceof Error ? err.message : String(err)}`,
        { retryAfterMs: null, budgetClass: cls },
      );
    }
  }

  /**
   * Settle at actual usage. Missing or partial usage on a paid model commits
   * the reserved amount; `outputText` (content plus tool-call arguments) sets
   * a floor under reported output tokens.
   */
  commit(
    id: string,
    usage: { inputTokens: number; outputTokens: number } | null,
    latencyMs: number,
    opts: { outputText?: string } = {},
  ): { costMicroUsd: number } {
    if (this.unrecordedLocal.delete(id)) return { costMicroUsd: 0 };
    try {
      const row = this.stmt.get.get(id) as LedgerRowRaw | undefined;
      if (!row) return { costMicroUsd: 0 };
      if (row.status === "committed") return { costMicroUsd: row.cost_micro_usd ?? 0 };
      if (row.status === "released") return { costMicroUsd: 0 };
      const local = row.price_in_usd_per_m === 0 && row.price_out_usd_per_m === 0;
      const inTok = Math.max(0, Math.floor(usage?.inputTokens ?? 0));
      let outTok = Math.max(0, Math.floor(usage?.outputTokens ?? 0));
      // Callers map an absent usage field to 0, and no billed request has 0
      // prompt or 0 completion tokens: either one zero means partial usage.
      const usable =
        !!usage &&
        Number.isFinite(usage.inputTokens) &&
        Number.isFinite(usage.outputTokens) &&
        inTok > 0 &&
        outTok > 0;
      let cost: number;
      if (local) {
        cost = 0;
      } else if (!usable) {
        cost = row.reserved_micro_usd;
      } else {
        if (opts.outputText) {
          // Allow for tokenizer differences; this catches gross under-reporting.
          const floor = Math.min(
            row.max_output_tokens,
            Math.floor(OUTPUT_FLOOR_FACTOR * estimatePiece(opts.outputText, performance.now() + ESTIMATE_TIME_BUDGET_MS)),
          );
          outTok = Math.max(outTok, floor);
        }
        cost = Math.ceil(inTok * row.price_in_usd_per_m + outTok * row.price_out_usd_per_m);
        if (row.est_input_tokens > 0 && inTok > row.est_input_tokens * 1.25) {
          logger.warn(
            `Inference input for ${row.model} was ${(inTok / row.est_input_tokens).toFixed(2)}x the estimate ` +
              `(${inTok} vs ${row.est_input_tokens} tokens)`,
          );
        }
      }
      this.stmt.commit.run({
        id,
        inTok: usage ? inTok : null,
        outTok: usage ? outTok : null,
        cost,
        latency: Math.max(0, Math.round(latencyMs)),
        now: this.now(),
      });
      return { costMicroUsd: cost };
    } catch (err) {
      logger.error("Failed to commit inference spend", err instanceof Error ? err : undefined);
      return { costMicroUsd: 0 };
    }
  }

  /** The provider provably did not bill. */
  release(id: string, errorClass: string): void {
    if (this.unrecordedLocal.delete(id)) return;
    try {
      this.stmt.release.run({ id, errorClass, now: this.now() });
    } catch (err) {
      logger.error("Failed to release inference reservation", err instanceof Error ? err : undefined);
    }
  }

  /** The provider may have billed: held at the reserved amount until it ages out. */
  markUnknown(id: string, errorClass: string): void {
    if (this.unrecordedLocal.delete(id)) return;
    try {
      this.stmt.markUnknown.run({ id, errorClass, now: this.now() });
    } catch (err) {
      logger.error("Failed to mark inference reservation unknown", err instanceof Error ? err : undefined);
    }
  }

  /** Reserved and not settled. */
  isOpen(id: string): boolean {
    if (this.unrecordedLocal.has(id)) return true;
    try {
      const row = this.stmt.get.get(id) as LedgerRowRaw | undefined;
      return row?.status === "reserved";
    } catch {
      return false;
    }
  }

  /** Whether any paid spend of this class would currently be allowed. */
  headroom(cls: BudgetClass, scope?: InferenceScope): Headroom {
    const s: InferenceScope = scope ?? { ...currentInferenceScope(), caller: callerForClass(cls) };
    try {
      this.clampFuture(this.now());
      return this.db
        .transaction((): Headroom => {
          const now = this.now();
          const refusal =
            this.tierRefusal(cls) ?? this.evaluate({ cls, scope: s, needed: 1, callId: "", now });
          return refusal
            ? { allowed: false, code: refusal.code, retryAfterMs: refusal.retryAfterMs }
            : { allowed: true, retryAfterMs: null };
        })
        .immediate();
    } catch (err) {
      logger.error("Inference ledger unavailable", err instanceof Error ? err : undefined);
      return { allowed: false, code: "GATE_UNAVAILABLE", retryAfterMs: null };
    }
  }

  setSurvival(s: { tier: GateSurvivalTier; creditsCents: number | null }): void {
    this.survivalState = { tier: s.tier, creditsCents: s.creditsCents };
  }

  survival(): SurvivalState {
    return { ...this.survivalState };
  }

  /** Cumulative spend of a task across all its attempts and retries (fractional cents). */
  taskSpendCents(taskId: string): number {
    try {
      const row = this.stmt.sumTask.get({ taskId }) as { held: number };
      return cents(row.held);
    } catch {
      return 0;
    }
  }

  usage(opts: { sessionId?: string } = {}): InferenceUsageReport {
    const now = this.now();
    const spend = (since: number): ClassSpend => {
      const rows = this.stmt.sumWindowByClass.all({ since }) as Array<{ cls: BudgetClass; held: number; n: number }>;
      const by = (c: BudgetClass) => rows.find((r) => r.cls === c)?.held ?? 0;
      return {
        mainCents: cents(by("main")),
        orchestrationCents: cents(by("orchestration")),
        survivalCents: cents(by("survival")),
        cappedCents: cents(by("main") + by("orchestration")),
        calls: rows.reduce((s, r) => s + r.n, 0),
      };
    };
    const lastHour = spend(now - HOUR_MS);
    const last24h = spend(now - DAY_MS);
    const p = this.policy;
    const report: InferenceUsageReport = {
      nowMs: now,
      caps: {
        hourlyCents: p.hourlyCapCents,
        dailyCents: p.dailyCapCents,
        sessionCents: p.sessionCapCents,
        perCallCents: p.perCallCeilingCents,
        orchestrationSharePct: p.orchestrationSharePct,
        survivalAllowanceCents: p.survivalAllowanceCents,
      },
      lastHour,
      last24h,
      remaining: {
        hourlyCents: Math.max(0, p.hourlyCapCents - lastHour.cappedCents),
        dailyCents: Math.max(0, p.dailyCapCents - last24h.cappedCents),
        survivalCents: Math.max(0, p.survivalAllowanceCents - last24h.survivalCents),
      },
      unknownCents24h: cents((this.stmt.sumWindowUnknown.get({ since: now - DAY_MS }) as { held: number }).held),
      openReservations: (this.stmt.countOpen.get() as { n: number }).n,
      byModel24h: (
        this.stmt.sumWindowByModel.all({ since: now - DAY_MS }) as Array<{ model: string; held: number; n: number }>
      ).map((r) => ({ model: r.model, cents: cents(r.held), attempts: r.n })),
      survival: this.survival(),
    };
    if (opts.sessionId) {
      const row = this.stmt.sumSession.get({ sessionId: opts.sessionId, since: now - DAY_MS }) as { held: number };
      report.session = { id: opts.sessionId, cents: cents(row.held), capCents: p.sessionCapCents };
    }
    return report;
  }

  // ─── internals ───────────────────────────────────────────────

  private clampFuture(now: number): void {
    const n = this.stmt.clampFuture.run({ now, limit: now + FUTURE_SKEW_MS }).changes;
    if (n > 0) logger.warn(`Clamped ${n} inference ledger row(s) stamped in the future (clock moved back)`);
  }

  private refuse(r: Refusal, cls: BudgetClass): InferenceRefusedError {
    return new InferenceRefusedError(r.code, r.message, { retryAfterMs: r.retryAfterMs, budgetClass: cls });
  }

  private tierRefusal(cls: BudgetClass): Refusal | null {
    const tier = this.survivalState.tier;
    if (tier === "dead") {
      return { code: "SURVIVAL_TIER", message: "Survival tier is dead: no paid inference", retryAfterMs: null };
    }
    if (cls === "orchestration" && orchestrationPaused(tier)) {
      return {
        code: "SURVIVAL_TIER",
        message: `Orchestration inference is paused at survival tier ${tier}`,
        retryAfterMs: null,
      };
    }
    return null;
  }

  private perCallCeilingCents(extra: number | undefined): number | null {
    const ceilings: number[] = [];
    if (this.policy.perCallCeilingCents > 0) ceilings.push(this.policy.perCallCeilingCents);
    if (typeof extra === "number" && Number.isFinite(extra) && extra >= 0) ceilings.push(extra);
    return ceilings.length > 0 ? Math.min(...ceilings) : null;
  }

  /** Task, session, then window caps, in that order. */
  private evaluate(input: EvalInput): Refusal | null {
    const { cls, scope, needed, now } = input;
    const p = this.policy;

    if (scope.taskId && typeof scope.taskCapCents === "number" && scope.taskCapCents >= 0) {
      const spent = (this.stmt.sumTask.get({ taskId: scope.taskId }) as { held: number }).held;
      const cap = scope.taskCapCents * MICRO_USD_PER_CENT;
      if (spent + needed > cap) {
        return {
          code: "TASK_CAP",
          message: `Task ${scope.taskId} budget exhausted: ${fmt(spent)} spent + ${fmt(needed)} > ${scope.taskCapCents}c`,
          retryAfterMs: null,
        };
      }
    }

    if (cls === "survival") return this.evaluateSurvival(input);

    if (p.sessionCapCents > 0 && scope.sessionId) {
      const spent = (this.stmt.sumSession.get({ sessionId: scope.sessionId, since: now - DAY_MS }) as { held: number })
        .held;
      if (spent + needed > p.sessionCapCents * MICRO_USD_PER_CENT) {
        return {
          code: "SESSION_CAP",
          message: `Session budget exhausted: ${fmt(spent)} spent + ${fmt(needed)} > ${p.sessionCapCents}c`,
          retryAfterMs: p.sessionCooldownMs,
        };
      }
    }

    if (cls === "orchestration") {
      const share = p.orchestrationSharePct / 100;
      const r =
        this.window("orchestration", HOUR_MS, p.hourlyCapCents * share, needed, now, "ORCHESTRATION_SHARE", "hourly orchestration share") ??
        this.window("orchestration", DAY_MS, p.dailyCapCents * share, needed, now, "ORCHESTRATION_SHARE", "daily orchestration share");
      if (r) return r;
    }

    return (
      this.window("spend", HOUR_MS, p.hourlyCapCents, needed, now, "HOURLY_CAP", "hourly inference cap") ??
      this.window("spend", DAY_MS, p.dailyCapCents, needed, now, "DAILY_CAP", "daily inference cap")
    );
  }

  private evaluateSurvival(input: EvalInput): Refusal | null {
    const { needed, now, callId } = input;
    const p = this.policy;
    if (p.survivalAllowanceCents <= 0) {
      return { code: "SURVIVAL_ALLOWANCE", message: "Survival allowance is disabled", retryAfterMs: null };
    }
    if (p.survivalMinIntervalMs > 0) {
      const last = (this.stmt.lastSurvival.get({ since: now - p.survivalMinIntervalMs, callId }) as { t: number | null }).t;
      if (last !== null && last !== undefined) {
        return {
          code: "SURVIVAL_ALLOWANCE",
          message: "A survival turn already ran in the last interval",
          retryAfterMs: Math.max(1, last + p.survivalMinIntervalMs - now),
        };
      }
    }
    return this.window("survival", DAY_MS, p.survivalAllowanceCents, needed, now, "SURVIVAL_ALLOWANCE", "survival allowance");
  }

  /**
   * Rolling-window check. On refusal, retryAfterMs is the earliest time
   * enough held spend ages out for the request to fit, or null when the
   * request alone exceeds the cap (no amount of waiting helps).
   */
  private window(
    kind: "spend" | "orchestration" | "survival",
    windowMs: number,
    capCents: number,
    needed: number,
    now: number,
    code: RefusalCode,
    label: string,
  ): Refusal | null {
    const cap = Math.floor(capCents * MICRO_USD_PER_CENT);
    const since = now - windowMs;
    const sumStmt =
      kind === "spend" ? this.stmt.sumWindowSpend : kind === "orchestration" ? this.stmt.sumWindowOrchestration : this.stmt.sumWindowSurvival;
    const held = (sumStmt.get({ since }) as { held: number }).held;
    if (held + needed <= cap) return null;

    let retryAfterMs: number | null = null;
    if (needed <= cap) {
      const rowsStmt =
        kind === "spend" ? this.stmt.rowsWindowSpend : kind === "orchestration" ? this.stmt.rowsWindowOrchestration : this.stmt.rowsWindowSurvival;
      let aged = 0;
      for (const row of rowsStmt.iterate({ since }) as Iterable<{ t: number; held: number }>) {
        aged += row.held;
        if (held - aged + needed <= cap) {
          retryAfterMs = Math.max(1, row.t + windowMs - now + 1);
          break;
        }
      }
    }
    const capText = `${(cap / MICRO_USD_PER_CENT).toFixed(2)}c`;
    return {
      code,
      message:
        needed > cap
          ? `This call (${fmt(needed)}) alone exceeds the ${label} of ${capText}`
          : `The ${label} is exhausted: ${fmt(held)} held + ${fmt(needed)} > ${capText}`,
      retryAfterMs,
    };
  }
}

function callerForClass(cls: BudgetClass): InferenceCaller {
  if (cls === "main") return "agent_turn";
  if (cls === "survival") return "survival_turn";
  return "unattributed";
}

interface LedgerRowRaw {
  id: string;
  status: "reserved" | "committed" | "released" | "unknown";
  model: string;
  price_in_usd_per_m: number;
  price_out_usd_per_m: number;
  est_input_tokens: number;
  max_output_tokens: number;
  reserved_micro_usd: number;
  cost_micro_usd: number | null;
}
