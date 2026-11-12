/**
 * Worker and orchestrator behaviour when the inference gate refuses:
 * the per-task cap fails a task for good (F057), a cap that clears with time
 * defers the task without using a retry, the planner never substitutes a
 * fallback plan on a refusal, and a paused survival tier stops orchestration
 * inference and spawning (F133).
 *
 * Real path: LocalWorkerPool -> GeneralHarness -> worker bridge ->
 * UnifiedInferenceClient -> gate, against a loopback provider stub.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { HarnessRegistry } from "../../agent/harness-registry.js";
import { createWorkerInferenceBridge } from "../../agent/worker-inference-bridge.js";
import { UnifiedInferenceClient, resetProviderCircuitBreakers } from "../../inference/inference-client.js";
import { ProviderRegistry, type ProviderConfig } from "../../inference/provider-registry.js";
import {
  InferenceGate,
  installInferenceGate,
  resetInferenceGateForTests,
} from "../../inference/gate.js";
import type { ResolvedInferencePolicy } from "../../inference/policy.js";
import { LocalWorkerPool } from "../../orchestration/local-worker.js";
import { SimpleAgentTracker } from "../../orchestration/simple-tracker.js";
import { Orchestrator, type OrchestratorWorkerPool } from "../../orchestration/orchestrator.js";
import { ColonyMessaging, type MessageTransport } from "../../orchestration/messaging.js";
import type { AgentTracker, FundingProtocol } from "../../orchestration/types.js";
import {
  ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY,
  type TaskNode,
} from "../../orchestration/task-graph.js";
import { createDatabase, getTaskById, getTasksByGoal } from "../../state/database.js";
import type { AutomatonDatabase, SurvivalTier } from "../../types.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";

// Pricing chosen so a worker turn reserves about 15c (1500 output tokens at
// $100/M) and costs about 20c (2000 output tokens), well apart from the 50c
// minimum task cap.
const ALPHA: ProviderConfig = {
  id: "alpha",
  name: "Alpha",
  baseUrl: "http://127.0.0.1:1/v1",
  apiKeyEnvVar: "ALPHA_API_KEY",
  models: (["reasoning", "fast", "cheap"] as const).map((tier) => ({
    id: `alpha-${tier}`,
    tier,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerInputToken: 1,
    costPerOutputToken: 100,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  })),
  maxRequestsPerMinute: 100,
  maxTokensPerMinute: 1_000_000,
  priority: 1,
  enabled: true,
};

const ORIGINAL_ENV = { ...process.env };

let server: http.Server;
let hits: number;
let stall: boolean;
let finish: boolean;
let tmpHome: string;
let db: AutomatonDatabase;
let gate: InferenceGate;
let clock: number;
let unified: UnifiedInferenceClient;
let pools: LocalWorkerPool[];

function policy(overrides: Partial<ResolvedInferencePolicy> = {}): ResolvedInferencePolicy {
  return {
    dailyCapCents: 100_000,
    hourlyCapCents: 100_000,
    sessionCapCents: 0,
    perCallCeilingCents: 0,
    orchestrationSharePct: 100,
    survivalAllowanceCents: 25,
    survivalMinIntervalMs: 1_800_000,
    sessionCooldownMs: 1_800_000,
    maxTokensPerTurn: 1500,
    enableModelFallback: true,
    unknownPrice: { inputUsdPerM: 2, outputUsdPerM: 14 },
    ...overrides,
  };
}

function installGate(overrides: Partial<ResolvedInferencePolicy> = {}, tier: SurvivalTier | "unknown" = "high"): void {
  gate = new InferenceGate({ db: db.raw, policy: policy(overrides), now: () => clock });
  gate.setSurvival({ tier, creditsCents: tier === "unknown" ? null : 100_000 });
  installInferenceGate(gate);
}

function insertGoal(description = "Ship the thing"): string {
  const id = ulid();
  db.raw
    .prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)")
    .run(id, "Goal", description, new Date().toISOString());
  return id;
}

function insertTask(goalId: string, opts: { estimatedCostCents?: number; maxRetries?: number; status?: string } = {}): TaskNode {
  const id = ulid();
  db.raw
    .prepare(
      `INSERT INTO task_graph (id, goal_id, title, description, status, agent_role, priority, dependencies,
        estimated_cost_cents, max_retries, created_at)
       VALUES (?, ?, 'Task', 'Do the work', ?, 'generalist', 50, '[]', ?, ?, ?)`,
    )
    .run(id, goalId, opts.status ?? "pending", opts.estimatedCostCents ?? 0, opts.maxRetries ?? 3, new Date().toISOString());
  const row = getTaskById(db.raw, id)!;
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
    result: null,
    metadata: {
      estimatedCostCents: row.estimatedCostCents,
      actualCostCents: row.actualCostCents,
      maxRetries: row.maxRetries,
      retryCount: row.retryCount,
      timeoutMs: 60_000,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    },
  };
}

function createPool(): LocalWorkerPool {
  const pool = new LocalWorkerPool({
    db: db.raw,
    inference: createWorkerInferenceBridge(unified),
    conway: new MockConwayClient(),
    harnessRegistry: new HarnessRegistry(),
    identity: createTestIdentity(),
    config: createTestConfig({ sandboxId: "" }),
    allowedEditRoot: tmpHome,
  });
  pools.push(pool);
  return pool;
}

/** A pool that records spawn calls and starts nothing. */
function stubPool(spawnResult: { address: string; name: string; sandboxId: string } | null = null): OrchestratorWorkerPool & {
  spawn: ReturnType<typeof vi.fn>;
} {
  return {
    spawn: vi.fn(() => spawnResult),
    hasWorker: () => false,
    abortWorker: () => false,
    reapOrphans: () => 0,
    getActiveCount: () => 0,
  };
}

