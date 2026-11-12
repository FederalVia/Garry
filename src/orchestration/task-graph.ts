import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import {
  getGoalById,
  getReadyTasks as getReadyTaskRows,
  getTaskById,
  insertEvent,
  insertGoal,
  insertTask,
  updateGoalStatus,
  updateTaskStatus,
  withTransaction,
} from "../state/database.js";
import type { GoalRow, GoalStatus as DbGoalStatus, TaskGraphRow } from "../state/database.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("orchestration.task-graph");

export type TaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

// One definition with the row type, so a new goal status needs no change here.
export type GoalStatus = DbGoalStatus;

export interface TaskResult {
  success: boolean;
  output: string;
  artifacts: string[];
  costCents: number;
  duration: number;
}

export interface TaskNode {
  id: string;
  parentId: string | null;
  goalId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedTo: string | null;
  agentRole: string | null;
  priority: number;
  dependencies: string[];
  result: TaskResult | null;
  metadata: {
    estimatedCostCents: number;
    actualCostCents: number;
    maxRetries: number;
    retryCount: number;
    timeoutMs: number;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  strategy: string | null;
  rootTasks: string[];
  expectedRevenueCents: number;
  actualRevenueCents: number;
  createdAt: string;
  deadline: string | null;
}

export type DecomposeTaskInput = Omit<TaskNode, "id" | "metadata"> & {
  estimatedCostCents?: number;
  timeoutMs?: number;
  maxRetries?: number;
};

/** Planner estimates are clamped so the per-task inference cap (2x estimate) stays at most 1000c. */
export const MAX_TASK_ESTIMATE_CENTS = 500;
export const MIN_TASK_TIMEOUT_MS = 60_000;
export const MAX_TASK_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;
/** Grace past a task's own timeout before the orchestrator reclaims it. */
export const TASK_DEADLINE_GRACE_MS = 2 * 60_000;

export function clampTaskEstimateCents(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(MAX_TASK_ESTIMATE_CENTS, Math.round(n)));
}

export function clampTaskTimeoutMs(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_TASK_TIMEOUT_MS;
  return Math.max(MIN_TASK_TIMEOUT_MS, Math.min(MAX_TASK_TIMEOUT_MS, Math.round(n)));
}

/** What a task's owner reports when it settles the task. */
export type TaskOutcome =
  | { kind: "complete"; result: TaskResult }
  | { kind: "fail"; error: string; retry: boolean; costCents?: number }
  | { kind: "defer"; reason: string; costCents?: number };

/** "stale": the caller no longer owns the task, so nothing but its spend was recorded. */
export type SettleResult = "applied" | "stale";

type CycleTask = {
  id?: string;
  title?: string;
  parentId?: string | null;
  dependencies: string[];
};

/** KV key set when worker inference was refused; the orchestrator assigns nothing before it passes. */
export const ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY = "orchestrator.inference_blocked_until";
/** Longest such block; a later value means the clock moved backwards and is ignored. */
export const MAX_INFERENCE_BLOCK_MS = 60 * 60_000;

/** SQL on alias `t`: the task's parent (an orchestrator task) is still assigned or running. */
const LIVE_PARENT = `EXISTS (SELECT 1 FROM task_graph p WHERE p.id = t.parent_id AND p.status IN ('assigned', 'running'))`;

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function createGoal(
  db: Database,
  title: string,
  description: string,
  strategy?: string,
): Goal {
  const normalizedTitle = title.trim();
  const normalizedDescription = description.trim();

  if (!normalizedTitle) {
    throw new Error("Goal title cannot be empty");
  }

  if (!normalizedDescription) {
    throw new Error("Goal description cannot be empty");
  }

  const id = insertGoal(db, {
    title: normalizedTitle,
    description: normalizedDescription,
    strategy: strategy ?? null,
  });

  const row = getGoalById(db, id);
  if (!row) {
    throw new Error(`Failed to load goal after insertion: ${id}`);
  }

  return goalRowToGoal(row, []);
}

