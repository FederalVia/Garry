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

describe("UnifiedInferenceClient with the Anthropic transport", () => {
  const anthropicCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let replies: Array<() => Response>;
  const fetchStub = vi.fn(async (url: any, init: any) => {
    anthropicCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const next = replies.shift();
    if (!next) throw new Error("No Anthropic reply queued");
    return next();
  });
  const ok = (content: unknown[], usage = { input_tokens: 100, output_tokens: 20 }, stop_reason = "end_turn") => () =>
    new Response(JSON.stringify({ id: "msg", model: "claude-haiku-5-5", content, stop_reason, usage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const status = (code: number, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify({ type: "error", error: { type: "x", message: "m" } }), { status: code, headers });

  const anthropicProvider = (models: Partial<import("../../inference/provider-registry.js").ModelConfig>[] = []): ProviderConfig => ({
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    kind: "anthropic",
    effort: "high",
    models: (["reasoning", "fast", "cheap"] as const).map((tier, i) => ({
      id: "claude-haiku-5-5",
      tier,
      contextWindow: 200000,
      maxOutputTokens: 64000,
      costPerInputToken: 0.1,
      costPerOutputToken: 0.5,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      minOutputTokens: 2048,
      capabilities: {
        effort: true,
        minOutputTokens: 2048,
        longPrompt: { aboveInputTokens: 100_000, inputUsdPerM: 0.5, outputUsdPerM: 2.5 },
      },
      ...(models[i] ?? {}),
    })),
    maxRequestsPerMinute: 100,
    maxTokensPerMinute: 100000,
    priority: 1,
    enabled: true,
  });
  const openaiFallback = (): ProviderConfig => ({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    models: (["reasoning", "fast", "cheap"] as const).map((tier) => ({
      id: "gpt-4.1-mini",
      tier,
      contextWindow: 128000,
      maxOutputTokens: 16384,
      costPerInputToken: 0.4,
      costPerOutputToken: 1.6,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
    })),
    maxRequestsPerMinute: 100,
    maxTokensPerMinute: 100000,
    priority: 2,
    enabled: true,
  });
  const registryOf = (...providers: ProviderConfig[]) =>
    new ProviderRegistry(
      providers,
      {
        reasoning: { preferredProvider: providers[0].id, fallbackOrder: providers.slice(1).map((p) => p.id) },
        fast: { preferredProvider: providers[0].id, fallbackOrder: providers.slice(1).map((p) => p.id) },
        cheap: { preferredProvider: providers[0].id, fallbackOrder: providers.slice(1).map((p) => p.id) },
      },
      { keys: { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai" }, fetch: fetchStub as any },
    );
  const ledger = () =>
    db.raw
      .prepare(
        "SELECT provider, status, input_tokens, output_tokens, price_in_usd_per_m AS pin, price_out_usd_per_m AS pout, max_output_tokens AS maxOut FROM inference_ledger ORDER BY rowid",
      )
      .all() as any[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.queue.splice(0, mockState.queue.length);
    mockState.calls.splice(0, mockState.calls.length);
    anthropicCalls.length = 0;
    replies = [];
    sleeps.length = 0;
    resetProviderCircuitBreakers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-anthropic-test-"));
    db = createDatabase(path.join(tmpDir, "state.db"));
    installGate();
  });

  afterEach(() => {
    resetInferenceGateForTests();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("posts the codec body to the pinned endpoint with x-api-key, and returns a fenced JSON reply parsed", async () => {
    replies.push(ok([{ type: "thinking", thinking: "" }, { type: "text", text: '```json\n{"plan":1}\n```' }]));
    const client = createClient(registryOf(anthropicProvider()));
    const result = await client.chat({
      tier: "reasoning",
      messages: [
        { role: "system", content: "plan things" },
        { role: "user", content: "go" },
      ],
      temperature: 0.3,
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      purpose: "planner",
    });
    expect(JSON.parse(result.content)).toEqual({ plan: 1 });
    expect(anthropicCalls).toHaveLength(1);
    const call = anthropicCalls[0];
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-ant-test");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body).not.toHaveProperty("temperature");
    expect(call.body).not.toHaveProperty("thinking");
    expect(call.body.system).toContain("Reply with one JSON object and nothing else.");
    // The output floor for a thinking model, also reserved at that size.
    expect(call.body.max_tokens).toBe(2048);
    expect(ledger()[0].maxOut).toBe(2048);
    // The owner's effort for planner calls.
    expect(call.body.output_config).toEqual({ effort: "high" });
    expect(mockState.create).not.toHaveBeenCalled();
  });

  it("known secrets are redacted from what the Anthropic transport sends", async () => {
    const { registerSecret, clearRegisteredSecrets } = await import("../../security/secret-redaction.js");
    const secret = "sk-live-" + "q".repeat(40);
    registerSecret(secret, "test-secret");
    try {
      replies.push(ok([{ type: "text", text: "ok" }]));
      const client = createClient(registryOf(anthropicProvider()));
      await client.chat({ tier: "fast", messages: [{ role: "user", content: `the key is ${secret}` }] });
      expect(JSON.stringify(anthropicCalls[0].body)).not.toContain(secret);
    } finally {
      clearRegisteredSecrets();
    }
  });

  it("classifier calls ask for low effort", async () => {
    replies.push(ok([{ type: "text", text: "{}" }]));
    const client = createClient(registryOf(anthropicProvider()));
    await client.chat({ tier: "cheap", messages: BASE_MESSAGES, purpose: "classify" });
    expect(anthropicCalls[0].body.output_config).toEqual({ effort: "low" });
  });

  it("a 401 disables the provider and the call fails over", async () => {
    replies.push(status(401));
    queueCompletion({ content: "from-openai" });
    const registry = registryOf(anthropicProvider(), openaiFallback());
    const client = createClient(registry);
    const result = await client.chat({ tier: "fast", messages: BASE_MESSAGES });
    expect(result.metadata.providerId).toBe("openai");
    expect(registry.getProviders().find((p) => p.id === "anthropic")?.enabled).toBe(false);
    expect(ledger().map((r) => [r.provider, r.status])).toEqual([
      ["anthropic", "released"],
      ["openai", "committed"],
    ]);
  });

  it("a 429 is retried once on the same provider", async () => {
    replies.push(status(429, { "retry-after": "1" }));
    replies.push(ok([{ type: "text", text: "second time" }]));
    const client = createClient(registryOf(anthropicProvider()));
    const result = await client.chat({ tier: "fast", messages: BASE_MESSAGES });
    expect(result.content).toBe("second time");
    expect(anthropicCalls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("a refusal is billed at its usage and fails over", async () => {
    replies.push(ok([], { input_tokens: 70, output_tokens: 3 }, "refusal"));
    queueCompletion({ content: "from-openai" });
    const client = createClient(registryOf(anthropicProvider(), openaiFallback()));
    const result = await client.chat({ tier: "fast", messages: BASE_MESSAGES });
    expect(result.metadata.providerId).toBe("openai");
    const rows = ledger();
    expect(rows[0]).toMatchObject({ provider: "anthropic", status: "committed", input_tokens: 70, output_tokens: 3 });
    expect(rows[1]).toMatchObject({ provider: "openai", status: "committed" });
  });

  it("reserves at the long-prompt price once the estimate reaches 70% of the threshold", async () => {
    replies.push(ok([{ type: "text", text: "short" }]));
    replies.push(ok([{ type: "text", text: "long" }]));
    const client = createClient(registryOf(anthropicProvider()));
    await client.chat({ tier: "fast", messages: BASE_MESSAGES });
    // Under 80% of 100K by the local estimate, which runs short of the
    // Claude tokenizer: the real prompt can be over 100K.
    const long = "word ".repeat(55_000);
    const est = gate.estimateInputTokens([{ role: "user", content: long }], undefined);
    expect(est).toBeGreaterThanOrEqual(70_000);
    expect(est).toBeLessThan(80_000);
    expect(est).toBeLessThan(100_000);
    await client.chat({ tier: "fast", messages: [{ role: "user", content: long }] });
    const rows = ledger();
    expect(rows[0]).toMatchObject({ pin: 0.1, pout: 0.5 });
    expect(rows[1]).toMatchObject({ pin: 0.5, pout: 2.5 });
  });

  it("settles at the long-prompt price when the reported input crosses the threshold the estimate missed", async () => {
    replies.push(ok([{ type: "text", text: "ok" }], { input_tokens: 140_000, output_tokens: 1000 }));
    const client = createClient(registryOf(anthropicProvider()));
    await client.chat({ tier: "fast", messages: BASE_MESSAGES });
    const row = db.raw.prepare("SELECT price_in_usd_per_m AS pin, cost_micro_usd AS cost FROM inference_ledger").get() as any;
    expect(row.pin).toBe(0.1);
    expect(row.cost).toBe(140_000 * 0.5 + 1000 * 2.5);
  });
});
