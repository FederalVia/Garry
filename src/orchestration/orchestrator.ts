import type { Database } from "better-sqlite3";
import type { AutomatonIdentity } from "../types.js";
import { createLogger } from "../observability/logger.js";
import {
  MAX_INFERENCE_BLOCK_MS,
  ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY,
  TASK_DEADLINE_GRACE_MS,
  assignTask,
  decomposeGoal,
  failTask,
  getGoalProgress,
  getReadyTasks,
  isGoalProgressComplete,
  releaseTask,
  supersedeOpenTasks,
  type DecomposeTaskInput,
  type Goal,
  type GoalProgress,
  type TaskNode,
  normalizeTaskResult,
} from "./task-graph.js";
import {
  PlannerOutputError,
  goalToPlannerInput,
  planGoal,
  replanAfterFailure,
  type PlannerFailureInput,
  type PlannerOutput,
  taskToPlannerFailureInput,
} from "./planner.js";
import { ColonyMessaging } from "./messaging.js";
import { generateTodoMd } from "./attention.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import { getInstalledInferenceGate, runWithInferenceScope } from "../inference/gate.js";
import { InferenceRefusedError } from "../inference/errors.js";
import { reviewPlan } from "./plan-mode.js";
import { buildPlannerContext, getNextPlannerVersion, persistPlannerArtifacts } from "./planner-context.js";
import { AgentWorkspace } from "./workspace.js";
import {
  getActiveGoals,
  getGoalById,
  getTaskById,
  getTasksByGoal,
  insertEvent,
  updateGoalStatus,
  withTransaction,
  type GoalRow,
  type TaskGraphRow,
} from "../state/database.js";
import type {
  AgentTracker,
  FundingProtocol,
  OrchestratorTickResult,
} from "./types.js";

const logger = createLogger("orchestration.orchestrator");

const ORCHESTRATOR_STATE_KEY = "orchestrator.state";
const ORCHESTRATOR_TODO_KEY = "orchestrator.todo_md";
const DEFAULT_TASK_FUNDING_CENTS = 25;
const DEFAULT_MAX_REPLANS = 3;
/** Survival tiers at which orchestration inference is paused (owner decision D8). */
const PAUSED_SURVIVAL_TIERS = new Set(["low_compute", "critical", "dead", "unknown"]);

type ExecutionPhase =
  | "idle"
  | "classifying"
  | "planning"
  | "plan_review"
  | "executing"
  | "replanning"
  | "complete"
  | "failed";

interface OrchestratorState {
  phase: ExecutionPhase;
  goalId: string | null;
  replanCount: number;
  failedTaskId: string | null;
  failedError: string | null;
  /** Completed tasks of the goal seen by the last executing tick (for the tick's completion count). */
  completedSeen?: number;
}

interface TickCounters {
  tasksAssigned: number;
  tasksCompleted: number;
  tasksFailed: number;
}

/**
 * Why a worker is stopped by the orchestrator. Mirrors the pool's reasons
 * (the pool adds "shutdown", which only the runtime uses).
 */
export type OrchestratorAbortReason = "cancelled" | "superseded" | "timeout";

/** The local worker pool as the orchestrator uses it. */
export interface OrchestratorWorkerPool {
  /** Assigns the pending task to a new worker and starts it; null when full or not pending. */
  spawn(task: TaskNode): { address: string; name: string; sandboxId: string } | null;
  hasWorker(address: string): boolean;
  abortWorker(address: string, reason: OrchestratorAbortReason): boolean;
  /** Aborts workers whose task row no longer names them as owner. */
  reapOrphans(): number;
  getActiveCount(): number;
}

const DEFAULT_STATE: OrchestratorState = {
  phase: "idle",
  goalId: null,
  replanCount: 0,
  failedTaskId: null,
  failedError: null,
};

/**
 * Tasks run on local in-process workers, or on the parent itself when
 * spawning is disabled or there is no pool. Conway children are never sent
 * colony tasks: no transport reaches them and they have no executor, so a
 * task left assigned to one is released back to the local workers.
 */
export class Orchestrator {
  constructor(private readonly params: {
    db: Database;
    /** Unused by the orchestrator; kept so callers need not change. */
    agentTracker: AgentTracker;
    funding: FundingProtocol;
    /** Unused by the orchestrator; kept so callers need not change. */
    messaging: ColonyMessaging;
    inference: UnifiedInferenceClient;
    identity: AutomatonIdentity;
    config: any;
    /** Local workers. Without a pool (or with config.disableSpawn) tasks are self-assigned. */
    workerPool?: OrchestratorWorkerPool;
    /** Liveness of a local worker address when no pool is given. */
    isWorkerAlive?: (address: string) => boolean;
  }) {}

