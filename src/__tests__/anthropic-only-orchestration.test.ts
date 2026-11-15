/**
 * An owner with only an Anthropic key gets the planner and workers: the
 * orchestration registry is built from the provider table, the goal tools are
 * offered, the planner reaches Anthropic with the JSON instruction, a worker
 * tool call round-trips as tool_use/tool_result, and every attempt is priced
 * and billed as orchestration.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { planGoal, type PlannerContext } from "../orchestration/planner.js";
import { createWorkerInferenceBridge } from "../agent/worker-inference-bridge.js";
import { ModelRegistry } from "../inference/registry.js";
import { UnifiedInferenceClient, resetProviderCircuitBreakers } from "../inference/inference-client.js";
import {
  InferenceGate,
  installInferenceGate,
  resetInferenceGateForTests,
  runWithInferenceScope,
} from "../inference/gate.js";
import { resolveInferencePolicy } from "../inference/policy.js";
import { createDatabase } from "../state/database.js";
import { buildOrchestrationRegistry } from "../providers/model-defaults.js";
import { resolveProviderTable } from "../providers/table.js";
import type { AutomatonDatabase, ChatMessage, SurvivalTier } from "../types.js";
import type { Goal } from "../orchestration/task-graph.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestIdentity, noToolResponse } from "./mocks.js";

const realFetch = globalThis.fetch;
let tmp: string;
let db: AutomatonDatabase;
let savedEnv: NodeJS.ProcessEnv;

const anthropicCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
let replies: Array<(body: any) => unknown>;

/** Answers Anthropic's model list and messages; nothing else is reachable. */
function installAnthropicStub(): void {
  globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
    if (url.startsWith("https://api.anthropic.com/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }], has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      const body = JSON.parse(String(init.body));
      anthropicCalls.push({ url, headers, body });
      const next = replies.shift() ?? (() => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
      return new Response(
        JSON.stringify({ id: "msg", type: "message", role: "assistant", model: body.model, usage: { input_tokens: 120, output_tokens: 30 }, ...(next(body) as object) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw Object.assign(new Error(`unexpected request to ${url}`), { code: "ENOTFOUND" });
  }) as any;
}

const config = () => createTestConfig({ conwayApiKey: "", anthropicApiKey: "sk-ant-only", inferenceModel: "gpt-5.2" });

function orchestration(tier: SurvivalTier) {
  const cfg = config();
  const table = resolveProviderTable(cfg, {});
  const registry = new ModelRegistry(db.raw, { table, config: cfg });
  registry.initialize();
  registry.seedFromPriceTable(table);
  const built = buildOrchestrationRegistry({
    table,
    registry,
    strategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: "gpt-5.2" },
    config: cfg,
  });
  const gate = new InferenceGate({
    db: db.raw,
    policy: resolveInferencePolicy(cfg, { maxInferenceDailyCents: 500 }),
    fixedTier: tier === "dead" ? undefined : (tier as any),
  });
  gate.setSurvival({ tier, creditsCents: null });
  installInferenceGate(gate);
  return { built, client: new UnifiedInferenceClient(built.registry!, { sleep: async () => {} }) };
}

const ledger = () =>
  db.raw
    .prepare(
      "SELECT budget_class AS cls, provider, model, status, price_in_usd_per_m AS pin, price_out_usd_per_m AS pout FROM inference_ledger ORDER BY rowid",
    )
    .all() as Array<{ cls: string; provider: string; model: string; status: string; pin: number; pout: number }>;

const goal: Goal = {
  id: "g1",
  title: "Earn",
  description: "Earn something",
  status: "active",
  strategy: null,
  rootTasks: [],
  expectedRevenueCents: 0,
  actualRevenueCents: 0,
  createdAt: "2026-01-01T00:00:00Z",
  deadline: null,
};
const context: PlannerContext = {
  creditsCents: null,
  usdcBalance: null,
  survivalTier: "high",
  availableRoles: ["generalist"],
  customRoles: [],
  activeGoals: [],
  recentOutcomes: [],
  marketIntel: "none",
  idleAgents: 1,
  busyAgents: 0,
  maxAgents: 3,
  workspaceFiles: [],
};
const plan = {
  analysis: "a",
  strategy: "s",
  customRoles: [],
  tasks: [
    {
      title: "T",
      description: "Do a specific thing and check it.",
      agentRole: "generalist",
      dependencies: [],
      estimatedCostCents: 10,
      priority: 1,
      timeoutMs: 60000,
    },
  ],
  risks: ["r"],
  estimatedTotalCostCents: 10,
  estimatedTimeMinutes: 5,
};

beforeEach(() => {
  savedEnv = { ...process.env };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-only-"));
  process.env.HOME = tmp;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.GROQ_API_KEY;
  delete process.env.TOGETHER_API_KEY;
  db = createDatabase(path.join(tmp, "state.db"));
  anthropicCalls.length = 0;
  replies = [];
  resetProviderCircuitBreakers();
  installAnthropicStub();
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  resetInferenceGateForTests();
  db.close();
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Anthropic-only orchestration", () => {
  it("a standalone loop builds the orchestration registry and offers create_goal", async () => {
    vi.spyOn(Orchestrator.prototype, "tick").mockResolvedValue({
      phase: "idle",
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      goalsActive: 0,
      agentsActive: 0,
    } as any);
    const inference = new MockInferenceClient([noToolResponse("done")]);
    await runAgentLoop({
      identity: createTestIdentity(),
      config: config(),
      db,
      conway: new MockConwayClient(),
      inference,
    });
    const offered = (inference.calls[0]?.options?.tools ?? []).map((t: any) => t.function.name);
    expect(offered).toContain("create_goal");
  });

  it("the planner reaches Anthropic on Sonnet with the JSON instruction, and a fenced reply parses", async () => {
    replies.push(() => ({ content: [{ type: "text", text: "Here:\n```json\n" + JSON.stringify(plan) + "\n```" }], stop_reason: "end_turn" }));
    const { built, client } = orchestration("high");
    expect(built.registry).not.toBeNull();
    const out = await planGoal(
      {
        ...goal,
      },
      context,
      client,
    );
    expect(out.tasks).toHaveLength(1);
    expect(anthropicCalls).toHaveLength(1);
    const call = anthropicCalls[0];
    expect(call.body.model).toBe("claude-sonnet-5-5");
    expect(call.headers["x-api-key"]).toBe("sk-ant-only");
    expect(call.body.system).toContain("Reply with one JSON object and nothing else.");
    expect(call.body).not.toHaveProperty("temperature");
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cls: "orchestration", provider: "anthropic", model: "claude-sonnet-5-5", status: "committed" });
    expect(rows[0].pin).toBe(2);
    expect(rows[0].pout).toBe(10);
  });

  it("at a fixed tier of normal the planner steps down to Haiku, as before", async () => {
    replies.push(() => ({ content: [{ type: "text", text: JSON.stringify(plan) }], stop_reason: "end_turn" }));
    const { client } = orchestration("normal");
    await planGoal(goal, context, client);
    expect(anthropicCalls[0].body.model).toBe("claude-haiku-5-5");
    expect(ledger()[0]).toMatchObject({ cls: "orchestration", model: "claude-haiku-5-5", pin: 0.1, pout: 0.5 });
  });

  it("a worker turn with a tool call round-trips tool_use and tool_result", async () => {
    replies.push(() => ({
      content: [{ type: "tool_use", id: "toolu_w1", name: "exec", input: { command: "ls" } }],
      stop_reason: "tool_use",
    }));
    replies.push(() => ({ content: [{ type: "text", text: "listed" }], stop_reason: "end_turn" }));
    const { client } = orchestration("high");
    const worker = createWorkerInferenceBridge(client);
    const tools = [{ type: "function" as const, function: { name: "exec", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    const history: ChatMessage[] = [
      { role: "system", content: "You are a worker." },
      { role: "user", content: "List the files." },
    ];
    const first = await runWithInferenceScope({ caller: "worker", taskId: "t1" }, () =>
      worker.chat({ tier: "fast", messages: history, tools, purpose: "worker_turn" } as any),
    );
    expect(first.toolCalls?.[0]).toMatchObject({ id: "toolu_w1", function: { name: "exec", arguments: '{"command":"ls"}' } });
    history.push({ role: "assistant", content: first.content, tool_calls: first.toolCalls });
    history.push({ role: "tool", content: "a.txt\nb.txt", tool_call_id: "toolu_w1" });
    const second = await runWithInferenceScope({ caller: "worker", taskId: "t1" }, () =>
      worker.chat({ tier: "fast", messages: history, tools, purpose: "worker_turn" } as any),
    );
    expect(second.content).toBe("listed");

    const sent = anthropicCalls[1].body.messages;
    expect(sent[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_w1", name: "exec", input: { command: "ls" } }],
    });
    expect(sent[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_w1", content: "a.txt\nb.txt" }],
    });
    for (const r of ledger()) {
      expect(r.cls).toBe("orchestration");
      expect(r.pin).toBeGreaterThan(0);
      expect(r.pout).toBeGreaterThan(0);
    }
  });
});