export function decomposeGoal(
  db: Database,
  goalId: string,
  tasks: DecomposeTaskInput[],
): void {
  if (!getGoalById(db, goalId)) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  if (tasks.length === 0) {
    return;
  }

  const titleCounts = new Map<string, number>();
  for (const task of tasks) {
    const normalizedTitle = task.title.trim();
    if (!normalizedTitle) {
      throw new Error("Task title cannot be empty");
    }

    if (!task.description.trim()) {
      throw new Error(`Task description cannot be empty for: ${task.title}`);
    }

    if (task.goalId !== goalId) {
      throw new Error(`Task goal mismatch for '${task.title}'. Expected ${goalId}, got ${task.goalId}`);
    }

    if (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 100) {
      throw new Error(`Task priority must be an integer in [0,100] for '${task.title}'`);
    }

    titleCounts.set(task.title, (titleCounts.get(task.title) ?? 0) + 1);
  }

  const plannedTasks = tasks.map((task, index) => ({
    localId: ulid(),
    index,
    task,
  }));

  const referenceMap = buildLocalReferenceMap(plannedTasks, titleCounts);
  const cycleTasks: CycleTask[] = plannedTasks.map(({ localId, task }) => ({
    id: localId,
    parentId: resolveReference(task.parentId, referenceMap),
    dependencies: task.dependencies.map((dep) => resolveReference(dep, referenceMap) ?? dep),
  }));

  if (detectCycles(cycleTasks)) {
    throw new Error("Task graph contains a cycle; decomposition must be a DAG");
  }

  withTransaction(db, () => {
    const localToPersisted = new Map<string, string>();
    const deferredUpdates: {
      taskId: string;
      requestedStatus: TaskStatus;
      parentRef: string | null;
      dependencyRefs: string[];
    }[] = [];

    for (const planned of plannedTasks) {
      const parentRef = resolveReference(planned.task.parentId, referenceMap);
      const dependencyRefs = uniqueStrings(
        planned.task.dependencies.map((dep) => resolveReference(dep, referenceMap) ?? dep),
      ).filter((dep) => dep !== planned.localId);

      const taskId = insertTask(db, {
        parentId: parentRef,
        goalId,
        title: planned.task.title,
        description: planned.task.description,
        status: planned.task.status,
        assignedTo: planned.task.assignedTo,
        agentRole: planned.task.agentRole,
        priority: planned.task.priority,
        dependencies: dependencyRefs,
        result: planned.task.result,
        ...(planned.task.estimatedCostCents !== undefined
          ? { estimatedCostCents: clampTaskEstimateCents(planned.task.estimatedCostCents) }
          : {}),
        ...(planned.task.timeoutMs !== undefined
          ? { timeoutMs: clampTaskTimeoutMs(planned.task.timeoutMs) }
          : {}),
        ...(typeof planned.task.maxRetries === "number" && Number.isInteger(planned.task.maxRetries)
          ? { maxRetries: Math.max(0, Math.min(10, planned.task.maxRetries)) }
          : {}),
      });

      localToPersisted.set(planned.localId, taskId);
      deferredUpdates.push({
        taskId,
        requestedStatus: planned.task.status,
        parentRef,
        dependencyRefs,
      });
    }

    const updateStmt = db.prepare(
      "UPDATE task_graph SET parent_id = ?, dependencies = ?, status = ? WHERE id = ?",
    );

    for (const update of deferredUpdates) {
      const resolvedParentId = update.parentRef
        ? (localToPersisted.get(update.parentRef) ?? update.parentRef)
        : null;
      const resolvedDependencies = uniqueStrings(
        update.dependencyRefs.map((dep) => localToPersisted.get(dep) ?? dep),
      );

      validateParentReference(db, goalId, update.taskId, resolvedParentId);
      validateDependencyReferences(db, goalId, update.taskId, resolvedDependencies);

      const initialStatus = resolveInitialTaskStatus(db, update.requestedStatus, resolvedDependencies);
      updateStmt.run(
        resolvedParentId,
        JSON.stringify(resolvedDependencies),
        initialStatus,
        update.taskId,
      );
    }

    unblockReadyBlockedTasks(db);
    refreshGoalStatus(db, goalId);
  });
}

/** The task as a TaskNode, or null when it does not exist. */
export function getTaskNode(db: Database, taskId: string): TaskNode | null {
  const row = getTaskById(db, taskId);
  return row ? taskRowToTaskNode(row) : null;
}

export function getReadyTasks(db: Database): TaskNode[] {
  return getReadyTaskRows(db).map(taskRowToTaskNode);
}

