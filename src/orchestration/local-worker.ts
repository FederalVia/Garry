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
  buildWisdomFromGoal,
  createBudgetFromTask,
} from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { getInstalledInferenceGate, runWithInferenceScope } from "../inference/gate.js";
import {
  MAX_INFERENCE_BLOCK_MS,
  ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY,
  completeTask,
  deferTask,
  failTask,
} from "./task-graph.js";
import type { TaskNode } from "./task-graph.js";
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
}

export class LocalWorkerPool {
  private activeWorkers = new Map<string, { promise: Promise<void>; abortController: AbortController }>();

  constructor(private readonly config: LocalWorkerConfig) {}

  spawn(task: TaskNode): { address: string; name: string; sandboxId: string } {
    const workerId = `local-worker-${ulid()}`;
    const workerName = `worker-${task.agentRole ?? "generalist"}-${workerId.slice(-6)}`;
    const address = `local://${workerId}`;
    const abortController = new AbortController();

    const workerPromise = this.runWorker(workerId, task, abortController.signal)
      .catch((error) => {
        logger.error("Local worker crashed", error instanceof Error ? error : new Error(String(error)), {
          workerId,
          taskId: task.id,
        });
        try {
          failTask(
            this.config.db,
            task.id,
            `Worker crashed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        } catch {
          // Task may already be in a terminal state.
        }
      })
      .finally(() => {
        this.activeWorkers.delete(workerId);
        markLocalWorkerFinished(this.config.db, address);
      });

    this.activeWorkers.set(workerId, { promise: workerPromise, abortController });
    return { address, name: workerName, sandboxId: workerId };
  }

  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  hasWorker(addressOrId: string): boolean {
    const id = addressOrId.replace("local://", "");
    return this.activeWorkers.has(id);
  }

  async shutdown(): Promise<void> {
    for (const [, worker] of this.activeWorkers) {
      worker.abortController.abort();
    }
    await Promise.allSettled([...this.activeWorkers.values()].map((worker) => worker.promise));
    this.activeWorkers.clear();
  }

  private async runWorker(workerId: string, task: TaskNode, signal: AbortSignal): Promise<void> {
    const harness = this.config.harnessRegistry.createForRole(task.agentRole);
    const workspace = new AgentWorkspace(task.goalId);
    const allowedEditRoot = resolveWorkerEditRoot(this.config.allowedEditRoot, workspace.basePath);
    const workerIdentity = createWorkerIdentity(this.config.identity, workerId, task.agentRole);
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot,
      workspace,
      identity: workerIdentity,
      config: this.config.config,
      db: this.config.db,
      conway: this.config.conway,
      inference: {
        chat: async (params) => this.config.inference.chat(params),
      },
      budget: createBudgetFromTask(task),
      wisdom: buildWisdomFromGoal(this.config.db, task.goalId, workspace),
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
      () => this.executeHarness(workerId, task, harness, context),
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
    task: TaskNode,
    harness: ReturnType<HarnessRegistry["createForRole"]>,
    context: HarnessContext,
  ): Promise<void> {
    const db = this.config.db;
    try {
      await harness.initialize(task, context);
      const result = await harness.execute();
      const costCents = taskSpendCents(task.id, result.costCents);

      if (result.success) {
        completeTask(db, task.id, { ...result, costCents });
        logger.info("Local worker completed task", {
          workerId,
          taskId: task.id,
          title: task.title,
          duration: result.duration,
          harness: harness.id,
          costCents,
        });
      } else {
        failTask(db, task.id, result.output || "Task reported failure", true, costCents);
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

      if (error instanceof InferenceDeferredError) {
        // A refusal that clears with time: the task waits without using a retry.
        logger.warn(`[WORKER ${workerId}] Inference refused (${error.code}); deferring task ${task.id}`);
        deferTask(db, task.id, message, costCents);
        this.blockAssignments(error.retryAfterMs);
        return;
      }

      if (error instanceof TaskBudgetExceededError) {
        // The cap is cumulative over every attempt, so a retry would be refused too.
        logger.warn(`[WORKER ${workerId}] ${message}`);
        failTask(db, task.id, message, false, costCents);
        return;
      }

      logger.error(`[WORKER ${workerId}] Harness execution failed: ${message}`);
      failTask(db, task.id, message, true, costCents);
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
    sandboxId: workerId,
  };
}

/** The orchestrator registers local workers as running children; retire the row when the worker ends. */
export function markLocalWorkerFinished(db: Database, address: string): void {
  try {
    db.prepare(
      "UPDATE children SET status = 'cleaned_up' WHERE address = ? AND status IN ('running', 'healthy')",
    ).run(address);
  } catch {
    // Best effort: the tracker never treats local workers as idle anyway.
  }
}
