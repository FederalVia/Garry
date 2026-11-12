/**
 * Audit reproductions for the credit side, end to end: the real Conway
 * client over a stubbed fetch that behaves like the Conway API, the real
 * tools, executeTool, the default policy rules and SimpleFundingProtocol.
 *
 * Only APIs that predate the treasury are imported statically; the treasury
 * is loaded and installed when present. Each case states what must hold, so
 * on a build without the gate these cases fail the way the audit describes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createConwayClient } from "../../conway/client.js";
import { SimpleFundingProtocol } from "../../orchestration/simple-tracker.js";
import { DEFAULT_TREASURY_POLICY } from "../../types.js";
import type { AutomatonDatabase, ConwayClient, ToolCallResult, TreasuryPolicy } from "../../types.js";
import { MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";

const API = "https://api.conway.tech";
const CHILD = "0x00000000000000000000000000000000000c41d1";
const AUDIT: Partial<TreasuryPolicy> = {
  maxSingleTransferCents: 5000,
  maxHourlyTransferCents: 10000,
  maxDailyTransferCents: 25000,
  minimumReserveCents: 1000,
  maxTransfersPerTurn: 2,
  requireConfirmationAboveCents: 1000,
};

/** A small in-memory Conway API. */
class FakeConway {
  transfers: Array<{ to: string; amount: number; key: string | undefined }> = [];
  sandboxPosts = 0;
  domainPosts = 0;
  transferStatus = "completed";
  failTransfers: number[] = [];
  private heldBalance: Array<() => void> = [];
  private holdBalanceUntil = 0;

  constructor(public balance: number) {}

  /** Hold balance reads until `n` are waiting, then answer them all. */
  holdBalanceReads(n: number): void {
    this.holdBalanceUntil = n;
  }

  async handle(url: string, init: RequestInit = {}): Promise<Response> {
    const { pathname } = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (method === "GET" && pathname === "/v1/credits/balance") {
      if (this.holdBalanceUntil > 0) {
        await new Promise<void>((resolve) => {
          this.heldBalance.push(resolve);
          if (this.heldBalance.length >= this.holdBalanceUntil) {
            this.holdBalanceUntil = 0;
            for (const r of this.heldBalance.splice(0)) r();
          }
        });
      }
      return json(200, { balance_cents: this.balance });
    }
    if (method === "POST" && pathname === "/v1/credits/transfer") {
      const status = this.failTransfers.shift();
      this.transfers.push({ to: body.to_address, amount: body.amount_cents, key: headers["Idempotency-Key"] });
      if (status) return json(status, { error: "upstream" });
      if (this.transferStatus === "completed") this.balance -= body.amount_cents;
      return json(200, {
        transfer_id: `t${this.transfers.length}`,
        status: this.transferStatus,
        amount_cents: body.amount_cents,
        balance_after_cents: this.balance,
      });
    }
    if (method === "GET" && pathname === "/v1/credits/pricing") return json(200, { tiers: [] });
    if (method === "POST" && pathname === "/v1/sandboxes") {
      this.sandboxPosts++;
      return json(201, { id: `sb${this.sandboxPosts}` });
    }
    if (method === "GET" && pathname === "/v1/sandboxes") return json(200, { sandboxes: [] });
    if (method === "GET" && pathname === "/v1/domains/search") {
      return json(200, { results: [{ domain: "test.com", available: true, registration_price: 1200 }] });
    }
    if (method === "POST" && pathname === "/v1/domains/register") {
      this.domainPosts++;
      return json(200, { domain: body.domain, status: "registered" });
    }
    return json(404, { error: `no route ${method} ${pathname}` });
  }