export function assignTask(db: Database, taskId: string, agentAddress: string): void {
  const normalizedAddress = agentAddress.trim();
  if (!normalizedAddress) {
    throw new Error("agentAddress cannot be empty");
  }

  withTransaction(db, () => {
    const task = getTaskById(db, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== "pending") {
      throw new Error(`Task ${taskId} is not assignable from status '${task.status}'`);
    }

    updateTaskStatus(db, taskId, "assigned");
    db.prepare("UPDATE task_graph SET assigned_to = ? WHERE id = ?").run(normalizedAddress, taskId);
  });
}

/** Admin completion (tools, tests): no owner check. Workers use settleTask. */
export function completeTask(db: Database, taskId: string, result: TaskResult): void {
  withTransaction(db, () => {
    const task = getTaskById(db, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Task ${taskId} is already in terminal status '${task.status}'`);
    }

    applyComplete(db, task, result);
  });
}

/**
 * Admin failure (tools, tests): no owner check. Workers use settleTask.
 * `costCents`, when given, is the task's cumulative inference spend and is
 * written to actual_cost_cents.
 */
export function failTask(
  db: Database,
  taskId: string,
  error: string,
  shouldRetry: boolean,
  costCents?: number,
): void {
  withTransaction(db, () => {
    const task = getTaskById(db, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Task ${taskId} is already in terminal status '${task.status}'`);
    }

    applyFail(db, task, error, shouldRetry, costCents);
  });
}

/**
 * Put a task back in the queue without consuming a retry: used when
 * inference was refused for a reason that clears with time. Returns false
 * when the task is missing or already terminal.
 */
export function deferTask(db: Database, taskId: string, reason: string, costCents?: number): boolean {
  return withTransaction(db, () => {
    const task = getTaskById(db, taskId);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) {
      return false;
    }
    applyDefer(db, task, reason, costCents);
    return true;
  });
}

/** True while `owner` holds the task (assigned or running to it). */
export function isTaskOwnedBy(db: Database, taskId: string, owner: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM task_graph WHERE id = ? AND assigned_to = ? AND status IN ('assigned', 'running')")
    .get(taskId, owner);
  return row !== undefined;
}

/**
 * The owner starts work: assigned -> running with started_at set now.
 * False when the task is no longer assigned to it (nothing to do).
 */
export function claimTaskStart(db: Database, taskId: string, owner: string): boolean {
  const info = db
    .prepare(
      `UPDATE task_graph SET status = 'running', started_at = ?
       WHERE id = ? AND assigned_to = ? AND status = 'assigned'`,
    )
    .run(new Date().toISOString(), taskId, owner);
  return info.changes > 0;
}

/**
 * Apply an owner's report. Only the current owner of an assigned or
 * running task can settle it; any other report is stale: it is dropped and
 * logged, and only its spend is kept (actual_cost_cents never goes down).
 */
export function settleTask(db: Database, taskId: string, owner: string, outcome: TaskOutcome): SettleResult {
  return withTransaction(db, () => {
    const task = getTaskById(db, taskId);
    if (!task || task.assignedTo !== owner || (task.status !== "assigned" && task.status !== "running")) {
      const cost = outcome.kind === "complete" ? outcome.result.costCents : outcome.costCents;
      recordStaleReport(db, taskId, owner, task, outcome.kind, cost);
      return "stale";
    }

    if (outcome.kind === "complete") {
      applyComplete(db, task, outcome.result);
    } else if (outcome.kind === "fail") {
      applyFail(db, task, outcome.error, outcome.retry, outcome.costCents);
    } else {
      applyDefer(db, task, outcome.reason, outcome.costCents);
    }
    return "applied";
  });
}

/**
 * Take a task back from its owner. With retry, the release counts as a
 * failed attempt (dead owner, timeout) and fails the task for good once its
 * retries are spent; without, it is a deferral that spends nothing.
 */
export function releaseTask(
  db: Database,
  taskId: string,
  owner: string,
  reason: string,
  options: { retry: boolean },
): SettleResult {
  return settleTask(
    db,
    taskId,
    owner,
    options.retry ? { kind: "fail", error: reason, retry: true } : { kind: "defer", reason },
  );
}

/** Raise a task's recorded spend; spend is a fact even when a report is dropped. */
export function recordTaskSpend(db: Database, taskId: string, costCents: number | undefined): void {
  if (typeof costCents !== "number" || !Number.isFinite(costCents) || costCents <= 0) return;
  db.prepare("UPDATE task_graph SET actual_cost_cents = MAX(COALESCE(actual_cost_cents, 0), ?) WHERE id = ?")
    .run(costCents, taskId);
}

