/**
 * Model discovery per provider kind with mocked HTTP (an injected fetch, and
 * one loopback server), failure handling (the registry is never touched on
 * a failed read), the KV status row, and the once-a-day cache.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestConfig } from "./mocks.js";
import { createDatabase } from "../state/database.js";
import { ModelRegistry } from "../inference/registry.js";
import { StructuredLogger } from "../observability/logger.js";
import type { AutomatonConfig, AutomatonDatabase, LogEntry } from "../types.js";
import { resolveProviderTable, type ProviderTable } from "../providers/table.js";
import { runWithCancellation } from "../runtime/cancellation.js";
import {
  DISCOVERY_FAILURE_TTL_MS,
  DISCOVERY_SUCCESS_TTL_MS,
  MAX_DISCOVERY_BODY_BYTES,
  discoverProviderModels,
  readDiscoveryStatus,
  refreshProviderModels,
} from "../providers/discovery.js";

const OPENAI_KEY = "sk-discovery-openai-0123456789";
const ANTHROPIC_KEY = "sk-ant-discovery-0123456789";
const OR_KEY = "sk-or-discovery-0123456789";

let tmp: string;
let db: AutomatonDatabase;
const logs: LogEntry[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-discovery-"));
  db = createDatabase(path.join(tmp, "state.db"));
  StructuredLogger.setSink((e) => logs.push(e));
});

afterEach(() => {
  StructuredLogger.resetSink();
  logs.length = 0;
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function standalone(over: Partial<AutomatonConfig> = {}): AutomatonConfig {
  return createTestConfig({
    conwayApiKey: undefined as unknown as string,
    ...over,
    providers: { mode: "standalone", ...(over.providers ?? {}) },
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch stub answering by URL; records every call. */
function stubFetch(route: (url: string, init: RequestInit) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers });
    return route(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function compatibleTable(over: Record<string, unknown> = {}): ProviderTable {
  return resolveProviderTable(
    standalone({ providers: { compatible: [{ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: OR_KEY, ...over }] } }),
    {},
  );
}

describe("discoverProviderModels: shapes", () => {
  it("OpenAI: GET {baseUrl}/models with a Bearer key, {data:[...]}", async () => {
    const t = resolveProviderTable(standalone({ openaiApiKey: OPENAI_KEY }), {});
    const { fetchImpl, calls } = stubFetch(() => json({ object: "list", data: [{ id: "gpt-5.2" }, { id: "gpt-9-new" }] }));
    const r = await discoverProviderModels(t.get("openai")!, t.key("openai"), { fetchImpl });
    expect(r).toEqual({ ok: true, providerId: "openai", models: [{ remoteId: "gpt-5.2" }, { remoteId: "gpt-9-new" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/models");
    expect(calls[0].headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it("a bare array (Together), with USD-per-M prices and context length", async () => {
    const t = resolveProviderTable(
      standalone({ providers: { compatible: [{ id: "together", baseUrl: "https://api.together.xyz/v1", apiKey: "tg-0123456789abcdef" }] } }),
      {},
    );
    const { fetchImpl } = stubFetch(() =>
      json([{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", context_length: 131072, pricing: { input: 0.88, output: 0.88 } }]),
    );
    const r = await discoverProviderModels(t.get("together")!, t.key("together"), { fetchImpl });
    expect(r.ok && r.models).toEqual([
      {
        remoteId: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        contextWindow: 131072,
        listedPrice: { inputUsdPerM: 0.88, outputUsdPerM: 0.88 },
      },
    ]);
  });

  it("a listing in USD per token under input/output is not read as USD per M: the model is left unpriced", async () => {
    const t = resolveProviderTable(
      standalone({ providers: { compatible: [{ id: "gw", baseUrl: "https://gateway.example.com/v1", apiKey: "gw-0123456789abcdef" }] } }),
      {},
    );
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.initialize();
    const { fetchImpl } = stubFetch(() =>
      json({
        data: [
          { id: "anthropic/claude-opus-5-5", pricing: { input: "0.000004", output: "0.00002" } },
          // One side plausible, the other not: still unpriced.
          { id: "half/priced", pricing: { input: "0.5", output: "0.000001" } },
          { id: "cheap/real", pricing: { input: "0.02", output: "0.05" } },
        ],
      }),
    );
    const r = await discoverProviderModels(t.get("gw")!, t.key("gw"), { fetchImpl });
    expect(r.ok && r.models.map((m) => m.listedPrice)).toEqual([
      undefined,
      { inputUsdPerM: 0.5, outputUsdPerM: 0 },
      { inputUsdPerM: 0.02, outputUsdPerM: 0.05 },
    ]);
    await refreshProviderModels(t, reg, db, { fetchImpl, force: true });
    for (const id of ["gw/anthropic/claude-opus-5-5", "gw/half/priced"]) {
      expect(reg.get(id)).toMatchObject({ costPer1kInput: 0, costPer1kOutput: 0, priceSource: null });
    }
    expect(reg.get("gw/cheap/real")).toMatchObject({ costPer1kInput: 0.2, costPer1kOutput: 0.5, priceSource: "listed" });
  });

  it("OpenRouter per-token price strings become USD per M; a request fee and tool support are read", async () => {
    const t = compatibleTable();
    const { fetchImpl } = stubFetch(() =>
      json({
        data: [
          {
            id: "anthropic/claude-opus-5-5",
            name: "Claude Opus 5.5",
            context_length: 1000000,
            pricing: { prompt: "0.000004", completion: "0.00002", request: "0" },
            top_provider: { max_completion_tokens: 128000 },
            supported_parameters: ["tools", "max_tokens"],
          },
          { id: "perplexity/sonar", pricing: { prompt: "0.000001", completion: "0.000001", request: "0.005" }, supported_parameters: ["max_tokens"] },
          { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        ],
      }),
    );
    const r = await discoverProviderModels(t.get("openrouter")!, t.key("openrouter"), { fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.models[0]).toEqual({
      remoteId: "anthropic/claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      listedPrice: { inputUsdPerM: 4, outputUsdPerM: 20 },
    });
    expect(r.models[0].listedPrice!.inputUsdPerM).toBeCloseTo(4, 10);
    expect(r.models[1].listedPrice).toEqual({ inputUsdPerM: 1, outputUsdPerM: 1, requestFeeUsd: 0.005 });
    expect(r.models[1].supportsTools).toBe(false);
    expect(r.models[2].listedPrice).toBeUndefined();
  });

  it("Anthropic: two pages followed by after_id, x-api-key and anthropic-version headers, the key never in the URL", async () => {
    const t = resolveProviderTable(standalone({ anthropicApiKey: ANTHROPIC_KEY }), {});
    const { fetchImpl, calls } = stubFetch((url) =>
      url.includes("after_id=")
        ? json({ data: [{ id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200000, max_tokens: 64000 }], has_more: false, last_id: "claude-haiku-4-5-20251001" })
        : json({
            data: [
              {
                id: "claude-opus-5-5",
                display_name: "Claude Opus 5.5",
                max_input_tokens: 1000000,
                max_tokens: 128000,
                capabilities: {
                  thinking: { supported: true, types: { adaptive: { supported: true } } },
                  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
                },
              },
            ],
            has_more: true,
            first_id: "claude-opus-5-5",
            last_id: "claude-opus-5-5",
          }),
    );
    const r = await discoverProviderModels(t.get("anthropic")!, t.key("anthropic"), { fetchImpl });
    expect(r.ok && r.models.map((m) => m.remoteId)).toEqual(["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
    expect(r.ok && r.models[0]).toMatchObject({
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      capabilities: { effort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5",
    ]);
    for (const c of calls) {
      expect(c.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
      expect(c.headers["anthropic-version"]).toBe("2023-06-01");
      expect(c.headers.authorization).toBeUndefined();
      expect(c.url).not.toContain(ANTHROPIC_KEY);
    }
  });

  it("a keyless loopback server gets no Authorization header (real HTTP on 127.0.0.1)", async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "qwen2.5-7b", max_model_len: 32768 }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const t = resolveProviderTable(
        standalone({ providers: { compatible: [{ id: "vllm", baseUrl: `http://127.0.0.1:${port}/v1`, free: true }] } }),
        {},
      );
      const r = await discoverProviderModels(t.get("vllm")!, t.key("vllm"));
      expect(r).toEqual({ ok: true, providerId: "vllm", models: [{ remoteId: "qwen2.5-7b", contextWindow: 32768 }] });
      expect(seen).toEqual([undefined]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("Ollama: reads /api/tags", async () => {
    const t = resolveProviderTable(standalone({ ollamaBaseUrl: "http://localhost:11434" }), {});
    const { fetchImpl, calls } = stubFetch(() => json({ models: [{ name: "llama3.2:latest" }, { name: "qwen3:8b" }] }));
    const r = await discoverProviderModels(t.get("ollama")!, undefined, { fetchImpl });
    expect(r.ok && r.models.map((m) => m.remoteId)).toEqual(["llama3.2:latest", "qwen3:8b"]);
    expect(calls[0].url).toBe("http://localhost:11434/api/tags");
  });
});

describe("refreshProviderModels: failures leave the registry alone", () => {
  /** A registry holding one discovered openrouter model, listed. */
  async function seeded(): Promise<{ t: ProviderTable; reg: ModelRegistry }> {
    const t = compatibleTable();
    const reg = new ModelRegistry(db.raw, { table: t });
    const { fetchImpl } = stubFetch(() => json({ data: [{ id: "a/model", pricing: { prompt: "0.000001", completion: "0.000002" } }] }));
    await refreshProviderModels(t, reg, db, { fetchImpl, force: true });
    expect(reg.get("openrouter/a/model")).toMatchObject({ listed: true, costPer1kInput: 10, costPer1kOutput: 20 });
    logs.length = 0;
    return { t, reg };
  }

  const cases: Array<[string, () => Response | Promise<Response>, RegExp, number?]> = [
    ["401", () => json({ error: "bad key" }, 401), /provider openrouter rejected its key/, 401],
    ["403", () => json({ error: "forbidden" }, 403), /provider openrouter rejected its key/, 403],
    ["500 (after retries)", () => json({ error: "boom" }, 500), /HTTP 500/, 500],
    ["invalid JSON", () => new Response("{not json", { status: 200 }), /not valid JSON/],
    ["no list", () => json({ object: "list" }), /no model list/],
    ["more than 2000 models", () => json({ data: Array.from({ length: 2001 }, (_, i) => ({ id: `m${i}` })) }), /more than 2000/],
    [
      "a declared body over the cap",
      () => new Response("{}", { status: 200, headers: { "content-length": String(MAX_DISCOVERY_BODY_BYTES + 1) } }),
      /larger than/,
    ],
    [
      "a streamed body over the cap",
      () => {
        const chunk = new Uint8Array(1024 * 1024).fill(0x20);
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent++ > 9) controller.close();
              else controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        );
      },
      /larger than/,
    ],
  ];

  for (const [what, respond, message, status] of cases) {
    it(`${what}: rows and listed state unchanged, KV status written, one warning`, async () => {
      const { t, reg } = await seeded();
      const before = reg.getAll();
      const { fetchImpl, calls } = stubFetch(respond);
      const [r] = await refreshProviderModels(t, reg, db, { fetchImpl, force: true, retryDelayMs: 0 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(message);
        if (status) expect(r.status).toBe(status);
      }
      expect(reg.getAll()).toEqual(before);
      const kv = readDiscoveryStatus(db, "openrouter")!;
      expect(kv.ok).toBe(false);
      expect(kv.error).toMatch(message);
      expect(kv.count).toBe(1);
      expect(kv.lastSuccessAt).toBeTypeOf("number");
      const warnings = logs.filter((l) => l.level === "warn" && l.message.includes("openrouter"));
      expect(warnings).toHaveLength(1);
      // Retryable failures are tried three times in all; the rest once.
      expect(calls).toHaveLength(status === 500 ? 3 : 1);
    });
  }

  it("a timeout: rows unchanged, status written", async () => {
    const { t, reg } = await seeded();
    const before = reg.getAll();
    const hang = ((_u: any, init: RequestInit = {}) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as typeof fetch;
    const [r] = await refreshProviderModels(t, reg, db, { fetchImpl: hang, force: true, timeoutMs: 20, retryDelayMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timed out/);
    expect(reg.getAll()).toEqual(before);
    expect(readDiscoveryStatus(db, "openrouter")?.ok).toBe(false);
  });

  it("a failure after the base URL changed unlists the rows the old endpoint listed", async () => {
    const { reg } = await seeded();
    const moved = compatibleTable({ baseUrl: "https://other-gateway.example/v1" });
    const movedReg = new ModelRegistry(db.raw, { table: moved });
    movedReg.initialize();
    expect(reg.get("openrouter/a/model")?.listed).toBe(true);
    const { fetchImpl } = stubFetch(() => json({ error: "no such route" }, 404));
    const [r] = await refreshProviderModels(moved, movedReg, db, { fetchImpl, retryDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(movedReg.get("openrouter/a/model")?.listed).toBe(false);
    expect(logs.some((l) => l.level === "warn" && /base URL changed/.test(l.message))).toBe(true);
    // The same URL failing again changes nothing more.
    logs.length = 0;
    await refreshProviderModels(moved, movedReg, db, { fetchImpl, force: true, retryDelayMs: 0 });
    expect(logs.some((l) => /base URL changed/.test(l.message))).toBe(false);
  });

  it("one provider failing does not stop another", async () => {
    const t = resolveProviderTable(
      standalone({
        providers: {
          compatible: [
            { id: "bad", baseUrl: "https://bad.example/v1", apiKey: "bad-key-0123456789" },
            { id: "good", baseUrl: "https://good.example/v1", apiKey: "good-key-0123456789" },
          ],
        },
      }),
      {},
    );
    const reg = new ModelRegistry(db.raw, { table: t });
    const { fetchImpl } = stubFetch((url) => (url.startsWith("https://bad") ? json({}, 401) : json({ data: [{ id: "m" }] })));
    const results = await refreshProviderModels(t, reg, db, { fetchImpl });
    expect(results.map((r) => [r.providerId, r.ok])).toEqual([
      ["bad", false],
      ["good", true],
    ]);
    expect(reg.get("good/m")).toBeDefined();
  });
});

describe("refreshProviderModels: what is asked, and when", () => {
  it("asks once a day after a success, once an hour after a failure, at once when the URL changes; force skips the cache", async () => {
    let now = Date.UTC(2026, 10, 1);
    const clock = () => now;
    let fail = false;
    const { fetchImpl, calls } = stubFetch(() => (fail ? json({}, 404) : json({ data: [{ id: "m" }] })));
    const t = compatibleTable();
    const reg = new ModelRegistry(db.raw, { table: t });
    const run = (table = t, force = false) => refreshProviderModels(table, reg, db, { fetchImpl, now: clock, force });

    await run();
    expect(calls).toHaveLength(1);
    now += DISCOVERY_SUCCESS_TTL_MS - 1;
    await run();
    expect(calls).toHaveLength(1);
    await run(t, true);
    expect(calls).toHaveLength(2);
    now += DISCOVERY_SUCCESS_TTL_MS;
    fail = true;
    await run();
    expect(calls).toHaveLength(3);
    now += DISCOVERY_FAILURE_TTL_MS - 1;
    await run();
    expect(calls).toHaveLength(3);
    now += 1;
    fail = false;
    await run();
    expect(calls).toHaveLength(4);
    // A new base URL is due at once.
    await run(compatibleTable({ baseUrl: "https://openrouter.ai/api/v2" }));
    expect(calls).toHaveLength(5);
    expect(calls[4].url).toBe("https://openrouter.ai/api/v2/models");
  });

  it("Conway mode with no new settings sends no request; a compatible entry or discover: true does", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ data: [] }));
    const plain = resolveProviderTable(
      createTestConfig({ conwayApiKey: "cnwy_k_x", openaiApiKey: OPENAI_KEY, anthropicApiKey: ANTHROPIC_KEY, ollamaBaseUrl: "http://localhost:11434" }),
      {},
    );
    const reg = new ModelRegistry(db.raw, { table: plain });
    expect(await refreshProviderModels(plain, reg, db, { fetchImpl, force: true })).toEqual([]);
    expect(calls).toHaveLength(0);

    const opted = resolveProviderTable(
      createTestConfig({
        conwayApiKey: "cnwy_k_x",
        anthropicApiKey: ANTHROPIC_KEY,
        providers: { anthropic: { discover: true }, compatible: [{ id: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_0123456789abcdef" }] },
      }),
      {},
    );
    await refreshProviderModels(opted, reg, db, { fetchImpl, force: true });
    expect(calls.map((c) => new URL(c.url).hostname).sort()).toEqual(["api.anthropic.com", "api.groq.com"]);
  });

  it("discover: false turns an entry off; a remote entry without a key is never asked", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ data: [] }));
    const t = resolveProviderTable(
      standalone({
        openaiApiKey: OPENAI_KEY,
        providers: {
          openai: { discover: false },
          compatible: [{ id: "nokey", baseUrl: "https://nokey.example/v1" }],
        },
      }),
      {},
    );
    expect(await refreshProviderModels(t, new ModelRegistry(db.raw, { table: t }), db, { fetchImpl, force: true })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("providerIds limits the run", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ data: [] }));
    const t = resolveProviderTable(
      standalone({
        openaiApiKey: OPENAI_KEY,
        providers: { compatible: [{ id: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_0123456789abcdef" }] },
      }),
      {},
    );
    await refreshProviderModels(t, new ModelRegistry(db.raw, { table: t }), db, { fetchImpl, providerIds: ["groq"] });
    expect(calls.map((c) => c.url)).toEqual(["https://api.groq.com/openai/v1/models"]);
  });

  it("records count and the unpriced models a built-in entry did not import", async () => {
    const t = resolveProviderTable(standalone({ openaiApiKey: OPENAI_KEY }), {});
    const reg = new ModelRegistry(db.raw, { table: t });
    reg.initialize();
    const { fetchImpl } = stubFetch(() => json({ data: [{ id: "gpt-5.2" }, { id: "dall-e-3" }, { id: "whisper-1" }] }));
    const [r] = await refreshProviderModels(t, reg, db, { fetchImpl });
    expect(r).toMatchObject({ ok: true, imported: 1, unpricedCount: 2, unpricedSample: ["dall-e-3", "whisper-1"] });
    expect(readDiscoveryStatus(db, "openai")).toMatchObject({ ok: true, count: 3, unpricedCount: 2, unpricedSample: ["dall-e-3", "whisper-1"] });
    expect(reg.get("dall-e-3")).toBeUndefined();
  });
});

describe("refreshProviderModels: heartbeat cancellation", () => {
  const hang = ((_u: any, init: RequestInit = {}) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as typeof fetch;

  it("a cancelled task aborts the request and records nothing; the old endpoint's rows stay listed", async () => {
    const t = compatibleTable();
    const reg = new ModelRegistry(db.raw, { table: t });
    const { fetchImpl } = stubFetch(() => json({ data: [{ id: "a/model" }] }));
    await refreshProviderModels(t, reg, db, { fetchImpl, force: true });
    const statusBefore = readDiscoveryStatus(db, "openrouter");
    // A moved base URL would unlist rows on a real failure; a cancellation must not.
    const moved = compatibleTable({ baseUrl: "https://other-gateway.example/v1" });
    const movedReg = new ModelRegistry(db.raw, { table: moved });
    const controller = new AbortController();
    const run = runWithCancellation(controller.signal, () =>
      refreshProviderModels(moved, movedReg, db, { fetchImpl: hang, force: true, timeoutMs: 60_000, retryDelayMs: 0 }),
    );
    setTimeout(() => controller.abort(Object.assign(new Error("task timed out"), { name: "AbortError" })), 10);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(readDiscoveryStatus(db, "openrouter")).toEqual(statusBefore);
    expect(movedReg.get("openrouter/a/model")?.listed).toBe(true);
  });

  it("the wait between retries ends at cancellation", async () => {
    const t = compatibleTable();
    const reg = new ModelRegistry(db.raw, { table: t });
    const { fetchImpl, calls } = stubFetch(() => json({ error: "busy" }, 503));
    const controller = new AbortController();
    const started = Date.now();
    const run = runWithCancellation(controller.signal, () =>
      refreshProviderModels(t, reg, db, { fetchImpl, force: true, retryDelayMs: 60_000 }),
    );
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(calls).toHaveLength(1);
    expect(readDiscoveryStatus(db, "openrouter")).toBeUndefined();
  });

  it("an Ollama read is aborted with its task", async () => {
    const t = resolveProviderTable(standalone({ ollamaBaseUrl: "http://localhost:11434" }), {});
    const controller = new AbortController();
    const run = runWithCancellation(controller.signal, () =>
      discoverProviderModels(t.get("ollama")!, undefined, { fetchImpl: hang, timeoutMs: 60_000 }),
    );
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  it("outside a task scope a timeout is still a recorded provider failure", async () => {
    const t = compatibleTable();
    const reg = new ModelRegistry(db.raw, { table: t });
    const [r] = await refreshProviderModels(t, reg, db, { fetchImpl: hang, force: true, timeoutMs: 20, retryDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(readDiscoveryStatus(db, "openrouter")?.ok).toBe(false);
  });
});
