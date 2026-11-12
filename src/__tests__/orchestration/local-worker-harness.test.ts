import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessRegistry } from "../../agent/harness-registry.js";
import type { AgentHarness, HarnessContext, HarnessTool } from "../../agent/harness-types.js";
import { LocalWorkerPool } from "../../orchestration/local-worker.js";
import type { PlannerOutput } from "../../orchestration/planner.js";
import type { TaskNode, TaskResult } from "../../orchestration/task-graph.js";
import { getTaskById } from "../../state/database.js";
import { createInMemoryDb } from "./test-db.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";

class SuccessHarness implements AgentHarness {
  readonly id = "success";
  readonly description = "success harness";
  static capturedContext: HarnessContext | null = null;

  async initialize(_task: TaskNode, context: HarnessContext): Promise<void> {
    SuccessHarness.capturedContext = context;
  }

  async execute(): Promise<TaskResult> {
    return { success: true, output: "completed by harness", artifacts: ["src/file.ts"], costCents: 0, duration: 1 };
  }

  getToolDefs(): HarnessTool[] {
    return [];
  }

  buildSystemPrompt(): string {
    return "";
  }

  buildTaskPrompt(): string {
    return "";
  }
}

class FailureHarness implements AgentHarness {
  readonly id = "failure";
  readonly description = "failure harness";
  async initialize(): Promise<void> {}
  async execute(): Promise<TaskResult> {
    return { success: false, output: "failed by harness", artifacts: [], costCents: 0, duration: 1 };
  }
  getToolDefs(): HarnessTool[] {
    return [];
  }
  buildSystemPrompt(): string {
    return "";
  }
  buildTaskPrompt(): string {
    return "";
  }
}

class SlowHarness implements AgentHarness {
  readonly id = "slow";
  readonly description = "slow harness";
  static release: (() => void) | null = null;
  /** Every unreleased run, so a test can end them all. */
  static pending: Array<() => void> = [];

  async initialize(): Promise<void> {}
  async execute(): Promise<TaskResult> {
    await new Promise<void>((resolve) => {
      SlowHarness.release = resolve;
      SlowHarness.pending.push(resolve);
    });
    return { success: true, output: "slow done", artifacts: [], costCents: 0, duration: 1 };
  }
  getToolDefs(): HarnessTool[] {
    return [];
  }
  buildSystemPrompt(): string {
    return "";
  }
  buildTaskPrompt(): string {
    return "";
  }
}

/** Spends 3c, then runs until aborted (as a real harness does mid-call). */
class AbortAwareHarness implements AgentHarness {
  readonly id = "abort-aware";
  readonly description = "abort-aware harness";
  static started = 0;
  private context!: HarnessContext;

  async initialize(_task: TaskNode, context: HarnessContext): Promise<void> {
    this.context = context;
  }

