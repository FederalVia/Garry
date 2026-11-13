/**
 * Local Agent Worker
 *
 * Runs inference-driven task execution in-process as an async background task.
 * Each worker executes through a harness chosen by role via HarnessRegistry.
 */

import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { HarnessContext, WorkerInferenceClient } from "../agent/harness-types.js";
import {
  InferenceDeferredError,
  TaskBudgetExceededError,
  TaskOwnershipLostError,
  buildWisdomFromGoal,
  createBudgetFromTask,
} from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { getInstalledInferenceGate, runWithInferenceScope } from "../inference/gate.js";
import {
  MAX_INFERENCE_BLOCK_MS,
  ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY,
  assignTask,
  claimTaskStart,
  getTaskNode,
  isTaskOwnedBy,
  recordTaskSpend,
  settleTask,
} from "./task-graph.js";
import type { TaskNode, TaskOutcome } from "./task-graph.js";
import { getTaskById } from "../state/database.js";
import { AgentWorkspace } from "./workspace.js";
import type {
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonTool,
  ConwayClient,
  InputSource,
  SpendTrackerInterface,
  ToolContext,
} from "../types.js";
import type { Database } from "better-sqlite3";
import type { PolicyEngine } from "../agent/policy-engine.js";
import { homeDir, runtimeRoot, stateDir } from "../security/protected-paths.js";

const logger = createLogger("orchestration.local-worker");