  moved(): number {
    return this.transfers.reduce((n, t) => n + t.amount, 0);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Env {
  db: AutomatonDatabase;
  server: FakeConway;
  conway: ConwayClient;
  tracker: SpendTracker;
  engine: PolicyEngine;
  run(tool: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  vi.unstubAllGlobals();
});

/** Loads the treasury module when this build has one. */
async function loadTreasury(): Promise<any | null> {
  const spec = "../../treasury/index.js";
  try {
    return await import(/* @vite-ignore */ spec);
  } catch {
    return null;
  }
}

async function setup(
  policy: Partial<TreasuryPolicy>,
  balance: number,
  beforeGate?: (tracker: SpendTracker) => void,
): Promise<Env> {
  const db = createTestDb();
  const server = new FakeConway(balance);
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => server.handle(String(url), init)));
  const conway = createConwayClient({ apiUrl: API, apiKey: "test-key", sandboxId: "" });
  const tracker = new SpendTracker(db.raw);
  if (beforeGate) {
    // Spend recorded before the upgrade: as in a database from before schema
    // 12, the ledger does not exist yet, so the gate copies the legacy rows.
    db.raw.exec("DROP TABLE treasury_ledger");
    beforeGate(tracker);
  }
  const full: TreasuryPolicy = { ...DEFAULT_TREASURY_POLICY, ...policy };
  const mod = await loadTreasury();
  if (mod) {
    const treasury = new mod.Treasury({
      db: db.raw,
      policy: mod.normalizeTreasuryPolicy(full),
      selfAddress: createTestIdentity().address,
      readCreditBalance: () => conway.getCreditsBalance(),
      spendTracker: tracker,
    });
    mod.installTreasury(treasury);
    cleanups.push(() => mod.resetTreasuryForTests());
  }
  cleanups.push(() => db.close());
  const engine = new PolicyEngine(db.raw, createDefaultRules(full));
  const tools = createBuiltinTools("test-sandbox-id");
  return {
    db,
    server,
    conway,
    tracker,
    engine,
    run: (tool, args) =>
      executeTool(
        tool,
        args,
        tools,
        {
          identity: createTestIdentity(),
          config: createTestConfig({ treasuryPolicy: full }),
          db,
          conway,
          inference: new MockInferenceClient(),
        },
        engine,
        { inputSource: "agent", turnToolCallCount: 0, sessionSpend: tracker },
      ),
  };
}

function addChild(env: Env, id: string, address: string, status: string, fundedCents: number): void {
  env.db.insertChild({
    id,
    name: id,
    address,
    sandboxId: `sb-${id}`,
    genesisPrompt: "child",
    fundedAmountCents: fundedCents,
    status: status as never,
    createdAt: new Date().toISOString(),
  });
}

function funded(env: Env, id: string): number {
  return env.db.raw.prepare("SELECT funded_amount_cents FROM children WHERE id = ?").pluck().get(id) as number;
}

function transferOutRows(env: Env): number {
  return env.db.raw.prepare("SELECT COUNT(*) FROM transactions WHERE type = 'transfer_out'").pluck().get() as number;
}