function makeOrchestrator(
  workerPool: OrchestratorWorkerPool,
  extra: { agentTracker?: AgentTracker } = {},
): Orchestrator {
  const transport: MessageTransport = {
    deliver: vi.fn().mockResolvedValue(undefined),
    getRecipients: vi.fn().mockReturnValue([]),
  };
  const automataDb = {
    raw: db.raw,
    getIdentity: (key: string) => (key === "address" ? "0x1234" : undefined),
    getChildren: () => [],
    getUnprocessedInboxMessages: () => [],
    markInboxMessageProcessed: () => {},
  } as unknown as AutomatonDatabase;
  const agentTracker: AgentTracker = {
    getIdle: vi.fn().mockReturnValue([]),
    getBestForTask: vi.fn().mockReturnValue(null),
    updateStatus: vi.fn(),
    register: vi.fn(),
  };
  const funding: FundingProtocol = {
    fundChild: vi.fn().mockResolvedValue({ success: true }),
    recallCredits: vi.fn().mockResolvedValue({ success: true, amountCents: 0 }),
    getBalance: vi.fn().mockResolvedValue(1000),
  };
  return new Orchestrator({
    db: db.raw,
    agentTracker: extra.agentTracker ?? agentTracker,
    workerPool,
    funding,
    messaging: new ColonyMessaging(transport, automataDb),
    inference: unified,
    identity: { ...createTestIdentity(), address: "0x1234" as any, name: "parent" },
    config: {},
  });
}

function setState(state: Record<string, unknown>): void {
  db.raw
    .prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .run("orchestrator.state", JSON.stringify({ replanCount: 0, failedTaskId: null, failedError: null, ...state }));
}

function phase(): string {
  const row = db.raw.prepare("SELECT value FROM kv WHERE key = 'orchestrator.state'").get() as { value: string };
  return JSON.parse(row.value).phase;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "inference-deferral-"));
  process.env.HOME = tmpHome;
  process.env.ALPHA_API_KEY = "alpha-key";
  hits = 0;
  stall = false;
  finish = false;
  clock = Date.now();
  pools = [];
  resetProviderCircuitBreakers();

  // Every response is a fresh tool call, so the worker keeps taking turns
  // until something stops it. Each one bills 1000 input + 2000 output tokens.
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      if (stall) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `c${hits}`,
          object: "chat.completion",
          created: 0,
          model: "alpha",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: `call-${hits}`,
                    type: "function",
                    function: finish
                      ? { name: "task_done", arguments: JSON.stringify({ summary: "done", success: true }) }
                      : { name: "read_file", arguments: JSON.stringify({ path: `notes-${hits}.txt` }) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const registry = new ProviderRegistry([{ ...ALPHA, baseUrl: `http://127.0.0.1:${port}/v1` }], {
    reasoning: { preferredProvider: "alpha", fallbackOrder: [] },
    fast: { preferredProvider: "alpha", fallbackOrder: [] },
    cheap: { preferredProvider: "alpha", fallbackOrder: [] },
  });
  unified = new UnifiedInferenceClient(registry, { sleep: async () => {} });
  db = createDatabase(path.join(tmpHome, ".automaton", "state.db"));
});

