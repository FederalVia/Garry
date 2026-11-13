/**
 * Durable Scheduler
 *
 * DB-backed heartbeat scheduler with tick overlap guard,
 * task leases, timeouts, and retry logic.
 *
 * Replaces the fragile setInterval-based heartbeat.
 */

import type BetterSqlite3 from "better-sqlite3";
import cronParser from "cron-parser";
import type {
  HeartbeatConfig,
  HeartbeatTaskFn,
  HeartbeatLegacyContext,
  HeartbeatScheduleRow,
  TickContext,
} from "../types.js";
import { buildTickContext, type TickContextOptions } from "./tick-context.js";
import { resolveRuntime } from "../providers/mode.js";
import { ALL_FEATURES, taskAllowed, type FeatureSet } from "../providers/features.js";
import {
  getHeartbeatSchedule,
  updateHeartbeatSchedule,
  insertHeartbeatHistory,
  pruneExpiredDedupKeys,
  insertWakeEvent,
} from "../state/database.js";
import {
  acquireScheduleLease,
  clearExpiredScheduleLeases,
  extendScheduleLease,
  getTaskAlias,
  releaseScheduleLease,
} from "./schedule-store.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.scheduler");

const DEFAULT_TASK_TIMEOUT_MS = 30_000;
const LEASE_TTL_MS = 60_000;
/**
 * A task still running this long after it started is given up on: its lease
 * is released and it may start again. Its late result is still handled.
 */
const ABANDON_AFTER_MIN_MS = 10 * 60_000;
const ABANDON_AFTER_TIMEOUTS = 10;
/** A last run this far in the future means the clock stepped back. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
const HISTORY_ID_COUNTER = { value: 0 };

/** Never slowed by the low-compute multiplier: survival depends on them. */
export const ESSENTIAL_HEARTBEAT_TASKS: ReadonlySet<string> = new Set([
  "heartbeat_ping",
  "check_credits",
  "check_usdc_balance",
]);

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  HISTORY_ID_COUNTER.value++;
  return `${timestamp}-${random}-${HISTORY_ID_COUNTER.value.toString(36)}`;
}

