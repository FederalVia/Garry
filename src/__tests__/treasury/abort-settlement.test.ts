/**
 * Ledger settlement of paid calls aborted by a heartbeat task's
 * cancellation: released only when nothing can have left, unknown when the
 * request may have been sent. A task timeout does not abort a paid request
 * that was already sent (it would only make the outcome unknown); shutdown
 * does. Real Treasury, ledger, Conway client, x402 and inference gate;
 * fetch is stubbed or a loopback server. No network.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.mock("../../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 1000) };
});

import { createConwayClient } from "../../conway/client.js";
import { resetX402HttpClientForTests } from "../../conway/x402.js";
import { topupCredits } from "../../conway/topup.js";
import { DurableScheduler } from "../../heartbeat/scheduler.js";
import { BUILTIN_TASKS } from "../../heartbeat/tasks.js";
import {
  UnifiedInferenceClient,
  resetProviderCircuitBreakers,
} from "../../inference/inference-client.js";
import { ProviderRegistry } from "../../inference/provider-registry.js";
import {
  InferenceGate,
  installInferenceGate,
  resetInferenceGateForTests,
  runWithInferenceScope,
} from "../../inference/gate.js";
import { TaskAbortedError, runWithCancellation } from "../../runtime/cancellation.js";
import { createDatabase, getHeartbeatSchedule, upsertHeartbeatSchedule } from "../../state/database.js";
import { installTreasury, listLedgerRows, resetTreasuryForTests } from "../../treasury/index.js";
import type { AutomatonDatabase, TickContext } from "../../types.js";
import { createTestConfig, createTestIdentity } from "../mocks.js";
import { CHILD_ADDRESS, PAY_TO, USDC_BASE, deferred, makeHarness, type Harness } from "./harness.js";

const API = "https://api.conway.tech";

let open: Harness[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const h of open) h.close();
  open = [];
  resetTreasuryForTests();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that never answers and rejects when its signal aborts, as Node's does. */
function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const fail = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Answers with `answer` unless the request's signal aborts first, as Node's fetch does. */
function answerUnlessAborted(init: RequestInit | undefined, answer: Promise<Response>): Promise<Response> {
  return Promise.race([answer, hangUntilAborted(init)]);
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A run scope as the scheduler builds it: per-run signal, shutdown root. */
function scope() {
  const root = new AbortController();
  const run = new AbortController();
  root.signal.addEventListener("abort", () => run.abort(root.signal.reason), { once: true });
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return runWithCancellation(run.signal, fn, { shutdownSignal: root.signal, state: { shielded: 0 } });
    },
    timeout: () => run.abort(new TaskAbortedError("timeout", "cancelled: timed out")),
    shutdown: () => root.abort(new TaskAbortedError("shutdown", "cancelled: runtime shutdown")),
  };
}

// ─── Guarded credit transfer ────────────────────────────────────

describe("guarded transferCredits", () => {
  function setup(onTransfer: (init: RequestInit | undefined) => Promise<Response> | Response) {
    const h = makeHarness({ balance: 100_000, install: false });
    open.push(h);
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers: (init?.headers ?? {}) as Record<string, string> });
        if (new URL(url).pathname === "/v1/credits/transfer") return onTransfer(init);
        throw new Error(`unexpected request ${url}`);
      }),
    );
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });
    return { h, client, calls };
  }

  it("aborted after the reservation and before sending: released, nothing sent", async () => {
    const { h, client, calls } = setup(() => json(200, { transfer_id: "t-1", status: "completed" }));
    const balanceGate = deferred();
    h.inner.gates.balance = balanceGate.promise;
    const s = scope();
    const transfer = s.run(() => client.transferCredits(CHILD_ADDRESS, 300)).catch((e) => e);
    // The gate is reading the balance for the reservation; the task times out.
    await vi.waitFor(() => expect(h.inner.balanceReads).toBeGreaterThan(0));
    s.timeout();
    balanceGate.resolve();

    const err = await transfer;
    expect(err).toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
    expect(listLedgerRows(h.raw, { budget: "transfer" }).map((r) => r.status)).toEqual(["released"]);
  });

  it("shutdown while the transfer is in flight: unknown, held at the reserved amount", async () => {
    const { h, client, calls } = setup((init) => hangUntilAborted(init));
    const s = scope();
    const transfer = s.run(() => client.transferCredits(CHILD_ADDRESS, 300)).catch((e) => e);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    s.shutdown();

    const err = await transfer;
    expect(err).toBeInstanceOf(Error);
    const rows = listLedgerRows(h.raw, { budget: "transfer" });
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(rows[0].amount_cents).toBe(300);
    expect(calls).toHaveLength(1);
  });

  it("a task timeout while the transfer is in flight lets it finish and commit", async () => {
    const answer = deferred<Response>();
    const { h, client, calls } = setup((init) => answerUnlessAborted(init, answer.promise));
    const s = scope();
    const transfer = s.run(() => client.transferCredits(CHILD_ADDRESS, 300));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    s.timeout();
    await new Promise((r) => setTimeout(r, 50));
    answer.resolve(json(200, { transfer_id: "t-1", status: "completed", amount_cents: 300 }));

    await expect(transfer).resolves.toMatchObject({ transferId: "t-1" });
    expect(listLedgerRows(h.raw, { budget: "transfer" }).map((r) => r.status)).toEqual(["committed"]);
  });
});