/**
 * Supersede every pending, blocked or failed task of a goal (a replan
 * replaces them), except keepIds. Assigned, running and completed tasks are
 * left alone.
 */
export function supersedeOpenTasks(
  db: Database,
  goalId: string,
  replanNumber: number,
  keepIds: ReadonlySet<string> = new Set(),
): number {
  const result: TaskResult & { superseded_by_replan: number } = {
    success: false,
    output: `Superseded by replan ${replanNumber}`,
    artifacts: [],
    costCents: 0,
    duration: 0,
    superseded_by_replan: replanNumber,
  };
  // Sub-tasks of a still-running orchestrator task belong to it and are left alone.
  const info = db
    .prepare(
      `UPDATE task_graph AS t SET status = 'cancelled', completed_at = ?, result = ?
       WHERE goal_id = ? AND status IN ('pending', 'blocked', 'failed') AND NOT ${LIVE_PARENT}
         AND id NOT IN (SELECT value FROM json_each(?))`,
    )
    .run(new Date().toISOString(), JSON.stringify(result), goalId, JSON.stringify([...keepIds]));
  return info.changes;
}

/**
 * Cancel the given failed tasks and every pending or blocked task that
 * depends on them, directly or transitively: a dependent of replaced work
 * could never become ready. Returns the ids cancelled.
 */
export function supersedeFailedWithDependents(
  db: Database,
  failedIds: string[],
  marker: Record<string, unknown>,
  output: string,
): string[] {
  const result = JSON.stringify({ success: false, output, artifacts: [], costCents: 0, duration: 0, ...marker });
  const now = new Date().toISOString();
  const cancelRoot = db.prepare(
    "UPDATE task_graph SET status = 'cancelled', completed_at = ?, result = ? WHERE id = ? AND status = 'failed'",
  );
  const cancelDependent = db.prepare(
    "UPDATE task_graph SET status = 'cancelled', completed_at = ?, result = ? WHERE id = ? AND status IN ('pending', 'blocked')",
  );
  const dependentsOf = db.prepare(
    `SELECT t.id FROM task_graph t
      WHERE t.status IN ('pending', 'blocked')
        AND EXISTS (SELECT 1 FROM json_each(COALESCE(NULLIF(t.dependencies, ''), '[]')) dep WHERE dep.value = ?)`,
  );

  const cancelled: string[] = [];
  const queue: string[] = [];
  for (const id of failedIds) {
    if (cancelRoot.run(now, result, id).changes > 0) cancelled.push(id);
    // A root cancelled earlier may still have waiting dependents.
    const status = getTaskById(db, id)?.status;
    if (status === "cancelled" || status === "failed") queue.push(id);
  }
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const row of dependentsOf.all(id) as Array<{ id: string }>) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (cancelDependent.run(now, result, row.id).changes > 0) {
        cancelled.push(row.id);
        queue.push(row.id);
      }
    }
  }
  return cancelled;
}

function recordStaleReport(
  db: Database,
  taskId: string,
  owner: string,
  task: TaskGraphRow | undefined,
  kind: TaskOutcome["kind"],
  costCents: number | undefined,
): void {
  if (task) recordTaskSpend(db, taskId, costCents);
  logger.warn("Dropped a stale task report", {
    taskId,
    reporter: owner,
    kind,
    currentStatus: task?.status ?? "missing",
    currentOwner: task?.assignedTo ?? null,
  });
  try {
    insertEvent(db, {
      type: "stale_task_report",
      agentAddress: owner,
      goalId: task?.goalId ?? null,
      taskId,
      content: JSON.stringify({ kind, currentStatus: task?.status ?? "missing", currentOwner: task?.assignedTo ?? null }),
      tokenCount: 0,
    });
  } catch {
    // The event stream is best effort; the report is dropped either way.
  }
}

