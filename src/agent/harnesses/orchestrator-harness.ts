import fs from "node:fs";
import path from "node:path";
import type { TaskGraphRow } from "../../state/database.js";
import { getTaskById, getTasksByGoal } from "../../state/database.js";
import { loadPlan } from "../../orchestration/plan-mode.js";
import {
  createPlannerFailureFromVerification,
  createPlannerGoalFromTask,
  planGoal,
  replanAfterFailure,
  taskToPlannerFailureInput,
  type PlannerOutput,
} from "../../orchestration/planner.js";
import {
  buildPlannerContext,
  getCurrentPlannerVersion,
  persistPlannerArtifacts,
} from "../../orchestration/planner-context.js";
import type { TaskNode, TaskResult } from "../../orchestration/task-graph.js";
import {
  MAX_TASK_TIMEOUT_MS,
  TASK_DEADLINE_GRACE_MS,
  clampTaskTimeoutMs,
  decomposeGoal,
  normalizeTaskResult,
  supersedeFailedWithDependents,
} from "../../orchestration/task-graph.js";
import { BaseHarness } from "./base-harness.js";
import type { HarnessTool } from "../harness-types.js";

const MAX_FIX_CYCLES = 3;
/** Roles a sub-plan may use: no further orchestrators (one level of nesting). */
const SUB_PLANNER_ROLES = ["executor", "researcher", "tester", "generalist"];
const WAIT_TOOL = "wait_for_tasks";
const DEFAULT_WAIT_POLL_MS = 5_000;
const MAX_WAIT_S = 300;

/** Persisted per orchestrator task, so retries keep the fix budget. */
interface SubplanState {
  fixCycles: number;
  /** Failed sub-task ids already replanned around. */
  handledFailures: string[];
  /** Completed sub-tasks whose result failed verification: redone, not reused. */
  rejected: string[];
}

export class OrchestratorHarness extends BaseHarness {
  readonly id = "orchestrator";
  readonly description = "Orchestrator agent for task decomposition, delegation, verification, and fix coordination.";

  private delegatedTaskIds: string[] = [];
  private currentPlan: PlannerOutput | null = null;
  private planVersion = 0;
  private plannerMode: "plan" | "replan" = "plan";
  private plannerError: string | null = null;
  private planTaskIdByIndex = new Map<number, string>();
  private subplanState: SubplanState = { fixCycles: 0, handledFailures: [], rejected: [] };

  override async initialize(task: TaskNode, context: Parameters<BaseHarness["initialize"]>[1]): Promise<void> {
    await super.initialize(task, context);
    this.subplanState = this.loadSubplanState();
    this.refreshDelegatedTaskState();
    this.planVersion = getCurrentPlannerVersion(this.getPlanWorkspacePath());

    try {
      if (this.shouldRefreshPlanOnInitialize()) {
        await this.refreshPlanInternal({});
      } else if (this.planVersion > 0) {
        this.currentPlan = await loadPlan(path.join(this.getPlanWorkspacePath(), "plan.json"));
        this.planTaskIdByIndex = buildPlanTaskIndexMap(this.currentPlan, this.reusableTasks());
      }
    } catch (error) {
      this.plannerError = error instanceof Error ? error.message : String(error);
    }

    this.messages = [
      { role: "system", content: this.buildSystemPrompt() },
      { role: "user", content: this.buildTaskPrompt() },
    ];
  }