// ─── x402 topup ─────────────────────────────────────────────────

interface Paywall {
  calls: Call[];
  payments: Array<{ nonce: string }>;
  probe: (init: RequestInit | undefined) => Promise<Response> | Response;
  paid: (init: RequestInit | undefined) => Promise<Response> | Response;
}

function offer402(url: string): Response {
  const m = /\/pay\/(\d+)\//.exec(url);
  return json(402, {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        maxAmountRequired: m ? String(BigInt(m[1]) * 1_000_000n) : "1000000",
        payTo: PAY_TO,
        asset: USDC_BASE,
      },
    ],
  });
}

function usdcSetup() {
  const account = privateKeyToAccount(generatePrivateKey());
  const h = makeHarness({ balance: 0, install: false, readAuthorizationState: async () => null });
  open.push(h);
  installTreasury(h.newTreasury({ selfAddress: account.address }));
  const paywall: Paywall = {
    calls: [],
    payments: [],
    probe: () => {
      throw new Error("probe not set");
    },
    paid: () => json(200, { credits_cents: 500 }),
  };
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    paywall.calls.push({ url, method: init?.method ?? "GET", headers });
    if (headers["X-Payment"]) {
      const payment = JSON.parse(Buffer.from(headers["X-Payment"], "base64").toString("utf-8"));
      paywall.payments.push({ nonce: payment.payload.authorization.nonce });
      return paywall.paid(init);
    }
    return paywall.probe(init);
  });
  resetX402HttpClientForTests();
  const rows = () => listLedgerRows(h.raw, { budget: "topup_auto" });
  return { account, h, paywall, rows };
}