afterEach(async () => {
  for (const pool of pools) await pool.shutdown();
  resetInferenceGateForTests();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe("F057: the per-task budget is enforced, cumulatively", () => {
  it("fails the task on the turn that would pass its cap, without a retry, and records its spend", async () => {
    installGate();
    const goalId = insertGoal();
    // estimatedCostCents 0 gives the minimum cap of 50c.
    const task = insertTask(goalId, { maxRetries: 3 });

    createPool().spawn(task);
    await waitFor(() => getTaskById(db.raw, task.id)?.status === "failed");

    const row = getTaskById(db.raw, task.id)!;
    // Turn 1 (20c) and turn 2 (40c total) ran; turn 3 would reserve another
    // 15c on top of 40c and was refused before any request was sent.
    expect(hits).toBe(2);
    expect(row.retryCount).toBe(0);
    expect(row.actualCostCents).toBeGreaterThan(40);
    expect(row.actualCostCents).toBeLessThan(41);
    expect(JSON.stringify(row.result)).toMatch(/inference budget/);
    expect(gate.taskSpendCents(task.id)).toBeCloseTo(row.actualCostCents, 6);

    // Re-queueing the same task does not grant a fresh budget.
    db.raw.prepare("UPDATE task_graph SET status = 'pending', assigned_to = NULL, result = NULL WHERE id = ?").run(task.id);
    createPool().spawn(task);
    await waitFor(() => getTaskById(db.raw, task.id)?.status === "failed");
    expect(hits).toBe(2);
  });
});

describe("caps that clear with time defer the task", () => {
  it("puts the task back to pending with its retry count unchanged and spawns nothing until there is headroom", async () => {
    // The first turn's 15c reservation fits the 20c daily cap; its 20c actual
    // spends the cap, so the next reservation (and any headroom) is refused.
    installGate({ dailyCapCents: 20, hourlyCapCents: 20 });
    const goalId = insertGoal();
    const task = insertTask(goalId, { estimatedCostCents: 1000, maxRetries: 3, status: "pending" });

    // Wired as loop.ts wires it: the real tracker, spawns through the local pool.
    const pool = createPool();
    const spawned: string[] = [];
    const originalSpawn = pool.spawn.bind(pool);
    const spawnAgent = vi.spyOn(pool, "spawn").mockImplementation((t: TaskNode) => {
      const worker = originalSpawn(t);
      if (worker) spawned.push(worker.address);
      return worker;
    });
    const orchestrator = makeOrchestrator(pool, {
      agentTracker: new SimpleAgentTracker(db),
    });
    setState({ phase: "executing", goalId });

    await orchestrator.tick();
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    await waitFor(() => getTaskById(db.raw, task.id)?.status === "pending");
    await waitFor(() => pool.getActiveCount() === 0);

    const row = getTaskById(db.raw, task.id)!;
    expect(hits).toBe(1);
    expect(row.retryCount).toBe(0);
    expect(row.assignedTo).toBeNull();
    expect(row.actualCostCents).toBeGreaterThan(20);
    const blocked = db.raw
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY) as { value: string } | undefined;
    expect(blocked && Date.parse(blocked.value)).toBeGreaterThan(Date.now());
    // Workers are never registered as children.
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM children").get()).toEqual({ n: 0 });

    await orchestrator.tick();
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    // Not routed around the block by self-assigning to the parent agent either.
    expect(getTaskById(db.raw, task.id)?.status).toBe("pending");
    expect(getTaskById(db.raw, task.id)?.assignedTo).toBeNull();

    // The gate alone still refuses after the worker's hint is gone.
    db.raw.prepare("DELETE FROM kv WHERE key = ?").run(ORCHESTRATOR_INFERENCE_BLOCKED_UNTIL_KEY);
    await orchestrator.tick();
    expect(spawnAgent).toHaveBeenCalledTimes(1);

    // Once the spend ages out of the window a new worker is spawned (the
    // finished one is not reused) and the task completes.
    clock += 24 * 3_600_000 + 1000;
    finish = true;
    await orchestrator.tick();
    expect(spawnAgent).toHaveBeenCalledTimes(2);
    expect(spawned[1]).not.toBe(spawned[0]);
    expect(getTaskById(db.raw, task.id)?.assignedTo).toBe(spawned[1]);
    await waitFor(() => getTaskById(db.raw, task.id)?.status === "completed");
    expect(hits).toBe(2);
  });

  it("never matches a finished local worker that is still registered as running", async () => {
    installGate();
    const goalId = insertGoal();
    const task = insertTask(goalId, { status: "pending" });
    // A row left by an earlier pool or a process that died mid-task.
    db.insertChild({
      id: ulid(),
      name: "old-worker",
      address: "local://local-worker-OLD" as any,
      sandboxId: "local-worker-OLD",
      genesisPrompt: "Role: generalist",
      creatorMessage: "registered by orchestrator",
      fundedAmountCents: 0,
      status: "running",
      createdAt: new Date().toISOString(),
    });
    const pool = stubPool(null);
    const orchestrator = makeOrchestrator(pool, {
      agentTracker: new SimpleAgentTracker(db),
    });
    setState({ phase: "executing", goalId });

    await orchestrator.tick();

    expect(pool.spawn).toHaveBeenCalledTimes(1);
    expect(getTaskById(db.raw, task.id)?.assignedTo).not.toBe("local://local-worker-OLD");
  });
});

describe("planner refusals never produce a fallback plan", () => {
  it("stays in planning and creates no task when the planner call is refused", async () => {
    // A planner call reserves 8192 output tokens at $100/M (about 82c): over the 50c cap.
    installGate({ dailyCapCents: 50, hourlyCapCents: 50 });
    const goalId = insertGoal();
    const pool = stubPool();
    const orchestrator = makeOrchestrator(pool);
    setState({ phase: "planning", goalId });

    await orchestrator.tick();
    await orchestrator.tick();

    expect(phase()).toBe("planning");
    expect(getTasksByGoal(db.raw, goalId)).toHaveLength(0);
    expect(pool.spawn).not.toHaveBeenCalled();
    expect(hits).toBe(0);
    const goal = db.raw.prepare("SELECT status FROM goals WHERE id = ?").get(goalId) as { status: string };
    expect(goal.status).toBe("active");
  });
});

describe("F133: a paused survival tier stops orchestration inference and spawning", () => {
  it("classifies heuristically, does not plan, and makes no inference call at critical", async () => {
    installGate({}, "critical");
    const goalId = insertGoal(
      "Research the market, design the product, build the service, write the docs, deploy it, " +
        "announce it, collect feedback from early users and iterate on pricing until revenue covers costs",
    );
    const pool = stubPool();
    const orchestrator = makeOrchestrator(pool);
    setState({ phase: "classifying", goalId });

    await orchestrator.tick();
    expect(phase()).toBe("planning");
    await orchestrator.tick();
    expect(phase()).toBe("planning");

    expect(hits).toBe(0);
    expect(pool.spawn).not.toHaveBeenCalled();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM inference_ledger").get()).toEqual({ n: 0 });
  });

  it("assigns no ready task at low_compute", async () => {
    installGate({}, "low_compute");
    const goalId = insertGoal();
    const task = insertTask(goalId, { status: "pending" });
    const pool = stubPool({ address: "local://w", name: "w", sandboxId: "w" });
    const orchestrator = makeOrchestrator(pool);
    setState({ phase: "executing", goalId });

    await orchestrator.tick();

    expect(pool.spawn).not.toHaveBeenCalled();
    expect(getTaskById(db.raw, task.id)?.status).toBe("pending");
    expect(getTaskById(db.raw, task.id)?.assignedTo).toBeNull();
  });

  it("defers a running worker's task when the tier drops mid-task", async () => {
    installGate({}, "high");
    const goalId = insertGoal();
    const task = insertTask(goalId, { estimatedCostCents: 1000 });
    // The tier drops after the first turn has been served.
    server.on("request", () => {
      gate.setSurvival({ tier: "critical", creditsCents: 40 });
    });

    createPool().spawn(task);
    await waitFor(() => getTaskById(db.raw, task.id)?.status === "pending");

    expect(hits).toBe(1);
    expect(getTaskById(db.raw, task.id)?.retryCount).toBe(0);
  });
});

describe("shutdown", () => {
  it("stops a worker's stalled inference call instead of awaiting it, holding the attempt as unknown", async () => {
    installGate();
    stall = true;
    const goalId = insertGoal();
    const task = insertTask(goalId, { estimatedCostCents: 1000 });
    const pool = createPool();

    pool.spawn(task);
    await waitFor(() => hits === 1);
    const started = Date.now();
    await pool.shutdown();

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(db.raw.prepare("SELECT status FROM inference_ledger").all()).toEqual([{ status: "unknown" }]);
  });
});