  buildSystemPrompt(): string {
    return `You are an orchestrator agent responsible for decomposing complex tasks
into smaller sub-tasks, delegating them, and verifying the results.

## Your Pipeline

You follow a strict planner-backed plan → execute → verify → fix cycle:

1. **PLAN**: Call refresh_plan to load the current planner output. Then delegate the
   planned work using delegate_task with plan_task_index whenever possible.
2. **EXECUTE**: After delegating, call wait_for_tasks to block until delegated work
   finishes. Do not poll check_task_status in a loop.
3. **VERIFY**: Once sub-tasks complete, use read_task_output and verify_result to
   validate results against the planned success criteria.
4. **FIX**: If a sub-task fails or verification fails, call refresh_plan again to
   request a planner-backed fix/replan, then delegate the new work.

## Rules

1. NEVER execute code yourself. You are a coordinator, not an executor.
2. Prefer delegate_task(plan_task_index=...) over rewriting planned tasks manually.
3. Do not delegate the same planned task twice; if a task already exists, reuse it.
4. Always verify completed sub-tasks before reporting completion.
5. If all sub-tasks succeed, call task_done with a consolidated summary.
6. If fix cycles are exhausted, call task_done with the best partial result and the blocker.
7. Do NOT create circular dependencies between sub-tasks.

## Anti-Loop Rules

- Do NOT repeatedly check_task_status for the same task without new information.
- If a sub-task is still running, move on to another sub-task or call wait_for_tasks.
- If planner output exists, follow it instead of inventing an unrelated decomposition.
- If you have nothing left to delegate or verify, call task_done.`;
  }

  override buildTaskPrompt(): string {
    const sections = [super.buildTaskPrompt()];
    const managedTasks = this.getManagedTasks();

    sections.push("", "## Planner State");
    if (this.currentPlan) {
      sections.push(
        `Current planner mode: ${this.plannerMode}`,
        `Current planner version: v${this.planVersion}`,
        formatPlanSummary(this.currentPlan),
      );
    } else if (this.plannerError) {
      sections.push(`Planner unavailable: ${this.plannerError}`);
    } else {
      sections.push("No plan is currently loaded. Call refresh_plan first.");
    }

    sections.push("", "## Existing Delegated Sub-Tasks");
    if (managedTasks.length === 0) {
      sections.push("No delegated sub-tasks exist yet.");
    } else {
      sections.push(...managedTasks.map((task) => formatManagedTask(task)));
    }

    sections.push(
      "",
      "## Operating Instructions",
      "- Start with refresh_plan if you need the latest planner output.",
      "- Use delegate_task(plan_task_index=...) to materialize planned tasks in order.",
      "- Use dependency task IDs returned by delegate_task for any manual follow-up tasks.",
      "- Verify completed work before declaring success.",
      "- If a delegated task fails or verification fails, call refresh_plan again to get a planner-backed fix plan.",
    );

    return sections.join("\n");
  }