  async tick(): Promise<OrchestratorTickResult> {
    const counters: TickCounters = {
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
    };

    let state = this.loadState();

    try {
      switch (state.phase) {
        case "idle": {
          state = this.handleIdlePhase(state);
          break;
        }

        case "classifying": {
          state = await this.handleClassifyingPhase(state);
          break;
        }

        case "planning": {
          state = await this.handlePlanningPhase(state);
          break;
        }

        case "plan_review": {
          state = await this.handlePlanReviewPhase(state);
          break;
        }

        case "executing": {
          state = await this.handleExecutingPhase(state, counters);
          break;
        }

        case "replanning": {
          state = await this.handleReplanningPhase(state);
          break;
        }

        case "complete": {
          state = this.handleCompletePhase();
          break;
        }

        case "failed": {
          state = this.handleFailedPhase(state);
          break;
        }

        default: {
          state = { ...DEFAULT_STATE };
          break;
        }
      }
    } catch (error) {
      if (error instanceof InferenceRefusedError) {
        // Budget refusals clear with time; the goal is not at fault.
        logger.warn("Orchestrator inference refused; staying in phase", {
          phase: state.phase,
          code: error.code,
        });
        this.saveState(state);
        this.persistTodo();
        return this.tickResult(state, counters);
      }

      const err = normalizeError(error);
      logger.error("Orchestrator tick failed", err, {
        phase: state.phase,
        goalId: state.goalId,
      });

      if (state.goalId && this.isGoalLive(state.goalId)) {
        updateGoalStatus(this.params.db, state.goalId, "failed");
      }

      state = {
        ...state,
        phase: "failed",
        failedError: err.message,
      };
    }

    this.saveState(state);
    this.persistTodo();

    return this.tickResult(state, counters);
  }

  /**
   * Explicit funding of a child for a task. The tick never calls it: colony
   * tasks are not delegated to children. It goes through the treasury gate.
   */
  async fundAgentForTask(addr: string, task: TaskNode): Promise<void> {
    const estimated = Math.max(0, task.metadata.estimatedCostCents);
    const configuredDefault = Number(this.params.config?.defaultTaskFundingCents ?? DEFAULT_TASK_FUNDING_CENTS);
    const amountCents = Math.max(estimated, Number.isFinite(configuredDefault) ? configuredDefault : 0);

    if (amountCents <= 0) {
      return;
    }

    const result = await this.params.funding.fundChild(addr, amountCents);
    if (!result.success) {
      throw new Error(`Funding transfer failed for ${addr}`);
    }
  }

  /** Admin failure of a task (no owner check), then move the goal on if it failed for good. */
  async handleFailure(task: TaskNode, error: string): Promise<void> {
    failTask(this.params.db, task.id, error, true);

    const latest = getTaskById(this.params.db, task.id);
    if (!latest || latest.status !== "failed") {
      return;
    }

    const state = this.loadState();
    const maxReplans = this.getMaxReplans();
    const goal = getGoalById(this.params.db, task.goalId);

    // Reactivation is failed -> active only; a cancelled or paused goal stays so.
    if (state.replanCount < maxReplans && goal?.status === "failed") {
      updateGoalStatus(this.params.db, task.goalId, "active");
    }

    this.saveState({
      ...state,
      phase: state.replanCount < maxReplans ? "replanning" : "failed",
      goalId: task.goalId,
      failedTaskId: task.id,
      failedError: error,
    });
  }

  private tickResult(state: OrchestratorState, counters: TickCounters): OrchestratorTickResult {
    return {
      phase: state.phase,
      tasksAssigned: counters.tasksAssigned,
      tasksCompleted: counters.tasksCompleted,
      tasksFailed: counters.tasksFailed,
      goalsActive: getActiveGoals(this.params.db).length,
      agentsActive: this.params.workerPool?.getActiveCount() ?? 0,
    };
  }

  private isGoalLive(goalId: string): boolean {
    const status = getGoalById(this.params.db, goalId)?.status;
    return status === "active" || status === "failed";
  }

  /**
   * The goal guard, run at the top of every phase that works on a goal. A
   * goal that is gone, or neither active nor failed (cancelled, completed,
   * paused), has its workers stopped and its held tasks released, and the
   * orchestrator returns to idle so other goals can run.
   */
  private guardGoal(state: OrchestratorState): { goal: GoalRow } | { idle: OrchestratorState } {
    if (!state.goalId) {
      return { idle: { ...DEFAULT_STATE } };
    }
    const goal = getGoalById(this.params.db, state.goalId);
    if (goal && (goal.status === "active" || goal.status === "failed")) {
      return { goal };
    }

    logger.info("Goal is no longer active; stopping its work", {
      goalId: state.goalId,
      status: goal?.status ?? "missing",
    });
    this.stopGoalWork(state.goalId);
    return { idle: { ...DEFAULT_STATE } };
  }

  private stopGoalWork(goalId: string, reason = "goal is no longer active"): void {
    const pool = this.params.workerPool;
    for (const task of getTasksByGoal(this.params.db, goalId)) {
      if (task.status !== "assigned" && task.status !== "running") continue;
      if (!task.assignedTo) continue;
      if (task.assignedTo.startsWith("local://")) {
        pool?.abortWorker(task.assignedTo, "cancelled");
      }
      releaseTask(this.params.db, task.id, task.assignedTo, reason, { retry: false });
    }
    // Cancelled tasks are no longer owned, so their workers are aborted here.
    pool?.reapOrphans();
  }