function applyComplete(db: Database, task: TaskGraphRow, result: TaskResult): void {
  updateTaskStatus(db, task.id, "completed");
  db.prepare(
    `UPDATE task_graph
     SET result = ?, actual_cost_cents = MAX(COALESCE(actual_cost_cents, 0), ?), started_at = COALESCE(started_at, ?)
     WHERE id = ?`,
  ).run(JSON.stringify(result), result.costCents, new Date().toISOString(), task.id);

  // An orchestrator task that succeeds has dealt with its failed sub-tasks;
  // they must not fail the goal once it is no longer running.
  const failedSubTasks = db
    .prepare("SELECT id FROM task_graph WHERE parent_id = ? AND status = 'failed'")
    .all(task.id) as Array<{ id: string }>;
  if (failedSubTasks.length > 0) {
    supersedeFailedWithDependents(
      db,
      failedSubTasks.map((row) => row.id),
      { superseded_by_parent: task.id },
      "Superseded: its orchestrator task completed",
    );
  }

  unblockReadyBlockedTasks(db);
  refreshGoalStatus(db, task.goalId);
}

function applyFail(
  db: Database,
  task: TaskGraphRow,
  error: string,
  shouldRetry: boolean,
  costCents?: number,
): void {
  const hasCost = typeof costCents === "number" && Number.isFinite(costCents) && costCents >= 0;
  if (hasCost) recordTaskSpend(db, task.id, costCents);

  const failureResult: TaskResult & { failedBy?: string } = {
    success: false,
    output: error,
    artifacts: [],
    costCents: hasCost ? costCents : task.actualCostCents,
    duration: 0,
  };

  const canRetry = shouldRetry && task.retryCount < task.maxRetries;
  if (canRetry) {
    // The next attempt clears assigned_to, so the failing owner goes in the result.
    if (task.assignedTo) failureResult.failedBy = task.assignedTo;
    const nextStatus: TaskStatus = areDependenciesSatisfied(db, task.dependencies)
      ? "pending"
      : "blocked";

    db.prepare(
      `UPDATE task_graph
       SET status = ?, retry_count = ?, assigned_to = NULL, started_at = NULL, completed_at = NULL, result = ?
       WHERE id = ?`,
    ).run(nextStatus, task.retryCount + 1, JSON.stringify(failureResult), task.id);

    return;
  }

  // A permanent failure keeps assigned_to so the failure stays attributed.
  updateTaskStatus(db, task.id, "failed");
  db.prepare("UPDATE task_graph SET result = ? WHERE id = ?").run(JSON.stringify(failureResult), task.id);

  blockDependentsForFailedTask(db, task.id);
  refreshGoalStatus(db, task.goalId);
}

function applyDefer(db: Database, task: TaskGraphRow, reason: string, costCents?: number): void {
  const nextStatus: TaskStatus = areDependenciesSatisfied(db, task.dependencies) ? "pending" : "blocked";
  const hasCost = typeof costCents === "number" && Number.isFinite(costCents) && costCents >= 0;
  const deferredResult: TaskResult = {
    success: false,
    output: `Deferred: ${reason}`,
    artifacts: [],
    costCents: hasCost ? costCents : task.actualCostCents,
    duration: 0,
  };

  db.prepare(
    `UPDATE task_graph
     SET status = ?, assigned_to = NULL, started_at = NULL, completed_at = NULL, result = ?,
         actual_cost_cents = MAX(COALESCE(actual_cost_cents, 0), ?)
     WHERE id = ?`,
  ).run(nextStatus, JSON.stringify(deferredResult), deferredResult.costCents, task.id);
}

export interface GoalProgress {
  total: number;
  completed: number;
  /** Failed tasks nobody is handling: the goal needs a replan. */
  failed: number;
  /** Failed sub-tasks whose orchestrator task is still running and handles them. */
  failedUnderLiveParent: number;
  blocked: number;
  /** Assigned or running. */
  running: number;
  pending: number;
  cancelled: number;
  /** Pending, assigned or running. */
  active: number;
  /** Total minus cancelled: what must complete for the goal to complete. */
  effectiveTotal: number;
}

