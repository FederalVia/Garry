import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderRegistry,
  type ProviderConfig,
} from "../../inference/provider-registry.js";
import {
  UnifiedInferenceClient,
  resetProviderCircuitBreakers,
  type UnifiedInferenceClientOptions,
} from "../../inference/inference-client.js";
import {
  InferenceGate,
  installInferenceGate,
  resetInferenceGateForTests,
} from "../../inference/gate.js";
import type { ResolvedInferencePolicy } from "../../inference/policy.js";
import { createDatabase } from "../../state/database.js";
import type { AutomatonDatabase, ChatMessage, SurvivalTier } from "../../types.js";

const mockState = vi.hoisted(() => {
  const queue: Array<(payload: any) => unknown | Promise<unknown>> = [];
  const calls: any[] = [];

  const create = vi.fn(async (payload: any) => {
    calls.push(payload);
    const next = queue.shift();
    if (!next) {
      throw new Error("No OpenAI mock response queued");
    }
    return next(payload);
  });

  const ctor = vi.fn().mockImplementation(function MockOpenAI(this: any) {
    this.chat = {
      completions: {
        create,
      },
    };
  });

  return {
    queue,
    calls,
    create,
    ctor,
  };
});

vi.mock("openai", () => ({
  default: mockState.ctor,
}));

const ORIGINAL_ENV = { ...process.env };
const BASE_MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

function createDefaultRegistry(): ProviderRegistry {
  return ProviderRegistry.fromConfig("/tmp/definitely-missing-provider-config.json");
}

const sleeps: number[] = [];
const recordSleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