  private handleIdlePhase(state: OrchestratorState): OrchestratorState {
    const activeGoals = getActiveGoals(this.params.db);
    if (activeGoals.length === 0) {
      return {
        ...DEFAULT_STATE,
      };
    }

    const goal = pickGoal(activeGoals, state.goalId);
    return {
      ...DEFAULT_STATE,
      phase: "classifying",
      goalId: goal.id,
    };
  }

  private async handleClassifyingPhase(state: OrchestratorState): Promise<OrchestratorState> {
    const guard = this.guardGoal(state);
    if ("idle" in guard) return guard.idle;
    const goal = guard.goal;

    const tasks = getTasksByGoal(this.params.db, goal.id);
    if (tasks.length > 0) {
      return {
        ...state,
        phase: "executing",
      };
    }

    const complexity = await this.classifyComplexity(goal);
    if (complexity.requiresPlanMode) {
      return {
        ...state,
        phase: "planning",
      };
    }

    decomposeGoal(this.params.db, goal.id, [
      {
        parentId: null,
        goalId: goal.id,
        title: goal.title,
        description: goal.description,
        status: "pending",
        assignedTo: null,
        agentRole: "generalist",
        priority: 50,
        dependencies: [],
        result: null,
      },
    ]);

    return {
      ...state,
      phase: "executing",
    };
  }

  private async handlePlanningPhase(state: OrchestratorState): Promise<OrchestratorState> {
    const guard = this.guardGoal(state);
    if ("idle" in guard) return guard.idle;
    const goal = guard.goal;

    const pause = this.orchestrationPauseReason();
    if (pause) {
      logger.info("Planning deferred: orchestration inference paused", { goalId: goal.id, reason: pause });
      return state;
    }

    let output: PlannerOutput;
    try {
      output = await planGoal(
        goalToPlannerInput(goalRowToGoal(goal)),
        await this.plannerContext(goal.id),
        this.params.inference,
      );
    } catch (error) {
      const err = normalizeError(error);
      if (!(error instanceof PlannerOutputError)) {
        // A refusal or provider failure: no fallback plan (it would spawn a
        // worker that spends the same budget); plan again on a later tick.
        logger.warn("Planner inference unavailable, will retry planning later", {
          goalId: goal.id,
          error: err.message,
          code: error instanceof InferenceRefusedError ? error.code : undefined,
        });
        return state;
      }
      logger.warn("Planner returned an unusable plan, falling back to single-task plan", {
        goalId: goal.id,
        error: err.message,
      });
      output = singleTaskPlan(goal, `Planner fallback: ${err.message}`, "Execute goal as a single generalist task",
        "Planner unavailable — executing without decomposition");
    }

    if (output.tasks.length === 0) {
      // Planner returned valid JSON but empty tasks — use fallback single task
      logger.warn("Planner returned no tasks, falling back to single-task plan", { goalId: goal.id });
      output = { ...output, tasks: singleTaskPlan(goal, "", "", "").tasks };
    }

    // The tasks and the phase that says they exist commit together, so a
    // restart in between cannot plan the goal a second time.
    const next: OrchestratorState = { ...state, phase: "plan_review" };
    withTransaction(this.params.db, () => {
      decomposeGoal(this.params.db, goal.id, plannerOutputToTasks(goal.id, output));
      this.saveState(next);
    });
    await this.persistPlannerOutput(goal.id, output, "plan");

    return next;
  }