export function getGoalProgress(db: Database, goalId: string): GoalProgress {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' AND NOT ${LIVE_PARENT} THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'failed' AND ${LIVE_PARENT} THEN 1 ELSE 0 END) AS failedUnderLiveParent,
         SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
         SUM(CASE WHEN status IN ('assigned', 'running') THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM task_graph t
       WHERE goal_id = ?`,
    )
    .get(goalId) as Record<string, number | null> | undefined;

  const total = row?.total ?? 0;
  const running = row?.running ?? 0;
  const pending = row?.pending ?? 0;
  const cancelled = row?.cancelled ?? 0;
  return {
    total,
    completed: row?.completed ?? 0,
    failed: row?.failed ?? 0,
    failedUnderLiveParent: row?.failedUnderLiveParent ?? 0,
    blocked: row?.blocked ?? 0,
    running,
    pending,
    cancelled,
    active: running + pending,
    effectiveTotal: total - cancelled,
  };
}

/** Every task that has to complete has completed (cancelled tasks do not count). */
export function isGoalProgressComplete(progress: GoalProgress): boolean {
  return progress.effectiveTotal > 0 && progress.completed === progress.effectiveTotal;
}

export function pruneCompletedGoals(db: Database, olderThan: string): void {
  withTransaction(db, () => {
    db.prepare(
      `DELETE FROM task_graph
       WHERE goal_id IN (
         SELECT id
         FROM goals
         WHERE status = 'completed'
           AND completed_at IS NOT NULL
           AND completed_at < ?
       )`,
    ).run(olderThan);

    db.prepare(
      `DELETE FROM goals
       WHERE status = 'completed'
         AND completed_at IS NOT NULL
         AND completed_at < ?`,
    ).run(olderThan);
  });
}

export function detectCycles(tasks: CycleTask[]): boolean {
  if (tasks.length === 0) {
    return false;
  }

  const nodes = tasks.map((task, index) => ({
    id: task.id && task.id.length > 0 ? task.id : `local-${index}-${ulid()}`,
    title: task.title,
    parentId: task.parentId ?? null,
    dependencies: task.dependencies,
    index,
  }));

  const titleCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.title) {
      titleCounts.set(node.title, (titleCounts.get(node.title) ?? 0) + 1);
    }
  }

  const aliasMap = new Map<string, string>();
  for (const node of nodes) {
    aliasMap.set(node.id, node.id);
    aliasMap.set(String(node.index), node.id);
    aliasMap.set(`#${node.index}`, node.id);
    aliasMap.set(`task-${node.index + 1}`, node.id);

    if (node.title && titleCounts.get(node.title) === 1) {
      aliasMap.set(node.title, node.id);
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) {
    const edges = new Set<string>();
    const refs = [...node.dependencies, ...(node.parentId ? [node.parentId] : [])];

    for (const ref of refs) {
      const resolved = aliasMap.get(ref);
      if (resolved) {
        edges.add(resolved);
      }
    }

    adjacency.set(node.id, edges);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) {
      return true;
    }

    if (visited.has(nodeId)) {
      return false;
    }

    visiting.add(nodeId);

    const neighbors = adjacency.get(nodeId);
    if (neighbors) {
      for (const dep of neighbors) {
        if (dfs(dep)) {
          return true;
        }
      }
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  for (const node of nodes) {
    if (dfs(node.id)) {
      return true;
    }
  }

  return false;
}

function taskRowToTaskNode(row: TaskGraphRow): TaskNode {
  return {
    id: row.id,
    parentId: row.parentId,
    goalId: row.goalId,
    title: row.title,
    description: row.description,
    status: row.status,
    assignedTo: row.assignedTo,
    agentRole: row.agentRole,
    priority: row.priority,
    dependencies: row.dependencies,
    result: normalizeTaskResult(row.result),
    metadata: {
      estimatedCostCents: row.estimatedCostCents,
      actualCostCents: row.actualCostCents,
      maxRetries: row.maxRetries,
      retryCount: row.retryCount,
      timeoutMs: row.timeoutMs,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    },
  };
}

function goalRowToGoal(row: GoalRow, rootTasks: string[]): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    strategy: row.strategy,
    rootTasks,
    expectedRevenueCents: row.expectedRevenueCents,
    actualRevenueCents: row.actualRevenueCents,
    createdAt: row.createdAt,
    deadline: row.deadline,
  };
}

export function normalizeTaskResult(value: unknown): TaskResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<TaskResult>;
  if (typeof candidate.success !== "boolean" || typeof candidate.output !== "string") {
    return null;
  }

  return {
    success: candidate.success,
    output: candidate.output,
    artifacts: Array.isArray(candidate.artifacts)
      ? candidate.artifacts.filter((entry): entry is string => typeof entry === "string")
      : [],
    costCents: typeof candidate.costCents === "number" ? candidate.costCents : 0,
    duration: typeof candidate.duration === "number" ? candidate.duration : 0,
  };
}