function createClient(
  registry = createDefaultRegistry(),
  options: UnifiedInferenceClientOptions = {},
): UnifiedInferenceClient {
  return new UnifiedInferenceClient(registry, { sleep: recordSleep, ...options });
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

function installGate(tier: SurvivalTier | "unknown" = "high"): void {
  gate = new InferenceGate({ db: db.raw, policy: PERMISSIVE_POLICY });
  gate.setSurvival({ tier, creditsCents: tier === "unknown" ? null : 100_000 });
  installInferenceGate(gate);
}

function queueCompletion(params?: {
  content?: unknown;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCalls?: unknown[];
}): void {
  mockState.queue.push(async () => ({
    choices: [
      {
        message: {
          content: params?.content ?? "ok",
          ...(params?.toolCalls ? { tool_calls: params.toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: params?.promptTokens ?? 100,
      completion_tokens: params?.completionTokens ?? 20,
      total_tokens: params?.totalTokens ?? 120,
    },
  }));
}

function queueStream(chunks: any[]): void {
  async function* makeChunks(): AsyncIterable<any> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  mockState.queue.push(async () => makeChunks());
}

function queueError(status: number, message = `HTTP ${status}`): void {
  mockState.queue.push(async () => {
    const error = new Error(message) as Error & { status?: number };
    error.status = status;
    throw error;
  });
}

function queueUnknownError(message = "boom"): void {
  mockState.queue.push(async () => {
    throw new Error(message);
  });
}

describe("UnifiedInferenceClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.queue.splice(0, mockState.queue.length);
    mockState.calls.splice(0, mockState.calls.length);
    sleeps.length = 0;
    process.env = { ...ORIGINAL_ENV };
    process.env.OPENAI_API_KEY = "sk-test-openai";
    process.env.GROQ_API_KEY = "gsk-test-groq";
    delete process.env.TOGETHER_API_KEY;
    delete process.env.AUTOMATON_CREDITS_BALANCE;
    resetProviderCircuitBreakers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-client-test-"));
    db = createDatabase(path.join(tmpDir, "state.db"));
    installGate();
  });

  afterEach(() => {
    resetInferenceGateForTests();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });

  it("chat resolves tier and returns result", async () => {
    const client = createClient();
    queueCompletion({ content: "reasoning-response" });

    const result = await client.chat({
      tier: "reasoning",
      messages: BASE_MESSAGES,
    });

    expect(result.content).toBe("reasoning-response");
    expect(result.metadata.providerId).toBe("openai");
    expect(result.metadata.modelId).toBe("gpt-4.1");
    expect(result.metadata.tier).toBe("reasoning");
  });

  it("chat steps the tier down at the normal survival tier (from the gate, not the env)", async () => {
    installGate("normal");
    const client = createClient();
    queueCompletion({ content: "survival" });

    const result = await client.chat({
      tier: "reasoning",
      messages: BASE_MESSAGES,
    });

    // reasoning -> fast, whose preferred provider is groq.
    expect(result.metadata.providerId).toBe("groq");
    expect(result.metadata.modelId).toBe("llama-3.3-70b-versatile");
    expect(result.metadata.tier).toBe("reasoning");
  });

  it("chat populates failedProviders as empty on first success", async () => {
    const client = createClient();
    queueCompletion();

    const result = await client.chat({ tier: "fast", messages: BASE_MESSAGES });
    expect(result.metadata.failedProviders).toEqual([]);
    expect(result.metadata.retries).toBe(0);
  });

  it("chat retries a transient error once on the same provider, then fails over", async () => {
    const client = createClient();
    queueError(429);
    queueCompletion({ content: "after-retry" });

    const result = await client.chat({ tier: "fast", messages: BASE_MESSAGES });

    expect(result.content).toBe("after-retry");
    expect(result.metadata.providerId).toBe("groq");
    expect(result.metadata.retries).toBe(1);
    expect(sleeps).toEqual([1000]);
  });

  it.each([429, 500, 503])(
    "fails over to next provider on retryable %s errors",
    async (status) => {
      const client = createClient();

      // openai gets 2 attempts (one retry), then groq succeeds
      queueError(status);
      queueError(status);
      queueCompletion({ content: `from-groq-${status}` });

      const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });

      expect(result.content).toBe(`from-groq-${status}`);
      expect(result.metadata.providerId).toBe("groq");
      expect(result.metadata.failedProviders).toEqual(["openai"]);
      expect(result.metadata.retries).toBe(2);
      expect(mockState.create).toHaveBeenCalledTimes(3);
    },
  );

  it("does not fail over on non-retryable provider error", async () => {
    const client = createClient();
    queueError(400, "bad request");

    await expect(
      client.chat({ tier: "reasoning", messages: BASE_MESSAGES }),
    ).rejects.toThrow("bad request");
  });

  it("stops retrying after max retry budget", async () => {
    const client = createClient();

    // Each provider gets one retry: 2 + 2 HTTP requests in total.
    queueError(429, "openai-1");
    queueError(429, "openai-2");
    queueError(429, "groq-1");
    queueError(429, "groq-2");
    queueError(429, "never-sent");

    await expect(
      client.chat({ tier: "reasoning", messages: BASE_MESSAGES }),
    ).rejects.toThrow(/All providers failed/);
    expect(mockState.create).toHaveBeenCalledTimes(4);
    expect(mockState.queue).toHaveLength(1);
  });

  it("throws when no providers are available for tier", async () => {
    const providers: ProviderConfig[] = [
      {
        id: "p1",
        name: "Disabled",
        baseUrl: "https://example.com/v1",
        apiKeyEnvVar: "P1_KEY",
        models: [
          {
            id: "m1",
            tier: "reasoning",
            contextWindow: 10000,
            maxOutputTokens: 1000,
            costPerInputToken: 0,
            costPerOutputToken: 0,
            supportsTools: false,
            supportsVision: false,
            supportsStreaming: false,
          },
        ],
        maxRequestsPerMinute: 10,
        maxTokensPerMinute: 1000,
        priority: 1,
        enabled: false,
      },
    ];

    process.env.P1_KEY = "k";
    const registry = new ProviderRegistry(providers);
    const client = createClient(registry);

    await expect(client.chat({ tier: "reasoning", messages: BASE_MESSAGES })).rejects.toThrow(
      /No providers available/,
    );
  });

  it("circuit breaker opens after 5 consecutive health failures (502s)", async () => {
    const client = createClient();

    for (let i = 0; i < 5; i += 1) {
      queueError(502, `hard-fail-${i}`);
      await expect(
        client.chatDirect({
          providerId: "openai",
          modelId: "gpt-4.1",
          messages: BASE_MESSAGES,
        }),
      ).rejects.toThrow(`hard-fail-${i}`);
    }

    queueCompletion({ content: "should-not-run" });

    await expect(
      client.chatDirect({
        providerId: "openai",
        modelId: "gpt-4.1",
        messages: BASE_MESSAGES,
      }),
    ).rejects.toThrow(/circuit is open/);

    expect(mockState.create).toHaveBeenCalledTimes(5);
  });

  it("chat skips providers with open circuit and fails over", async () => {
    const client = createClient();

    for (let i = 0; i < 5; i += 1) {
      queueError(502, `trip-${i}`);
      await expect(
        client.chatDirect({
          providerId: "openai",
          modelId: "gpt-4.1",
          messages: BASE_MESSAGES,
        }),
      ).rejects.toThrow();
    }

    queueCompletion({ content: "from-fallback" });

    const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });
    expect(result.metadata.providerId).toBe("groq");
    expect(result.metadata.failedProviders).toEqual([]);
  });

  it("successful chatDirect resets circuit breaker failure count", async () => {
    const client = createClient();

    queueError(502, "first-fail");
    await expect(
      client.chatDirect({ providerId: "openai", modelId: "gpt-4.1", messages: BASE_MESSAGES }),
    ).rejects.toThrow("first-fail");

    queueCompletion({ content: "recovered" });
    await expect(
      client.chatDirect({ providerId: "openai", modelId: "gpt-4.1", messages: BASE_MESSAGES }),
    ).resolves.toMatchObject({ content: "recovered" });

    for (let i = 0; i < 4; i += 1) {
      queueError(502, `again-${i}`);
      await expect(
        client.chatDirect({ providerId: "openai", modelId: "gpt-4.1", messages: BASE_MESSAGES }),
      ).rejects.toThrow(`again-${i}`);
    }

    queueCompletion({ content: "still-open" });
    await expect(
      client.chatDirect({ providerId: "openai", modelId: "gpt-4.1", messages: BASE_MESSAGES }),
    ).resolves.toMatchObject({ content: "still-open" });
  });

  it("chatDirect bypasses tier resolution", async () => {
    const registry = createDefaultRegistry();
    const resolveSpy = vi.spyOn(registry, "resolveCandidates");
    const client = createClient(registry);

    queueCompletion({ content: "direct" });

    const result = await client.chatDirect({
      providerId: "openai",
      modelId: "gpt-4.1-mini",
      messages: BASE_MESSAGES,
    });

    expect(result.metadata.providerId).toBe("openai");
    expect(result.metadata.modelId).toBe("gpt-4.1-mini");
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("chatDirect throws when provider circuit is open", async () => {
    const client = createClient();

    for (let i = 0; i < 5; i += 1) {
      queueError(502, "trip-circuit");
      await expect(
        client.chatDirect({ providerId: "openai", modelId: "gpt-4.1", messages: BASE_MESSAGES }),
      ).rejects.toThrow("trip-circuit");
    }

    await expect(
      client.chatDirect({ providerId: "openai", modelId: "gpt-4.1", messages: BASE_MESSAGES }),
    ).rejects.toThrow(/circuit is open/);
  });

  it("chatDirect includes retry metadata", async () => {
    const client = createClient();

    queueError(429);
    queueCompletion({ content: "after-direct-retry" });

    const result = await client.chatDirect({
      providerId: "openai",
      modelId: "gpt-4.1",
      messages: BASE_MESSAGES,
    });

    expect(result.metadata.retries).toBe(1);
    expect(result.metadata.failedProviders).toEqual([]);
  });

  it("tracks cost fields in result", async () => {
    const client = createClient();
    queueCompletion({
      content: "cost-test",
      promptTokens: 2000,
      completionTokens: 500,
      totalTokens: 2500,
    });

    const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 500, totalTokens: 2500 });
    // USD per 1M tokens: 2000 * $2 = $0.004 = 0.4c; 500 * $8 = $0.004 = 0.4c.
    expect(result.cost.inputCostCents).toBeCloseTo(0.4);
    expect(result.cost.outputCostCents).toBeCloseTo(0.4);
    expect(result.cost.totalCostCents).toBeCloseTo(0.8);
    expect(result.cost.costMicroUsd).toBe(8000);
  });

  it("extracts text content from structured content arrays", async () => {
    const client = createClient();
    queueCompletion({
      content: [
        { type: "text", text: "alpha" },
        "-",
        { type: "text", text: "beta" },
      ],
    });

    const result = await client.chat({ tier: "fast", messages: BASE_MESSAGES });
    expect(result.content).toBe("alpha-beta");
  });

  it("returns toolCalls when provided by completion", async () => {
    const client = createClient();
    const toolCalls = [
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      },
    ];
    queueCompletion({ content: "tool", toolCalls });

    const result = await client.chat({ tier: "fast", messages: BASE_MESSAGES });
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("throws when provider response has no completion choice", async () => {
    const client = createClient();
    // Fails over to groq, which also returns nothing usable.
    mockState.queue.push(async () => ({ choices: [] }));
    mockState.queue.push(async () => ({ choices: [] }));

    await expect(client.chat({ tier: "reasoning", messages: BASE_MESSAGES })).rejects.toThrow(
      /No completion choice returned/,
    );
  });

  it("chat supports streaming responses", async () => {
    const client = createClient();
    queueStream([
      {
        choices: [
          {
            delta: {
              content: "hello ",
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              content: "world",
              tool_calls: [
                {
                  index: 0,
                  id: "tc_1",
                  type: "function",
                  function: {
                    name: "sum",
                    arguments: "{\"a\":",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: "1}",
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
    ]);

    const result = await client.chat({
      tier: "reasoning",
      messages: BASE_MESSAGES,
      stream: true,
    });

    expect(result.content).toBe("hello world");
    expect(result.toolCalls).toEqual([
      {
        id: "tc_1",
        type: "function",
        function: {
          name: "sum",
          arguments: "{\"a\":1}",
        },
      },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    // Usage only arrives in a stream when it is asked for.
    expect(mockState.calls.at(-1)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("includes failed provider IDs in final all-failed error", async () => {
    const client = createClient();

    queueError(500, "openai-hard-fail");
    queueError(500, "openai-hard-fail-again");
    queueError(502, "groq-hard-fail");
    await expect(client.chat({ tier: "reasoning", messages: BASE_MESSAGES })).rejects.toThrow(
      /All providers failed for tier 'reasoning'\. Failed providers: openai, groq.*groq-hard-fail/,
    );
  });

  it("passes tool and response-format params to OpenAI payload", async () => {
    const client = createClient();
    queueCompletion({ content: "payload" });

    await client.chat({
      tier: "fast",
      messages: BASE_MESSAGES,
      temperature: 0.2,
      maxTokens: 321,
      tools: [{ type: "function", function: { name: "x", description: "y", parameters: {} } }],
      toolChoice: "auto",
      responseFormat: { type: "json_object" },
    });

    const payload = mockState.calls.at(-1);
    expect(payload).toMatchObject({
      temperature: 0.2,
      max_tokens: 321,
      tool_choice: "auto",
      response_format: { type: "json_object" },
    });
    expect(Array.isArray(payload.tools)).toBe(true);
  });
  it("holds an error of unknown shape at its reservation and fails over", async () => {
    const client = createClient();
    queueUnknownError("socket hang up");
    queueCompletion({ content: "from-groq" });

    const result = await client.chat({ tier: "reasoning", messages: BASE_MESSAGES });
    expect(result.metadata.providerId).toBe("groq");
    const rows = db.raw
      .prepare("SELECT provider, status FROM inference_ledger ORDER BY attempt")
      .all() as Array<{ provider: string; status: string }>;
    expect(rows).toEqual([
      { provider: "openai", status: "unknown" },
      { provider: "groq", status: "committed" },
    ]);
  });

  it("sends nothing when orchestration is paused by the survival tier", async () => {
    installGate("critical");
    const client = createClient();
    queueCompletion({ content: "never" });

    await expect(client.chat({ tier: "fast", messages: BASE_MESSAGES })).rejects.toMatchObject({
      name: "InferenceRefusedError",
      code: "SURVIVAL_TIER",
    });
    expect(mockState.create).not.toHaveBeenCalled();
  });

  it("refuses paid providers when no gate is installed", async () => {
    resetInferenceGateForTests();
    const client = createClient();
    queueCompletion({ content: "never" });

    await expect(client.chat({ tier: "reasoning", messages: BASE_MESSAGES })).rejects.toMatchObject({
      code: "GATE_UNAVAILABLE",
    });
    expect(mockState.create).not.toHaveBeenCalled();
  });
});
