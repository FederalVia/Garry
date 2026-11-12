import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorHarness } from "../../agent/harnesses/orchestrator-harness.js";
import type { HarnessContext, WorkerInferenceClient } from "../../agent/harness-types.js";
import type { PlannerOutput } from "../../orchestration/planner.js";
import type { TaskNode, TaskResult } from "../../orchestration/task-graph.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { getTaskById, getTasksByGoal } from "../../state/database.js";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";

class PlannerAwareInference implements WorkerInferenceClient {
  private plannerIndex = 0;
  private workerIndex = 0;

  constructor(
    private readonly plannerOutputs: PlannerOutput[],
    private readonly workerResponses: Array<{ content: string; toolCalls?: Array<{ id: string; type?: "function"; function: { name: string; arguments: string } }> }>,
  ) {}

  async chat(params: Parameters<WorkerInferenceClient["chat"]>[0]): ReturnType<WorkerInferenceClient["chat"]> {
    const systemPrompt = params.messages[0]?.content ?? "";
    if (systemPrompt.includes("# Planner Agent") || params.responseFormat?.type === "json_object") {
      const plan = this.plannerOutputs[this.plannerIndex++] ?? this.plannerOutputs[this.plannerOutputs.length - 1];
      return { content: JSON.stringify(plan) };
    }

    const response = this.workerResponses[this.workerIndex++] ?? { content: "Done." };
    return {
      content: response.content,
      toolCalls: response.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function" as const,
        function: toolCall.function,
      })),
    };
  }
}

