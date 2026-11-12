/**
 * Legacy client: honours the router's deadline, never resends a billable
 * POST, records ambiguous attempts, and refuses to send without a gate
 * reservation.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../state/database.js";
import type { AgentTurn, AutomatonDatabase } from "../../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../../types.js";
import { ModelRegistry } from "../../inference/registry.js";
import { InferenceRouter } from "../../inference/router.js";
import { InferenceGate, installInferenceGate, resetInferenceGateForTests } from "../../inference/gate.js";
import { resolveInferencePolicy } from "../../inference/policy.js";
import { InferenceCallError, InferenceRefusedError } from "../../inference/errors.js";
import { createInferenceClient } from "../../conway/inference.js";
import { summarizeTurns } from "../../agent/context.js";

type Mode = "ok" | "stall" | "headers-stall" | "trickle" | "500" | "500-once";

let server: http.Server;
let base: string;
let posts: number;
let mode: Mode;
let tmp: string;
let db: AutomatonDatabase;
let gate: InferenceGate;

beforeEach(async () => {
  posts = 0;
  mode = "ok";
  server = http.createServer((req, res) => {
    // Counted on arrival: an abort can cut the body short, but the POST was sent.
    posts++;
    req.resume();
    req.on("end", () => {
      if (mode === "stall") return; // never answers
      if (mode === "headers-stall" || mode === "trickle") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        if (mode === "trickle") {
          const t = setInterval(() => res.write(" "), 100);
          res.on("close", () => clearInterval(t));
        }
        return;
      }
      if (mode === "500" || (mode === "500-once" && posts === 1)) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-deadline-"));
  db = createDatabase(path.join(tmp, "state.db"));
  gate = new InferenceGate({
    db: db.raw,
    policy: resolveInferencePolicy({}, { maxInferenceDailyCents: 50_000 }),
  });
  gate.setSurvival({ tier: "high", creditsCents: 100_000 });
  installInferenceGate(gate);
});

afterEach(async () => {
  resetInferenceGateForTests();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function client() {
  // Loopback HTTP is allowed because the Ollama URL is loopback; the Conway
  // backend serves the gpt models here.
  return createInferenceClient({
    apiUrl: `${base}/conway`,
    apiKey: "conway-key",
    defaultModel: "gpt-5.2",
    maxTokens: 4096,
    ollamaBaseUrl: `${base}/ollama`,
  });
}

function router(deadlineMs?: number, fallback = true) {
  const registry = new ModelRegistry(db.raw);
  registry.initialize();
  const strategy = { ...DEFAULT_MODEL_STRATEGY_CONFIG, enableModelFallback: fallback };
  return new InferenceRouter(db.raw, registry, gate, () => strategy, { deadlineMs, sleep: async () => {} });
}

const rows = () =>
  db.raw.prepare("SELECT model, status, error_class FROM inference_ledger ORDER BY rowid").all() as any[];

function reserve(): string {
  return gate.reserve({
    callId: `c-${Math.random()}`,
    attempt: 1,
    provider: "openai",
    model: "gpt-5.2",
    price: { inputUsdPerM: 1.8, outputUsdPerM: 14, local: false },
    estInputTokens: 100,
    maxOutputTokens: 100,
    minOutputTokens: 100,
    scope: { caller: "agent_turn" },
  }).id;
}

describe("deadline (F129)", () => {
  it("aborts a stalled generation at the router's deadline after exactly one POST, held as unknown", async () => {
    mode = "stall";
    const c = client();
    const started = Date.now();
    // Long enough to reach the server under a loaded test run.
    await expect(
      router(1_500).route(
        { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
        (m, o) => c.chat(m, o),
      ),
    ).rejects.toBeInstanceOf(InferenceCallError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(posts).toBe(1);
    expect(rows()).toEqual([{ model: "gpt-5.2", status: "unknown", error_class: "ambiguous" }]);
  });

  for (const bodyMode of ["headers-stall", "trickle"] as const) {
    it(`holds the deadline when the provider sends headers and then a ${bodyMode === "trickle" ? "trickling" : "stalled"} body`, async () => {
      mode = bodyMode;
      const c = client();
      const started = Date.now();
      await expect(
        router(1_500).route(
          { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
          (m, o) => c.chat(m, o),
        ),
      ).rejects.toBeInstanceOf(InferenceCallError);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(posts).toBe(1);
      expect(rows()).toEqual([{ model: "gpt-5.2", status: "unknown", error_class: "ambiguous" }]);
    });
  }

  it("the caller's signal still aborts the legacy client's body read after headers", async () => {
    mode = "trickle";
    const started = Date.now();
    await expect(
      client().chat([{ role: "user", content: "hi" }], { reservationId: reserve(), signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("sends nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client().chat([{ role: "user", content: "hi" }], { reservationId: reserve(), signal: controller.signal })).rejects.toThrow();
    await expect(
      router().route(
        { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s", signal: controller.signal },
        (m, o) => client().chat(m, o),
      ),
    ).rejects.toBeInstanceOf(InferenceCallError);
    expect(posts).toBe(0);
  });

  it("a 500 is retried once by the router: 2 POSTs, not 4", async () => {
    mode = "500-once";
    const c = client();
    const r = await router(undefined, false).route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
      (m, o) => c.chat(m, o),
    );
    expect(r.finishReason).toBe("stop");
    expect(posts).toBe(2);
    expect(rows().map((x) => x.status)).toEqual(["released", "committed"]);
  });

  it("a persistent 500 makes 2 POSTs on a single candidate, never the client's own 4", async () => {
    mode = "500";
    const c = client();
    await expect(
      router(undefined, false).route(
        { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
        (m, o) => c.chat(m, o),
      ),
    ).rejects.toBeInstanceOf(InferenceCallError);
    expect(posts).toBe(2);
  });
});

describe("bypass", () => {
  it("chat without an open reservation throws UNGATED_CALL and sends nothing", async () => {
    const c = client();
    const attempts: Array<Record<string, unknown> | undefined> = [undefined, { reservationId: "made-up" }];
    const settled = reserve();
    gate.commit(settled, { inputTokens: 1, outputTokens: 1 }, 1);
    attempts.push({ reservationId: settled });
    for (const opts of attempts) {
      const err = await c.chat([{ role: "user", content: "hi" }], opts as any).catch((e) => e);
      expect(err).toBeInstanceOf(InferenceRefusedError);
      expect(err.code).toBe("UNGATED_CALL");
    }
    resetInferenceGateForTests();
    const err = await c.chat([{ role: "user", content: "hi" }], { reservationId: reserve() }).catch((e) => e);
    expect(err.code).toBe("UNGATED_CALL");
    expect(posts).toBe(0);
  });

  it("summarizeTurns, which calls the client directly, falls back to raw summaries", async () => {
    const turns: AgentTurn[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      timestamp: new Date().toISOString(),
      state: "running",
      input: "x",
      inputSource: "system",
      thinking: `thought ${i}`,
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costCents: 0,
    }));
    const summary = await summarizeTurns(turns, client());
    expect(summary).toContain("thought 7");
    expect(posts).toBe(0);
  });
});