  private async handlePlanReviewPhase(state: OrchestratorState): Promise<OrchestratorState> {
    const guard = this.guardGoal(state);
    if ("idle" in guard) return guard.idle;

    const planKey = `orchestrator.plan.${guard.goal.id}`;
    const planRow = this.params.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(planKey) as { value: string } | undefined;

    if (!planRow?.value) {
      return { ...state, phase: "executing" };
    }

    const planData = safeJsonParse(planRow.value);
    if (!planData) {
      return { ...state, phase: "executing" };
    }

    try {
      const result = await reviewPlan(planData as any, {
        mode: "auto",
        autoBudgetThreshold: 5000,
        consensusCriticRole: "reviewer",
        reviewTimeoutMs: 1800000,
      });

      if (result.approved) {
        return { ...state, phase: "executing" };
      }

      this.params.db.prepare(
        "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ).run(`orchestrator.review_feedback.${guard.goal.id}`, result.feedback ?? "Plan rejected");

      return { ...state, phase: "planning" };
    } catch (error) {
      const err = normalizeError(error);
      if (err.message === "awaiting human approval") {
        return state;
      }
      throw error;
    }
  }

  private async handleExecutingPhase(
    state: OrchestratorState,
    counters: TickCounters,
  ): Promise<OrchestratorState> {
    // 1. Goal guard.
    const guard = this.guardGoal(state);
    if ("idle" in guard) return guard.idle;
    const goal = guard.goal;

    // 2-4. Take back tasks nobody will finish: remote owners, dead local
    // owners, and owners past their deadline.
    this.releaseRemoteAssignments(goal.id);
    this.releaseDeadOwners(goal.id, counters);
    this.enforceDeadlines(goal.id, counters);

    // 5. Stop workers whose task was taken from them (cancelled, completed by the parent).
    this.params.workerPool?.reapOrphans();

    // 6. Assign ready tasks. A goal that has already failed gets no new work.
    if (goal.status === "active") {
      this.assignReadyTasks(goal.id, counters);
    }

    // 7. Evaluate.
    const progress = getGoalProgress(this.params.db, goal.id);
    const maxReplans = this.getMaxReplans();
    // Workers settle tasks between ticks; count what finished since the last look.
    counters.tasksCompleted += Math.max(0, progress.completed - (state.completedSeen ?? progress.completed));
    state = { ...state, completedSeen: progress.completed };

    if (isGoalProgressComplete(progress)) {
      updateGoalStatus(this.params.db, goal.id, "completed");
      return {
        ...state,
        phase: "complete",
      };
    }

    if (progress.failed > 0) {
      return {
        ...state,
        phase: state.replanCount < maxReplans ? "replanning" : "failed",
        failedTaskId: this.findFirstFailedTaskId(goal.id),
        failedError: state.failedError ?? "Task execution failed",
      };
    }

    if (goal.status === "failed") {
      // Failed with no failed task left (e.g. all cancelled): nothing to replan around.
      return { ...state, phase: "failed", failedError: state.failedError ?? "Goal failed" };
    }

    const stall = this.describeStall(goal.id, progress);
    if (stall) {
      logger.warn("Goal cannot make progress", { goalId: goal.id, reason: stall });
      return {
        ...state,
        phase: state.replanCount < maxReplans ? "replanning" : "failed",
        failedTaskId: null,
        failedError: `Goal stalled: ${stall}`,
      };
    }

    return state;
  }

  /**
   * Why the goal can make no further progress, or null. That is: nothing
   * is assigned, running or ready, and the goal is not complete. Left-over
   * work is blocked behind a failed or cancelled task, or nothing is left
   * at all (every task cancelled).
   */
  private describeStall(goalId: string, progress: GoalProgress): string | null {
    if (isGoalProgressComplete(progress) || progress.running > 0) return null;
    const ready = getReadyTasks(this.params.db).some((task) => task.goalId === goalId);
    if (ready) return null;
    if (progress.effectiveTotal === 0) {
      return progress.total === 0 ? "the goal has no tasks" : "every task of the goal was cancelled";
    }
    const waiting = progress.blocked + progress.pending;
    return `${waiting} task(s) wait on work that can no longer complete`;
  }

  private releaseRemoteAssignments(goalId: string): void {
    for (const task of getTasksByGoal(this.params.db, goalId)) {
      if (task.status !== "assigned" && task.status !== "running") continue;
      const owner = task.assignedTo;
      if (!owner || owner.startsWith("local://") || owner === this.params.identity.address) continue;

      // No transport reaches a remote child and it has no colony executor:
      // waiting would wait forever. Run the task locally instead.
      logger.warn("Releasing a task assigned to a remote agent: remote children do not execute colony tasks", {
        taskId: task.id,
        owner,
      });
      if (releaseTask(this.params.db, task.id, owner, "remote children do not execute colony tasks", { retry: false }) === "applied") {
        try {
          insertEvent(this.params.db, {
            type: "remote_delegation_unsupported",
            agentAddress: owner,
            goalId,
            taskId: task.id,
            content: "Task was assigned to a remote child; released to local workers without spending a retry.",
            tokenCount: 0,
          });
        } catch {
          // Best effort.
        }
      }
    }
  }

  private releaseDeadOwners(goalId: string, counters: TickCounters): void {
    for (const task of getTasksByGoal(this.params.db, goalId)) {
      if (task.status !== "assigned" && task.status !== "running") continue;
      const owner = task.assignedTo;
      // The parent works on its own tasks in its turns; it is never "dead".
      if (!owner || !owner.startsWith("local://")) continue;
      const alive = this.isLocalWorkerAlive(owner);
      if (alive !== false) continue;

      logger.warn("Releasing task from a dead worker", { taskId: task.id, worker: owner });
      releaseTask(this.params.db, task.id, owner, "worker ended without reporting a result", { retry: true });
      if (getTaskById(this.params.db, task.id)?.status === "failed") {
        counters.tasksFailed += 1;
      }
    }
  }

  private enforceDeadlines(goalId: string, counters: TickCounters): void {
    const now = Date.now();
    for (const task of getTasksByGoal(this.params.db, goalId)) {
      if (task.status !== "assigned" && task.status !== "running") continue;
      const owner = task.assignedTo;
      // Self-assigned tasks have no deadline: the parent completes or cancels them.
      if (!owner || !owner.startsWith("local://") || !task.startedAt) continue;
      const startedMs = parseTimestamp(task.startedAt);
      if (!Number.isFinite(startedMs)) continue;
      const deadline = startedMs + task.timeoutMs + TASK_DEADLINE_GRACE_MS;
      if (deadline >= now) continue;

      logger.warn("Task is past its deadline; stopping its worker", {
        taskId: task.id,
        worker: owner,
        startedAt: task.startedAt,
        timeoutMs: task.timeoutMs,
      });
      this.params.workerPool?.abortWorker(owner, "timeout");
      releaseTask(this.params.db, task.id, owner, `Task exceeded its deadline (${task.timeoutMs} ms plus grace)`, { retry: true });
      if (getTaskById(this.params.db, task.id)?.status === "failed") {
        counters.tasksFailed += 1;
      }
    }
  }

  private assignReadyTasks(goalId: string, counters: TickCounters): void {
    const ready = getReadyTasks(this.params.db).filter((task) => task.goalId === goalId);
    if (ready.length === 0) return;

    // No assignment while orchestration inference cannot run: a self-assigned
    // task would run as main-loop turns outside the orchestration share.
    const assignmentBlock = this.assignmentBlockReason();
    if (assignmentBlock) {
      logger.info("Task assignment deferred: orchestration inference unavailable", {
        goalId,
        readyTasks: ready.length,
        reason: assignmentBlock,
      });
      return;
    }

    const pool = this.params.workerPool;
    const useWorkers = pool !== undefined && this.params.config?.disableSpawn !== true;

    for (const task of ready) {
      if (useWorkers) {
        // Null: the pool is full or the task is held; it waits pending.
        if (pool.spawn(task)) counters.tasksAssigned += 1;
        continue;
      }

      try {
        assignTask(this.params.db, task.id, this.params.identity.address);
        counters.tasksAssigned += 1;
        logger.info("Self-assigning task to the parent agent", { taskId: task.id, role: task.agentRole });
      } catch (error) {
        logger.warn("Could not self-assign task", { taskId: task.id, error: normalizeError(error).message });
      }
    }
  }

  /** True/false for a local worker address, or null when liveness cannot be known. */
  private isLocalWorkerAlive(address: string): boolean | null {
    if (this.params.workerPool) return this.params.workerPool.hasWorker(address);
    if (this.params.isWorkerAlive) return this.params.isWorkerAlive(address);
    return null;
  }

  private async handleReplanningPhase(state: OrchestratorState): Promise<OrchestratorState> {
    const guard = this.guardGoal(state);
    if ("idle" in guard) return guard.idle;
    const goal = guard.goal;

    const stateFailed = state.failedTaskId ? getTaskById(this.params.db, state.failedTaskId) : undefined;
    const fallbackId = this.findFirstFailedTaskId(goal.id);
    const failedTaskRow = stateFailed?.status === "failed" && stateFailed.goalId === goal.id
      ? stateFailed
      : fallbackId ? getTaskById(this.params.db, fallbackId) : undefined;

    let failureInput: PlannerFailureInput;
    if (failedTaskRow) {
      failureInput = taskToPlannerFailureInput(taskRowToTaskNode(failedTaskRow));
    } else {
      // No failed task: replan only if the goal is stalled, else carry on.
      const stall = this.describeStall(goal.id, getGoalProgress(this.params.db, goal.id));
      if (!stall) {
        return { ...state, phase: "executing", failedTaskId: null, failedError: null };
      }
      failureInput = this.stallFailureInput(goal, stall);
    }

    const pause = this.orchestrationPauseReason();
    if (pause) {
      logger.info("Replanning deferred: orchestration inference paused", { goalId: goal.id, reason: pause });
      return state;
    }

    const goalTasks = getTasksByGoal(this.params.db, goal.id);
    const completedTitles = goalTasks.filter((task) => task.status === "completed").map((task) => task.title);
    const inProgressTitles = goalTasks
      .filter((task) => task.status === "assigned" || task.status === "running")
      .map((task) => task.title);

    let output: PlannerOutput;
    try {
      output = await replanAfterFailure(
        goalToPlannerInput(goalRowToGoal(goal)),
        failureInput,
        await this.plannerContext(goal.id),
        this.params.inference,
        { completedTasks: completedTitles, inProgressTasks: inProgressTitles },
      );
    } catch (error) {
      const err = normalizeError(error);
      if (!(error instanceof PlannerOutputError)) {
        logger.warn("Replanner inference unavailable, will retry replanning later", {
          goalId: goal.id,
          error: err.message,
          code: error instanceof InferenceRefusedError ? error.code : undefined,
        });
        return state;
      }
      logger.warn("Replanner returned an unusable plan, falling back to single-task plan", {
        goalId: goal.id,
        error: err.message,
      });
      output = singleTaskPlan(goal, `Replanner fallback: ${err.message}`, "Re-execute goal as a single generalist task",
        "Replanner unavailable — re-executing without decomposition");
    }

    if (output.tasks.length === 0) {
      logger.warn("Replanner returned no tasks, falling back to single-task plan", { goalId: goal.id });
      output = { ...output, tasks: singleTaskPlan(goal, "", "", "").tasks };
    }

    const replanNumber = state.replanCount + 1;
    const plannedTasks = plannerOutputToTasks(goal.id, output);
    const inFlightIds = new Set(
      goalTasks.filter((task) => task.status === "assigned" || task.status === "running").map((task) => task.id),
    );

    const next: OrchestratorState = {
      ...state,
      phase: "plan_review",
      replanCount: replanNumber,
      failedTaskId: null,
      failedError: null,
    };
    withTransaction(this.params.db, () => {
      // Workers settled tasks while the replanner ran: decide on the tasks as
      // they are now, not on the snapshot the planner was given.
      const liveTasks = getTasksByGoal(this.params.db, goal.id);
      const plannedTitles = new Set(plannedTasks.map((task) => normalizeTitle(task.title)));
      const keep = new Set<string>();
      for (const task of liveTasks) {
        if (!inFlightIds.has(task.id)) continue;
        // The planner was told this runs. A retry queued meanwhile is still
        // that work; a failure it never saw stays for the next replan unless
        // the new plan redoes it.
        if (task.status === "pending" || task.status === "blocked") keep.add(task.id);
        if (task.status === "failed" && !plannedTitles.has(normalizeTitle(task.title))) keep.add(task.id);
      }
      // Work that is done, running or kept is not planned a second time.
      const covering = liveTasks.filter((task) =>
        task.status === "completed" || task.status === "assigned" || task.status === "running"
        || (keep.has(task.id) && task.status !== "failed"));
      const newTasks = dedupeAgainstExisting(plannedTasks, covering);

      // The new plan replaces every other open task; running work is left alone.
      supersedeOpenTasks(this.params.db, goal.id, replanNumber, keep);
      if (getGoalById(this.params.db, goal.id)?.status === "failed") {
        updateGoalStatus(this.params.db, goal.id, "active");
      }
      decomposeGoal(this.params.db, goal.id, newTasks);
      this.saveState(next);
    });
    this.params.workerPool?.reapOrphans();
    await this.persistPlannerOutput(goal.id, output, "replan");

    return next;
  }

  /** A failure input for a stalled goal: the first task that waits on dead work, or the goal itself. */
  private stallFailureInput(goal: GoalRow, stall: string): PlannerFailureInput {
    const waiting = getTasksByGoal(this.params.db, goal.id).find((task) => task.status === "blocked" || task.status === "pending");
    if (waiting) {
      const input = taskToPlannerFailureInput(taskRowToTaskNode(waiting));
      return {
        ...input,
        status: "failed",
        result: { success: false, output: `Stalled: ${stall}`, artifacts: [], costCents: 0, duration: 0 },
      };
    }
    const now = new Date().toISOString();
    return {
      id: goal.id,
      title: goal.title,
      description: goal.description,
      status: "failed",
      agentRole: null,
      dependencies: [],
      assignedTo: null,
      result: { success: false, output: `Stalled: ${stall}`, artifacts: [], costCents: 0, duration: 0 },
      metadata: {
        estimatedCostCents: 0,
        actualCostCents: 0,
        maxRetries: 0,
        retryCount: 0,
        timeoutMs: 0,
        createdAt: goal.createdAt ?? now,
        startedAt: null,
        completedAt: null,
      },
    };
  }

  private handleCompletePhase(): OrchestratorState {
    return {
      ...DEFAULT_STATE,
      phase: "idle",
    };
  }

  private handleFailedPhase(state: OrchestratorState): OrchestratorState {
    logger.warn("Goal execution failed", {
      goalId: state.goalId,
      error: state.failedError,
      replanCount: state.replanCount,
    });

    if (!state.goalId) {
      return { ...DEFAULT_STATE };
    }

    // Never overwrite a goal the operator cancelled or paused meanwhile.
    if (this.isGoalLive(state.goalId)) {
      updateGoalStatus(this.params.db, state.goalId, "failed");
    }
    // The orchestrator moves on and no longer watches this goal's workers
    // (deadlines, dead owners), so they stop here and free their slots.
    this.stopGoalWork(state.goalId, "goal was given up");

    // Reset to idle so the orchestrator can pick up other active goals
    // instead of being stuck in "failed" forever.
    return { ...DEFAULT_STATE };
  }

  private async plannerContext(goalId: string) {
    const pool = this.params.workerPool;
    const maxAgents = Math.max(1, Number(this.params.config?.maxChildren ?? 3) || 1);
    const busy = pool?.getActiveCount() ?? 0;
    return buildPlannerContext({
      db: this.params.db,
      workspace: new AgentWorkspace(goalId),
      idleAgents: Math.max(0, maxAgents - busy),
      busyAgents: busy,
      maxAgents,
    });
  }

  private async classifyComplexity(goal: GoalRow): Promise<{ requiresPlanMode: boolean; estimatedSteps: number }> {
    if (this.orchestrationPauseReason()) {
      const estimatedSteps = heuristicStepEstimate(goal);
      return { estimatedSteps, requiresPlanMode: estimatedSteps > 3 };
    }

    try {
      // A refusal lands in the catch and uses the free heuristic.
      const result = await runWithInferenceScope({ caller: "orchestrator.classify" }, () => this.params.inference.chat({
        tier: "cheap",
        purpose: "classify",
        maxTokens: 512,
        responseFormat: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Classify execution complexity.",
              "Return JSON with keys: estimatedSteps (number), reason (string), stepOutline (array of strings).",
              "No markdown.",
            ].join(" "),
          },
          {
            role: "user",
            content: `Goal title: ${goal.title}\nGoal description: ${goal.description}`,
          },
        ],
      }));

