/**
 * UnifiedInferenceClient through the inference gate, against a loopback
 * HTTP server that stands in for every provider (real OpenAI SDK, real
 * HTTP errors, real timeouts). Each block reproduces one audit finding.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UnifiedInferenceClient,
  resetProviderCircuitBreakers,
  type UnifiedInferenceClientOptions,
} from "../../inference/inference-client.js";
import { ProviderRegistry } from "../../inference/provider-registry.js";
import {
  InferenceGate,
  installInferenceGate,
  resetInferenceGateForTests,
  runWithInferenceScope,
} from "../../inference/gate.js";
import type { ResolvedInferencePolicy } from "../../inference/policy.js";
import { createDatabase } from "../../state/database.js";
import type { AutomatonDatabase, ChatMessage } from "../../types.js";

type Provider = "openai" | "groq";

interface Script {
  status?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
  headers?: Record<string, string>;
  stall?: boolean;
  delayMs?: number;
  stream?: boolean;
}

const MESSAGES: ChatMessage[] = [{ role: "user", content: "plan the goal" }];
const ORIGINAL_ENV = { ...process.env };

let server: http.Server;
let port: number;
let scripts: Record<Provider, Script[]>;
let hits: Record<Provider, number>;
let bodies: Record<Provider, any[]>;
let tmpDir: string;
let db: AutomatonDatabase;
let gate: InferenceGate;
let clock: number;
let sleeps: number[];

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
    maxTokensPerTurn: 100_000,
    enableModelFallback: true,
    unknownPrice: { inputUsdPerM: 2, outputUsdPerM: 14 },
    ...overrides,
  };
}

function installGate(overrides: Partial<ResolvedInferencePolicy> = {}): void {
  gate = new InferenceGate({ db: db.raw, policy: policy(overrides), now: () => clock });
  gate.setSurvival({ tier: "high", creditsCents: 100_000 });
  installInferenceGate(gate);
}

function completionBody(usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 0,
    model: "stub",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

function registry(baseFor: Partial<Record<Provider, string>> = {}): ProviderRegistry {
  const reg = ProviderRegistry.fromConfig(path.join(tmpDir, "no-providers.json"));
  reg.overrideBaseUrl("openai", baseFor.openai ?? `http://127.0.0.1:${port}/openai/v1`);
  reg.overrideBaseUrl("groq", baseFor.groq ?? `http://127.0.0.1:${port}/groq/v1`);
  return reg;
}

function client(reg = registry(), options: UnifiedInferenceClientOptions = {}): UnifiedInferenceClient {
  return new UnifiedInferenceClient(reg, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
}

function ledger(): Array<{ provider: string; status: string; cost_micro_usd: number | null; reserved_micro_usd: number }> {
  return db.raw
    .prepare("SELECT provider, status, cost_micro_usd, reserved_micro_usd FROM inference_ledger ORDER BY created_at_ms, attempt")
    .all() as any;
}

function asPlanner<T>(fn: () => Promise<T>): Promise<T> {
  return runWithInferenceScope({ caller: "orchestrator.plan" }, fn);
}

async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const p = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return p;
}

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  process.env.OPENAI_API_KEY = "sk-test-openai";
  process.env.GROQ_API_KEY = "gsk-test-groq";
  delete process.env.TOGETHER_API_KEY;
  delete process.env.AUTOMATON_CREDITS_BALANCE;
  scripts = { openai: [], groq: [] };
  hits = { openai: 0, groq: 0 };
  bodies = { openai: [], groq: [] };
  sleeps = [];
  clock = Date.now();
  resetProviderCircuitBreakers();

  server = http.createServer((req, res) => {
    const provider = (req.url ?? "").split("/")[1] as Provider;
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      hits[provider] = (hits[provider] ?? 0) + 1;
      try {
        bodies[provider]?.push(JSON.parse(raw));
      } catch {
        bodies[provider]?.push(raw);
      }
      const script = scripts[provider]?.shift() ?? {};
      if (script.stall) return;
      setTimeout(() => {
        const status = script.status ?? 200;
        if (status !== 200) {
          res.writeHead(status, { "content-type": "application/json", ...script.headers });
          res.end(JSON.stringify({ error: { message: `stub ${status}`, type: "stub" } }));
          return;
        }
        if (script.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const usage = script.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
          res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta: { content: "streamed" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub", choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(completionBody(script.usage)));
      }, script.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-gate-"));
  db = createDatabase(path.join(tmpDir, "state.db"));
  installGate();
});

afterEach(async () => {
  resetInferenceGateForTests();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe("F123: orchestration spend is recorded, in the right units, and capped", () => {
  it("records each planner call at its true cost and refuses the next one within the hour", async () => {
    // Only openai: a refusal would otherwise move on to a cheaper groq model.
    delete process.env.GROQ_API_KEY;
    installGate({ hourlyCapCents: 10 });
    scripts.openai.push({ usage: { prompt_tokens: 20_000, completion_tokens: 2_000 } });

    const result = await asPlanner(() =>
      client().chat({ tier: "reasoning", purpose: "planner", maxTokens: 8192, messages: MESSAGES }),
    );

    // gpt-4.1 at $2 / $8 per 1M tokens: 20k * 2 + 2k * 8 = 56,000 micro-USD = 5.6 cents.
    expect(result.metadata.modelId).toBe("gpt-4.1");
    expect(result.cost.totalCostCents).toBeCloseTo(5.6, 6);
    expect(result.cost.costMicroUsd).toBe(56_000);
    expect(ledger()).toEqual([
      expect.objectContaining({ provider: "openai", status: "committed", cost_micro_usd: 56_000 }),
    ]);
    // The planner request carried the max tokens it was priced at.
    expect(bodies.openai[0].max_tokens).toBe(8192);

    // 5.6c spent + about 6.6c reserved for the next planner call > 10c. With a
    // 100% share the orchestration share of the hourly cap is the cap itself.
    const refusal = await asPlanner(() =>
      client().chat({ tier: "reasoning", purpose: "planner", maxTokens: 8192, messages: MESSAGES }),
    ).catch((e) => e);
    expect(refusal).toMatchObject({ name: "InferenceRefusedError", code: "ORCHESTRATION_SHARE" });
    expect(refusal.retryAfterMs).toBeGreaterThan(3_590_000);
    expect(refusal.retryAfterMs).toBeLessThanOrEqual(3_600_001);
    expect(hits.openai).toBe(1);
  });

  it("counts orchestration and main-loop spend against the same hourly cap", async () => {
    delete process.env.GROQ_API_KEY;
    installGate({ hourlyCapCents: 10 });
    const main = gate.reserve({
      callId: "main-turn",
      attempt: 1,
      provider: "openai",
      model: "gpt-4.1",
      price: { inputUsdPerM: 2, outputUsdPerM: 8, local: false },
      estInputTokens: 25_000,
      maxOutputTokens: 100,
      minOutputTokens: 100,
      scope: { caller: "agent_turn" },
    });
    gate.commit(main.id, { inputTokens: 25_000, outputTokens: 0 }, 10); // 5c

    const refusal = await asPlanner(() =>
      client().chat({ tier: "reasoning", purpose: "planner", maxTokens: 8192, messages: MESSAGES }),
    ).catch((e) => e);
    expect(refusal).toMatchObject({ name: "InferenceRefusedError", code: "HOURLY_CAP" });
    expect(hits.openai).toBe(0);
  });
});

describe("F124: the daily cap applies to orchestration calls", () => {
  it("refuses at the daily cap until the old spend ages out of the 24 h window", async () => {
    delete process.env.GROQ_API_KEY;
    installGate({ dailyCapCents: 500, hourlyCapCents: 500 });
    // 495c of main-loop spend two hours ago.
    const t0 = clock - 2 * 3_600_000;
    const now = clock;
    clock = t0;
    const prior = gate.reserve({
      callId: "prior",
      attempt: 1,
      provider: "openai",
      model: "gpt-4.1",
      price: { inputUsdPerM: 2, outputUsdPerM: 8, local: false },
      estInputTokens: 2_400_000,
      maxOutputTokens: 1000,
      minOutputTokens: 1000,
      scope: { caller: "agent_turn" },
    });
    gate.commit(prior.id, { inputTokens: 2_471_000, outputTokens: 1000 }, 10);
    clock = now;

    const refused = await asPlanner(() =>
      client().chat({ tier: "reasoning", purpose: "planner", messages: MESSAGES }),
    ).catch((e) => e);
    expect(refused).toMatchObject({ name: "InferenceRefusedError", code: "DAILY_CAP" });
    expect(Math.abs(refused.retryAfterMs - (t0 + 24 * 3_600_000 - now))).toBeLessThanOrEqual(2);
    expect(hits.openai + hits.groq).toBe(0);

    clock = t0 + 24 * 3_600_000 + 1;
    const allowed = await asPlanner(() =>
      client().chat({ tier: "reasoning", purpose: "planner", messages: MESSAGES }),
    );
    expect(allowed.metadata.providerId).toBe("openai");
    expect(hits.openai).toBe(1);
  });
});

describe("F131: one retry layer, at most 4 HTTP attempts per call", () => {
  it("makes exactly 2 + 2 requests when both providers return 429, honouring Retry-After", async () => {
    scripts.openai.push(
      { status: 429, headers: { "retry-after": "1" } },
      { status: 429, headers: { "retry-after": "1" } },
    );
    scripts.groq.push(
      { status: 429, headers: { "retry-after": "1" } },
      { status: 429, headers: { "retry-after": "1" } },
      { status: 429 },
    );

    const error = await asPlanner(() => client().chat({ tier: "reasoning", messages: MESSAGES })).catch((e) => e);

    expect(error).toMatchObject({ name: "InferenceCallError" });
    expect(hits).toEqual({ openai: 2, groq: 2 });
    expect(sleeps).toEqual([1000, 1000]);
    // Every HTTP attempt had its own reservation; a 429 provably did not bill.
    expect(ledger().map((r) => `${r.provider}:${r.status}`)).toEqual([
      "openai:released",
      "openai:released",
      "groq:released",
      "groq:released",
    ]);
  });

  it("caps Retry-After at 10 s", async () => {
    scripts.openai.push({ status: 503, headers: { "retry-after": "3600" } }, {});
    await asPlanner(() => client().chat({ tier: "reasoning", messages: MESSAGES }));
    expect(sleeps).toEqual([10_000]);
  });
});

describe("F130: deadlines and failover on timeouts, connection errors, 502 and 504", () => {
  it("fails over from a stalled provider within the attempt timeout and holds the stalled attempt as unknown", async () => {
    scripts.openai.push({ stall: true });
    const started = Date.now();

    const result = await asPlanner(() =>
      client(registry(), { attemptTimeoutMs: 300 }).chat({ tier: "reasoning", messages: MESSAGES }),
    );

    expect(result.metadata.providerId).toBe("groq");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ledger().map((r) => `${r.provider}:${r.status}`)).toEqual(["openai:unknown", "groq:committed"]);
    const stalled = ledger()[0];
    // Held at the full reservation until it ages out.
    expect(stalled.reserved_micro_usd).toBeGreaterThan(0);
    expect(hits).toEqual({ openai: 1, groq: 1 });
  });

  it("gives up at the call deadline instead of waiting on a stalled provider", async () => {
    process.env.GROQ_API_KEY = "";
    scripts.openai.push({ stall: true });
    const started = Date.now();

    const error = await asPlanner(() =>
      client(registry(), { deadlineMs: { planner: 400 } }).chat({ tier: "reasoning", messages: MESSAGES }),
    ).catch((e) => e);

    expect(error).toMatchObject({ name: "InferenceCallError" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ledger().map((r) => r.status)).toEqual(["unknown"]);
  });

  it.each([502, 504])("fails over on %s and releases the failed attempt", async (status) => {
    scripts.openai.push({ status });

    const result = await asPlanner(() => client().chat({ tier: "reasoning", messages: MESSAGES }));

    expect(result.metadata.providerId).toBe("groq");
    expect(hits).toEqual({ openai: 1, groq: 1 });
    expect(ledger().map((r) => `${r.provider}:${r.status}`)).toEqual(["openai:released", "groq:committed"]);
  });

  it("fails over when the provider refuses the connection", async () => {
    const dead = await closedPort();
    const reg = registry({ openai: `http://127.0.0.1:${dead}/openai/v1` });

    const result = await asPlanner(() => client(reg).chat({ tier: "reasoning", messages: MESSAGES }));

    expect(result.metadata.providerId).toBe("groq");
    expect(ledger().map((r) => `${r.provider}:${r.status}`)).toEqual(["openai:released", "groq:committed"]);
  });

  it("sends nothing when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      asPlanner(() => client().chat({ tier: "reasoning", messages: MESSAGES, signal: controller.signal })),
    ).rejects.toThrow();
    expect(hits).toEqual({ openai: 0, groq: 0 });
    expect(ledger()).toEqual([]);
  });
});

describe("F133: survival tier comes from the gate", () => {
  it("normal tier steps the planner down to the fast tier", async () => {
    gate.setSurvival({ tier: "normal", creditsCents: 200 });
    const result = await asPlanner(() => client().chat({ tier: "reasoning", messages: MESSAGES }));
    expect(result.metadata.providerId).toBe("groq");
    expect(result.metadata.modelId).toBe("llama-3.3-70b-versatile");
  });

  it("low_compute pauses orchestration with no request sent", async () => {
    gate.setSurvival({ tier: "low_compute", creditsCents: 30 });
    await expect(
      asPlanner(() => client().chat({ tier: "reasoning", messages: MESSAGES })),
    ).rejects.toMatchObject({ code: "SURVIVAL_TIER" });
    expect(hits).toEqual({ openai: 0, groq: 0 });
  });

  it("the old AUTOMATON_CREDITS_BALANCE env var has no effect", async () => {
    process.env.AUTOMATON_CREDITS_BALANCE = "30";
    const result = await asPlanner(() => client().chat({ tier: "reasoning", messages: MESSAGES }));
    expect(result.metadata.modelId).toBe("gpt-4.1");
  });
});

describe("F127: no placeholder keys", () => {
  it("never contacts groq without a key and serves the fast tier from openai", async () => {
    delete process.env.GROQ_API_KEY;
    const result = await runWithInferenceScope({ caller: "worker", taskId: "t1" }, () =>
      client().chat({ tier: "fast", messages: MESSAGES }),
    );
    expect(result.metadata.providerId).toBe("openai");
    expect(result.metadata.modelId).toBe("gpt-4.1-mini");
    expect(hits.groq).toBe(0);
  });
});

describe("F132: the circuit breaker counts provider health only", () => {
  it("five caller 400s leave the provider active", async () => {
    delete process.env.GROQ_API_KEY;
    for (let i = 0; i < 5; i++) scripts.openai.push({ status: 400 });
    // One client, as within a wake cycle.
    const c = client();
    for (let i = 0; i < 5; i++) {
      await expect(asPlanner(() => c.chat({ tier: "reasoning", messages: MESSAGES }))).rejects.toThrow();
    }
    const result = await asPlanner(() => c.chat({ tier: "reasoning", messages: MESSAGES }));
    expect(result.metadata.providerId).toBe("openai");
    expect(hits.openai).toBe(6);
  });

  it("five 503s open the breaker, and a new client (next wake cycle) still skips the provider", async () => {
    delete process.env.GROQ_API_KEY;
    for (let i = 0; i < 6; i++) scripts.openai.push({ status: 503 });
    const c = client();
    for (let i = 0; i < 3; i++) {
      await expect(asPlanner(() => c.chat({ tier: "reasoning", messages: MESSAGES }))).rejects.toThrow();
    }
    // Attempts 1-2, 3-4, then the 5th failure opens the breaker: no retry after it.
    expect(hits.openai).toBe(5);

    process.env.GROQ_API_KEY = "gsk-test-groq";
    const result = await asPlanner(() => client(registry()).chat({ tier: "reasoning", messages: MESSAGES }));
    expect(result.metadata.providerId).toBe("groq");
    expect(hits.openai).toBe(5);
  });
});

describe("concurrency: worst-case reservations prevent overshoot", () => {
  it("lets exactly three of five concurrent 3c worker calls through a 10c hourly cap", async () => {
    installGate({ hourlyCapCents: 10 });
    delete process.env.GROQ_API_KEY;
    for (let i = 0; i < 5; i++) scripts.openai.push({ delayMs: 200, usage: { prompt_tokens: 10, completion_tokens: 100 } });

    const calls = Array.from({ length: 5 }, (_, i) =>
      runWithInferenceScope({ caller: "worker", taskId: `task-${i}` }, () =>
        // gpt-4.1: 3700 output tokens * $8/M is just under 3c of worst case.
        client().chat({ tier: "reasoning", purpose: "worker_turn", maxTokens: 3700, messages: MESSAGES }),
      ),
    );
    const settled = await Promise.allSettled(calls);

    const ok = settled.filter((s) => s.status === "fulfilled");
    const refused = settled.filter((s) => s.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      // Worker spend is orchestration class; with a 100% share its hourly share is the cap.
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "ORCHESTRATION_SHARE" });
    }
    expect(hits.openai).toBe(3);
    const committed = ledger().reduce((sum, r) => sum + (r.cost_micro_usd ?? 0), 0);
    expect(committed).toBeLessThanOrEqual(10 * 10_000);
  });
});

describe("streaming", () => {
  it("asks for usage in the stream and commits at it", async () => {
    scripts.openai.push({ stream: true, usage: { prompt_tokens: 1000, completion_tokens: 500 } });
    const result = await asPlanner(() => client().chat({ tier: "reasoning", messages: MESSAGES, stream: true }));
    expect(result.content).toBe("streamed");
    expect(bodies.openai[0].stream_options).toEqual({ include_usage: true });
    // 1000 * 2 + 500 * 8 = 6000 micro-USD
    expect(ledger()).toEqual([expect.objectContaining({ status: "committed", cost_micro_usd: 6000 })]);
  });
});
