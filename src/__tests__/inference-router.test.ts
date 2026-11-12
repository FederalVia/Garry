/**
 * Inference Router Tests (Sub-phase 2.3)
 *
 * Tests: ModelRegistry, InferenceRouter (with the inference gate),
 * routing matrix, message transformation, schema migration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6 } from "../state/schema.js";
import {
  inferenceInsertCost,
  inferenceGetSessionCosts,
  inferenceGetDailyCost,
  inferenceGetHourlyCost,
  inferenceGetModelCosts,
  inferencePruneCosts,
  modelRegistryUpsert,
  modelRegistryGet,
  modelRegistryGetAll,
  modelRegistryGetAvailable,
  modelRegistrySetEnabled,
} from "../state/database.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceRouter } from "../inference/router.js";
import { InferenceGate } from "../inference/gate.js";
import { resolveInferencePolicy } from "../inference/policy.js";
import { InferenceCallError } from "../inference/errors.js";
import {
  STATIC_MODEL_BASELINE,
  DEFAULT_ROUTING_MATRIX,
  DEFAULT_MODEL_STRATEGY_CONFIG,
  TASK_TIMEOUTS,
} from "../inference/types.js";
import type { ModelRegistryRow, InferenceCostRow, ModelStrategyConfig } from "../types.js";

let db: BetterSqlite3.Database;

function createTestDb(): BetterSqlite3.Database {
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(MIGRATION_V6);
  return testDb;
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ─── ModelRegistry Tests ──────────────────────────────────────────

describe("ModelRegistry", () => {
  it("initialize seeds from static baseline when table is empty", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    const all = registry.getAll();
    expect(all.length).toBe(STATIC_MODEL_BASELINE.length);
    expect(all.length).toBeGreaterThan(0);
  });

  it("initialize does not re-seed when table has entries", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();
    const countBefore = registry.getAll().length;

    // Call initialize again
    registry.initialize();
    const countAfter = registry.getAll().length;

    expect(countAfter).toBe(countBefore);
  });

  it("get returns entry by modelId", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    const entry = registry.get("gpt-4.1");
    expect(entry).toBeDefined();
    expect(entry!.modelId).toBe("gpt-4.1");
    expect(entry!.provider).toBe("openai");
  });

  it("get returns undefined for unknown model", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    const entry = registry.get("nonexistent-model");
    expect(entry).toBeUndefined();
  });

  it("getAvailable returns only enabled models", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    // Disable one model
    registry.setEnabled("gpt-4.1", false);

    const available = registry.getAvailable();
    const ids = available.map((m) => m.modelId);
    expect(ids).not.toContain("gpt-4.1");
  });

  it("getAvailable filters by tier minimum", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    const lowCompute = registry.getAvailable("low_compute");
    // Should include models with tierMinimum <= low_compute (i.e., critical, low_compute)
    for (const model of lowCompute) {
      expect(["dead", "critical", "low_compute"]).toContain(model.tierMinimum);
    }
  });

  it("upsert creates new entry", () => {
    const registry = new ModelRegistry(db);
    const now = new Date().toISOString();

    registry.upsert({
      modelId: "test-model",
      provider: "other",
      displayName: "Test Model",
      tierMinimum: "normal",
      costPer1kInput: 10,
      costPer1kOutput: 20,
      maxTokens: 4096,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: null,
      createdAt: now,
      updatedAt: now,
    });

    const entry = registry.get("test-model");
    expect(entry).toBeDefined();
    expect(entry!.displayName).toBe("Test Model");
  });

  it("upsert updates existing entry", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    const existing = registry.get("gpt-4.1")!;
    registry.upsert({
      ...existing,
      displayName: "Updated GPT-4.1",
      updatedAt: new Date().toISOString(),
    });

    const updated = registry.get("gpt-4.1")!;
    expect(updated.displayName).toBe("Updated GPT-4.1");
  });

  it("setEnabled toggles model availability", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    registry.setEnabled("gpt-4.1", false);
    expect(registry.get("gpt-4.1")!.enabled).toBe(false);

    registry.setEnabled("gpt-4.1", true);
    expect(registry.get("gpt-4.1")!.enabled).toBe(true);
  });

  it("refreshFromApi updates from API response", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    registry.refreshFromApi([
      {
        id: "new-api-model",
        provider: "conway",
        display_name: "New API Model",
        max_tokens: 8192,
        context_window: 200000,
        supports_tools: true,
        supports_vision: false,
        pricing: { input_per_1k: 15, output_per_1k: 30 },
      },
    ]);

    const entry = registry.get("new-api-model");
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe("conway");
    expect(entry!.costPer1kInput).toBe(15);
  });

  it("refreshFromApi reads listModels' USD-per-1M prices and keeps a known price when the listing has none", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();
    const before = registry.get("gpt-5.2")!;
    registry.refreshFromApi([
      { id: "claude-opus-4-6", provider: "anthropic", pricing: { inputPerMillion: 5, outputPerMillion: 25 } },
      { id: "gpt-5.2", provider: "openai", pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
    ]);
    const opus = registry.get("claude-opus-4-6")!;
    expect(opus.costPer1kInput).toBe(50);
    expect(opus.costPer1kOutput).toBe(250);
    expect(registry.get("gpt-5.2")!.costPer1kInput).toBe(before.costPer1kInput);
    expect(registry.get("gpt-5.2")!.costPer1kOutput).toBe(before.costPer1kOutput);
  });

  it("getCostPer1k returns correct pricing", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    const cost = registry.getCostPer1k("gpt-4.1");
    expect(cost.input).toBeGreaterThan(0);
    expect(cost.output).toBeGreaterThan(0);
  });

  it("getCostPer1k returns zeros for unknown model", () => {
    const registry = new ModelRegistry(db);
    const cost = registry.getCostPer1k("nonexistent");
    expect(cost.input).toBe(0);
    expect(cost.output).toBe(0);
  });
});

// ─── InferenceRouter Tests ────────────────────────────────────────

describe("InferenceRouter", () => {
  let registry: ModelRegistry;
  let gate: InferenceGate;
  let router: InferenceRouter;
  let strategy: ModelStrategyConfig;

  const makeRouter = (policyOverrides: Partial<ModelStrategyConfig> = {}, daily = 50_000) => {
    strategy = { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...policyOverrides };
    gate = new InferenceGate({
      db,
      policy: resolveInferencePolicy({ modelStrategy: strategy }, { maxInferenceDailyCents: daily }),
    });
    gate.setSurvival({ tier: "high", creditsCents: 100_000 });
    return new InferenceRouter(db, registry, gate, () => strategy);
  };
  const ledger = () =>
    db.prepare("SELECT * FROM inference_ledger ORDER BY created_at_ms, attempt").all() as any[];

  beforeEach(() => {
    registry = new ModelRegistry(db);
    registry.initialize();
    router = makeRouter();
  });

  describe("selectModel", () => {
    it("returns correct model for normal/agent_turn", () => {
      const model = router.selectModel("normal", "agent_turn");
      expect(model).not.toBeNull();
      expect(model!.modelId).toBe("gpt-5.2");
    });

    it("returns cheaper model for low_compute tier", () => {
      const model = router.selectModel("low_compute", "agent_turn");
      expect(model).not.toBeNull();
      expect(model!.modelId).toBe("gpt-5-mini");
    });

    it("returns minimal model for critical tier", () => {
      const model = router.selectModel("critical", "agent_turn");
      expect(model).not.toBeNull();
      expect(model!.modelId).toBe("gpt-5-mini");
    });

    it("returns null for dead tier", () => {
      const model = router.selectModel("dead", "agent_turn");
      expect(model).toBeNull();
    });

    it("returns null for critical tier with non-essential task", () => {
      const model = router.selectModel("critical", "summarization");
      expect(model).toBeNull();
    });

    it("skips disabled models and picks next candidate", () => {
      registry.setEnabled("gpt-5.2", false);
      const model = router.selectModel("normal", "agent_turn");
      expect(model).not.toBeNull();
      expect(model!.modelId).toBe("gpt-5-mini");
    });
  });

  describe("route", () => {
    it("calls inference and records the attempt in the ledger", async () => {
      const mockChat = async (_msgs: any[], _opts: any) => ({
        message: { content: "Hello!", role: "assistant" },
        usage: { promptTokens: 100, completionTokens: 50 },
        finishReason: "stop",
      });

      const result = await router.route(
        {
          messages: [{ role: "user", content: "Hi" }],
          taskType: "agent_turn",
          tier: "normal",
          sessionId: "test-session",
        },
        mockChat,
      );

      expect(result.content).toBe("Hello!");
      expect(result.model).toBe("gpt-5.2");
      expect(result.finishReason).toBe("stop");

      const rows = ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        model: "gpt-5.2",
        status: "committed",
        budget_class: "main",
        caller: "agent_turn",
        session_id: "test-session",
      });
    });

    it("computes the actual cost exactly, in micro-USD, from token usage", async () => {
      // gpt-5.2 is 18 / 140 hundredths of a cent per 1k = $1.8 / $14 per M.
      const mockChat = async (_msgs: any[], _opts: any) => ({
        message: { content: "result", role: "assistant" },
        usage: { promptTokens: 1000, completionTokens: 500 },
        finishReason: "stop",
      });

      const result = await router.route(
        {
          messages: [{ role: "user", content: "test cost" }],
          taskType: "agent_turn",
          tier: "normal",
          sessionId: "cost-accuracy-session",
        },
        mockChat,
      );

      // 1000 * 1.8 + 500 * 14 = 8800 micro-USD = 0.88c (no whole-cent rounding).
      expect(result.costMicroUsd).toBe(8800);
      expect(result.costCents).toBeCloseTo(0.88, 10);
      const [row] = ledger();
      expect(row.cost_micro_usd).toBe(8800);
      expect(row.input_tokens).toBe(1000);
      expect(row.output_tokens).toBe(500);
    });

    it("returns a refusal, without calling inference, when the per-call ceiling cannot fit", async () => {
      const strictRouter = makeRouter({ perCallCeilingCents: 1 });
      let calls = 0;
      const result = await strictRouter.route(
        {
          messages: [{ role: "user", content: "x".repeat(100000) }],
          taskType: "agent_turn",
          tier: "normal",
          sessionId: "test-session",
          maxTokens: 50000,
        },
        async () => {
          calls++;
          return { message: { content: "" }, usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "stop" };
        },
      );

      expect(result.finishReason).toBe("budget_exceeded");
      expect(result.refusal).toMatchObject({ code: "PER_CALL_CEILING", retryAfterMs: null });
      expect(calls).toBe(0);
      expect(ledger()).toHaveLength(0);
    });

    it("enforces the session budget per budget session only", async () => {
      // About 27k estimated input tokens: even gpt-5-mini needs ~3.5c.
      const sessionRouter = makeRouter({ sessionBudgetCents: 2 });
      const longMessage = "x".repeat(100000);
      const chat = async () => ({
        message: { content: "" },
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "stop",
      });
      const result = await sessionRouter.route(
        { messages: [{ role: "user", content: longMessage }], taskType: "agent_turn", tier: "normal", sessionId: "budget-session" },
        chat,
      );
      expect(result.finishReason).toBe("budget_exceeded");
      expect(result.refusal?.code).toBe("SESSION_CAP");
      expect(result.refusal?.retryAfterMs).toBe(30 * 60_000);
    });

    it("passes the call's deadline signal and a reservation id to the inference function", async () => {
      let receivedSignal: AbortSignal | undefined;
      let reservationId: string | undefined;
      let openDuringCall = false;
      const mockChat = async (_msgs: any[], opts: any) => {
        receivedSignal = opts.signal;
        reservationId = opts.reservationId;
        openDuringCall = gate.isOpen(opts.reservationId);
        return {
          message: { content: "ok", role: "assistant" },
          usage: { promptTokens: 10, completionTokens: 5 },
          finishReason: "stop",
        };
      };

      await router.route(
        { messages: [{ role: "user", content: "test" }], taskType: "agent_turn", tier: "normal", sessionId: "signal-test" },
        mockChat,
      );

      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(reservationId).toBeTruthy();
      expect(openDuringCall).toBe(true);
      expect(gate.isOpen(reservationId!)).toBe(false);
    });

    it("returns a NO_MODEL refusal for the dead tier when no local model exists", async () => {
      let calls = 0;
      const result = await router.route(
        { messages: [{ role: "user", content: "Hi" }], taskType: "agent_turn", tier: "dead", sessionId: "test-session" },
        async () => {
          calls++;
          return { message: { content: "" }, usage: {}, finishReason: "stop" };
        },
      );

      expect(result.finishReason).toBe("budget_exceeded");
      expect(result.refusal?.code).toBe("NO_MODEL");
      expect(calls).toBe(0);
    });

    it("throws instead of returning an empty error turn when every attempt fails", async () => {
      await expect(
        router.route(
          { messages: [{ role: "user", content: "Hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
          async () => {
            throw Object.assign(new Error("bad gateway"), { status: 502 });
          },
        ),
      ).rejects.toBeInstanceOf(InferenceCallError);
      // 502 fails over: gpt-5.2 then gpt-5-mini, both held as unknown (a gateway error may follow billing).
      expect(ledger().map((r) => [r.model, r.status])).toEqual([
        ["gpt-5.2", "unknown"],
        ["gpt-5-mini", "unknown"],
      ]);
    });
  });

  describe("transformMessagesForProvider", () => {
    it("handles OpenAI format correctly (no transformation needed)", () => {
      const messages = [
        { role: "system" as const, content: "You are helpful" },
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there" },
      ];
      const result = router.transformMessagesForProvider(messages, "openai");
      expect(result.length).toBe(3);
    });

    it("handles Anthropic format: merges consecutive tool messages", () => {
      const messages = [
        { role: "user" as const, content: "Do something" },
        {
          role: "assistant" as const,
          content: "I will use tools",
          tool_calls: [
            { id: "tc1", type: "function" as const, function: { name: "tool1", arguments: "{}" } },
            { id: "tc2", type: "function" as const, function: { name: "tool2", arguments: "{}" } },
          ],
        },
        { role: "tool" as const, content: "result1", tool_call_id: "tc1" },
        { role: "tool" as const, content: "result2", tool_call_id: "tc2" },
      ];
      const result = router.transformMessagesForProvider(messages, "anthropic");

      // The two tool messages should be merged into one user message
      const userMessages = result.filter((m) => m.role === "user");
      // Original user + merged tool results = 2 user messages
      expect(userMessages.length).toBe(2);

      // The merged tool result message should contain both results
      const lastUser = result[result.length - 1];
      expect(lastUser.role).toBe("user");
      expect(lastUser.content).toContain("result1");
      expect(lastUser.content).toContain("result2");
    });

    it("Anthropic: alternating user/assistant maintained", () => {
      const messages = [
        { role: "user" as const, content: "First" },
        { role: "assistant" as const, content: "Response" },
        { role: "user" as const, content: "Second" },
      ];
      const result = router.transformMessagesForProvider(messages, "anthropic");

      // Verify alternating pattern
      for (let i = 1; i < result.length; i++) {
        if (result[i].role !== "system") {
          expect(result[i].role).not.toBe(result[i - 1].role);
        }
      }
    });

    it("Anthropic: merges consecutive same-role user messages", () => {
      const messages = [
        { role: "user" as const, content: "First" },
        { role: "user" as const, content: "Second" },
      ];
      const result = router.transformMessagesForProvider(messages, "anthropic");
      expect(result.length).toBe(1);
      expect(result[0].content).toContain("First");
      expect(result[0].content).toContain("Second");
    });

    it("throws error for empty message array", () => {
      expect(() => {
        router.transformMessagesForProvider([], "openai");
      }).toThrow("Cannot route inference with empty message array");
    });

    it("merges consecutive same-role messages for OpenAI", () => {
      const messages = [
        { role: "user" as const, content: "Part 1" },
        { role: "user" as const, content: "Part 2" },
        { role: "assistant" as const, content: "Response" },
      ];
      const result = router.transformMessagesForProvider(messages, "openai");
      expect(result.length).toBe(2); // merged user + assistant
      expect(result[0].content).toContain("Part 1");
      expect(result[0].content).toContain("Part 2");
    });
  });
});

// Budget enforcement moved to the inference gate: see inference/gate.test.ts.

// ─── Routing Matrix Tests ─────────────────────────────────────────

describe("Routing Matrix", () => {
  it("all SurvivalTier x InferenceTaskType combinations are defined", () => {
    const tiers = ["dead", "critical", "low_compute", "normal", "high"] as const;
    const taskTypes = ["agent_turn", "heartbeat_triage", "safety_check", "summarization", "planning"] as const;

    for (const tier of tiers) {
      for (const taskType of taskTypes) {
        const preference = DEFAULT_ROUTING_MATRIX[tier]?.[taskType];
        expect(preference).toBeDefined();
        expect(preference).toHaveProperty("candidates");
        expect(preference).toHaveProperty("maxTokens");
        expect(preference).toHaveProperty("ceilingCents");
      }
    }
  });

  it("dead tier has empty candidates for all task types", () => {
    const taskTypes = ["agent_turn", "heartbeat_triage", "safety_check", "summarization", "planning"] as const;
    for (const taskType of taskTypes) {
      expect(DEFAULT_ROUTING_MATRIX.dead[taskType].candidates).toHaveLength(0);
    }
  });

  it("normal tier has candidates for all task types", () => {
    const taskTypes = ["agent_turn", "heartbeat_triage", "safety_check", "summarization", "planning"] as const;
    for (const taskType of taskTypes) {
      expect(DEFAULT_ROUTING_MATRIX.normal[taskType].candidates.length).toBeGreaterThan(0);
    }
  });

  it("critical tier only has candidates for essential task types", () => {
    expect(DEFAULT_ROUTING_MATRIX.critical.agent_turn.candidates.length).toBeGreaterThan(0);
    expect(DEFAULT_ROUTING_MATRIX.critical.heartbeat_triage.candidates.length).toBeGreaterThan(0);
    expect(DEFAULT_ROUTING_MATRIX.critical.safety_check.candidates.length).toBeGreaterThan(0);
    // Non-essential tasks should have no candidates
    expect(DEFAULT_ROUTING_MATRIX.critical.summarization.candidates).toHaveLength(0);
    expect(DEFAULT_ROUTING_MATRIX.critical.planning.candidates).toHaveLength(0);
  });
});

// ─── Task Timeouts Tests ──────────────────────────────────────────

describe("Task Timeouts", () => {
  it("heartbeat_triage has 15s timeout", () => {
    expect(TASK_TIMEOUTS.heartbeat_triage).toBe(15_000);
  });

  it("safety_check has 30s timeout", () => {
    expect(TASK_TIMEOUTS.safety_check).toBe(30_000);
  });

  it("agent_turn has 120s timeout", () => {
    expect(TASK_TIMEOUTS.agent_turn).toBe(120_000);
  });

  it("planning has 120s timeout", () => {
    expect(TASK_TIMEOUTS.planning).toBe(120_000);
  });
});

// ─── Static Model Baseline Tests ──────────────────────────────────

describe("Static Model Baseline", () => {
  it("contains expected models", () => {
    const ids = STATIC_MODEL_BASELINE.map((m) => m.modelId);
    expect(ids).toContain("gpt-4.1");
    expect(ids).toContain("gpt-4.1-mini");
    expect(ids).toContain("gpt-4.1-nano");
    expect(ids).toContain("gpt-5.2");
    expect(ids).toContain("gpt-5.3");
  });

  it("all models have positive pricing", () => {
    for (const model of STATIC_MODEL_BASELINE) {
      expect(model.costPer1kInput).toBeGreaterThan(0);
      expect(model.costPer1kOutput).toBeGreaterThan(0);
    }
  });

  it("all models have valid provider", () => {
    const validProviders = ["openai", "anthropic", "conway", "other"];
    for (const model of STATIC_MODEL_BASELINE) {
      expect(validProviders).toContain(model.provider);
    }
  });
});

// ─── Schema Tests ─────────────────────────────────────────────────

describe("Schema MIGRATION_V6", () => {
  it("creates inference_costs table", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inference_costs'").all();
    expect(tables.length).toBe(1);
  });

  it("creates model_registry table", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_registry'").all();
    expect(tables.length).toBe(1);
  });

  it("inference_costs table has correct columns", () => {
    const info = db.prepare("PRAGMA table_info(inference_costs)").all() as any[];
    const columns = info.map((c: any) => c.name);
    expect(columns).toContain("id");
    expect(columns).toContain("session_id");
    expect(columns).toContain("model");
    expect(columns).toContain("cost_cents");
    expect(columns).toContain("task_type");
    expect(columns).toContain("tier");
  });

  it("model_registry table has correct columns", () => {
    const info = db.prepare("PRAGMA table_info(model_registry)").all() as any[];
    const columns = info.map((c: any) => c.name);
    expect(columns).toContain("model_id");
    expect(columns).toContain("provider");
    expect(columns).toContain("cost_per_1k_input");
    expect(columns).toContain("tier_minimum");
    expect(columns).toContain("parameter_style");
  });

  it("is idempotent (can run twice)", () => {
    expect(() => db.exec(MIGRATION_V6)).not.toThrow();
  });
});

// ─── DB Helpers Tests ─────────────────────────────────────────────

describe("Inference DB Helpers", () => {
  it("inferenceInsertCost returns a valid id", () => {
    const id = inferenceInsertCost(db, {
      sessionId: "s1",
      turnId: null,
      model: "gpt-4.1",
      provider: "openai",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 5,
      latencyMs: 200,
      tier: "normal",
      taskType: "agent_turn",
      cacheHit: false,
    });
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("inferenceGetSessionCosts returns costs for session", () => {
    inferenceInsertCost(db, {
      sessionId: "s1", turnId: null, model: "gpt-4.1", provider: "openai",
      inputTokens: 100, outputTokens: 50, costCents: 5,
      latencyMs: 200, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });
    inferenceInsertCost(db, {
      sessionId: "s2", turnId: null, model: "gpt-4.1", provider: "openai",
      inputTokens: 100, outputTokens: 50, costCents: 3,
      latencyMs: 200, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });

    const s1Costs = inferenceGetSessionCosts(db, "s1");
    expect(s1Costs.length).toBe(1);
    expect(s1Costs[0].costCents).toBe(5);
  });

  it("inferencePruneCosts removes old records", () => {
    // Insert a cost record with an old timestamp by directly inserting
    db.prepare(
      `INSERT INTO inference_costs (id, session_id, turn_id, model, provider, input_tokens, output_tokens, cost_cents, latency_ms, tier, task_type, cache_hit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("old-record", "s1", null, "gpt-4.1", "openai", 100, 50, 5, 200, "normal", "agent_turn", 0, "2020-01-01 00:00:00");

    // Insert a fresh record (uses datetime('now') default)
    inferenceInsertCost(db, {
      sessionId: "s2", turnId: null, model: "gpt-4.1", provider: "openai",
      inputTokens: 100, outputTokens: 50, costCents: 5,
      latencyMs: 200, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });

    // Prune with 30-day retention - should remove the old record but not the fresh one
    const pruned = inferencePruneCosts(db, 30);
    expect(pruned).toBe(1);

    // Verify the fresh record is still there
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM inference_costs").get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it("inferenceGetModelCosts cutoff matches datetime('now') format", () => {
    // Insert a record with exact-second timestamp (matches SQLite datetime('now'))
    const borderTs = new Date(Date.now() - 1 * 86400000);
    const sqliteFormat = borderTs.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

    db.prepare(
      `INSERT INTO inference_costs (id, session_id, turn_id, model, provider, input_tokens, output_tokens, cost_cents, latency_ms, tier, task_type, cache_hit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("border-record", "s1", null, "gpt-4.1", "openai", 100, 50, 10, 200, "normal", "agent_turn", 0, sqliteFormat);

    // Query with days=1 should include this record since it's exactly at the boundary
    const result = inferenceGetModelCosts(db, "gpt-4.1", 1);
    expect(result.totalCents).toBe(10);
    expect(result.callCount).toBe(1);
  });

  it("modelRegistryUpsert and modelRegistryGet work correctly", () => {
    const now = new Date().toISOString();
    modelRegistryUpsert(db, {
      modelId: "test-model",
      provider: "openai",
      displayName: "Test",
      tierMinimum: "normal",
      costPer1kInput: 10,
      costPer1kOutput: 20,
      maxTokens: 4096,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const entry = modelRegistryGet(db, "test-model");
    expect(entry).toBeDefined();
    expect(entry!.modelId).toBe("test-model");
    expect(entry!.supportsTools).toBe(true);
    expect(entry!.supportsVision).toBe(false);
  });

  it("modelRegistryGetAll returns all entries", () => {
    const now = new Date().toISOString();
    modelRegistryUpsert(db, {
      modelId: "m1", provider: "openai", displayName: "M1",
      tierMinimum: "normal", costPer1kInput: 10, costPer1kOutput: 20,
      maxTokens: 4096, contextWindow: 128000, supportsTools: true,
      supportsVision: false, parameterStyle: "max_tokens", enabled: true,
      createdAt: now, updatedAt: now,
    });
    modelRegistryUpsert(db, {
      modelId: "m2", provider: "anthropic", displayName: "M2",
      tierMinimum: "low_compute", costPer1kInput: 5, costPer1kOutput: 10,
      maxTokens: 4096, contextWindow: 200000, supportsTools: true,
      supportsVision: true, parameterStyle: "max_tokens", enabled: true,
      createdAt: now, updatedAt: now,
    });

    const all = modelRegistryGetAll(db);
    expect(all.length).toBe(2);
  });

  it("modelRegistrySetEnabled toggles enabled flag", () => {
    const now = new Date().toISOString();
    modelRegistryUpsert(db, {
      modelId: "m1", provider: "openai", displayName: "M1",
      tierMinimum: "normal", costPer1kInput: 10, costPer1kOutput: 20,
      maxTokens: 4096, contextWindow: 128000, supportsTools: true,
      supportsVision: false, parameterStyle: "max_tokens", enabled: true,
      createdAt: now, updatedAt: now,
    });

    modelRegistrySetEnabled(db, "m1", false);
    expect(modelRegistryGet(db, "m1")!.enabled).toBe(false);

    modelRegistrySetEnabled(db, "m1", true);
    expect(modelRegistryGet(db, "m1")!.enabled).toBe(true);
  });

  it("inferenceGetDailyCost includes records at end of day (23:59:59)", () => {
    const today = new Date().toISOString().slice(0, 10);

    // Insert a record at 23:59:59 (end of day)
    db.prepare(
      `INSERT INTO inference_costs (id, session_id, turn_id, model, provider, input_tokens, output_tokens, cost_cents, latency_ms, tier, task_type, cache_hit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("eod-record", "s1", null, "gpt-4.1", "openai", 100, 50, 7, 200, "normal", "agent_turn", 0, `${today} 23:59:59`);

    const cost = inferenceGetDailyCost(db, today);
    expect(cost).toBe(7);
  });
});

// ─── Default Model Strategy Config Tests ──────────────────────────

describe("DEFAULT_MODEL_STRATEGY_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.inferenceModel).toBe("gpt-5.2");
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.lowComputeModel).toBe("gpt-5-mini");
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.criticalModel).toBe("gpt-5-mini");
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.enableModelFallback).toBe(true);
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.hourlyBudgetCents).toBe(0); // no limit
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.sessionBudgetCents).toBe(0); // no limit
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.perCallCeilingCents).toBe(0); // no limit
  });
});