      const parsed = safeJsonParse(result.content);
      const estimatedSteps = clampSteps(
        typeof parsed?.estimatedSteps === "number" ? parsed.estimatedSteps : heuristicStepEstimate(goal),
      );

      return {
        estimatedSteps,
        requiresPlanMode: estimatedSteps > 3,
      };
    } catch {
      const estimatedSteps = heuristicStepEstimate(goal);
      return {
        estimatedSteps,
        requiresPlanMode: estimatedSteps > 3,
      };
    }
  }

  /** Why orchestration inference is paused by survival tier, or null. Without a gate the client decides. */
  private orchestrationPauseReason(): string | null {
    const gate = getInstalledInferenceGate();
    if (!gate) return null;
    try {
      const { tier } = gate.survival();
      return PAUSED_SURVIVAL_TIERS.has(tier) ? `survival tier ${tier}` : null;
    } catch {
      return "inference gate unavailable";
    }
  }

  /** Why ready tasks must stay pending this tick, or null when they may be assigned. */
  private assignmentBlockReason(): string | null {
    const pause = this.orchestrationPauseReason();
    if (pause) return pause;

    const blockedUntil = this.params.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY) as { value: string } | undefined;
    const untilMs = blockedUntil ? Date.parse(blockedUntil.value) : NaN;
    // Writers clamp to an hour; anything further out means the clock moved back.
    if (Number.isFinite(untilMs) && untilMs > Date.now() && untilMs - Date.now() <= MAX_INFERENCE_BLOCK_MS) {
      return `worker inference refused until ${new Date(untilMs).toISOString()}`;
    }

    const gate = getInstalledInferenceGate();
    if (!gate) return null;
    try {
      // Workers carry a task, not a session: check as a worker would be checked.
      const headroom = gate.headroom("orchestration", { caller: "worker" });
      return headroom.allowed ? null : `no orchestration headroom (${headroom.code ?? "refused"})`;
    } catch {
      return "inference gate unavailable";
    }
  }

  private persistTodo(): void {
    const todoMd = generateTodoMd(this.params.db);
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(ORCHESTRATOR_TODO_KEY, todoMd);
  }

  private async persistPlannerOutput(
    goalId: string,
    output: PlannerOutput,
    mode: "plan" | "replan",
  ): Promise<void> {
    const canonicalKey = `orchestrator.plan.${goalId}`;
    const modeKey = `orchestrator.${mode}.${goalId}`;
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(canonicalKey, JSON.stringify(output));

    if (modeKey !== canonicalKey) {
      this.params.db.prepare(
        "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ).run(modeKey, JSON.stringify(output));
    }

    try {
      const workspace = new AgentWorkspace(goalId);
      await persistPlannerArtifacts({
        goalId,
        workspacePath: workspace.basePath,
        plan: output,
        version: getNextPlannerVersion(workspace.basePath),
      });
    } catch (error) {
      const err = normalizeError(error);
      logger.warn("Failed to persist planner artifacts to workspace", {
        goalId,
        mode,
        error: err.message,
      });
    }
  }

  private loadState(): OrchestratorState {
    const row = this.params.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(ORCHESTRATOR_STATE_KEY) as { value: string } | undefined;

    if (!row?.value) {
      return { ...DEFAULT_STATE };
    }

    const parsed = safeJsonParse(row.value);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_STATE };
    }

    const phase = asPhase(parsed.phase);
    return {
      phase: phase ?? DEFAULT_STATE.phase,
      goalId: typeof parsed.goalId === "string" ? parsed.goalId : null,
      replanCount: typeof parsed.replanCount === "number" ? Math.max(0, Math.floor(parsed.replanCount)) : 0,
      failedTaskId: typeof parsed.failedTaskId === "string" ? parsed.failedTaskId : null,
      failedError: typeof parsed.failedError === "string" ? parsed.failedError : null,
      ...(typeof parsed.completedSeen === "number" ? { completedSeen: parsed.completedSeen } : {}),
    };
  }

  private saveState(state: OrchestratorState): void {
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(ORCHESTRATOR_STATE_KEY, JSON.stringify(state));
  }

  /** The oldest failure nobody handles (a running orchestrator task handles its own sub-tasks'). */
  private findFirstFailedTaskId(goalId: string): string | null {
    const row = this.params.db.prepare(
      `SELECT t.id FROM task_graph t
       WHERE t.goal_id = ? AND t.status = 'failed'
         AND NOT EXISTS (SELECT 1 FROM task_graph p WHERE p.id = t.parent_id AND p.status IN ('assigned', 'running'))
       ORDER BY t.created_at ASC LIMIT 1`,
    ).get(goalId) as { id: string } | undefined;

    return row?.id ?? null;
  }

  private getMaxReplans(): number {
    const configured = Number(this.params.config?.maxReplans ?? DEFAULT_MAX_REPLANS);
    if (!Number.isFinite(configured)) {
      return DEFAULT_MAX_REPLANS;
    }

    return Math.max(0, Math.floor(configured));
  }
}