/** Minimum wait before the orchestrator assigns work again after a deferral. */
const MIN_INFERENCE_BLOCK_MS = 60_000;
/** Wait used when the refusal carries no clear time (paused tier, gate unavailable). */
const DEFAULT_INFERENCE_BLOCK_MS = 5 * 60_000;

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function overlaps(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

const warnedEditRoots = new Set<string>();

/**
 * Edit root for a worker. Workers write files and run commands there, so it
 * must not be the runtime checkout, the state directory (outside its
 * workspace), HOME or /. Any of those, or an unresolvable path, falls back
 * to the goal's workspace.
 */
export function resolveWorkerEditRoot(configured: string | undefined, workspaceBase: string): string {
  const workspace = tryRealpath(workspaceBase) ?? path.resolve(workspaceBase);
  if (!configured) return workspace;

  const fallback = (why: string): string => {
    if (!warnedEditRoots.has(configured)) {
      warnedEditRoots.add(configured);
      logger.warn(`Worker edit root ${configured} ${why}; using the goal workspace instead`);
    }
    return workspace;
  };

  const real = tryRealpath(path.resolve(configured));
  if (!real) return fallback("cannot be resolved");
  if (real === path.parse(real).root) return fallback("is the filesystem root");
  const home = tryRealpath(homeDir()) ?? path.resolve(homeDir());
  if (real === home) return fallback("is the home directory");
  const runtime = tryRealpath(runtimeRoot()) ?? path.resolve(runtimeRoot());
  if (overlaps(real, runtime)) return fallback("overlaps the runtime checkout");
  const state = tryRealpath(stateDir()) ?? path.resolve(stateDir());
  const stateWorkspace = path.join(state, "workspace");
  if (overlaps(real, state) && !isWithin(real, stateWorkspace)) {
    return fallback("overlaps the state directory");
  }
  return real;
}

interface LocalWorkerConfig {
  db: Database;
  inference: WorkerInferenceClient;
  conway: ConwayClient;
  maxTurns?: number;
  harnessRegistry: HarnessRegistry;
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  allowedEditRoot?: string;
  tools?: AutomatonTool[];
  toolContext?: ToolContext;
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  inputSource?: InputSource;
  /** Workers running at once; default max(1, config.maxChildren). */
  maxConcurrent?: number;
  /** Poll interval passed to wait_for_tasks (tests). */
  waitPollMs?: number;
}

/**
 * Why a worker was aborted. "shutdown" puts its task back without spending
 * a retry; for the others the orchestrator has already settled the task.
 */
export type WorkerAbortReason = "shutdown" | "cancelled" | "superseded" | "timeout";

interface WorkerEntry {
  promise: Promise<void>;
  abortController: { abort: () => void };
  taskId?: string;
  /** Aborted and no longer counted; its task stays held until it settles. */
  detached?: boolean;
  detachedAt?: number;
  /** Blocked in wait_for_tasks: not counted against the cap. */
  waiting?: boolean;
  abortReason?: WorkerAbortReason;
}

/** Default worker cap when the config has no usable maxChildren. */
const DEFAULT_MAX_CONCURRENT = 3;
/**
 * An aborted worker keeps its task from being re-run until it settles (a
 * tool call can outlive the abort). After this long it no longer does.
 */
const DETACHED_TASK_HOLD_MS = 10 * 60_000;
/** Parent chain walk limit when computing a task's depth. */
const MAX_DEPTH_WALK = 10;

export class LocalWorkerPool {
  private activeWorkers = new Map<string, WorkerEntry>();

  constructor(private readonly config: LocalWorkerConfig) {}

  /** The most workers that may run at once. */
  get maxConcurrent(): number {
    const explicit = this.config.maxConcurrent;
    if (typeof explicit === "number" && Number.isFinite(explicit)) return Math.max(1, Math.floor(explicit));
    const configured = Number(this.config.config?.maxChildren);
    return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Assign a pending task to a new worker and start it. Returns null, with
   * nothing changed, when the pool is full, the task is no longer pending,
   * or an aborted worker still holds the task.
   */
  spawn(task: TaskNode): { address: string; name: string; sandboxId: string } | null {
    if (!this.hasCapacity() || this.isTaskHeld(task.id)) {
      return null;
    }

    const workerId = `local-worker-${ulid()}`;
    const workerName = `worker-${task.agentRole ?? "generalist"}-${workerId.slice(-6)}`;
    const address = `local://${workerId}`;

    // Assign before the worker starts, so the worker can never act on a task it does not own.
    try {
      assignTask(this.config.db, task.id, address);
    } catch {
      return null;
    }

    const abortController = new AbortController();
    const entry: WorkerEntry = { promise: Promise.resolve(), abortController, taskId: task.id };
    this.activeWorkers.set(workerId, entry);

    entry.promise = this.runWorker(workerId, task, abortController.signal, entry)
      .catch((error) => {
        logger.error("Local worker crashed", error instanceof Error ? error : new Error(String(error)), {
          workerId,
          taskId: task.id,
        });
        try {
          settleTask(this.config.db, task.id, address, {
            kind: "fail",
            error: `Worker crashed: ${error instanceof Error ? error.message : String(error)}`,
            retry: true,
          });
        } catch {
          // Best effort: a dead owner is released by the orchestrator.
        }
      })
      .finally(() => {
        this.activeWorkers.delete(workerId);
        markLocalWorkerFinished(this.config.db, address);
      });

    return { address, name: workerName, sandboxId: workerId };
  }

  /** Live workers, including ones waiting on sub-tasks; aborted ones are not counted. */
  getActiveCount(): number {
    let count = 0;
    for (const entry of this.activeWorkers.values()) {
      if (!entry.detached) count++;
    }
    return count;
  }

  hasCapacity(): boolean {
    let running = 0;
    for (const entry of this.activeWorkers.values()) {
      if (!entry.detached && !entry.waiting) running++;
    }
    return running < this.maxConcurrent;
  }

  hasWorker(addressOrId: string): boolean {
    const entry = this.activeWorkers.get(addressOrId.replace("local://", ""));
    return entry !== undefined && !entry.detached;
  }

  /**
   * Abort a worker and stop counting it at once, so a worker stuck in a
   * call does not hold a slot. Its task stays held until it settles.
   */
  abortWorker(addressOrId: string, reason: WorkerAbortReason): boolean {
    const entry = this.activeWorkers.get(addressOrId.replace("local://", ""));
    if (!entry || entry.detached) return false;
    entry.abortReason = reason;
    entry.detached = true;
    entry.detachedAt = Date.now();
    entry.abortController.abort();
    return true;
  }

  /** Abort every worker whose task row no longer names it as owner. */
  reapOrphans(): number {
    let reaped = 0;
    for (const [workerId, entry] of [...this.activeWorkers.entries()]) {
      if (entry.detached || !entry.taskId) continue;
      if (!isTaskOwnedBy(this.config.db, entry.taskId, `local://${workerId}`)) {
        logger.warn("Aborting a worker that no longer owns its task", { workerId, taskId: entry.taskId });
        if (this.abortWorker(workerId, "cancelled")) reaped++;
      }
    }
    return reaped;
  }

  async shutdown(): Promise<void> {
    for (const [workerId, entry] of this.activeWorkers) {
      if (entry.detached) continue;
      entry.abortReason = "shutdown";
      entry.detached = true;
      entry.detachedAt = Date.now();
      try {
        entry.abortController.abort();
      } catch (error) {
        logger.warn("Worker abort failed", { workerId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await Promise.allSettled([...this.activeWorkers.values()].map((worker) => worker.promise));
    this.activeWorkers.clear();
  }

  private isTaskHeld(taskId: string): boolean {
    const now = Date.now();
    for (const entry of this.activeWorkers.values()) {
      if (entry.taskId !== taskId) continue;
      if (entry.detached && entry.detachedAt !== undefined && now - entry.detachedAt > DETACHED_TASK_HOLD_MS) continue;
      return true;
    }
    return false;
  }

  /** Ancestors along parent_id: 0 for a top-level task. */
  private taskDepth(task: TaskNode): number {
    let depth = 0;
    let parentId = task.parentId;
    const seen = new Set<string>([task.id]);
    while (parentId && depth < MAX_DEPTH_WALK && !seen.has(parentId)) {
      seen.add(parentId);
      depth++;
      parentId = getTaskById(this.config.db, parentId)?.parentId ?? null;
    }
    return depth;
  }

  private async runWorker(
    workerId: string,
    assignedTask: TaskNode,
    signal: AbortSignal,
    entry: WorkerEntry = { promise: Promise.resolve(), abortController: { abort: () => {} } },
  ): Promise<void> {
    const address = `local://${workerId}`;
    // Claimed before the first await: assigned -> running with started_at,
    // which the orchestrator's deadline is measured from.
    if (!claimTaskStart(this.config.db, assignedTask.id, address)) {
      logger.warn(`[WORKER ${workerId}] Task ${assignedTask.id} is no longer assigned to this worker; exiting`);
      return;
    }
    const task = getTaskNode(this.config.db, assignedTask.id);
    if (!task) return;

    const harness = this.config.harnessRegistry.createForRole(task.agentRole, { depth: this.taskDepth(task) });
    const workspace = new AgentWorkspace(task.goalId);
    const allowedEditRoot = resolveWorkerEditRoot(this.config.allowedEditRoot, workspace.basePath);
    const workerIdentity = createWorkerIdentity(this.config.identity, workerId, task.agentRole);
    const db = this.config.db;
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot,
      workspace,
      identity: workerIdentity,
      config: this.config.config,
      db,
      conway: this.config.conway,
      inference: {
        chat: async (params) => this.config.inference.chat(params),
      },
      budget: createBudgetFromTask(task),
      wisdom: buildWisdomFromGoal(db, task.goalId, workspace),
      abortSignal: signal,
      goalId: task.goalId,
      toolCatalog: this.config.tools,
      toolContext: this.config.toolContext
        ? {
            ...this.config.toolContext,
            identity: workerIdentity,
          }
        : undefined,
      policyEngine: this.config.policyEngine,
      spendTracker: this.config.spendTracker,
      inputSource: this.config.inputSource,
      isTaskOwned: () => isTaskOwnedBy(db, task.id, address),
      setWaiting: (waiting) => {
        entry.waiting = waiting;
      },
      waitPollMs: this.config.waitPollMs,
    };

    if (this.config.maxTurns) {
      context.budget.maxTurns = this.config.maxTurns;
    }
    if (harness.id === "orchestrator" && !this.config.maxTurns) {
      context.budget.maxTurns = Math.max(context.budget.maxTurns, 50);
    }

    logger.info(
      `[WORKER ${workerId}] Starting task "${task.title}" (${task.id}), role: ${task.agentRole ?? "generalist"}, harness: ${harness.id}`,
    );

    // Every inference call of this worker, including nested planner calls,
    // is attributed to the task and counted against its cumulative cap. The
    // worker carries no session: sessions belong to the main loop's cycle.
    await runWithInferenceScope(
      {
        caller: "worker",
        taskId: task.id,
        goalId: task.goalId,
        workerId,
        taskCapCents: context.budget.maxCostCents,
        sessionId: undefined,
        turnId: undefined,
      },
      () => this.executeHarness(workerId, address, task, harness, context, entry),
    );
  }

  /**
   * Keep the orchestrator from re-spawning a worker for deferred work until
   * the refusal can have cleared, so a spent budget does not cause a
   * spawn-and-defer loop every tick.
   */
  private blockAssignments(retryAfterMs: number | null): void {
    const waitMs = Math.min(
      MAX_INFERENCE_BLOCK_MS,
      Math.max(MIN_INFERENCE_BLOCK_MS, retryAfterMs ?? DEFAULT_INFERENCE_BLOCK_MS),
    );
    const until = new Date(Date.now() + waitMs).toISOString();
    try {
      const current = this.config.db
        .prepare("SELECT value FROM kv WHERE key = ?")
        .get(ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY) as { value: string } | undefined;
      if (current && Date.parse(current.value) >= Date.parse(until)) return;
      this.config.db
        .prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .run(ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY, until);
    } catch {
      // Best effort: the gate still refuses each call.
    }
  }

  private async executeHarness(
    workerId: string,
    address: string,
    task: TaskNode,
    harness: ReturnType<HarnessRegistry["createForRole"]>,
    context: HarnessContext,
    entry: WorkerEntry,
  ): Promise<void> {
    const db = this.config.db;
    const settle = (outcome: TaskOutcome): void => {
      if (settleTask(db, task.id, address, outcome) === "stale") {
        logger.warn(`[WORKER ${workerId}] Result for task ${task.id} dropped: the worker no longer owns it`);
      }
    };

    try {
      await harness.initialize(task, context);
      const result = await harness.execute();
      const costCents = taskSpendCents(task.id, result.costCents);

      if (result.success) {
        settle({ kind: "complete", result: { ...result, costCents } });
        logger.info("Local worker completed task", {
          workerId,
          taskId: task.id,
          title: task.title,
          duration: result.duration,
          harness: harness.id,
          costCents,
        });
      } else {
        settle({ kind: "fail", error: result.output || "Task reported failure", retry: true, costCents });
        logger.warn("Local worker reported task failure", {
          workerId,
          taskId: task.id,
          title: task.title,
          harness: harness.id,
          output: result.output.slice(0, 200),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const costCents = taskSpendCents(task.id, context.budget.costUsedCents);

      if (context.abortSignal.aborted || error instanceof TaskOwnershipLostError) {
        const reason = error instanceof TaskOwnershipLostError ? "cancelled" : (entry.abortReason ?? "shutdown");
        if (reason === "shutdown") {
          // Graceful shutdown: the task waits for the next run without spending a retry.
          settle({ kind: "defer", reason: "the runtime is shutting down", costCents });
        } else {
          // The orchestrator (or the parent) already settled the task; keep the spend.
          recordTaskSpend(db, task.id, costCents);
          logger.info(`[WORKER ${workerId}] Stopped (${reason}); no result reported for task ${task.id}`);
        }
        return;
      }

      if (error instanceof InferenceDeferredError) {
        // A refusal that clears with time: the task waits without using a retry.
        logger.warn(`[WORKER ${workerId}] Inference refused (${error.code}); deferring task ${task.id}`);
        settle({ kind: "defer", reason: message, costCents });
        this.blockAssignments(error.retryAfterMs);
        return;
      }

      if (error instanceof TaskBudgetExceededError) {
        // The cap is cumulative over every attempt, so a retry would be refused too.
        logger.warn(`[WORKER ${workerId}] ${message}`);
        settle({ kind: "fail", error: message, retry: false, costCents });
        return;
      }

      logger.error(`[WORKER ${workerId}] Harness execution failed: ${message}`);
      settle({ kind: "fail", error: message, retry: true, costCents });
    }
  }
}

/** The gate's cumulative spend for the task; the harness figure only without a gate. */
function taskSpendCents(taskId: string, fallback: number): number {
  const gate = getInstalledInferenceGate();
  if (!gate) return fallback;
  try {
    return gate.taskSpendCents(taskId);
  } catch {
    return fallback;
  }
}

function createWorkerIdentity(
  parentIdentity: AutomatonIdentity,
  workerId: string,
  role: string | null,
): AutomatonIdentity {
  return {
    ...parentIdentity,
    name: `worker-${role ?? "generalist"}-${workerId.slice(-6)}`,
    address: `local://${workerId}`,
    // The parent's sandbox: a worker runs where its parent runs, so parent
    // tools it calls take the same local or remote path as the parent's.
    sandboxId: parentIdentity.sandboxId,
  };
}

/** Workers are not children rows any more; this retires rows an older version registered. */
export function markLocalWorkerFinished(db: Database, address: string): void {
  try {
    db.prepare(
      "UPDATE children SET status = 'cleaned_up' WHERE address = ? AND status IN ('running', 'healthy')",
    ).run(address);
  } catch {
    // Best effort: the tracker never treats local workers as idle anyway.
  }
}