describe("x402 topup", () => {
  const buy = (account: ReturnType<typeof privateKeyToAccount>) =>
    topupCredits(API, account, 5, undefined, { topupPurpose: "survival" });

  it("aborted after the 402 and before markSent: released, no payment sent", async () => {
    const u = usdcSetup();
    const s = scope();
    u.paywall.probe = () => {
      // The task times out while the 402 comes back.
      s.timeout();
      return offer402(`${API}/pay/5/x`);
    };
    const result = await s.run(() => buy(u.account));
    expect(result.success).toBe(false);
    expect(u.paywall.payments).toHaveLength(0);
    expect(u.rows().map((r) => r.status)).toEqual(["released"]);
  });

  it("aborted by shutdown during the paid request: unknown, nonce kept", async () => {
    const u = usdcSetup();
    const s = scope();
    u.paywall.probe = () => offer402(`${API}/pay/5/x`);
    u.paywall.paid = (init) => hangUntilAborted(init);
    const result = s.run(() => buy(u.account));
    await vi.waitFor(() => expect(u.paywall.payments).toHaveLength(1));
    s.shutdown();

    expect((await result).success).toBe(false);
    const rows = u.rows();
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(rows[0].x402_nonce).toBe(u.paywall.payments[0].nonce);
  });

  it("a task timeout during the paid request does not abort it: committed", async () => {
    const u = usdcSetup();
    const s = scope();
    const answer = deferred<Response>();
    u.paywall.probe = () => offer402(`${API}/pay/5/x`);
    u.paywall.paid = (init) => answerUnlessAborted(init, answer.promise);
    const result = s.run(() => buy(u.account));
    await vi.waitFor(() => expect(u.paywall.payments).toHaveLength(1));
    s.timeout();
    await new Promise((r) => setTimeout(r, 50));
    answer.resolve(json(200, { credits_cents: 500 }));

    expect((await result).success).toBe(true);
    expect(u.rows().map((r) => r.status)).toEqual(["committed"]);
  });

  it("check_usdc_balance under the scheduler: a slow paid request outlives the task timeout and commits", async () => {
    const u = usdcSetup();
    u.paywall.probe = () => offer402(`${API}/pay/5/x`);
    u.paywall.paid = (init) =>
      answerUnlessAborted(
        init,
        new Promise((r) => setTimeout(() => r(json(200, { credits_cents: 500 })), 600)),
      );
    upsertHeartbeatSchedule(u.h.raw, {
      taskName: "check_usdc_balance",
      cronExpression: "* * * * *",
      intervalMs: null,
      enabled: 1,
      priority: 0,
      timeoutMs: 100,
      maxRetries: 0,
      tierMinimum: "dead",
      lastRunAt: null,
      nextRunAt: null,
      lastResult: null,
      lastError: null,
      runCount: 0,
      failCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const identity = { ...createTestIdentity(), address: u.account.address, account: u.account };
    const sched = new DurableScheduler(
      u.h.raw,
      { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
      new Map([["check_usdc_balance", BUILTIN_TASKS.check_usdc_balance]]),
      { identity, config: createTestConfig(), db: u.h.db, conway: u.h.inner },
    );
    const tick: TickContext = {
      tickId: "t",
      startedAt: new Date(),
      creditBalance: 0,
      usdcBalance: 10,
      creditRead: { known: true, value: 0, at: new Date().toISOString() },
      usdcRead: { known: true, value: 10, at: new Date().toISOString() },
      survivalTier: "critical",
      survivalTierKnown: true,
      lowComputeMultiplier: 4,
      config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
      db: u.h.raw,
    };

    await sched.executeTask("check_usdc_balance", tick);
    expect(u.paywall.payments).toHaveLength(1);
    expect(u.rows().map((r) => r.status)).toEqual(["committed"]);
    const row = getHeartbeatSchedule(u.h.raw).find((r) => r.taskName === "check_usdc_balance")!;
    expect(row.lastResult).toBe("timeout");
    expect(row.leaseOwner).toBeNull();
  });
});

// ─── Inference ──────────────────────────────────────────────────

describe("inference inside a task scope", () => {
  const ORIGINAL_ENV = { ...process.env };
  let server: http.Server;
  let port: number;
  let hits: Record<string, number>;
  let tmpDir: string;
  let db: AutomatonDatabase;

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, OPENAI_API_KEY: "sk-test-openai", GROQ_API_KEY: "gsk-test-groq" };
    delete process.env.TOGETHER_API_KEY;
    hits = { openai: 0, groq: 0 };
    resetProviderCircuitBreakers();
    // Every provider reads the request and never answers.
    server = http.createServer((req) => {
      const provider = (req.url ?? "").split("/")[1];
      req.resume();
      req.on("end", () => {
        hits[provider] = (hits[provider] ?? 0) + 1;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abort-inference-"));
    db = createDatabase(path.join(tmpDir, "state.db"));
    const gate = new InferenceGate({
      db: db.raw,
      policy: {
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
      },
    });
    gate.setSurvival({ tier: "high", creditsCents: 100_000 });
    installInferenceGate(gate);
  });

  afterEach(async () => {
    resetInferenceGateForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  it("an ambient-only abort of a sent call: one unknown row, no failover", async () => {
    const reg = ProviderRegistry.fromConfig(path.join(tmpDir, "no-providers.json"));
    reg.overrideBaseUrl("openai", `http://127.0.0.1:${port}/openai/v1`);
    reg.overrideBaseUrl("groq", `http://127.0.0.1:${port}/groq/v1`);
    const client = new UnifiedInferenceClient(reg, { sleep: async () => {} });
    const s = scope();

    const call = s
      .run(() =>
        runWithInferenceScope({ caller: "orchestrator.plan" }, () =>
          client.chat({ tier: "reasoning", messages: [{ role: "user", content: "plan" }] }),
        ),
      )
      .catch((e) => e);
    await vi.waitFor(() => expect(hits.openai).toBe(1));
    s.timeout();

    const err = await call;
    expect(err).toBeInstanceOf(Error);
    await new Promise((r) => setTimeout(r, 100));
    expect(hits).toEqual({ openai: 1, groq: 0 });
    const rows = db.raw.prepare("SELECT provider, status FROM inference_ledger").all();
    expect(rows).toEqual([{ provider: "openai", status: "unknown" }]);
  });
});