function plannerOutputToTasks(goalId: string, output: PlannerOutput): DecomposeTaskInput[] {
  return output.tasks.map((task, index) => ({
    parentId: null,
    goalId,
    title: task.title,
    description: task.description,
    status: "pending",
    assignedTo: null,
    agentRole: task.agentRole,
    priority: clampPriority(task.priority, index),
    dependencies: task.dependencies.map((dep) => String(dep)),
    result: null,
    // decomposeGoal clamps these to the per-task limits.
    estimatedCostCents: task.estimatedCostCents,
    timeoutMs: task.timeoutMs,
  }));
}

/**
 * Drop planned tasks that repeat work a covering task (completed, running,
 * or kept) already does (same title), and point their dependents at the
 * existing task instead.
 */
function dedupeAgainstExisting(planned: DecomposeTaskInput[], covering: TaskGraphRow[]): DecomposeTaskInput[] {
  const keepByTitle = new Map<string, string>();
  for (const task of covering) {
    const key = normalizeTitle(task.title);
    if (!keepByTitle.has(key) || task.status !== "completed") keepByTitle.set(key, task.id);
  }
  if (keepByTitle.size === 0) return planned;

  const replacement = new Map<number, string>();
  const newIndex = new Map<number, number>();
  const kept: DecomposeTaskInput[] = [];
  planned.forEach((task, index) => {
    const existingId = keepByTitle.get(normalizeTitle(task.title));
    if (existingId) {
      replacement.set(index, existingId);
    } else {
      newIndex.set(index, kept.length);
      kept.push(task);
    }
  });
  if (replacement.size === 0) return planned;

  return kept.map((task) => ({
    ...task,
    dependencies: task.dependencies.map((dep) => {
      const index = Number(dep);
      if (!Number.isInteger(index) || String(index) !== dep) return dep;
      return replacement.get(index) ?? String(newIndex.get(index) ?? dep);
    }),
  }));
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim().toLowerCase();
}