  async execute(): Promise<TaskResult> {
    AbortAwareHarness.started += 1;
    this.context.budget.costUsedCents = 3;
    await new Promise<void>((resolve) => {
      if (this.context.abortSignal.aborted) return resolve();
      this.context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("Harness execution aborted by abort signal");
  }

  getToolDefs(): HarnessTool[] {
    return [];
  }
  buildSystemPrompt(): string {
    return "";
  }
  buildTaskPrompt(): string {
    return "";
  }
}

/** Blocks in a wait (like wait_for_tasks) until released. */
class WaitingHarness implements AgentHarness {
  readonly id = "waiting";
  readonly description = "waiting harness";
  static release: (() => void) | null = null;
  private context!: HarnessContext;

  async initialize(_task: TaskNode, context: HarnessContext): Promise<void> {
    this.context = context;
  }

  async execute(): Promise<TaskResult> {
    this.context.setWaiting?.(true);
    try {
      await new Promise<void>((resolve) => {
        WaitingHarness.release = resolve;
      });
    } finally {
      this.context.setWaiting?.(false);
    }
    return { success: true, output: "waited", artifacts: [], costCents: 0, duration: 1 };
  }

  getToolDefs(): HarnessTool[] {
    return [];
  }
  buildSystemPrompt(): string {
    return "";
  }
  buildTaskPrompt(): string {
    return "";
  }
}

class OrchestratorBudgetHarness implements AgentHarness {
  readonly id = "orchestrator";
  readonly description = "orchestrator budget harness";
  static capturedBudget: number | null = null;

  async initialize(_task: TaskNode, context: HarnessContext): Promise<void> {
    OrchestratorBudgetHarness.capturedBudget = context.budget.maxTurns;
  }

  async execute(): Promise<TaskResult> {
    return { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };
  }

  getToolDefs(): HarnessTool[] {
    return [];
  }

  buildSystemPrompt(): string {
    return "";
  }

  buildTaskPrompt(): string {
    return "";
  }
}

class PlannerAwareWorkerInference {
  private plannerIndex = 0;
  private workerIndex = 0;

  constructor(
    private readonly plannerOutputs: PlannerOutput[],
    private readonly workerResponses: Array<{ content: string; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> }>,
  ) {}

  async chat(params: { messages: any[]; responseFormat?: { type: string } }): Promise<{ content: string; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> }> {
    const systemPrompt = params.messages[0]?.content ?? "";
    if (systemPrompt.includes("# Planner Agent") || params.responseFormat?.type === "json_object") {
      const plan = this.plannerOutputs[this.plannerIndex++] ?? this.plannerOutputs[this.plannerOutputs.length - 1];
      return { content: JSON.stringify(plan) };
    }

    const response = this.workerResponses[this.workerIndex++] ?? { content: "Done." };
    return response;
  }
}

describe("orchestration/LocalWorkerPool harness integration", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let registry: HarnessRegistry;
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    db = createInMemoryDb();
    registry = new HarnessRegistry();
    insertGoal(db, "goal-1");
    SuccessHarness.capturedContext = null;
    SlowHarness.release = null;
    WaitingHarness.release = null;
    AbortAwareHarness.started = 0;
    OrchestratorBudgetHarness.capturedBudget = null;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "local-worker-harness-home-"));
    // Workspaces land under HOME/.automaton/workspace; keep them out of the real HOME.
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    db.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const pools: LocalWorkerPool[] = [];
  afterEach(async () => {
    for (const release of SlowHarness.pending.splice(0)) release();
    WaitingHarness.release?.();
    for (const pool of pools.splice(0)) await pool.shutdown();
  });

  function createPool(maxTurns?: number, allowedEditRoot: string = process.cwd(), maxChildren?: number): LocalWorkerPool {
    const pool = new LocalWorkerPool({
      db,
      conway: new MockConwayClient(),
      inference: { chat: async () => ({ content: "done" }) },
      maxTurns,
      harnessRegistry: registry,
      identity: createTestIdentity(),
      config: createTestConfig(maxChildren === undefined ? {} : { maxChildren }),
      allowedEditRoot,
    });
    pools.push(pool);
    return pool;
  }

  function pendingTask(id: string, agentRole: string, maxRetries = 3): TaskNode {
    return insertTask(db, { id, goalId: "goal-1", agentRole, status: "pending", assignedTo: null, maxRetries });
  }

  it("F065: a worker that finishes at once completes a task the pool assigned before starting it", async () => {
    registry.register("custom-success", SuccessHarness);
    const pool = createPool();
    const task = pendingTask("task-instant", "custom-success");

    const spawned = pool.spawn(task);
    expect(spawned).not.toBeNull();
    await waitFor(() => pool.getActiveCount() === 0);

    expect(getTaskById(db, task.id)).toMatchObject({ status: "completed", assignedTo: spawned!.address });
    const goal = db.prepare("SELECT status FROM goals WHERE id = 'goal-1'").get() as { status: string };
    expect(goal.status).toBe("completed");
    // Workers are not children.
    expect(db.prepare("SELECT COUNT(*) AS n FROM children").get()).toEqual({ n: 0 });
  });

  it("spawn returns null and changes nothing for a task that is not pending", () => {
    registry.register("custom-success", SuccessHarness);
    const pool = createPool();
    const task = insertTask(db, { id: "task-held", goalId: "goal-1", agentRole: "custom-success", status: "assigned", assignedTo: "0xparent", maxRetries: 0 });
    expect(pool.spawn(task)).toBeNull();
    expect(getTaskById(db, task.id)).toMatchObject({ status: "assigned", assignedTo: "0xparent" });
    expect(pool.getActiveCount()).toBe(0);
  });