  getToolDefs(): HarnessTool[] {
    return [
      {
        name: "refresh_plan",
        description: "Generate or refresh the planner-backed task decomposition. Automatically replans around failed or unverifiable sub-tasks.",
        parameters: {
          type: "object",
          properties: {
            failed_task_id: {
              type: "string",
              description: "Optional failed sub-task ID to replan around. If omitted, the first failed managed sub-task is used.",
            },
            failure_note: {
              type: "string",
              description: "Optional extra failure or verification context to feed into replanning.",
            },
          },
          required: [],
        },
        execute: async (args) => {
          try {
            const failedTaskId = typeof args.failed_task_id === "string" ? args.failed_task_id : undefined;
            const failureNote = typeof args.failure_note === "string" ? args.failure_note : undefined;
            const result = await this.refreshPlanInternal({ failedTaskId, failureNote });
            return [
              `Planner refreshed in ${result.mode} mode (v${result.version}).`,
              formatPlanSummary(result.plan),
            ].join("\n\n");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.plannerError = message;
            return `Failed to refresh plan: ${message}`;
          }
        },
      },
      {
        name: "delegate_task",
        description: "Create a sub-task and add it to the task graph for execution by a worker agent.",
        parameters: {
          type: "object",
          properties: {
            plan_task_index: {
              type: "number",
              description: "Index of the task in the current planner output. Preferred when a planner-backed plan is available.",
            },
            title: { type: "string", description: "Short, descriptive title for the sub-task" },
            description: { type: "string", description: "Detailed description including success criteria" },
            role: {
              type: "string",
              description: "Agent role: executor (coding), researcher (info gathering), tester (verification), generalist (other)",
            },
            priority: { type: "number", description: "Priority 0-100 (default: 50)" },
            depends_on: {
              type: "array",
              items: { type: "string" },
              description: "Array of task IDs this sub-task depends on (default: [])",
            },
          },
          required: [],
        },
        execute: async (args) => {
          try {
            const plannedIndex = typeof args.plan_task_index === "number"
              ? Math.floor(args.plan_task_index)
              : null;

            const plannedTask = plannedIndex !== null && this.currentPlan
              ? this.currentPlan.tasks[plannedIndex]
              : null;

            if (plannedIndex !== null && !plannedTask) {
              return `No planner task found at index ${plannedIndex}. Call refresh_plan first.`;
            }

            const title = plannedTask?.title ?? asNonEmptyString(args.title, "title");
            const description = plannedTask?.description ?? asNonEmptyString(args.description, "description");
            const role = plannedTask?.agentRole ?? asNonEmptyString(args.role, "role");
            const priority = plannedTask
              ? clampPriority(plannedTask.priority)
              : clampPriority(typeof args.priority === "number" ? args.priority : 50);

            const existing = this.findManagedTaskBySignature(title, role, description);
            if (existing) {
              this.trackDelegatedTask(existing.id, plannedIndex);
              return `Sub-task already exists: "${existing.title}" (ID: ${existing.id}, status: ${existing.status})`;
            }

            const dependsOn = plannedTask
              ? this.resolvePlannedDependencies(plannedTask.dependencies)
              : Array.isArray(args.depends_on)
                ? (args.depends_on as string[])
                : [];

            if (plannedTask && plannedTask.dependencies.length > 0 && dependsOn.length !== plannedTask.dependencies.length) {
              const missingIndexes = plannedTask.dependencies
                .filter((dependencyIndex) => !this.planTaskIdByIndex.has(dependencyIndex));
              return `Cannot delegate planner task ${plannedIndex} yet. Delegate dependency task indexes first: ${missingIndexes.join(", ")}`;
            }

            const beforeIds = new Set(getTasksByGoal(this.context.db, this.context.goalId).map((task) => task.id));
            decomposeGoal(this.context.db, this.context.goalId, [
              {
                parentId: this.task.id,
                goalId: this.context.goalId,
                title,
                description,
                status: "pending",
                assignedTo: null,
                agentRole: role,
                priority,
                dependencies: dependsOn,
                result: null,
                ...(plannedTask
                  ? { estimatedCostCents: plannedTask.estimatedCostCents, timeoutMs: plannedTask.timeoutMs }
                  : {}),
              },
            ]);

            const createdTask = getTasksByGoal(this.context.db, this.context.goalId).find((task) =>
              !beforeIds.has(task.id)
              && task.parentId === this.task.id
              && task.title === title
              && task.agentRole === role,
            );

            const taskId = createdTask?.id ?? "unknown";
            this.trackDelegatedTask(taskId, plannedIndex);
            // This task must outlive the work it now waits on.
            this.extendDeadlineForChildren();

            return [
              `Sub-task created: "${title}"`,
              `ID: ${taskId}`,
              `Role: ${role}`,
              `Priority: ${priority}`,
              `Depends on: ${dependsOn.length > 0 ? dependsOn.join(", ") : "none"}`,
            ].join("\n");
          } catch (error) {
            return `Failed to create sub-task: ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      },
      {
        name: WAIT_TOOL,
        description:
          "Block until at least one of the given delegated sub-tasks finishes (completed, failed or cancelled), " +
          `or max_wait_s passes (at most ${MAX_WAIT_S}). Use this instead of polling check_task_status.`,
        parameters: {
          type: "object",
          properties: {
            task_ids: {
              type: "array",
              items: { type: "string" },
              description: "Sub-task IDs to wait for. Default: every unfinished delegated sub-task.",
            },
            max_wait_s: { type: "number", description: `Longest wait in seconds (default and max ${MAX_WAIT_S}).` },
          },
          required: [],
        },
        execute: async (args) => this.waitForTasks(args),
      },
      {
        name: "check_task_status",
        description: "Check the current status of a delegated sub-task.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "The task ID to check" },
          },
          required: ["task_id"],
        },
        execute: async (args) => {
          const taskId = args.task_id as string;
          const task = getTaskById(this.context.db, taskId);
          if (!task || task.goalId !== this.context.goalId) return `Task not found: ${taskId}`;
          const lines = [
            `Status: ${task.status}`,
            `Title: ${task.title}`,
            `Assigned to: ${task.assignedTo ?? "unassigned"}`,
          ];
          const result = normalizeTaskResult(task.result) as TaskResult | null;
          if (result) {
            lines.push(`Success: ${result.success}`);
            lines.push(`Output: ${result.output.slice(0, 500)}`);
            if (result.artifacts.length > 0) {
              lines.push(`Artifacts: ${result.artifacts.join(", ")}`);
            }
          }
          return lines.join("\n");
        },
      },
      {
        name: "read_task_output",
        description: "Read the full output and artifacts of a completed task.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "The task ID to read output from" },
          },
          required: ["task_id"],
        },
        execute: async (args) => {
          const taskId = args.task_id as string;
          const task = getTaskById(this.context.db, taskId);
          if (!task || task.goalId !== this.context.goalId) return `Task not found: ${taskId}`;
          if (task.status !== "completed" && task.status !== "failed") {
            return `Task ${taskId} is not yet complete (status: ${task.status})`;
          }
          const result = normalizeTaskResult(task.result);
          if (!result) return `Task ${taskId} has no result data`;
          return JSON.stringify(result, null, 2);
        },
      },
      {
        name: "verify_result",
        description: "Verify that a completed task's output meets the success criteria. Runs a lightweight check.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "The task ID to verify" },
            criteria: { type: "string", description: "The success criteria to check against" },
          },
          required: ["task_id", "criteria"],
        },
        execute: async (args) => {
          const taskId = args.task_id as string;
          const criteria = args.criteria as string;
          const task = getTaskById(this.context.db, taskId);
          if (!task || task.goalId !== this.context.goalId) return `Task not found: ${taskId}`;
          if (task.status !== "completed") return `Task ${taskId} is not completed (status: ${task.status})`;
          const result = normalizeTaskResult(task.result);
          if (!result) return `Task ${taskId} has no result data`;

          const criteriaTerms = criteria.toLowerCase().split(/\s+/u).filter((term) => term.length > 3);
          const outputLower = result.output.toLowerCase();
          const matched = criteriaTerms.filter((term) => outputLower.includes(term));
          const matchRatio = criteriaTerms.length > 0 ? matched.length / criteriaTerms.length : 1;

          if (matchRatio >= 0.5) {
            return `VERIFIED: Task output appears to meet criteria (${Math.round(matchRatio * 100)}% term match). Output preview: ${result.output.slice(0, 300)}`;
          }

          const taskNode = taskRowToTaskNode(task);
          // A result that failed verification is redone, not reused.
          if (!this.subplanState.rejected.includes(task.id)) {
            this.subplanState.rejected.push(task.id);
            this.saveSubplanState();
          }
          let replanNote = "";
          if (this.subplanState.fixCycles < MAX_FIX_CYCLES) {
            try {
              const note = `Verification failed (${Math.round(matchRatio * 100)}% term match). Missing terms: ${criteriaTerms.filter((term) => !outputLower.includes(term)).join(", ")}`;
              const refreshed = await this.refreshPlanInternal({
                verificationFailureTask: createPlannerFailureFromVerification({
                  task: taskNode,
                  output: result.output,
                  note,
                }),
                failureNote: note,
              });
              replanNote = ` Planner-backed replan prepared (v${refreshed.version}); inspect it with refresh_plan before delegating fixes.`;
            } catch (error) {
              this.plannerError = error instanceof Error ? error.message : String(error);
            }
          }

          return `VERIFICATION FAILED: Task output may not meet criteria (${Math.round(matchRatio * 100)}% term match). Missing terms: ${criteriaTerms.filter((term) => !outputLower.includes(term)).join(", ")}. Output preview: ${result.output.slice(0, 300)}.${replanNote}`;
        },
      },
      {
        name: "task_done",
        description: "Signal that orchestration is complete. Provide a consolidated summary of all sub-task results.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Consolidated summary of all sub-task results" },
            success: { type: "boolean", description: "Whether the overall task was completed successfully" },
          },
          required: ["summary"],
        },
        execute: async (args) => {
          const summary = args.summary as string;
          const success = args.success !== false;
          return `TASK_COMPLETE:${success ? "SUCCESS" : "FAILURE"}:${summary}`;
        },
      },
    ];
  }

  private async refreshPlanInternal(params: {
    failedTaskId?: string;
    failureNote?: string;
    verificationFailureTask?: ReturnType<typeof createPlannerFailureFromVerification>;
  }): Promise<{ mode: "plan" | "replan"; version: number; plan: PlannerOutput }> {
    this.refreshDelegatedTaskState();

    const explicitFailedTask = params.failedTaskId
      ? getTaskById(this.context.db, params.failedTaskId)
      : undefined;
    // An explicit id is a deliberate request; otherwise only a failure not yet replanned counts.
    const failedManagedTask = explicitFailedTask && explicitFailedTask.parentId === this.task.id
      ? explicitFailedTask
      : this.findUnhandledFailedTask();

    const failureInput = params.verificationFailureTask
      ?? (failedManagedTask ? taskToPlannerFailureInput(taskRowToTaskNode(failedManagedTask)) : undefined);

    // Nothing failed: load the plan we already have instead of paying for a new one.
    if (!failureInput && this.planVersion > 0) {
      const planPath = path.join(this.getPlanWorkspacePath(), "plan.json");
      if (fs.existsSync(planPath)) {
        const existing = await loadPlan(planPath);
        this.currentPlan = existing;
        this.plannerError = null;
        this.planTaskIdByIndex = buildPlanTaskIndexMap(existing, this.reusableTasks(), this.planTaskIdByIndex);
        return { mode: this.plannerMode, version: this.planVersion, plan: existing };
      }
    }

    if (failureInput && this.subplanState.fixCycles >= MAX_FIX_CYCLES) {
      throw new Error(`Maximum fix cycles (${MAX_FIX_CYCLES}) reached for this orchestrator task`);
    }

    const plannerContext = await buildPlannerContext({
      db: this.context.db,
      workspace: this.context.workspace,
      availableRoles: SUB_PLANNER_ROLES,
      idleAgents: 0,
      busyAgents: Math.max(1, this.getManagedTasks().filter((task) => task.status === "assigned" || task.status === "running").length),
      maxAgents: Math.max(1, Number(this.context.config?.maxChildren ?? this.getManagedTasks().length ?? 1)),
    });

    const planningGoal = createPlannerGoalFromTask(this.task);
    const plan = failureInput
      ? await replanAfterFailure(planningGoal, failureInput, plannerContext, this.context.inference as any, this.describeProgress())
      : await planGoal(planningGoal, plannerContext, this.context.inference as any);

    if (failureInput) {
      this.subplanState.fixCycles += 1;
      if (failedManagedTask && !this.subplanState.handledFailures.includes(failedManagedTask.id)) {
        this.subplanState.handledFailures.push(failedManagedTask.id);
      }
      this.saveSubplanState();
      // The new plan replaces the failed sub-task, so it no longer holds up
      // the goal. Its waiting dependents go too: the new plan re-creates
      // them against the new prerequisite.
      if (failedManagedTask?.status === "failed") {
        supersedeFailedWithDependents(
          this.context.db,
          [failedManagedTask.id],
          { superseded_by_subplan: this.planVersion + 1 },
          `Superseded by sub-plan replan around ${failedManagedTask.title}`,
        );
      }
    }

    const persisted = await persistPlannerArtifacts({
      goalId: this.context.goalId,
      workspacePath: this.getPlanWorkspacePath(),
      plan,
      version: this.planVersion > 0 ? this.planVersion + 1 : undefined,
    });

    const decision = failureInput
      ? `Replanned around ${failureInput.title}`
      : `Planned ${plan.tasks.length} sub-task${plan.tasks.length === 1 ? "" : "s"}`;
    this.context.workspace.logDecision(
      decision,
      params.failureNote ?? plan.strategy,
      this.task.agentRole ?? "orchestrator",
    );

    this.currentPlan = plan;
    this.planVersion = persisted.version;
    this.plannerMode = failureInput ? "replan" : "plan";
    this.plannerError = null;
    this.planTaskIdByIndex = buildPlanTaskIndexMap(plan, this.reusableTasks());

    return {
      mode: this.plannerMode,
      version: this.planVersion,
      plan,
    };
  }

  /** Titles of finished and running sub-tasks, so a replan keeps them instead of redoing them. */
  private describeProgress(): { completedTasks: string[]; inProgressTasks: string[] } {
    const managed = this.getManagedTasks();
    return {
      completedTasks: managed.filter((task) => task.status === "completed").map((task) => task.title),
      inProgressTasks: managed
        .filter((task) => task.status === "assigned" || task.status === "running" || task.status === "pending" || task.status === "blocked")
        .map((task) => task.title),
    };
  }

  private findUnhandledFailedTask(): TaskGraphRow | undefined {
    return this.getManagedTasks().find((task) =>
      task.status === "failed" && !this.subplanState.handledFailures.includes(task.id));
  }

  private async waitForTasks(args: Record<string, unknown>): Promise<string> {
    const managed = this.getManagedTasks();
    const requested = Array.isArray(args.task_ids)
      ? (args.task_ids as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    const ids = requested.length > 0
      ? requested
      : managed.filter((task) => !isTerminalTaskStatus(task.status)).map((task) => task.id);
    if (ids.length === 0) {
      return "No unfinished delegated sub-tasks to wait for.";
    }

    this.extendDeadlineForChildren();
    const maxWaitS = typeof args.max_wait_s === "number" && Number.isFinite(args.max_wait_s)
      ? Math.max(1, Math.min(MAX_WAIT_S, args.max_wait_s))
      : MAX_WAIT_S;
    const budget = this.context.budget;
    const budgetLeftMs = budget.startedAt > 0
      ? budget.timeoutMs - (Date.now() - budget.startedAt) - 5_000
      : maxWaitS * 1000;
    const deadline = Date.now() + Math.max(0, Math.min(maxWaitS * 1000, budgetLeftMs));
    const pollMs = Math.max(1, this.context.waitPollMs ?? DEFAULT_WAIT_POLL_MS);

    const snapshot = () => ids.map((id) => {
      const row = getTaskById(this.context.db, id);
      return { id, row: row && row.goalId === this.context.goalId ? row : undefined };
    });

    this.context.setWaiting?.(true);
    let rows = snapshot();
    try {
      while (true) {
        if (rows.some(({ row }) => !row || isTerminalTaskStatus(row.status))) break;
        if (this.context.abortSignal.aborted) break;
        if (this.context.isTaskOwned && !this.context.isTaskOwned()) break;
        const left = deadline - Date.now();
        if (left <= 0) break;
        await abortableSleep(Math.min(pollMs, left), this.context.abortSignal);
        rows = snapshot();
      }
    } finally {
      this.context.setWaiting?.(false);
    }

    const finished = rows.filter(({ row }) => row && isTerminalTaskStatus(row.status)).length;
    return [
      finished > 0 ? `${finished} of ${ids.length} sub-task(s) finished.` : `No sub-task finished yet; waited until the time limit.`,
      ...rows.map(({ id, row }) => row ? `- ${id}: ${row.title} [status=${row.status}]` : `- ${id}: not found`),
    ].join("\n");
  }

  /**
   * Extend this task's own time budget, and its row's timeout (which the
   * orchestrator's deadline uses), to cover the longest unfinished sub-task
   * plus the grace, up to the one-hour task limit.
   */
  private extendDeadlineForChildren(): void {
    const unfinished = this.getManagedTasks().filter((task) => !isTerminalTaskStatus(task.status));
    if (unfinished.length === 0) return;
    const longest = Math.max(...unfinished.map((task) => clampTaskTimeoutMs(task.timeoutMs)));
    const now = Date.now();

    const budget = this.context.budget;
    const elapsed = budget.startedAt > 0 ? now - budget.startedAt : 0;
    const wanted = Math.min(MAX_TASK_TIMEOUT_MS, elapsed + longest + TASK_DEADLINE_GRACE_MS);
    if (wanted > budget.timeoutMs) budget.timeoutMs = wanted;

    const row = getTaskById(this.context.db, this.task.id);
    if (!row) return;
    const startedMs = row.startedAt ? Date.parse(row.startedAt) : NaN;
    const sinceStart = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : elapsed;
    const rowWanted = Math.min(MAX_TASK_TIMEOUT_MS, sinceStart + longest + TASK_DEADLINE_GRACE_MS);
    if (rowWanted > row.timeoutMs) {
      this.context.db.prepare("UPDATE task_graph SET timeout_ms = ? WHERE id = ?").run(rowWanted, this.task.id);
    }
  }

  private loadSubplanState(): SubplanState {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.getPlanWorkspacePath(), "state.json"), "utf8")) as Partial<SubplanState>;
      return {
        fixCycles: typeof raw.fixCycles === "number" && Number.isFinite(raw.fixCycles) ? Math.max(0, Math.floor(raw.fixCycles)) : 0,
        handledFailures: Array.isArray(raw.handledFailures)
          ? raw.handledFailures.filter((id): id is string => typeof id === "string")
          : [],
        rejected: Array.isArray(raw.rejected)
          ? raw.rejected.filter((id): id is string => typeof id === "string")
          : [],
      };
    } catch {
      return { fixCycles: 0, handledFailures: [], rejected: [] };
    }
  }

  private saveSubplanState(): void {
    try {
      const dir = this.getPlanWorkspacePath();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(this.subplanState, null, 2)}\n`, "utf8");
    } catch {
      // The counter then lives only in memory for this attempt.
    }
  }

  protected override loopExemptTools(): string[] {
    return [WAIT_TOOL];
  }

  private shouldRefreshPlanOnInitialize(): boolean {
    if (this.findUnhandledFailedTask()) {
      return true;
    }

    return this.getManagedTasks().length === 0 && this.planVersion === 0;
  }

  private refreshDelegatedTaskState(): void {
    const managedTasks = this.getManagedTasks();
    this.delegatedTaskIds = managedTasks.map((task) => task.id);
    // Completed tasks stay mapped: dependents resolve to them instead of to a duplicate.
    const reusable = new Set(this.reusableTasks().map((task) => task.id));
    this.planTaskIdByIndex = new Map(
      [...this.planTaskIdByIndex.entries()].filter(([, taskId]) => reusable.has(taskId)),
    );
  }

  /**
   * Sub-tasks a plan may map to: anything but failed, cancelled, rejected by
   * verification, or waiting on a failed or cancelled task (it can never
   * become ready).
   */
  private reusableTasks(): TaskGraphRow[] {
    const statusById = new Map(
      getTasksByGoal(this.context.db, this.context.goalId).map((task) => [task.id, task.status] as const),
    );
    const deadDependency = (task: TaskGraphRow) => (task.status === "pending" || task.status === "blocked") && task.dependencies.some((dep) => {
      const status = statusById.get(dep) ?? getTaskById(this.context.db, dep)?.status;
      return status === undefined || status === "failed" || status === "cancelled";
    });
    return this.getManagedTasks().filter((task) =>
      isReusableTaskStatus(task.status) && !this.subplanState.rejected.includes(task.id) && !deadDependency(task));
  }

  private getManagedTasks(): TaskGraphRow[] {
    return getTasksByGoal(this.context.db, this.context.goalId)
      .filter((task) => task.parentId === this.task.id);
  }

  private getFixCycleCount(): number {
    return Math.max(0, this.planVersion - 1);
  }

  private getPlanWorkspacePath(): string {
    return path.join(this.context.workspace.basePath, "subplans", this.task.id);
  }

  private findManagedTaskBySignature(title: string, role: string, description: string): TaskGraphRow | undefined {
    const normalizedTitle = normalizeText(title);
    const normalizedRole = normalizeText(role);
    const normalizedDescription = normalizeText(description);

    return this.reusableTasks().find((task) =>
      normalizeText(task.title) === normalizedTitle
      && normalizeText(task.agentRole ?? "") === normalizedRole
      && normalizeText(task.description) === normalizedDescription
    );
  }

  private resolvePlannedDependencies(dependencies: number[]): string[] {
    return dependencies
      .map((index) => this.planTaskIdByIndex.get(index))
      .filter((value): value is string => typeof value === "string");
  }

  private trackDelegatedTask(taskId: string, plannedIndex: number | null): void {
    if (taskId === "unknown") {
      return;
    }

    if (!this.delegatedTaskIds.includes(taskId)) {
      this.delegatedTaskIds.push(taskId);
    }

    if (plannedIndex !== null) {
      this.planTaskIdByIndex.set(plannedIndex, taskId);
    }
  }
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

function formatPlanSummary(plan: PlannerOutput): string {
  const lines = [
    `Strategy: ${plan.strategy}`,
    `Analysis: ${plan.analysis}`,
    `Estimated cost: ${plan.estimatedTotalCostCents} cents`,
    `Estimated time: ${plan.estimatedTimeMinutes} minutes`,
    `Risks: ${plan.risks.length > 0 ? plan.risks.join("; ") : "none"}`,
    "",
    "Planned tasks:",
  ];

  plan.tasks.forEach((task, index) => {
    lines.push(
      `${index}. ${task.title} [role=${task.agentRole}, priority=${task.priority}, deps=${task.dependencies.length > 0 ? task.dependencies.join(", ") : "none"}]`,
      `   ${task.description}`,
    );
  });

  return lines.join("\n");
}

function formatManagedTask(task: TaskGraphRow): string {
  const result = normalizeTaskResult(task.result);
  const outcome = result
    ? ` success=${result.success} output=${truncate(result.output, 160)}`
    : "";
  return `- ${task.id}: ${task.title} [status=${task.status}, role=${task.agentRole ?? "generalist"}]${outcome}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }
  return Math.max(0, Math.min(100, Math.floor(value)));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function isTerminalTaskStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Failed and cancelled tasks are redone; anything else (completed included) is reused. */
function isReusableTaskStatus(status: string): boolean {
  return status !== "failed" && status !== "cancelled";
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Map plan indexes to existing reusable sub-tasks: known mappings first, then exact text matches. */
function buildPlanTaskIndexMap(
  plan: PlannerOutput,
  managedTasks: TaskGraphRow[],
  known: Map<number, string> = new Map(),
): Map<number, string> {
  const usable = managedTasks;
  const mapping = new Map<number, string>();
  // Mappings made by delegate_task in this attempt win over text matching.
  for (const [index, taskId] of known) {
    if (index < plan.tasks.length && usable.some((task) => task.id === taskId)) mapping.set(index, taskId);
  }
  const remainingTasks = usable.filter((task) => ![...mapping.values()].includes(task.id));

  plan.tasks.forEach((plannedTask, index) => {
    if (mapping.has(index)) return;
    const matchIndex = remainingTasks.findIndex((task) =>
      normalizeText(task.title) === normalizeText(plannedTask.title)
      && normalizeText(task.agentRole ?? "") === normalizeText(plannedTask.agentRole)
      && normalizeText(task.description) === normalizeText(plannedTask.description),
    );

    if (matchIndex === -1) {
      return;
    }

    const [match] = remainingTasks.splice(matchIndex, 1);
    mapping.set(index, match.id);
  });

  return mapping;
}
