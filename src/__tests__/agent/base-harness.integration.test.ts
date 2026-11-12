import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BaseHarness } from "../../agent/harnesses/base-harness.js";
import {
  InferenceDeferredError,
  TaskBudgetExceededError,
  TaskOwnershipLostError,
  type HarnessContext,
  type HarnessTool,
} from "../../agent/harness-types.js";
import { InferenceRefusedError, type RefusalCode } from "../../inference/errors.js";
import type { TaskNode, TaskResult } from "../../orchestration/task-graph.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";

class TestHarness extends BaseHarness {
  readonly id = "test";
  readonly description = "test harness";
  beforeTurnCalls = 0;

  buildSystemPrompt(): string {
    return "system prompt";
  }

  protected override beforeTurn(): void {
    this.beforeTurnCalls += 1;
  }

  getToolDefs(): HarnessTool[] {
    return [
      {
        name: "ping",
        description: "ping",
        parameters: { type: "object", properties: {} },
        execute: async () => "pong",
      },
      {
        name: "task_done",
        description: "done",
        parameters: {
          type: "object",
          properties: { summary: { type: "string" }, success: { type: "boolean" } },
          required: ["summary"],
        },
        execute: async (args) => `TASK_COMPLETE:${args.summary as string}`,
      },
    ];
  }
}