function singleTaskPlan(goal: GoalRow, analysis: string, strategy: string, risk: string): PlannerOutput {
  return {
    analysis,
    strategy,
    customRoles: [],
    tasks: [{
      title: goal.title,
      description: goal.description,
      agentRole: "generalist",
      dependencies: [],
      estimatedCostCents: 200,
      priority: 50,
      timeoutMs: 300_000,
    }],
    risks: risk ? [risk] : [],
    estimatedTotalCostCents: 200,
    estimatedTimeMinutes: 30,
  };
}

/** ISO timestamps as written by the task graph; a zone-less SQLite value is UTC. */
function parseTimestamp(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

function goalRowToGoal(goal: GoalRow): Goal {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    status: goal.status,
    strategy: goal.strategy,
    rootTasks: [],
    expectedRevenueCents: goal.expectedRevenueCents,
    actualRevenueCents: goal.actualRevenueCents,
    createdAt: goal.createdAt,
    deadline: goal.deadline,
  };
}

function taskRowToTaskNode(task: TaskGraphRow): TaskNode {
  return {
    id: task.id,
    parentId: task.parentId,
    goalId: task.goalId,
    title: task.title,
    description: task.description,
    status: task.status,
    assignedTo: task.assignedTo,
    agentRole: task.agentRole,
    priority: task.priority,
    dependencies: task.dependencies,
    result: normalizeTaskResult(task.result),
    metadata: {
      estimatedCostCents: task.estimatedCostCents,
      actualCostCents: task.actualCostCents,
      maxRetries: task.maxRetries,
      retryCount: task.retryCount,
      timeoutMs: task.timeoutMs,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    },
  };
}

function pickGoal(goals: GoalRow[], preferredId: string | null): GoalRow {
  if (preferredId) {
    const preferred = goals.find((goal) => goal.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }

  return goals[0];
}

function clampPriority(priority: number, fallbackIndex: number): number {
  if (!Number.isFinite(priority)) {
    return Math.max(0, 50 - fallbackIndex);
  }

  return Math.max(0, Math.min(100, Math.floor(priority)));
}

function heuristicStepEstimate(goal: GoalRow): number {
  const words = `${goal.title} ${goal.description}`.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 40) return 6;
  if (words >= 24) return 5;
  if (words >= 12) return 4;
  return 2;
}

function clampSteps(value: number): number {
  if (!Number.isFinite(value)) {
    return 4;
  }

  const rounded = Math.floor(value);
  return Math.max(1, Math.min(20, rounded));
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asPhase(value: unknown): ExecutionPhase | null {
  if (
    value === "idle"
    || value === "classifying"
    || value === "planning"
    || value === "plan_review"
    || value === "executing"
    || value === "replanning"
    || value === "complete"
    || value === "failed"
  ) {
    return value;
  }

  return null;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
