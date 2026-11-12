/**
 * Integration tests for UnifiedInferenceClient failover behavior.
 *
 * These tests exercise the interaction between UnifiedInferenceClient and
 * ProviderRegistry as a unit: registry tier resolution, circuit-breaker state
 * synced back into the registry, and the survival-tier mapping (read from the
 * inference gate) all working together.
 *
 * The OpenAI network layer is mocked via vi.hoisted so no real HTTP calls are
 * made. Each test gets a fresh client + registry pair to avoid state bleed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry, type ProviderConfig } from "../../inference/provider-registry.js";
import { UnifiedInferenceClient, resetProviderCircuitBreakers } from "../../inference/inference-client.js";
import {
  InferenceGate,
  installInferenceGate,
  resetInferenceGateForTests,
} from "../../inference/gate.js";
import type { ResolvedInferencePolicy } from "../../inference/policy.js";
import { createDatabase } from "../../state/database.js";
import type { AutomatonDatabase, ChatMessage, SurvivalTier } from "../../types.js";

// ---------------------------------------------------------------------------
// OpenAI mock — must be hoisted so the module mock runs before imports resolve
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  const queue: Array<(payload: unknown) => unknown | Promise<unknown>> = [];
  const calls: unknown[] = [];

  const create = vi.fn(async (payload: unknown) => {
    calls.push(payload);
    const next = queue.shift();
    if (!next) {
      throw new Error("No OpenAI mock response queued");
    }
    return next(payload);
  });

  const ctor = vi.fn().mockImplementation(function MockOpenAI(this: Record<string, unknown>) {
    this.chat = { completions: { create } };
  });

  return { queue, calls, create, ctor };
});

vi.mock("openai", () => ({ default: mockState.ctor }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const BASE_MESSAGES: ChatMessage[] = [{ role: "user", content: "ping" }];

/** Build a minimal enabled provider with models for all three tiers. */
function makeProvider(
  id: string,
  priority: number,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1`,
    apiKeyEnvVar: `${id.toUpperCase()}_API_KEY`,
    models: [
      {
        id: `${id}-reasoning`,
        tier: "reasoning",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        costPerInputToken: 1.0,
        costPerOutputToken: 2.0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: `${id}-fast`,
        tier: "fast",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        costPerInputToken: 0.2,
        costPerOutputToken: 0.4,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: `${id}-cheap`,
        tier: "cheap",
        contextWindow: 128000,
        maxOutputTokens: 2048,
        costPerInputToken: 0.05,
        costPerOutputToken: 0.1,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 100,
    maxTokensPerMinute: 500000,
    priority,
    enabled: true,
    ...overrides,
  };
}

/** Build a registry with the given providers and explicit tier preference order. */
function makeRegistry(providers: ProviderConfig[], preferredForReasoning?: string): ProviderRegistry {
  const primaryId = preferredForReasoning ?? providers[0]?.id ?? "alpha";
  const fallbackIds = providers.slice(1).map((p) => p.id);
  return new ProviderRegistry(providers, {
    reasoning: { preferredProvider: primaryId, fallbackOrder: fallbackIds },
    fast: { preferredProvider: primaryId, fallbackOrder: fallbackIds },
    cheap: { preferredProvider: primaryId, fallbackOrder: fallbackIds },
  });
}

const sleeps: number[] = [];

function makeClient(registry: ProviderRegistry): UnifiedInferenceClient {
  return new UnifiedInferenceClient(registry, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

const PERMISSIVE_POLICY: ResolvedInferencePolicy = {
  dailyCapCents: 1_000_000,
  hourlyCapCents: 1_000_000,
  sessionCapCents: 0,
  perCallCeilingCents: 0,
  orchestrationSharePct: 100,
  survivalAllowanceCents: 25,
  survivalMinIntervalMs: 1_800_000,
  sessionCooldownMs: 1_800_000,
  maxTokensPerTurn: 100_000,
  enableModelFallback: true,
  unknownPrice: { inputUsdPerM: 2, outputUsdPerM: 14 },
};

let tmpDir: string;
let db: AutomatonDatabase;
let gate: InferenceGate;

function setSurvival(tier: SurvivalTier | "unknown"): void {
  gate.setSurvival({ tier, creditsCents: tier === "unknown" ? null : 1000 });
}

/** Push a successful chat completion onto the mock queue. */
function queueCompletion(content = "ok", promptTokens = 100, completionTokens = 20): void {
  mockState.queue.push(async () => ({
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }));
}

/** Push an HTTP error response onto the mock queue. */
function queueError(status: number, message = `HTTP ${status}`): void {
  mockState.queue.push(async () => {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockState.queue.splice(0, mockState.queue.length);
  mockState.calls.splice(0, mockState.calls.length);
  sleeps.length = 0;
  process.env = { ...ORIGINAL_ENV };
  process.env.ALPHA_API_KEY = "alpha-key";
  process.env.BETA_API_KEY = "beta-key";
  process.env["PRICING-TEST_API_KEY"] = "pricing-key";
  delete process.env.AUTOMATON_CREDITS_BALANCE;
  delete process.env.AUTOMATON_INFERENCE_TASK_TYPE;
  resetProviderCircuitBreakers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inference-failover-"));
  db = createDatabase(path.join(tmpDir, "state.db"));
  gate = new InferenceGate({ db: db.raw, policy: PERMISSIVE_POLICY });
  setSurvival("high");
  installInferenceGate(gate);
});

afterEach(() => {
  vi.useRealTimers();
  resetInferenceGateForTests();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration/inference-failover", () => {
  // -------------------------------------------------------------------------
  // 1. Provider resolution
  // -------------------------------------------------------------------------

  describe("provider resolution", () => {
    it("uses the preferred provider for a tier on the first request", async () => {
      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      queueCompletion("from-alpha");

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.content).toBe("from-alpha");
      expect(result.metadata.providerId).toBe("alpha");
      expect(result.metadata.failedProviders).toEqual([]);
    });

    it("respects provider priority order when preferred is absent from fallback list", async () => {
      // Create a registry where only beta has a reasoning model.
      const alpha = makeProvider("alpha", 1, {
        models: [
          {
            id: "alpha-fast",
            tier: "fast",
            contextWindow: 64000,
            maxOutputTokens: 2048,
            costPerInputToken: 0.1,
            costPerOutputToken: 0.2,
            supportsTools: true,
            supportsVision: false,
            supportsStreaming: true,
          },
        ],
      });
      const beta = makeProvider("beta", 2);
      const registry = new ProviderRegistry([alpha, beta]);
      const client = makeClient(registry);

      queueCompletion("from-beta");

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.metadata.providerId).toBe("beta");
    });

    it("returns cost fields calculated from model pricing", async () => {
      const provider = makeProvider("pricing-test", 1);
      const registry = makeRegistry([provider]);
      const client = makeClient(registry);

      // 1000 input tokens, 500 output tokens
      queueCompletion("priced", 1000, 500);

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      // Prices are USD per 1M tokens: 1000 * $1.0 = $0.001 = 0.1c; 500 * $2.0 = 0.1c.
      expect(result.cost.inputCostCents).toBeCloseTo(0.1);
      expect(result.cost.outputCostCents).toBeCloseTo(0.1);
      expect(result.cost.totalCostCents).toBeCloseTo(0.2);
      expect(result.cost.costMicroUsd).toBe(2000);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Failover between providers
  // -------------------------------------------------------------------------

  describe("failover between providers", () => {
    it("falls over to secondary provider after primary exhausts retries on 429", async () => {
      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      // Alpha gets 2 calls: the first and its single retry.
      queueError(429, "alpha-rate-limit");
      queueError(429, "alpha-rate-limit");
      queueCompletion("from-beta");

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.content).toBe("from-beta");
      expect(result.metadata.providerId).toBe("beta");
      expect(result.metadata.failedProviders).toContain("alpha");
      expect(result.metadata.retries).toBe(2);
      expect(sleeps).toEqual([1000]);
    });

    it("falls over to secondary provider after primary exhausts retries on 503", async () => {
      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      queueError(503);
      queueError(503);
      queueCompletion("beta-ok");

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.metadata.providerId).toBe("beta");
      expect(result.metadata.failedProviders).toContain("alpha");
    });

    it("does not fail over on a non-retryable 400 error — throws immediately", async () => {
      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      queueError(400, "bad-request");
      // beta is queued but should never be called
      queueCompletion("should-not-reach");

      await expect(
        client.chat({ tier: "reasoning", messages: BASE_MESSAGES }),
      ).rejects.toThrow("bad-request");

      // Only one OpenAI call should have been made (alpha, no retry/failover)
      expect(mockState.create).toHaveBeenCalledTimes(1);
    });

    it("throws all-providers-failed error with provider names when both providers exhaust retries", async () => {
      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      // Both use their single retry: 2 calls each, 4 in total (the per-call limit).
      for (let i = 0; i < 2; i++) queueError(429, `alpha-${i}`);
      for (let i = 0; i < 2; i++) queueError(500, `beta-${i}`);

      await expect(
        client.chat({ tier: "reasoning", messages: BASE_MESSAGES }),
      ).rejects.toThrow(/All providers failed.*alpha.*beta/);
      expect(mockState.create).toHaveBeenCalledTimes(4);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Circuit breaker ↔ registry coordination
  // -------------------------------------------------------------------------

  describe("circuit breaker and registry coordination", () => {
    it("caller payload errors (400) never open the circuit breaker", async () => {
      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      for (let i = 0; i < 5; i++) {
        queueError(400, `context_length_exceeded-${i}`);
        await expect(
          client.chatDirect({ providerId: "alpha", modelId: "alpha-reasoning", messages: BASE_MESSAGES }),
        ).rejects.toThrow(`context_length_exceeded-${i}`);
      }

      // The fault was in the payload, not the provider: alpha stays in service.
      expect(registry.getProviders().find((p) => p.id === "alpha")?.enabled).toBe(true);
      queueCompletion("alpha-still-serving");
      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });
      expect(result.metadata.providerId).toBe("alpha");
    });

    it("circuit breaker opens after 5 health failures and skips provider in chat()", async () => {
      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      // Trip the circuit on alpha via chatDirect
      for (let i = 0; i < 5; i++) {
        queueError(502, `trip-${i}`);
        await expect(
          client.chatDirect({ providerId: "alpha", modelId: "alpha-reasoning", messages: BASE_MESSAGES }),
        ).rejects.toThrow(`trip-${i}`);
      }

      // Now chat() should skip alpha (circuit open) and go straight to beta
      queueCompletion("beta-after-trip");
      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.metadata.providerId).toBe("beta");
      // alpha was skipped by the circuit, not "failed" mid-flight
      expect(result.metadata.failedProviders).toEqual([]);
    });

    it("registry.disableProvider is called when circuit breaker threshold is reached", async () => {
      const alpha = makeProvider("alpha", 1);
      const registry = makeRegistry([alpha]);
      const client = makeClient(registry);
      const disableSpy = vi.spyOn(registry, "disableProvider");

      for (let i = 0; i < 5; i++) {
        queueError(502, `fail-${i}`);
        await expect(
          client.chatDirect({ providerId: "alpha", modelId: "alpha-reasoning", messages: BASE_MESSAGES }),
        ).rejects.toThrow();
      }

      expect(disableSpy).toHaveBeenCalledWith(
        "alpha",
        expect.stringContaining("circuit-breaker"),
        expect.any(Number),
      );
    });

    it("circuit breaker re-enables provider after cooldown and registry reflects it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });

      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      // Trip the circuit on alpha
      for (let i = 0; i < 5; i++) {
        queueError(504, `trip-${i}`);
        await expect(
          client.chatDirect({ providerId: "alpha", modelId: "alpha-reasoning", messages: BASE_MESSAGES }),
        ).rejects.toThrow();
      }

      // Alpha is circuit-open; registry also has it disabled
      expect(registry.getProviders().find((p) => p.id === "alpha")?.enabled).toBe(false);

      // A new client (as each wake cycle builds) still sees the open circuit.
      await expect(
        makeClient(registry).chatDirect({ providerId: "alpha", modelId: "alpha-reasoning", messages: BASE_MESSAGES }),
      ).rejects.toThrow(/circuit is open/);

      // Advance past the 5-minute cooldown (CIRCUIT_BREAKER_DISABLE_MS = 5 * 60_000)
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);

      // A successful call to alpha resets the state
      queueCompletion("alpha-recovered");
      const result = await client.chatDirect({
        providerId: "alpha",
        modelId: "alpha-reasoning",
        messages: BASE_MESSAGES,
      });

      expect(result.content).toBe("alpha-recovered");
      expect(registry.getProviders().find((p) => p.id === "alpha")?.enabled).toBe(true);

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Survival mode tier downgrade
  // -------------------------------------------------------------------------

  describe("survival tier mapping (from the gate)", () => {
    it("normal tier steps reasoning down to fast", async () => {
      setSurvival("normal");

      const alpha = makeProvider("alpha", 1);
      const registry = makeRegistry([alpha]);
      const client = makeClient(registry);

      queueCompletion("survival-fast");

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      // reasoning -> fast, so the actual model served is fast
      expect(result.metadata.modelId).toBe("alpha-fast");
      // But the requested tier is preserved in metadata
      expect(result.metadata.tier).toBe("reasoning");
    });

    it("normal tier steps fast down to cheap", async () => {
      setSurvival("normal");

      const alpha = makeProvider("alpha", 1);
      const registry = makeRegistry([alpha]);
      const client = makeClient(registry);

      queueCompletion("survival-cheap");

      const result = await client.chat({ tier: "fast", messages: BASE_MESSAGES });

      expect(result.metadata.modelId).toBe("alpha-cheap");
      expect(result.metadata.tier).toBe("fast");
    });

    it("high tier serves the requested tier", async () => {
      setSurvival("high");

      const alpha = makeProvider("alpha", 1);
      const registry = makeRegistry([alpha]);
      const client = makeClient(registry);

      queueCompletion("full-reasoning");

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.metadata.modelId).toBe("alpha-reasoning");
    });

    it("ignores the old AUTOMATON_CREDITS_BALANCE env var", async () => {
      setSurvival("high");
      process.env.AUTOMATON_CREDITS_BALANCE = "30";

      const alpha = makeProvider("alpha", 1);
      const registry = makeRegistry([alpha]);
      const client = makeClient(registry);

      queueCompletion("normal-reasoning");

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.metadata.modelId).toBe("alpha-reasoning");
    });

    it("populates failedProviders in metadata when failover occurs at the normal tier", async () => {
      setSurvival("normal");

      const alpha = makeProvider("alpha", 1);
      const beta = makeProvider("beta", 2);
      const registry = makeRegistry([alpha, beta], "alpha");
      const client = makeClient(registry);

      // reasoning -> fast; alpha-fast fails twice, beta-fast succeeds
      queueError(429);
      queueError(429);
      queueCompletion("beta-survival");

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.metadata.failedProviders).toContain("alpha");
      expect(result.metadata.providerId).toBe("beta");
      expect(result.metadata.modelId).toBe("beta-fast");
    });

    it.each(["low_compute", "critical", "dead", "unknown"] as const)(
      "%s pauses orchestration inference without sending a request",
      async (tier) => {
        setSurvival(tier);

        const alpha = makeProvider("alpha", 1);
        const registry = makeRegistry([alpha]);
        const client = makeClient(registry);
        queueCompletion("never");

        await expect(
          client.chat({ tier: "reasoning", messages: BASE_MESSAGES }),
        ).rejects.toMatchObject({ code: "SURVIVAL_TIER" });
        expect(mockState.create).not.toHaveBeenCalled();
      },
    );
  });
});