function resolveInitialTaskStatus(
  db: Database,
  requestedStatus: TaskStatus,
  dependencies: string[],
): TaskStatus {
  if (TERMINAL_TASK_STATUSES.has(requestedStatus)) {
    return requestedStatus;
  }

  if (requestedStatus === "assigned" || requestedStatus === "running") {
    return requestedStatus;
  }

  const depsSatisfied = areDependenciesSatisfied(db, dependencies);
  if (!depsSatisfied) {
    return "blocked";
  }

  return "pending";
}

function areDependenciesSatisfied(db: Database, dependencies: string[]): boolean {
  for (const dependencyId of dependencies) {
    const task = getTaskById(db, dependencyId);
    if (!task || task.status !== "completed") {
      return false;
    }
  }

  return true;
}

function validateParentReference(
  db: Database,
  goalId: string,
  taskId: string,
  parentId: string | null,
): void {
  if (!parentId) {
    return;
  }

  if (parentId === taskId) {
    throw new Error(`Task ${taskId} cannot be its own parent`);
  }

  const parentTask = getTaskById(db, parentId);
  if (!parentTask) {
    throw new Error(`Parent task ${parentId} not found for task ${taskId}`);
  }

  if (parentTask.goalId !== goalId) {
    throw new Error(`Parent task ${parentId} is outside goal ${goalId}`);
  }
}

function validateDependencyReferences(
  db: Database,
  goalId: string,
  taskId: string,
  dependencies: string[],
): void {
  for (const dependencyId of dependencies) {
    if (dependencyId === taskId) {
      throw new Error(`Task ${taskId} cannot depend on itself`);
    }

    const dependencyTask = getTaskById(db, dependencyId);
    if (!dependencyTask) {
      throw new Error(`Dependency task ${dependencyId} not found for task ${taskId}`);
    }

    if (dependencyTask.goalId !== goalId) {
      throw new Error(`Dependency task ${dependencyId} is outside goal ${goalId}`);
    }
  }
}

function blockDependentsForFailedTask(db: Database, failedTaskId: string): void {
  db.prepare(
    `UPDATE task_graph
     SET status = 'blocked', assigned_to = NULL
     WHERE status IN ('pending', 'assigned', 'running')
       AND EXISTS (
         SELECT 1
         FROM json_each(COALESCE(NULLIF(task_graph.dependencies, ''), '[]')) dep
         WHERE dep.value = ?
       )`,
  ).run(failedTaskId);
}

function unblockReadyBlockedTasks(db: Database): void {
  db.prepare(
    `UPDATE task_graph
     SET status = 'pending'
     WHERE status = 'blocked'
       AND NOT EXISTS (
         SELECT 1
         FROM json_each(COALESCE(NULLIF(task_graph.dependencies, ''), '[]')) dep
         LEFT JOIN task_graph d ON d.id = dep.value
         WHERE d.status IS NULL OR d.status != 'completed'
       )`,
  ).run();
}

function refreshGoalStatus(db: Database, goalId: string): void {
  const goal = getGoalById(db, goalId);
  // Only active and failed goals follow their tasks; paused, completed and
  // cancelled goals are set by their owner and never overwritten here.
  if (!goal || (goal.status !== "active" && goal.status !== "failed")) {
    return;
  }

  const progress = getGoalProgress(db, goalId);

  if (progress.failed > 0) {
    if (goal.status !== "failed") updateGoalStatus(db, goalId, "failed");
    return;
  }

  if (isGoalProgressComplete(progress)) {
    updateGoalStatus(db, goalId, "completed");
    return;
  }

  if (goal.status !== "active") {
    updateGoalStatus(db, goalId, "active");
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }

  return output;
}

function buildLocalReferenceMap(
  plannedTasks: { localId: string; index: number; task: DecomposeTaskInput }[],
  titleCounts: Map<string, number>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const planned of plannedTasks) {
    map.set(planned.localId, planned.localId);
    map.set(String(planned.index), planned.localId);
    map.set(`#${planned.index}`, planned.localId);
    map.set(`task-${planned.index + 1}`, planned.localId);

    if ((titleCounts.get(planned.task.title) ?? 0) === 1) {
      map.set(planned.task.title, planned.localId);
    }
  }

  return map;
}

function resolveReference(reference: string | null | undefined, map: Map<string, string>): string | null {
  if (!reference) {
    return null;
  }

  return map.get(reference) ?? reference;
}