function timeoutSignal(ms: number): { promise: Promise<"timeout">; clear: () => void } {
  let timerId: ReturnType<typeof setTimeout>;
  const promise = new Promise<"timeout">((resolve) => {
    timerId = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, clear: () => clearTimeout(timerId!) };
}

// Survival tier ordering for tier minimum checks
const TIER_ORDER: Record<string, number> = {
  dead: 0,
  critical: 1,
  low_compute: 2,
  normal: 3,
  high: 4,
};

function tierMeetsMinimum(currentTier: string, minimumTier: string): boolean {
  return (TIER_ORDER[currentTier] ?? 0) >= (TIER_ORDER[minimumTier] ?? 0);
}

type TaskResult = { shouldWake: boolean; message?: string };

interface InFlightTask {
  /** Resolves once the task settled and its outcome was handled. */
  done: Promise<void>;
  startedMs: number;
  abandonAt: number;
  settled: boolean;
  timedOut: boolean;
  abandoned: boolean;
}

export class DurableScheduler {
  private tickInProgress = false;
  private currentTick: Promise<void> | null = null;
  private stopped = false;
  private readonly ownerId: string;
  private readonly inFlight = new Map<string, InFlightTask>();
  private readonly warnedMissing = new Set<string>();

  constructor(
    private readonly db: DatabaseType,
    private readonly config: HeartbeatConfig,
    private readonly tasks: Map<string, HeartbeatTaskFn>,
    private readonly legacyContext: HeartbeatLegacyContext,
    private readonly onWakeRequest?: (reason: string) => void,
  ) {
    this.ownerId = `scheduler-${Date.now().toString(36)}`;
  }

  /**
   * Called on interval -- guards against overlap.
   */
  async tick(): Promise<void> {
    if (this.tickInProgress || this.stopped) return;
    this.tickInProgress = true;
    const run = this.runTick();
    this.currentTick = run;
    try {
      await run;
    } finally {
      this.tickInProgress = false;
      this.currentTick = null;
    }
  }

  private async runTick(): Promise<void> {
    try {
      // Clear any expired leases first
      clearExpiredScheduleLeases(this.db);

      // Build shared context (single API call for balance)
      const context = await buildTickContext(
        this.db,
        this.legacyContext.conway,
        this.config,
        this.legacyContext.identity.address,
        this.legacyContext.identity.chainType,
        tickOptionsFor(this.legacyContext),
      );

      // Get tasks that are due
      const dueTasks = this.getDueTasks(context);

      for (const task of dueTasks) {
        if (this.stopped) break;
        await this.executeTask(task.taskName, context);
      }

      // Periodic cleanup
      pruneExpiredDedupKeys(this.db);
    } catch (err: any) {
      logger.error("Tick failed", err instanceof Error ? err : undefined);
    }
  }

  /** No new task starts after this; a running task is not interrupted. */
  stop(): void {
    this.stopped = true;
  }

  resume(): void {
    this.stopped = false;
  }

  /**
   * Wait for the current tick and every task still running (including ones
   * past their timeout), at most timeoutMs.
   */
  async drain(timeoutMs: number): Promise<void> {
    const pending: Promise<unknown>[] = [];
    if (this.currentTick) pending.push(this.currentTick);
    for (const flight of this.inFlight.values()) pending.push(flight.done);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    });
    try {
      await Promise.race([Promise.allSettled(pending).then(() => undefined), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Names of entries whose task is still running. */
  getInFlightTasks(): string[] {
    return [...this.inFlight.keys()];
  }

  /** The task function an entry runs: its own name, else its alias. */
  private resolveTask(entryName: string): { fn?: HeartbeatTaskFn; taskName: string } {
    const own = this.tasks.get(entryName);
    if (own) return { fn: own, taskName: entryName };
    let alias: string | undefined;
    try {
      alias = getTaskAlias(this.db, entryName);
    } catch {
      alias = undefined;
    }
    if (alias) return { fn: this.tasks.get(alias), taskName: alias };
    return { taskName: entryName };
  }

  /**
   * Check which tasks are due based on DB schedule.
   */
  getDueTasks(context: TickContext): HeartbeatScheduleRow[] {
    const schedule = getHeartbeatSchedule(this.db);
    const now = new Date();
    const nowMs = now.getTime();
    const multiplier = context.lowComputeMultiplier;
    const slowed =
      (TIER_ORDER[context.survivalTier] ?? 0) <= TIER_ORDER.low_compute &&
      typeof multiplier === "number" &&
      Number.isFinite(multiplier) &&
      multiplier > 1;

    return schedule.filter((row) => {
      // Skip disabled tasks
      if (!row.enabled) return false;

      // Skip tasks that require a higher survival tier
      if (!tierMeetsMinimum(context.survivalTier, row.tierMinimum)) return false;

      // Skip if lease is held by someone else
      if (row.leaseOwner && row.leaseOwner !== this.ownerId) {
        if (row.leaseExpiresAt && new Date(row.leaseExpiresAt) > now) {
          return false;
        }
      }

      const lastRunMs = row.lastRunAt ? Date.parse(row.lastRunAt) : NaN;
      // A last run in the future means the clock stepped back: run now
      // instead of waiting for the clock to catch up.
      if (Number.isFinite(lastRunMs) && lastRunMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
        return true;
      }

      // Check if a retry was explicitly scheduled via nextRunAt
      if (row.nextRunAt && new Date(row.nextRunAt) <= now) {
        return true;
      }

      // Low compute stretches the period of every non-essential task.
      const stretch =
        slowed && Number.isFinite(lastRunMs) && !ESSENTIAL_HEARTBEAT_TASKS.has(this.resolveTask(row.taskName).taskName);

      // Check if task is due based on cron expression
      if (row.cronExpression) {
        try {
          const currentDate = Number.isFinite(lastRunMs)
            ? new Date(lastRunMs)
            : new Date(nowMs - 86400000); // If never run, assume due

          const interval = cronParser.parseExpression(row.cronExpression, {
            currentDate,
          });
          const nextRun = interval.next().toDate();
          if (nextRun > now) return false;
          if (!stretch) return true;
          const following = interval.next().toDate();
          const periodMs = Math.max(following.getTime() - nextRun.getTime(), 0);
          return nowMs >= lastRunMs + periodMs * multiplier;
        } catch {
          return false;
        }
      }

      // Check if task is due based on intervalMs
      if (row.intervalMs) {
        if (!Number.isFinite(lastRunMs)) return true;
        const elapsed = nowMs - lastRunMs;
        return elapsed >= row.intervalMs * (stretch ? multiplier : 1);
      }

      return false;
    });
  }

  /**
   * Execute a single task with timeout and lease.
   *
   * On timeout the timeout is recorded, but the task cannot be cancelled:
   * the lease stays held and no second copy starts until it settles. Its
   * late result is then handled (a wake is still delivered). A task that
   * never settles is given up on after max(10 x timeout, 10 min).
   */
  async executeTask(taskName: string, ctx: TickContext): Promise<void> {
    const entryName = taskName;
    const schedule = getHeartbeatSchedule(this.db).find(
      (r) => r.taskName === entryName,
    );
    const { fn: taskFn, taskName: resolvedTask } = this.resolveTask(entryName);
    // A task for a feature this runtime lacks (standalone mode) is skipped,
    // not failed; heartbeat.yml keeps the entry.
    if (taskFn && !taskAllowed(resolvedTask, featuresOf(this.legacyContext))) {
      logger.debug(`Skipped heartbeat task '${entryName}': feature off in this mode`);
      return;
    }
    if (!taskFn) {
      if (!this.warnedMissing.has(entryName)) {
        this.warnedMissing.add(entryName);
        logger.warn(`No task function for heartbeat entry '${entryName}'`);
      }
      if (schedule) {
        this.recordFailure(entryName, new Error(`no task function for '${entryName}'`), 0, new Date().toISOString());
      }
      return;
    }
    const timeoutMs = schedule?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

    const running = this.inFlight.get(entryName);
    if (running) {
      if (Date.now() < running.abandonAt) return;
      running.abandoned = true;
      this.inFlight.delete(entryName);
      this.releaseLease(entryName);
      logger.warn(
        `Task '${entryName}' has not settled ${Math.round((Date.now() - running.startedMs) / 1000)}s after it started; starting it again`,
      );
    }

    // Acquire lease
    if (!this.acquireLease(entryName)) return;

    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const flight: InFlightTask = {
      done: Promise.resolve(),
      startedMs: startMs,
      abandonAt: startMs + Math.max(ABANDON_AFTER_MIN_MS, timeoutMs * ABANDON_AFTER_TIMEOUTS),
      settled: false,
      timedOut: false,
      abandoned: false,
    };
    const run = Promise.resolve().then(() => taskFn(ctx, this.legacyContext));
    flight.done = run.then(
      (result) => this.onTaskSettled(entryName, resolvedTask, flight, startedAt, { ok: true, result }),
      (error) => this.onTaskSettled(entryName, resolvedTask, flight, startedAt, { ok: false, error }),
    );
    this.inFlight.set(entryName, flight);

    const timeout = timeoutSignal(timeoutMs);
    const first = await Promise.race([flight.done.then(() => "settled" as const), timeout.promise]);
    timeout.clear();
    if (first === "timeout" && !flight.settled) {
      flight.timedOut = true;
      try {
        this.recordFailure(
          entryName,
          new Error(`Task timed out after ${timeoutMs}ms`),
          Date.now() - startMs,
          startedAt,
          "timeout",
        );
        this.scheduleRetryIfAllowed(entryName, schedule);
        // Keep the lease until the task settles (or is given up on).
        extendScheduleLease(this.db, entryName, this.ownerId, Math.max(flight.abandonAt - Date.now(), LEASE_TTL_MS));
      } catch (err) {
        logger.error(`Recording timeout of '${entryName}' failed`, err instanceof Error ? err : undefined);
      }
    }
  }

  private onTaskSettled(
    entryName: string,
    resolvedTask: string,
    flight: InFlightTask,
    startedAt: string,
    outcome: { ok: true; result: TaskResult } | { ok: false; error: unknown },
  ): void {
    flight.settled = true;
    if (this.inFlight.get(entryName) === flight) this.inFlight.delete(entryName);
    const late = flight.timedOut || flight.abandoned;
    try {
      if (!late) {
        if (outcome.ok) {
          this.recordSuccess(entryName, Date.now() - flight.startedMs, startedAt);
        } else {
          const err = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
          this.recordFailure(entryName, err, Date.now() - flight.startedMs, startedAt, "failure");
          const schedule = getHeartbeatSchedule(this.db).find((r) => r.taskName === entryName);
          this.scheduleRetryIfAllowed(entryName, schedule);
        }
      } else if (outcome.ok) {
        logger.info(`Task '${entryName}' finished after its timeout`);
      } else {
        const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        logger.warn(`Task '${entryName}' failed after its timeout: ${msg}`);
      }

      if (outcome.ok && outcome.result?.shouldWake) {
        const reason = outcome.result.message || `Heartbeat task '${entryName}' requested wake`;
        this.deliverWake(reason, entryName, resolvedTask);
      }
    } catch (err) {
      logger.error(`Handling the result of '${entryName}' failed`, err instanceof Error ? err : undefined);
    } finally {
      if (!flight.abandoned) {
        try {
          this.releaseLease(entryName);
        } catch {
          // database closed
        }
      }
    }
  }

  /** The scheduler is the only writer of heartbeat wake events; the callback only notifies. */
  private deliverWake(reason: string, entryName: string, resolvedTask: string): void {
    const payload: Record<string, string> = { taskName: resolvedTask };
    if (entryName !== resolvedTask) payload.entryName = entryName;
    insertWakeEvent(this.db, "heartbeat", reason, payload);
    try {
      this.onWakeRequest?.(reason);
    } catch (err) {
      logger.error("onWakeRequest callback failed", err instanceof Error ? err : undefined);
    }
  }

  /**
   * Retry while the consecutive failures, the current one included, are at
   * most maxRetries.
   */
  private scheduleRetryIfAllowed(taskName: string, schedule: HeartbeatScheduleRow | undefined): void {
    if (!schedule || schedule.maxRetries <= 0) return;
    if (this.getRecentFailures(taskName) <= schedule.maxRetries) {
      this.scheduleRetry(taskName);
    }
  }

  /**
   * Acquire a lease for a task.
   */
  acquireLease(taskName: string): boolean {
    return acquireScheduleLease(this.db, taskName, this.ownerId, LEASE_TTL_MS);
  }

  /**
   * Release a lease for a task.
   */
  releaseLease(taskName: string): void {
    releaseScheduleLease(this.db, taskName, this.ownerId);
  }

  /**
   * Record a successful task execution.
   */
  recordSuccess(taskName: string, durationMs: number, startedAt: string): void {
    const now = new Date().toISOString();

    insertHeartbeatHistory(this.db, {
      id: generateId(),
      taskName,
      startedAt,
      completedAt: now,
      result: "success",
      durationMs,
      error: null,
      idempotencyKey: null,
    });

    updateHeartbeatSchedule(this.db, taskName, {
      lastRunAt: now,
      nextRunAt: null, // Clear any pending retry
      lastResult: "success",
      lastError: null,
      runCount: (this.getRunCount(taskName) ?? 0) + 1,
    });
  }

  /**
   * Record a failed task execution.
   */
  recordFailure(
    taskName: string,
    error: Error,
    durationMs: number,
    startedAt: string,
    result: "failure" | "timeout" = "failure",
  ): void {
    const now = new Date().toISOString();
    const errorMessage = error.message || String(error);

    insertHeartbeatHistory(this.db, {
      id: generateId(),
      taskName,
      startedAt,
      completedAt: now,
      result,
      durationMs,
      error: errorMessage,
      idempotencyKey: null,
    });

    // A spent retry time must not keep the task due; a new retry is set after this.
    updateHeartbeatSchedule(this.db, taskName, {
      lastRunAt: now,
      nextRunAt: null,
      lastResult: result,
      lastError: errorMessage,
      failCount: (this.getFailCount(taskName) ?? 0) + 1,
      runCount: (this.getRunCount(taskName) ?? 0) + 1,
    });

    logger.error(`Task '${taskName}' ${result}: ${errorMessage}`);
  }

  /**
   * Prune old history entries.
   */
  pruneHistory(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const result = this.db.prepare(
      "DELETE FROM heartbeat_history WHERE started_at < ?",
    ).run(cutoff);
    return result.changes;
  }

  /**
   * Prune expired dedup keys.
   */
  pruneExpiredDedupKeys(): number {
    return pruneExpiredDedupKeys(this.db);
  }

  // ─── Private helpers ──────────────────────────────────────────

  private getRunCount(taskName: string): number {
    const row = this.db.prepare(
      "SELECT run_count FROM heartbeat_schedule WHERE task_name = ?",
    ).get(taskName) as { run_count: number } | undefined;
    return row?.run_count ?? 0;
  }

  private getFailCount(taskName: string): number {
    const row = this.db.prepare(
      "SELECT fail_count FROM heartbeat_schedule WHERE task_name = ?",
    ).get(taskName) as { fail_count: number } | undefined;
    return row?.fail_count ?? 0;
  }

  private getRecentFailures(taskName: string): number {
    // Count consecutive recent failures (since last success)
    const rows = this.db.prepare(
      `SELECT result FROM heartbeat_history
       WHERE task_name = ? ORDER BY started_at DESC LIMIT 10`,
    ).all(taskName) as { result: string }[];

    let count = 0;
    for (const row of rows) {
      if (row.result === "success") break;
      count++;
    }
    return count;
  }

  private scheduleRetry(taskName: string): void {
    // Reset next_run_at to now + 30s for a quick retry
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    updateHeartbeatSchedule(this.db, taskName, {
      nextRunAt: retryAt,
    });
  }
}

/** Features of the runtime this context belongs to; a context without a config is Conway. */
function featuresOf(ctx: HeartbeatLegacyContext): FeatureSet {
  return ctx.config ? resolveRuntime(ctx.config).features : ALL_FEATURES;
}

/** Tick options for the runtime: a fixed tier reads no balance; payments off reads no USDC. */
export function tickOptionsFor(ctx: HeartbeatLegacyContext): TickContextOptions {
  if (!ctx.config) return {};
  const runtime = resolveRuntime(ctx.config);
  return { survival: runtime.survival, readUsdc: runtime.payments };
}