describe("audit reproductions, credit side", () => {
  it("F040: ten fund_child(balance/2) calls in one turn do not drain the balance", async () => {
    const env = await setup(AUDIT, 100_000);
    addChild(env, "kid", CHILD, "wallet_verified", 0);
    for (let i = 0; i < 10; i++) {
      await env.run("fund_child", { child_id: "kid", amount_cents: Math.floor(env.server.balance / 2) });
    }
    expect(env.server.moved()).toBe(0);
    expect(env.server.balance).toBe(100_000);
  });

  it("F040: fund_child spend counts against the shared transfer budget", async () => {
    const env = await setup({ ...AUDIT, requireConfirmationAboveCents: 100_000 }, 100_000);
    addChild(env, "kid", CHILD, "wallet_verified", 0);
    await env.run("fund_child", { child_id: "kid", amount_cents: 1000 });
    expect(env.tracker.getHourlySpend("transfer")).toBe(1000);
  });

  it("F045: a transfer that would leave less than the reserve is refused", async () => {
    const env = await setup({ ...AUDIT, transferCooldownMs: 60_000 }, 1500);
    const first = await env.run("transfer_credits", { to_address: CHILD, amount_cents: 750 });
    expect(first.error).toMatch(/RESERVE_VIOLATION/);
    expect(env.server.transfers).toHaveLength(0);
    await env.run("transfer_credits", { to_address: CHILD, amount_cents: 100 });
    const second = await env.run("transfer_credits", { to_address: CHILD, amount_cents: 100 });
    expect(second.error).toMatch(/TRANSFER_COOLDOWN/);
    expect(env.server.transfers).toHaveLength(1);
  });

  it("F042: four concurrent transfers at 9000/10000 this hour send exactly one", async () => {
    const env = await setup(AUDIT, 100_000, (tracker) =>
      tracker.recordSpend({ toolName: "transfer_credits", amountCents: 9000, category: "transfer" }),
    );
    env.server.holdBalanceReads(4);
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        env.run("transfer_credits", { to_address: `0x${String(i).repeat(40)}`, amount_cents: 1000 }),
      ),
    );
    expect(env.server.transfers).toHaveLength(1);
    expect(results.filter((r) => r.error?.includes("SPEND_LIMIT_EXCEEDED"))).toHaveLength(3);
    expect(env.tracker.getHourlySpend("transfer")).toBe(10_000);
  });

  it("F074: orchestrator funding below the reserve is refused and nothing is sent", async () => {
    const env = await setup(AUDIT, 600);
    const funding = new SimpleFundingProtocol(env.conway, createTestIdentity(), env.db);
    expect(await funding.fundChild(CHILD, 590)).toEqual({ success: false });
    expect(env.server.transfers).toHaveLength(0);
  });

  it("F074: successful orchestrator funding is recorded in transactions and the spend tracker", async () => {
    const env = await setup(AUDIT, 100_000);
    addChild(env, "kid", CHILD, "healthy", 0);
    const funding = new SimpleFundingProtocol(env.conway, createTestIdentity(), env.db);
    expect(await funding.fundChild(CHILD, 250)).toEqual({ success: true });
    expect(transferOutRows(env)).toBe(1);
    expect(env.tracker.getHourlySpend("transfer")).toBe(250);
  });

  it("F050: create_sandbox with oversized resources is refused before any request", async () => {
    const env = await setup(AUDIT, 100_000);
    const res = await env.run("create_sandbox", { name: "big", vcpu: 32, memory_mb: 131072, disk_gb: 500 });
    expect(res.error).toMatch(/INVALID_AMOUNT/);
    expect(env.server.sandboxPosts).toBe(0);
  });

  it("F050: register_domain for 10 years is capped by the infra budget", async () => {
    const env = await setup(AUDIT, 100_000);
    const res = await env.run("register_domain", { domain: "test.com", years: 10 });
    expect(res.error).toMatch(/SPEND_LIMIT_EXCEEDED/);
    expect(env.server.domainPosts).toBe(0);
  });

  it("H1-005: retrying an ambiguous transfer reuses the idempotency key", async () => {
    const env = await setup(AUDIT, 100_000);
    env.server.failTransfers = [504];
    const first = await env.run("transfer_credits", { to_address: CHILD, amount_cents: 500 });
    expect(first.error).toMatch(/Outcome unknown/);
    await env.run("transfer_credits", { to_address: CHILD, amount_cents: 500 });
    const keys = env.server.transfers.map((t) => t.key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("H1-006: a rejected fund_child transfer is not recorded and does not mark the child funded", async () => {
    const env = await setup(AUDIT, 100_000);
    addChild(env, "kid", CHILD, "wallet_verified", 0);
    env.server.transferStatus = "rejected";
    const res = await env.run("fund_child", { child_id: "kid", amount_cents: 500 });
    expect(res.error).toMatch(/Transfer rejected/);
    expect(funded(env, "kid")).toBe(0);
    expect(transferOutRows(env)).toBe(0);
  });

  it("F068: recallCredits sends nothing and leaves the child ledger alone", async () => {
    const env = await setup(AUDIT, 100_000);
    addChild(env, "kid", CHILD, "healthy", 25);
    const funding = new SimpleFundingProtocol(env.conway, createTestIdentity(), env.db);
    const result = await funding.recallCredits(CHILD);
    expect(result.success).toBe(false);
    expect(env.server.transfers).toHaveLength(0);
    expect(funded(env, "kid")).toBe(25);
  });
});