describe("agent/OrchestratorHarness", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let workspaceRoot: string;

  beforeEach(() => {
    db = createInMemoryDb();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-harness-"));
    db.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("goal-1", "Goal", "Goal description", "active", new Date().toISOString());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeTask(): TaskNode {
    return {
      id: "orchestrator-task-1",
      parentId: null,
      goalId: "goal-1",
      title: "Coordinate implementation",
      description: "Plan, delegate, verify, and fix the work.",
      status: "assigned",
      assignedTo: "local://worker-orchestrator",
      agentRole: "orchestrator",
      priority: 50,
      dependencies: [],
      result: null,
      metadata: {
        estimatedCostCents: 50,
        actualCostCents: 0,
        maxRetries: 0,
        retryCount: 0,
        timeoutMs: 30_000,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
      },
    };
  }

  function persistTask(task: TaskNode): void {
    db.prepare(
      `INSERT INTO task_graph (
        id, parent_id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, result, max_retries, retry_count, timeout_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id,
      task.parentId,
      task.goalId,
      task.title,
      task.description,
      task.status,
      task.assignedTo,
      task.agentRole,
      task.priority,
      JSON.stringify(task.dependencies),
      task.result ? JSON.stringify(task.result) : null,
      task.metadata.maxRetries,
      task.metadata.retryCount,
      task.metadata.timeoutMs,
      task.metadata.createdAt,
    );
  }

  function makeContext(inference: WorkerInferenceClient): HarnessContext {
    const workspace = new AgentWorkspace("goal-1", path.join(workspaceRoot, "workspace"));
    return {
      workspaceRoot: workspace.basePath,
      allowedEditRoot: workspaceRoot,
      workspace,
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference,
      budget: {
        maxTurns: 50,
        maxCostCents: 500,
        timeoutMs: 30_000,
        turnsUsed: 0,
        costUsedCents: 0,
        startedAt: 0,
      },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-1",
    };
  }

  it("creates planner artifacts on initialize and enforces planner dependency ordering", async () => {
    const initialPlan: PlannerOutput = {
      analysis: "Two-step plan",
      strategy: "Implement then verify",
      customRoles: [],
      tasks: [
        {
          title: "Implement feature",
          description: "Write the feature implementation.",
          agentRole: "executor",
          dependencies: [],
          estimatedCostCents: 100,
          priority: 60,
          timeoutMs: 60_000,
        },
        {
          title: "Verify feature",
          description: "Verify the implementation result.",
          agentRole: "tester",
          dependencies: [0],
          estimatedCostCents: 50,
          priority: 55,
          timeoutMs: 45_000,
        },
      ],
      risks: ["None"],
      estimatedTotalCostCents: 150,
      estimatedTimeMinutes: 20,
    };

    const harness = new OrchestratorHarness();
    const task = makeTask();
    persistTask(task);
    await harness.initialize(task, makeContext(new PlannerAwareInference([initialPlan], [])));

    const planDir = path.join(workspaceRoot, "workspace", "subplans", "orchestrator-task-1");
    expect(fs.existsSync(path.join(planDir, "plan.json"))).toBe(true);
    expect(fs.existsSync(path.join(planDir, "plan.md"))).toBe(true);

    const delegateTool = harness.getToolDefs().find((tool) => tool.name === "delegate_task");
    expect(delegateTool).toBeDefined();

    const blocked = await delegateTool!.execute({ plan_task_index: 1 });
    expect(blocked).toContain("Delegate dependency task indexes first: 0");

    const first = await delegateTool!.execute({ plan_task_index: 0 });
    expect(first).toContain("Sub-task created");
    expect(first).toContain("Role: executor");

    const second = await delegateTool!.execute({ plan_task_index: 1 });
    expect(second).toContain("Sub-task created");
    expect(second).toContain("Role: tester");

    const tasks = getTasksByGoal(db, "goal-1").filter((task) => task.parentId === "orchestrator-task-1");
    expect(tasks).toHaveLength(2);
    const implementTask = tasks.find((task) => task.title === "Implement feature");
    const verifyTask = tasks.find((task) => task.title === "Verify feature");
    expect(implementTask).toBeDefined();
    expect(verifyTask?.dependencies).toEqual([implementTask?.id]);
  });

  it("replans after verification failure and updates persisted planner artifacts", async () => {
    const initialPlan: PlannerOutput = {
      analysis: "Initial plan",
      strategy: "Start with implementation",
      customRoles: [],
      tasks: [
        {
          title: "Implement feature",
          description: "Create the first draft.",
          agentRole: "executor",
          dependencies: [],
          estimatedCostCents: 100,
          priority: 60,
          timeoutMs: 60_000,
        },
      ],
      risks: ["Verification might fail"],
      estimatedTotalCostCents: 100,
      estimatedTimeMinutes: 15,
    };

    const replan: PlannerOutput = {
      analysis: "Verification failed; add a fix task",
      strategy: "Patch the implementation before re-running verification",
      customRoles: [],
      tasks: [
        {
          title: "Patch implementation",
          description: "Apply the fix that the verifier requested.",
          agentRole: "executor",
          dependencies: [],
          estimatedCostCents: 80,
          priority: 65,
          timeoutMs: 60_000,
        },
      ],
      risks: ["Fix may need another review"],
      estimatedTotalCostCents: 80,
      estimatedTimeMinutes: 10,
    };

    const harness = new OrchestratorHarness();
    const task = makeTask();
    persistTask(task);
    await harness.initialize(task, makeContext(new PlannerAwareInference([initialPlan, replan], [])));

    const delegateTool = harness.getToolDefs().find((tool) => tool.name === "delegate_task");
    const verifyTool = harness.getToolDefs().find((tool) => tool.name === "verify_result");
    expect(delegateTool).toBeDefined();
    expect(verifyTool).toBeDefined();

    await delegateTool!.execute({ plan_task_index: 0 });

    const delegated = getTasksByGoal(db, "goal-1").find((task) => task.parentId === "orchestrator-task-1" && task.title === "Implement feature");
    expect(delegated).toBeDefined();

    db.prepare(
      "UPDATE task_graph SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
    ).run(
      JSON.stringify({ success: true, output: "Implemented but missing tests.", artifacts: [], costCents: 0, duration: 1 }),
      new Date().toISOString(),
      delegated!.id,
    );

    const verification = await verifyTool!.execute({
      task_id: delegated!.id,
      criteria: "must include tests and validation",
    });
    expect(verification).toContain("VERIFICATION FAILED");
    expect(verification).toContain("Planner-backed replan prepared");

    const planFile = path.join(workspaceRoot, "workspace", "subplans", "orchestrator-task-1", "plan.json");
    const persisted = JSON.parse(fs.readFileSync(planFile, "utf8")) as PlannerOutput;
    expect(persisted.tasks[0].title).toBe("Patch implementation");
  });

  it("does not reuse a failed child task when a replan repeats the same planned signature", async () => {
    const initialPlan: PlannerOutput = {
      analysis: "Initial plan",
      strategy: "Implement feature once",
      customRoles: [],
      tasks: [
        {
          title: "Implement feature",
          description: "Create the first draft.",
          agentRole: "executor",
          dependencies: [],
          estimatedCostCents: 100,
          priority: 60,
          timeoutMs: 60_000,
        },
      ],
      risks: ["Verification may fail"],
      estimatedTotalCostCents: 100,
      estimatedTimeMinutes: 15,
    };

    const replanWithSameSignature: PlannerOutput = {
      ...initialPlan,
      analysis: "Retry the same implementation with fixes",
      strategy: "Re-run the same task after failure",
    };

    const harness = new OrchestratorHarness();
    const task = makeTask();
    persistTask(task);
    await harness.initialize(task, makeContext(new PlannerAwareInference([initialPlan, replanWithSameSignature], [])));

    const delegateTool = harness.getToolDefs().find((tool) => tool.name === "delegate_task");
    const verifyTool = harness.getToolDefs().find((tool) => tool.name === "verify_result");
    expect(delegateTool).toBeDefined();
    expect(verifyTool).toBeDefined();

    await delegateTool!.execute({ plan_task_index: 0 });
    const firstDelegated = getTasksByGoal(db, "goal-1").find((entry) => entry.parentId === "orchestrator-task-1" && entry.title === "Implement feature");
    expect(firstDelegated).toBeDefined();

    db.prepare(
      "UPDATE task_graph SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
    ).run(
      JSON.stringify({ success: true, output: "Implemented but still failing validation.", artifacts: [], costCents: 0, duration: 1 }),
      new Date().toISOString(),
      firstDelegated!.id,
    );

    const verification = await verifyTool!.execute({
      task_id: firstDelegated!.id,
      criteria: "must include validation and tests",
    });
    expect(verification).toContain("Planner-backed replan prepared");

    const secondDelegation = await delegateTool!.execute({ plan_task_index: 0 });
    expect(secondDelegation).toContain("Sub-task created");

    const delegatedTasks = getTasksByGoal(db, "goal-1").filter((entry) => entry.parentId === "orchestrator-task-1" && entry.title === "Implement feature");
    expect(delegatedTasks).toHaveLength(2);
    expect(new Set(delegatedTasks.map((entry) => entry.id)).size).toBe(2);
  });

  it("on a replan after a rejected verification, reuses the completed prerequisite and redoes only the rejected task", async () => {
    const initialPlan: PlannerOutput = {
      analysis: "Initial two-step plan",
      strategy: "Implement then verify",
      customRoles: [],
      tasks: [
        {
          title: "Implement feature",
          description: "Create the first draft.",
          agentRole: "executor",
          dependencies: [],
          estimatedCostCents: 100,
          priority: 60,
          timeoutMs: 60_000,
        },
        {
          title: "Verify feature",
          description: "Verify the implementation result.",
          agentRole: "tester",
          dependencies: [0],
          estimatedCostCents: 50,
          priority: 55,
          timeoutMs: 45_000,
        },
      ],
      risks: ["Verification may fail"],
      estimatedTotalCostCents: 150,
      estimatedTimeMinutes: 20,
    };

    const replanWithSameDependencies: PlannerOutput = {
      ...initialPlan,
      analysis: "Retry the same implementation/verification pair",
      strategy: "Run the same dependency graph again after failure",
    };

    const harness = new OrchestratorHarness();
    const task = makeTask();
    persistTask(task);
    await harness.initialize(task, makeContext(new PlannerAwareInference([initialPlan, replanWithSameDependencies], [])));

    const delegateTool = harness.getToolDefs().find((tool) => tool.name === "delegate_task");
    const verifyTool = harness.getToolDefs().find((tool) => tool.name === "verify_result");
    expect(delegateTool).toBeDefined();
    expect(verifyTool).toBeDefined();

    await delegateTool!.execute({ plan_task_index: 0 });
    await delegateTool!.execute({ plan_task_index: 1 });

    const initialChildren = getTasksByGoal(db, "goal-1").filter((entry) => entry.parentId === "orchestrator-task-1");
    const initialImplement = initialChildren.find((entry) => entry.title === "Implement feature");
    const initialVerify = initialChildren.find((entry) => entry.title === "Verify feature");
    expect(initialImplement).toBeDefined();
    expect(initialVerify?.dependencies).toEqual([initialImplement?.id]);

    db.prepare(
      "UPDATE task_graph SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
    ).run(
      JSON.stringify({ success: true, output: "Initial implementation complete.", artifacts: [], costCents: 0, duration: 1 }),
      new Date().toISOString(),
      initialImplement!.id,
    );

    db.prepare(
      "UPDATE task_graph SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
    ).run(
      JSON.stringify({ success: true, output: "Verification still missing required assertions.", artifacts: [], costCents: 0, duration: 1 }),
      new Date().toISOString(),
      initialVerify!.id,
    );

    const verification = await verifyTool!.execute({
      task_id: initialVerify!.id,
      criteria: "must include stronger assertions and validation",
    });
    expect(verification).toContain("Planner-backed replan prepared");

    // The implementation passed and is reused; only the rejected verification is redone.
    expect(await delegateTool!.execute({ plan_task_index: 0 })).toContain("Sub-task already exists");
    expect(await delegateTool!.execute({ plan_task_index: 1 })).toContain("Sub-task created");

    const allImplementTasks = getTasksByGoal(db, "goal-1").filter((entry) => entry.parentId === "orchestrator-task-1" && entry.title === "Implement feature");
    const allVerifyTasks = getTasksByGoal(db, "goal-1").filter((entry) => entry.parentId === "orchestrator-task-1" && entry.title === "Verify feature");
    expect(allImplementTasks).toHaveLength(1);
    expect(allVerifyTasks).toHaveLength(2);

    const newVerify = allVerifyTasks.find((entry) => entry.id !== initialVerify!.id);
    expect(newVerify?.dependencies).toEqual([initialImplement!.id]);
    // Its dependency is complete, so it is ready at once.
    expect(newVerify?.status).toBe("pending");
  });

  // ─── F058 / F059 / F060 ───────────────────────────────────────

  function twoStepPlan(): PlannerOutput {
    return {
      analysis: "Two steps",
      strategy: "Research then implement",
      customRoles: [],
      tasks: [
        { title: "Research API", description: "Find the API.", agentRole: "researcher", dependencies: [], estimatedCostCents: 50, priority: 60, timeoutMs: 120_000 },
        { title: "Implement client", description: "Write the client.", agentRole: "executor", dependencies: [0], estimatedCostCents: 50, priority: 55, timeoutMs: 600_000 },
      ],
      risks: [],
      estimatedTotalCostCents: 100,
      estimatedTimeMinutes: 10,
    };
  }

  /** Counts planner calls; worker turns come from the given script. */
  class CountingInference implements WorkerInferenceClient {
    plannerCalls = 0;
    private turn = 0;
    constructor(private readonly plan: PlannerOutput, private readonly turns: Array<{ content: string; toolCalls?: any[] }> = []) {}
    async chat(params: Parameters<WorkerInferenceClient["chat"]>[0]): ReturnType<WorkerInferenceClient["chat"]> {
      if (params.responseFormat?.type === "json_object") {
        this.plannerCalls += 1;
        return { content: JSON.stringify(this.plan) };
      }
      return this.turns[this.turn++] ?? { content: "" };
    }
  }

  function childOf(title: string) {
    return getTasksByGoal(db, "goal-1").filter((entry) => entry.parentId === "orchestrator-task-1" && entry.title === title);
  }

  function complete(id: string): void {
    db.prepare("UPDATE task_graph SET status = 'completed', result = ?, completed_at = ? WHERE id = ?").run(
      JSON.stringify({ success: true, output: "ok", artifacts: [], costCents: 0, duration: 1 }),
      new Date().toISOString(),
      id,
    );
  }

  it("F059: a retried orchestrator reuses a completed planned task instead of delegating it again", async () => {
    const task = makeTask();
    persistTask(task);
    const first = new OrchestratorHarness();
    await first.initialize(task, makeContext(new CountingInference(twoStepPlan())));
    await first.getToolDefs().find((t) => t.name === "delegate_task")!.execute({ plan_task_index: 0 });
    const research = childOf("Research API")[0];
    complete(research.id);

    // The retry re-initializes from the persisted plan.
    const retry = new OrchestratorHarness();
    const inference = new CountingInference(twoStepPlan());
    await retry.initialize(task, makeContext(inference));
    const delegate = retry.getToolDefs().find((t) => t.name === "delegate_task")!;

    expect(await delegate.execute({ plan_task_index: 1 })).toContain("Sub-task created");
    expect(childOf("Implement client")[0].dependencies).toEqual([research.id]);
    expect(await delegate.execute({ plan_task_index: 0 })).toContain("Sub-task already exists");
    expect(childOf("Research API")).toHaveLength(1);
    expect(inference.plannerCalls).toBe(0);
  });

  it("F060: an argument-less refresh_plan with no failure loads the plan instead of regenerating it", async () => {
    const task = makeTask();
    persistTask(task);
    const inference = new CountingInference(twoStepPlan());
    const harness = new OrchestratorHarness();
    await harness.initialize(task, makeContext(inference));
    expect(inference.plannerCalls).toBe(1);

    const refresh = harness.getToolDefs().find((t) => t.name === "refresh_plan")!;
    await refresh.execute({});
    await refresh.execute({});
    expect(inference.plannerCalls).toBe(1);
    const statePath = path.join(workspaceRoot, "workspace", "subplans", "orchestrator-task-1", "state.json");
    expect(fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")).fixCycles : 0).toBe(0);
  });

  it("F060: a failure is replanned once; later refreshes and retries do not replan it again", async () => {
    const task = makeTask();
    persistTask(task);
    const inference = new CountingInference(twoStepPlan());
    const harness = new OrchestratorHarness();
    await harness.initialize(task, makeContext(inference));
    await harness.getToolDefs().find((t) => t.name === "delegate_task")!.execute({ plan_task_index: 0 });
    const research = childOf("Research API")[0];
    db.prepare("UPDATE task_graph SET status = 'failed' WHERE id = ?").run(research.id);

    const refresh = harness.getToolDefs().find((t) => t.name === "refresh_plan")!;
    expect(await refresh.execute({})).toContain("replan mode");
    expect(inference.plannerCalls).toBe(2);
    // Superseded by the fix plan, so it no longer holds up the goal.
    expect(getTaskById(db, research.id)?.status).toBe("cancelled");
    await refresh.execute({});
    expect(inference.plannerCalls).toBe(2);

    const statePath = path.join(workspaceRoot, "workspace", "subplans", "orchestrator-task-1", "state.json");
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(saved).toMatchObject({ fixCycles: 1, handledFailures: [research.id] });

    // A retry of the orchestrator does not replan around the same failure either.
    const retry = new OrchestratorHarness();
    const retryInference = new CountingInference(twoStepPlan());
    await retry.initialize(task, makeContext(retryInference));
    expect(retryInference.plannerCalls).toBe(0);
  });

  it("a replan around a failed prerequisite supersedes its blocked dependent, and the new dependent binds to the new prerequisite", async () => {
    const task = makeTask();
    persistTask(task);
    const harness = new OrchestratorHarness();
    await harness.initialize(task, makeContext(new CountingInference(twoStepPlan())));
    const delegate = harness.getToolDefs().find((t) => t.name === "delegate_task")!;
    await delegate.execute({ plan_task_index: 0 });
    await delegate.execute({ plan_task_index: 1 });
    const oldResearch = childOf("Research API")[0];
    const oldImplement = childOf("Implement client")[0];
    expect(oldImplement.dependencies).toEqual([oldResearch.id]);
    db.prepare("UPDATE task_graph SET status = 'failed' WHERE id = ?").run(oldResearch.id);
    db.prepare("UPDATE task_graph SET status = 'blocked' WHERE id = ?").run(oldImplement.id);

    expect(await harness.getToolDefs().find((t) => t.name === "refresh_plan")!.execute({})).toContain("replan mode");
    expect(getTaskById(db, oldResearch.id)?.status).toBe("cancelled");
    expect(getTaskById(db, oldImplement.id)).toMatchObject({
      status: "cancelled",
      result: expect.objectContaining({ superseded_by_subplan: expect.any(Number) }),
    });

    expect(await delegate.execute({ plan_task_index: 0 })).toContain("Sub-task created");
    expect(await delegate.execute({ plan_task_index: 1 })).toContain("Sub-task created");
    const newResearch = childOf("Research API").find((t) => t.id !== oldResearch.id)!;
    const newImplement = childOf("Implement client").find((t) => t.id !== oldImplement.id)!;
    expect(newImplement.dependencies).toEqual([newResearch.id]);
  });

  it("a waiting sub-task whose prerequisite was cancelled is not reused by a later plan", async () => {
    const task = makeTask();
    persistTask(task);
    const harness = new OrchestratorHarness();
    await harness.initialize(task, makeContext(new CountingInference(twoStepPlan())));
    const delegate = harness.getToolDefs().find((t) => t.name === "delegate_task")!;
    await delegate.execute({ plan_task_index: 0 });
    await delegate.execute({ plan_task_index: 1 });
    const oldResearch = childOf("Research API")[0];
    // Cancelled from outside the harness (no dependent cascade).
    db.prepare("UPDATE task_graph SET status = 'cancelled' WHERE id = ?").run(oldResearch.id);

    // A retried orchestrator maps the persisted plan again.
    const retry = new OrchestratorHarness();
    await retry.initialize(task, makeContext(new CountingInference(twoStepPlan())));
    const retryDelegate = retry.getToolDefs().find((t) => t.name === "delegate_task")!;
    expect(await retryDelegate.execute({ plan_task_index: 0 })).toContain("Sub-task created");
    expect(await retryDelegate.execute({ plan_task_index: 1 })).toContain("Sub-task created");
    const newResearch = childOf("Research API").find((t) => t.id !== oldResearch.id)!;
    expect(childOf("Implement client").find((t) => t.dependencies.includes(newResearch.id))).toBeDefined();
  });

  it("F058: wait_for_tasks returns when a sub-task finishes, and repeated waits are not treated as a loop", async () => {
    const task = makeTask();
    persistTask(task);
    db.prepare("UPDATE task_graph SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), task.id);
    const waitCall = (n: number) => ({
      content: "",
      toolCalls: [{ id: `w${n}`, type: "function", function: { name: "wait_for_tasks", arguments: "{}" } }],
    });
    const turns = [
      { content: "", toolCalls: [{ id: "d0", type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ plan_task_index: 0 }) } }] },
      ...Array.from({ length: 6 }, (_, i) => waitCall(i)),
      { content: "", toolCalls: [{ id: "done", type: "function", function: { name: "task_done", arguments: JSON.stringify({ summary: "all done", success: true }) } }] },
    ];
    const inference = new CountingInference(twoStepPlan(), turns);
    const context = { ...makeContext(inference), waitPollMs: 5 };
    const waiting: boolean[] = [];
    context.setWaiting = (w) => waiting.push(w);
    const harness = new OrchestratorHarness();
    await harness.initialize({ ...task, status: "running" }, context);

    // The first wait blocks until the sub-task finishes; the five identical
    // waits after it return at once and must not be blocked as a loop.
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      const research = childOf("Research API")[0];
      if (research && polls > 30) complete(research.id);
    }, 5);
    try {
      const result = await harness.execute();
      expect(result).toMatchObject({ success: true, output: "all done" });
    } finally {
      clearInterval(timer);
    }
    expect(polls).toBeGreaterThan(30);
    expect(waiting).toEqual([true, false]);
    // Delegating extended this task's time budget and row timeout to cover the sub-task.
    expect(context.budget.timeoutMs).toBeGreaterThanOrEqual(120_000 + 120_000);
    expect(getTaskById(db, task.id)!.timeoutMs).toBeGreaterThanOrEqual(120_000 + 120_000);
  });

  it("F063: the sub-planner is not offered orchestrator or critic roles", async () => {
    const task = makeTask();
    persistTask(task);
    let systemPrompt = "";
    const inference: WorkerInferenceClient = {
      chat: async (params) => {
        systemPrompt = String(params.messages[0]?.content ?? "");
        return { content: JSON.stringify(twoStepPlan()) };
      },
    };
    await new OrchestratorHarness().initialize(task, makeContext(inference));
    const roleLine = systemPrompt.split("\n").find((line) => line.includes("Available predefined roles")) ?? "";
    expect(roleLine).toContain("executor");
    expect(roleLine).not.toContain("orchestrator");
    expect(roleLine).not.toContain("critic");
  });
});