describe("agent/BaseHarness integration", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function createTask(): TaskNode {
    return {
      id: "task-1",
      parentId: null,
      goalId: "goal-1",
      title: "Run test harness",
      description: "Use tools and finish",
      status: "assigned",
      assignedTo: "local://worker",
      agentRole: "generalist",
      priority: 50,
      dependencies: [],
      result: null,
      metadata: {
        estimatedCostCents: 5,
        actualCostCents: 0,
        maxRetries: 0,
        retryCount: 0,
        timeoutMs: 5_000,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
      },
    };
  }

  function createContext(): HarnessContext {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "base-harness-"));
    const workspace = new AgentWorkspace("goal-1", path.join(tempDir, "workspace"));
    const db = createInMemoryDb();
    return {
      workspaceRoot: workspace.basePath,
      allowedEditRoot: tempDir,
      workspace,
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference: {
        chat: async () => ({
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "ping", arguments: "{}" },
            },
            {
              id: "call-2",
              type: "function",
              function: { name: "task_done", arguments: JSON.stringify({ summary: "finished", success: true }) },
            },
          ],
        }),
      },
      budget: {
        maxTurns: 3,
        maxCostCents: 50,
        timeoutMs: 5_000,
        turnsUsed: 0,
        costUsedCents: 0,
        startedAt: 0,
      },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-1",
    };
  }

  it("executes tool calls and returns a TaskResult on task_done", async () => {
    const harness = new TestHarness();
    const task = createTask();
    const context = createContext();
    await harness.initialize(task, context);
    const result = await harness.execute();
    expect(result.success).toBe(true);
    expect(result.output).toBe("finished");
    expect(context.budget.turnsUsed).toBe(1);
    (context.db as any).close?.();
  });

  it("fails immediately when the turn budget is already exhausted", async () => {
    const harness = new TestHarness();
    const task = createTask();
    const context = createContext();
    context.budget.maxTurns = 0;
    await harness.initialize(task, context);
    await expect(harness.execute()).rejects.toThrow(/Budget exhausted: reached max turns/);
    (context.db as any).close?.();
  });

  it("does not consume turn budget or reset per-turn state on inference retry", async () => {
    const harness = new TestHarness();
    const task = createTask();
    const context = createContext();
    let callCount = 0;
    context.inference = {
      chat: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("transient inference failure");
        }
        return {
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "task_done", arguments: JSON.stringify({ summary: "finished after retry", success: true }) },
            },
          ],
        };
      },
    };

    context.inferenceRetryBackoffMs = [5];
    await harness.initialize(task, context);
    const result = await harness.execute();

    expect(result.output).toBe("finished after retry");
    expect(callCount).toBe(2);
    expect(context.budget.turnsUsed).toBe(1);
    expect(harness.beforeTurnCalls).toBe(1);
    (context.db as any).close?.();
  });

  function pingTurn(costCents: number) {
    return {
      content: "",
      costCents,
      toolCalls: [{ id: `call-${Math.random()}`, type: "function" as const, function: { name: "ping", arguments: "{}" } }],
    };
  }

  function refusal(code: RefusalCode, retryAfterMs: number | null = null): InferenceRefusedError {
    return new InferenceRefusedError(code, `${code} refused`, { retryAfterMs, budgetClass: "orchestration" });
  }

  it("adds each call's committed cost to the budget and stops at the cost limit", async () => {
    const harness = new TestHarness();
    const context = createContext();
    context.budget.maxTurns = 10;
    context.budget.maxCostCents = 5;
    let calls = 0;
    context.inference = {
      chat: async () => {
        calls += 1;
        return pingTurn(2);
      },
    };

    await harness.initialize(createTask(), context);
    await expect(harness.execute()).rejects.toBeInstanceOf(TaskBudgetExceededError);
    // 2c + 2c + 2c reaches 5c after the third turn; no fourth call is made.
    expect(calls).toBe(3);
    expect(context.budget.costUsedCents).toBe(6);
    (context.db as any).close?.();
  });

  it("maps a task-cap refusal to TaskBudgetExceededError without retrying", async () => {
    const harness = new TestHarness();
    const context = createContext();
    let calls = 0;
    context.inference = {
      chat: async () => {
        calls += 1;
        throw refusal("TASK_CAP");
      },
    };

    await harness.initialize(createTask(), context);
    await expect(harness.execute()).rejects.toBeInstanceOf(TaskBudgetExceededError);
    expect(calls).toBe(1);
    (context.db as any).close?.();
  });

  it.each(["DAILY_CAP", "HOURLY_CAP", "ORCHESTRATION_SHARE", "SURVIVAL_TIER", "GATE_UNAVAILABLE"] as const)(
    "maps a %s refusal to InferenceDeferredError without using the 3-strike retries",
    async (code) => {
      const harness = new TestHarness();
      const context = createContext();
      let calls = 0;
      context.inference = {
        chat: async () => {
          calls += 1;
          throw refusal(code, 60_000);
        },
      };

      await harness.initialize(createTask(), context);
      const error = await harness.execute().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InferenceDeferredError);
      expect((error as InferenceDeferredError).code).toBe(code);
      expect((error as InferenceDeferredError).retryAfterMs).toBe(60_000);
      expect(calls).toBe(1);
      (context.db as any).close?.();
    },
  );

  it("backs off 1 s then 2 s between ordinary inference errors", async () => {
    const harness = new TestHarness();
    const context = createContext();
    const stamps: number[] = [];
    context.inference = {
      chat: async () => {
        stamps.push(Date.now());
        throw new Error("provider down");
      },
    };

    await harness.initialize(createTask(), context);
    await expect(harness.execute()).rejects.toThrow(/3 consecutive inference failures/);
    expect(stamps).toHaveLength(3);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(950);
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(1950);
    (context.db as any).close?.();
  });

  it("F058: a text-only reply is answered with a reminder; a second one ends the task as a failure", async () => {
    const harness = new TestHarness();
    const context = createContext();
    let calls = 0;
    context.inference = {
      chat: async () => {
        calls += 1;
        return { content: "I could not complete this" };
      },
    };
    await harness.initialize(createTask(), context);

    const result = await harness.execute();

    expect(calls).toBe(2);
    expect(result.success).toBe(false);
    expect(result.output).toContain("I could not complete this");
  });

  it("F058: after the reminder, task_done finishes normally", async () => {
    const harness = new TestHarness();
    const context = createContext();
    const seen: string[] = [];
    let calls = 0;
    context.inference = {
      chat: async (params) => {
        calls += 1;
        seen.push(String(params.messages[params.messages.length - 1]?.content ?? ""));
        if (calls === 1) return { content: "Working on it." };
        return {
          content: "",
          toolCalls: [{ id: "d", type: "function", function: { name: "task_done", arguments: JSON.stringify({ summary: "done", success: true }) } }],
        };
      },
    };
    await harness.initialize(createTask(), context);

    const result = await harness.execute();

    expect(result).toMatchObject({ success: true, output: "done" });
    expect(seen[1]).toContain("task_done");
  });

  it("F015: stops at the next turn once the task is no longer owned", async () => {
    const harness = new TestHarness();
    const context = createContext();
    let owned = true;
    let calls = 0;
    context.isTaskOwned = () => owned;
    context.inference = {
      chat: async () => {
        calls += 1;
        // The task is cancelled while this turn runs.
        owned = false;
        return { content: "", toolCalls: [{ id: `p${calls}`, type: "function", function: { name: "ping", arguments: "{}" } }] };
      },
    };
    await harness.initialize(createTask(), context);

    await expect(harness.execute()).rejects.toBeInstanceOf(TaskOwnershipLostError);
    expect(calls).toBe(1);
  });
});