  it("F084: runs at most maxChildren workers; the rest stay pending until a slot frees", async () => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool(undefined, process.cwd(), 1);
    const first = pendingTask("task-cap-1", "custom-slow");
    const second = pendingTask("task-cap-2", "custom-slow");

    expect(pool.spawn(first)).not.toBeNull();
    expect(pool.spawn(second)).toBeNull();
    expect(getTaskById(db, second.id)).toMatchObject({ status: "pending", assignedTo: null });

    await waitFor(() => SlowHarness.release !== null);
    SlowHarness.release!();
    await waitFor(() => pool.getActiveCount() === 0);
    expect(pool.spawn(second)).not.toBeNull();
  });

  it("maxChildren 0 still allows one worker", () => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool(undefined, process.cwd(), 0);
    expect(pool.maxConcurrent).toBe(1);
    expect(pool.spawn(pendingTask("task-zero", "custom-slow"))).not.toBeNull();
  });

  it("a worker blocked waiting on sub-tasks does not hold a slot", async () => {
    registry.register("custom-waiting", WaitingHarness);
    registry.register("custom-success", SuccessHarness);
    const pool = createPool(undefined, process.cwd(), 1);

    expect(pool.spawn(pendingTask("task-waiter", "custom-waiting"))).not.toBeNull();
    await waitFor(() => WaitingHarness.release !== null);
    // The waiter is live but not counted against the cap, so its sub-task can run.
    expect(pool.getActiveCount()).toBe(1);
    const sub = pendingTask("task-sub", "custom-success");
    expect(pool.spawn(sub)).not.toBeNull();
    await waitFor(() => getTaskById(db, sub.id)?.status === "completed");
    WaitingHarness.release!();
    await waitFor(() => pool.getActiveCount() === 0);
    expect(getTaskById(db, "task-waiter")?.status).toBe("completed");
  });

  it("graceful shutdown defers the task without spending a retry", async () => {
    registry.register("custom-abort", AbortAwareHarness);
    const pool = createPool();
    const task = pendingTask("task-shutdown", "custom-abort");
    pool.spawn(task);
    await waitFor(() => AbortAwareHarness.started === 1);

    await pool.shutdown();

    expect(getTaskById(db, task.id)).toMatchObject({ status: "pending", assignedTo: null, retryCount: 0 });
    expect(getTaskById(db, task.id)?.actualCostCents).toBe(3);
  });

  it("an aborted worker stops counting at once but keeps its task from running twice until it settles", async () => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool(undefined, process.cwd(), 1);
    const task = pendingTask("task-abort", "custom-slow");
    const spawned = pool.spawn(task)!;
    await waitFor(() => SlowHarness.release !== null);

    // The orchestrator times the worker out and releases its task.
    expect(pool.abortWorker(spawned.address, "timeout")).toBe(true);
    expect(pool.getActiveCount()).toBe(0);
    expect(pool.hasWorker(spawned.address)).toBe(false);
    db.prepare("UPDATE task_graph SET status = 'pending', assigned_to = NULL WHERE id = ?").run(task.id);

    // Still inside its call: the task is not handed to a second worker.
    expect(pool.spawn(task)).toBeNull();
    // Other work can use the freed slot.
    registry.register("custom-success", SuccessHarness);
    expect(pool.spawn(pendingTask("task-other", "custom-success"))).not.toBeNull();

    // The old worker returns: its late result is dropped and the task can run again.
    const release = SlowHarness.release!;
    SlowHarness.release = null;
    release();
    await waitFor(() => pool.getActiveCount() === 0 && (pool as any).activeWorkers.size === 0);
    expect(getTaskById(db, task.id)).toMatchObject({ status: "pending", assignedTo: null });
    expect(pool.spawn(task)).not.toBeNull();
  });

  it("reapOrphans aborts a worker whose task was cancelled, and the worker reports nothing", async () => {
    registry.register("custom-abort", AbortAwareHarness);
    const pool = createPool();
    const task = pendingTask("task-orphan", "custom-abort");
    pool.spawn(task);
    await waitFor(() => AbortAwareHarness.started === 1);

    db.prepare("UPDATE task_graph SET status = 'cancelled' WHERE id = ?").run(task.id);
    expect(pool.reapOrphans()).toBe(1);
    await waitFor(() => (pool as any).activeWorkers.size === 0);

    expect(getTaskById(db, task.id)?.status).toBe("cancelled");
    // Spend so far is kept on the task.
    expect(getTaskById(db, task.id)?.actualCostCents).toBe(3);
  });

  it("F063: passes the task's depth to the registry", async () => {
    const seen: Array<{ role: string | null | undefined; depth: number | undefined }> = [];
    registry.register("custom-success", SuccessHarness);
    const original = registry.createForRole.bind(registry);
    registry.createForRole = (role, options) => {
      seen.push({ role, depth: options?.depth });
      return original(role, options);
    };
    const pool = createPool();
    insertTask(db, { id: "task-top", goalId: "goal-1", agentRole: "orchestrator", status: "running", assignedTo: "x", maxRetries: 0 });
    const child = pendingTask("task-child", "custom-success");
    db.prepare("UPDATE task_graph SET parent_id = 'task-top' WHERE id = ?").run(child.id);

    pool.spawn({ ...child, parentId: "task-top" });
    await waitFor(() => getTaskById(db, child.id)?.status === "completed");
    expect(seen).toEqual([{ role: "custom-success", depth: 1 }]);
  });

  it("routes a worker task through the configured harness and completes the task", async () => {
    registry.register("custom-success", SuccessHarness);
    const pool = createPool(7);
    const task = insertTask(db, {
      id: "task-success",
      goalId: "goal-1",
      agentRole: "custom-success",
      status: "assigned",
      assignedTo: "local://worker-test",
      maxRetries: 0,
    });

    await runAssigned(pool, task);

    const row = getTaskById(db, task.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ success: true, output: "completed by harness" });
    expect(SuccessHarness.capturedContext?.budget.maxTurns).toBe(7);
    // The runtime checkout is never a worker edit root: it is replaced by the goal workspace.
    expect(SuccessHarness.capturedContext?.allowedEditRoot).toBe(
      fs.realpathSync(path.join(tempHome, ".automaton", "workspace", "goal-1")),
    );
    expect(SuccessHarness.capturedContext?.allowedEditRoot).not.toBe(process.cwd());
  });

  it("keeps a configured edit root that overlaps neither the runtime nor the state directory", async () => {
    registry.register("custom-success", SuccessHarness);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-worker-project-"));
    try {
      const pool = createPool(undefined, projectDir);
      const task = insertTask(db, {
        id: "task-project-root",
        goalId: "goal-1",
        agentRole: "custom-success",
        status: "assigned",
        assignedTo: "local://worker-test",
        maxRetries: 0,
      });

      await runAssigned(pool, task);

      expect(SuccessHarness.capturedContext?.allowedEditRoot).toBe(fs.realpathSync(projectDir));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("replaces an edit root of HOME or the state directory with the goal workspace", async () => {
    registry.register("custom-success", SuccessHarness);
    const workspace = path.join(tempHome, ".automaton", "workspace", "goal-1");
    for (const [index, root] of [tempHome, path.join(tempHome, ".automaton"), "/"].entries()) {
      fs.mkdirSync(root, { recursive: true });
      const pool = createPool(undefined, root);
      const task = insertTask(db, {
        id: `task-bad-root-${index}`,
        goalId: "goal-1",
        agentRole: "custom-success",
        status: "assigned",
        assignedTo: "local://worker-test",
        maxRetries: 0,
      });
      await runAssigned(pool, task);
      expect(SuccessHarness.capturedContext?.allowedEditRoot).toBe(fs.realpathSync(workspace));
    }
  });

  it("marks the task as failed when the harness reports failure", async () => {
    registry.register("custom-failure", FailureHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-failure",
      goalId: "goal-1",
      agentRole: "custom-failure",
      status: "assigned",
      assignedTo: "local://worker-test",
      maxRetries: 0,
    });

    await runAssigned(pool, task);

    const row = getTaskById(db, task.id);
    expect(row?.status).toBe("failed");
    expect(row?.result).toMatchObject({ success: false, output: "failed by harness" });
  });

  it("tracks active workers for spawn/hasWorker/getActiveCount", async () => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-slow",
      goalId: "goal-1",
      agentRole: "custom-slow",
      status: "pending",
      assignedTo: null,
      maxRetries: 0,
    });

    const spawned = pool.spawn(task)!;
    expect(spawned).not.toBeNull();
    // The pool assigns the task before the worker starts.
    expect(getTaskById(db, task.id)).toMatchObject({ status: "running", assignedTo: spawned.address });
    expect(pool.getActiveCount()).toBe(1);
    expect(pool.hasWorker(spawned.address)).toBe(true);
    expect(pool.hasWorker(spawned.sandboxId)).toBe(true);

    await waitFor(async () => SlowHarness.release !== null);
    SlowHarness.release?.();
    await waitFor(async () => pool.getActiveCount() === 0);
    expect(pool.getActiveCount()).toBe(0);
  });

  it("gives orchestrator-role harnesses a 50-turn default budget", async () => {
    registry.register("custom-planner", OrchestratorBudgetHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-orchestrator-budget",
      goalId: "goal-1",
      agentRole: "custom-planner",
      status: "assigned",
      assignedTo: "local://worker-test",
      maxRetries: 0,
    });

    await runAssigned(pool, task);

    expect(OrchestratorBudgetHarness.capturedBudget).toBe(50);
  });

  it("runs the real orchestrator harness through planner-backed delegation and persists plan artifacts", async () => {
    const plannerOutput: PlannerOutput = {
      analysis: "Plan delegated work",
      strategy: "Create an implementation task and exit cleanly",
      customRoles: [],
      tasks: [
        {
          title: "Implement planned subtask",
          description: "Carry out the planned implementation step.",
          agentRole: "executor",
          dependencies: [],
          estimatedCostCents: 100,
          priority: 55,
          timeoutMs: 60_000,
        },
      ],
      risks: ["None"],
      estimatedTotalCostCents: 100,
      estimatedTimeMinutes: 10,
    };

    const workerInference = new PlannerAwareWorkerInference(
      [plannerOutput],
      [
        {
          content: "",
          toolCalls: [
            {
              id: "delegate-1",
              function: { name: "delegate_task", arguments: JSON.stringify({ plan_task_index: 0 }) },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "done-1",
              function: { name: "task_done", arguments: JSON.stringify({ summary: "Delegated the planner-backed work.", success: true }) },
            },
          ],
        },
      ],
    );

    const task = insertTask(db, {
      id: "task-orchestrator-run",
      goalId: "goal-1",
      agentRole: "orchestrator",
      status: "assigned",
      assignedTo: "local://worker-test",
      maxRetries: 0,
    });

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const pool = new LocalWorkerPool({
        db,
        conway: new MockConwayClient(),
        inference: workerInference as any,
        harnessRegistry: registry,
        identity: createTestIdentity(),
        config: createTestConfig(),
        allowedEditRoot: process.cwd(),
      });

      await runAssigned(pool, task);
    } finally {
      process.env.HOME = originalHome;
    }

    const row = getTaskById(db, task.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ success: true, output: "Delegated the planner-backed work." });

    const delegated = db.prepare(
      "SELECT parent_id AS parentId, title, agent_role AS agentRole FROM task_graph WHERE goal_id = ? AND parent_id = ?",
    ).all("goal-1", "task-orchestrator-run") as Array<{ parentId: string; title: string; agentRole: string | null }>;
    expect(delegated.some((entry) => entry.title === "Implement planned subtask" && entry.agentRole === "executor")).toBe(true);

    const planDir = path.join(tempHome, ".automaton", "workspace", "goal-1", "subplans", "task-orchestrator-run");
    expect(fs.existsSync(path.join(planDir, "plan.json"))).toBe(true);
    expect(fs.existsSync(path.join(planDir, "plan.md"))).toBe(true);
  });
});

/** Run a worker in-line on a task already assigned to local://worker-test. */
async function runAssigned(pool: LocalWorkerPool, task: TaskNode, signal = new AbortController().signal): Promise<void> {
  await (pool as any).runWorker("worker-test", task, signal);
}

function insertGoal(db: ReturnType<typeof createInMemoryDb>, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "Goal", "Goal description", "active", new Date().toISOString());
}

function insertTask(
  db: ReturnType<typeof createInMemoryDb>,
  overrides: {
    id: string;
    goalId: string;
    agentRole: string;
    status: string;
    assignedTo: string | null;
    maxRetries: number;
  },
): TaskNode {
  db.prepare(
    `INSERT INTO task_graph (
      id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, max_retries, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    overrides.goalId,
    "Task",
    "Task description",
    overrides.status,
    overrides.assignedTo,
    overrides.agentRole,
    50,
    JSON.stringify([]),
    overrides.maxRetries,
    new Date().toISOString(),
  );

  const row = getTaskById(db, overrides.id);
  if (!row) {
    throw new Error(`Failed to load task ${overrides.id}`);
  }

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
    result: row.result as TaskResult | null,
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
