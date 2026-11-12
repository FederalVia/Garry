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
import { buildWisdomFromGoal, createBudgetFromTask } from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { completeTask, failTask } from "./task-graph.js";
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

    try {
      await harness.initialize(task, context);
      const result = await harness.execute();

      if (result.success) {
        completeTask(this.config.db, task.id, result);
        logger.info("Local worker completed task", {
          workerId,
          taskId: task.id,
          title: task.title,
          duration: result.duration,
          harness: harness.id,
        });
      } else {
        failTask(this.config.db, task.id, result.output || "Task reported failure", true);
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
      logger.error(`[WORKER ${workerId}] Harness execution failed: ${message}`);
      failTask(this.config.db, task.id, message, true);
    }
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
