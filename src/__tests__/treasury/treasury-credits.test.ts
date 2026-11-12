/**
 * Treasury, credit side: transfers, child funding, sandboxes and domains go
 * through the guarded Conway client, the real policy engine and executeTool,
 * against a real ledger. Conway is a mock client, or the real client over a
 * stubbed fetch where the raw primitives themselves are under test.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import * as conwayClientModule from "../../conway/client.js";
import { createConwayClient, createCreditBalanceReader } from "../../conway/client.js";
import { HealthMonitor, type HealthReport } from "../../orchestration/health-monitor.js";
import { Orchestrator } from "../../orchestration/orchestrator.js";
import { SimpleFundingProtocol } from "../../orchestration/simple-tracker.js";
import {
  HOUR_MS,
  OutcomeUnknownError,
  TreasuryDeniedError,
  TreasuryNotInstalledError,
  getLedgerRow,
  guardConwayClient,
  listLedgerRows,
  normalizeTreasuryPolicy,
  resetTreasuryForTests,
  type LedgerRow,
  type TreasuryDenyCode,
} from "../../treasury/index.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import type { ConwayClient, PricingTier, ToolCallResult, ToolContext, TreasuryPolicy } from "../../types.js";
import { MockInferenceClient, createTestConfig, createTestIdentity } from "../mocks.js";
import {
  AUDIT_POLICY,
  CHILD_ADDRESS,
  OTHER_ADDRESS,
  SELF_ADDRESS,
  T0,
  deferred,
  makeHarness,
  transferQuote,
  type Harness,
  type HarnessOptions,
} from "./harness.js";

let open: Harness[] = [];

function harness(opts: HarnessOptions = {}): Harness {
  const h = makeHarness(opts);
  open.push(h);
  return h;
}

afterEach(() => {
  for (const h of open) h.close();
  open = [];
  resetTreasuryForTests();
  vi.unstubAllGlobals();
});

/** Audit policy with the confirmation threshold lifted, so the single cap is 5000. */
const AP_WIDE: Partial<TreasuryPolicy> = { ...AUDIT_POLICY, requireConfirmationAboveCents: 100_000 };

const SMALL_TIER: PricingTier = { name: "small", vcpu: 1, memoryMb: 512, diskGb: 5, monthlyCents: 2000 };

function addr(i: number): string {
  return `0x${(0xa000 + i).toString(16).padStart(40, "0")}`;
}

interface ExecOpts {
  source?: string;
  turnCount?: number;
  engine?: boolean;
  /** Pass a turn context (input source) even without the engine. Default: same as engine. */
  turnContext?: boolean;
  conway?: ConwayClient;
}

/** executeTool with the real tools and policy engine; optionally another Conway client. */
async function run(h: Harness, tool: string, args: Record<string, unknown>, opts: ExecOpts = {}): Promise<ToolCallResult> {
  const context: ToolContext = {
    identity: createTestIdentity(),
    config: createTestConfig({ treasuryPolicy: h.policy }),
    db: h.db,
    conway: opts.conway ?? h.conway,
    inference: new MockInferenceClient(),
  };
  const useEngine = opts.engine !== false;
  const withTurn = opts.turnContext ?? useEngine;
  return executeTool(
    tool,
    args,
    createBuiltinTools("test-sandbox-id"),
    context,
    useEngine ? h.engine : undefined,
    withTurn
      ? { inputSource: opts.source as never, turnToolCallCount: opts.turnCount ?? 0, sessionSpend: h.tracker }
      : undefined,
  );
}

function addChild(h: Harness, id: string, address: string, status = "wallet_verified", funded = 0): void {
  h.db.insertChild({
    id,
    name: id,
    address,
    sandboxId: `sb-${id}`,
    genesisPrompt: "test child",
    fundedAmountCents: funded,
    status: status as never,
    createdAt: new Date().toISOString(),
  });
}

function funded(h: Harness, id: string): number {
  return h.raw.prepare("SELECT funded_amount_cents FROM children WHERE id = ?").pluck().get(id) as number;
}

function count(h: Harness, sql: string, ...params: unknown[]): number {
  return h.raw.prepare(sql).pluck().get(...params) as number;
}

function transferOutRows(h: Harness): number {
  return count(h, "SELECT COUNT(*) FROM transactions WHERE type = 'transfer_out'");
}

function denials(h: Harness, code: TreasuryDenyCode): LedgerRow[] {
  return h.rows(undefined, "denied").filter((r) => r.deny_code === code);
}

async function settleTicks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** Commit `n` transfers of `amount` through the gate (mirror included). */
async function seedTransfers(h: Harness, n: number, amount: number): Promise<void> {
  for (let i = 0; i < n; i++) await h.conway.transferCredits(addr(900 + i), amount);
}

async function deniedCode(p: Promise<unknown>): Promise<TreasuryDenyCode> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TreasuryDeniedError) return err.code;
    throw err;
  }
  throw new Error("expected a TreasuryDeniedError");
}

function healthReport(addresses: string[]): HealthReport {
  return {
    timestamp: new Date().toISOString(),
    totalAgents: addresses.length,
    healthyAgents: 0,
    unhealthyAgents: addresses.length,
    deadAgents: 0,
    agents: addresses.map((address) => ({
      address,
      name: address,
      status: "healthy",
      healthy: false,
      lastHeartbeat: null,
      currentTaskId: null,
      creditBalance: 0,
      errorRate: 0,
      issues: ["out_of_credits"],
    })),
  };
}

// ─── F040: fund_child shares every transfer cap ────────────────

describe("fund_child is capped like transfer_credits (F040)", () => {
  it("C1: ten half-balance fund_child calls in one turn move nothing", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    addChild(h, "kid", CHILD_ADDRESS);
    const errors: string[] = [];
    for (let i = 0; i < 10; i++) {
      const amount = Math.floor(h.inner.creditsCents / 2);
      const res = await run(h, "fund_child", { child_id: "kid", amount_cents: amount }, { source: "agent", turnCount: 0 });
      errors.push(res.error ?? "");
    }
    expect(errors.every((e) => e.startsWith("Policy denied"))).toBe(true);
    expect(h.inner.calls.transferCredits).toHaveLength(0);
    expect(h.inner.creditsCents).toBe(100_000);
    expect(funded(h, "kid")).toBe(0);
  });

  it("C1 (worker, no policy engine): the gate alone refuses the drain", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    addChild(h, "kid", CHILD_ADDRESS);
    for (let i = 0; i < 10; i++) {
      const amount = Math.floor(h.inner.creditsCents / 2);
      const res = await run(h, "fund_child", { child_id: "kid", amount_cents: amount }, { engine: false });
      expect(res.error).toContain("Policy denied: SPEND_LIMIT_EXCEEDED");
    }
    expect(h.inner.calls.transferCredits).toHaveLength(0);
    expect(h.inner.creditsCents).toBe(100_000);
  });

  it("C2: twelve fund_child(1000) commit ten, then the shared budget refuses transfer_credits", async () => {
    const h = harness({ policy: AP_WIDE, balance: 100_000 });
    addChild(h, "kid", CHILD_ADDRESS);
    const results: ToolCallResult[] = [];
    for (let i = 0; i < 12; i++) {
      results.push(await run(h, "fund_child", { child_id: "kid", amount_cents: 1000 }, { source: "agent" }));
    }
    expect(results.filter((r) => !r.error)).toHaveLength(10);
    const refused = results.filter((r) => r.error);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.error).toContain("SPEND_LIMIT_EXCEEDED");
    expect(h.tracker.getHourlySpend("transfer")).toBe(10_000);
    expect(funded(h, "kid")).toBe(10_000);

    const transfer = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 100 }, { source: "agent" });
    expect(transfer.error).toContain("SPEND_LIMIT_EXCEEDED");
    expect(transferOutRows(h)).toBe(10);
    expect(h.inner.calls.transferCredits).toHaveLength(10);
  });

  it("C3: the same twelve calls with no policy engine and no turn context", async () => {
    const h = harness({ policy: AP_WIDE, balance: 100_000 });
    addChild(h, "kid", CHILD_ADDRESS);
    const results: ToolCallResult[] = [];
    for (let i = 0; i < 12; i++) {
      results.push(await run(h, "fund_child", { child_id: "kid", amount_cents: 1000 }, { engine: false }));
    }
    expect(results.filter((r) => !r.error)).toHaveLength(10);
    for (const r of results.filter((x) => x.error)) {
      expect(r.error).toContain("Policy denied: SPEND_LIMIT_EXCEEDED");
    }
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(10_000);
    expect(denials(h, "SPEND_LIMIT_EXCEEDED")).toHaveLength(1); // two identical denials collapse into one row
    expect(denials(h, "SPEND_LIMIT_EXCEEDED")[0].deny_count).toBe(2);
  });

  it("records origin tool name and input source on the ledger row", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    addChild(h, "kid", CHILD_ADDRESS);
    const res = await run(h, "fund_child", { child_id: "kid", amount_cents: 300 }, { source: "agent" });
    expect(res.error).toBeUndefined();
    const [row] = h.rows("transfer", "committed");
    expect(row.origin_type).toBe("tool");
    expect(row.origin_name).toBe("fund_child");
    expect(row.input_source).toBe("agent");
    expect(row.counterparty).toBe(CHILD_ADDRESS);
    const tx = h.raw.prepare("SELECT * FROM transactions WHERE type = 'transfer_out'").get() as {
      amount_cents: number;
      balance_after_cents: number | null;
    };
    expect(tx.amount_cents).toBe(300);
    expect(tx.balance_after_cents).toBe(100_000 - 300);
  });
});

// ─── F045: reserve, cooldown, balance ──────────────────────────

describe("reserve floor and cooldown are enforced (F045)", () => {
  it("C4: balance 1500 and reserve 1000", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 1500 });
    const first = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 750 }, { source: "agent" });
    expect(first.error).toContain("Policy denied: RESERVE_VIOLATION");
    expect(h.inner.calls.transferCredits).toHaveLength(0);

    const ok = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 500 }, { source: "agent" });
    expect(ok.error).toBeUndefined();
    expect(ok.result).toContain("Credit transfer submitted");

    const last = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 1 }, { source: "agent" });
    expect(last.error).toContain("RESERVE_VIOLATION");
    expect(h.inner.creditsCents).toBe(1000);
  });

  it("C4: the reserve floor applies to fund_child, with and without the policy engine", async () => {
    for (const engine of [true, false]) {
      const h = harness({ policy: AUDIT_POLICY, balance: 1500 });
      addChild(h, "kid", CHILD_ADDRESS);
      // 600 passes the tool's own half-balance check (750) but would leave 900 < 1000.
      const res = await run(h, "fund_child", { child_id: "kid", amount_cents: 600 }, { source: "agent", engine });
      expect(res.error).toContain("Policy denied: RESERVE_VIOLATION");
      expect(h.inner.calls.transferCredits).toHaveLength(0);
      expect(funded(h, "kid")).toBe(0);
      expect(h.inner.creditsCents).toBe(1500);
      h.close();
    }
  });

  it("C5: transferCooldownMs applies to tools and automatic funding", async () => {
    const h = harness({ policy: { ...AUDIT_POLICY, transferCooldownMs: 60_000 }, balance: 100_000 });
    const first = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 100 }, { source: "agent" });
    expect(first.error).toBeUndefined();

    h.clock.advance(1000);
    const second = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 100 }, { source: "agent" });
    expect(second.error).toContain("TRANSFER_COOLDOWN");
    const funding = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db);
    expect(await funding.fundChild(CHILD_ADDRESS, 100)).toEqual({ success: false });

    h.clock.set(T0 + 60_001);
    const third = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 100 }, { source: "agent" });
    expect(third.error).toBeUndefined();
    expect(h.inner.calls.transferCredits).toHaveLength(2);
  });

  it("C6: an unreadable balance refuses the transfer and writes a denied row", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    const blind = h.newTreasury({
      readCreditBalance: async () => {
        throw new Error("balance endpoint down");
      },
    });
    const conway = guardConwayClient(h.inner, blind);
    const res = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 100 }, { source: "agent", conway });
    expect(res.error).toContain("Policy denied: BALANCE_UNAVAILABLE");
    expect(h.inner.calls.transferCredits).toHaveLength(0);
    expect(denials(h, "BALANCE_UNAVAILABLE")).toHaveLength(1);
  });
});

// ─── F042: concurrency ─────────────────────────────────────────

describe("concurrent outflows cannot overshoot (F042)", () => {
  it("C7: four concurrent transfer_credits at 9000/10000 this hour: one is sent", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    await seedTransfers(h, 9, 1000);
    const balanceGate = deferred();
    const transferGate = deferred();
    h.inner.gates.balance = balanceGate.promise;
    h.inner.gates.transferCredits = transferGate.promise;

    const calls = [0, 1, 2, 3].map((i) =>
      run(h, "transfer_credits", { to_address: addr(i), amount_cents: 1000 }, { source: "agent" }),
    );
    await settleTicks();
    balanceGate.resolve();
    await settleTicks(20);
    transferGate.resolve();
    const results = await Promise.all(calls);

    expect(results.filter((r) => !r.error)).toHaveLength(1);
    const refused = results.filter((r) => r.error);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.error).toContain("SPEND_LIMIT_EXCEEDED");
    expect(h.inner.calls.transferCredits).toHaveLength(10);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(10_000);
    expect(h.tracker.getHourlySpend("transfer")).toBe(10_000);
  });

  it("C8: two Treasury objects over one database serialize", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    await seedTransfers(h, 9, 1000);
    const other = h.newTreasury();
    const a = guardConwayClient(h.inner, h.treasury);
    const b = guardConwayClient(h.inner, other);
    const gate = deferred();
    h.inner.gates.balance = gate.promise;
    const outcomes = Promise.allSettled([
      a.transferCredits(addr(1), 1000),
      a.transferCredits(addr(2), 1000),
      b.transferCredits(addr(3), 1000),
      b.transferCredits(addr(4), 1000),
    ]);
    await settleTicks();
    gate.resolve();
    const settled = await outcomes;
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(h.inner.calls.transferCredits).toHaveLength(10);
  });

  it("C9: half balance is checked against what concurrent reservations leave", async () => {
    const h = harness({ policy: AP_WIDE, balance: 6000 });
    addChild(h, "kid", CHILD_ADDRESS);
    addChild(h, "kid2", OTHER_ADDRESS);
    const gate = deferred();
    h.inner.gates.balance = gate.promise;
    const calls = [
      run(h, "fund_child", { child_id: "kid", amount_cents: 2500 }, { source: "agent" }),
      run(h, "fund_child", { child_id: "kid2", amount_cents: 2500 }, { source: "agent" }),
    ];
    await settleTicks();
    gate.resolve();
    const results = await Promise.all(calls);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.find((r) => r.error)!.error).toContain("HALF_BALANCE");
    expect(h.inner.calls.transferCredits).toHaveLength(1);
  });

  it("C10: the commit phase returns a plain value, never a promise", () => {
    const h = harness({ policy: AUDIT_POLICY });
    const out = h.treasury.reserveSync(transferQuote(CHILD_ADDRESS, 100), { type: "unattributed" }, {
      balanceCents: 100_000,
      balanceReadStartedMs: h.clock.now(),
    });
    expect(typeof (out as { then?: unknown }).then).toBe("undefined");
    expect(out.reservation).toBeDefined();
  });

  it("C11: tools and orchestrator funding share the hourly cap under concurrency", async () => {
    const h = harness({ policy: { ...AP_WIDE, maxHourlyTransferCents: 10_000 }, balance: 100_000 });
    const funding = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db);
    const gate = deferred();
    h.inner.gates.balance = gate.promise;
    const tool1 = run(h, "transfer_credits", { to_address: addr(1), amount_cents: 4000 }, { source: "agent" });
    const tool2 = run(h, "transfer_credits", { to_address: addr(2), amount_cents: 4000 }, { source: "agent" });
    const auto = funding.fundChild(addr(3), 4000);
    await settleTicks();
    gate.resolve();
    const [r1, r2, r3] = await Promise.all([tool1, tool2, auto]);
    const successes = [!r1.error, !r2.error, r3.success].filter(Boolean);
    expect(successes).toHaveLength(2);
    expect(h.inner.calls.transferCredits).toHaveLength(2);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(8000);
  });
});

// ─── F050: sandboxes and domains ───────────────────────────────

describe("sandboxes and domains are priced, bounded and capped (F050)", () => {
  it("C12: argument bounds, the infra daily cap and the reservation key", async () => {
    const h = harness({ pricing: [SMALL_TIER] });
    const big = await run(h, "create_sandbox", { name: "big", vcpu: 32 }, { source: "agent" });
    expect(big.error).toContain("Policy denied: INVALID_AMOUNT");
    expect(h.inner.calls.createSandbox).toHaveLength(0);

    const results: ToolCallResult[] = [];
    for (let i = 0; i < 3; i++) results.push(await run(h, "create_sandbox", { name: "box" }, { source: "agent" }));
    expect(results.filter((r) => !r.error)).toHaveLength(2);
    expect(results[2].error).toContain("SPEND_LIMIT_EXCEEDED");
    expect(h.treasury.usage("infra", 24 * HOUR_MS)).toBe(4000);

    const committed = h.rows("infra", "committed");
    expect(committed).toHaveLength(2);
    expect(h.inner.calls.createSandbox.map((c) => c.idempotencyKey)).toEqual(committed.map((r) => r.id));
    expect(committed[0].amount_basis).toBe("estimate");
    expect(committed[0].external_ref).toBe("new-sandbox-id");
    expect(committed[0].dedupe_key).toBe("sandbox_create|box|1|512|5");
    expect(count(h, "SELECT COUNT(*) FROM transactions WHERE type = 'tool_use'")).toBe(2);
    // The resolved spec is what gets created.
    expect(h.inner.calls.createSandbox[0].args[0]).toMatchObject({ name: "box", vcpu: 1, memoryMb: 512, diskGb: 5 });
  });

  it("C12: no matching price reserves the infra single cap as a ceiling", async () => {
    const h = harness({ pricing: [], balance: 100_000 });
    const res = await run(h, "create_sandbox", { name: "box" }, { source: "agent" });
    expect(res.error).toBeUndefined();
    const [row] = h.rows("infra", "committed");
    expect(row.amount_cents).toBe(2500);
    expect(row.amount_basis).toBe("ceiling");
  });

  it("a pricing error also reserves the ceiling", async () => {
    const h = harness({ balance: 100_000 });
    h.inner.getCreditsPricing = async () => {
      throw new Error("pricing down");
    };
    await h.conway.createSandbox({ name: "box" });
    expect(h.rows("infra", "committed")[0]).toMatchObject({ amount_cents: 2500, amount_basis: "ceiling" });
  });

  it("rejects non-integer, negative and out-of-range resources", async () => {
    const h = harness({ pricing: [SMALL_TIER] });
    for (const spec of [
      { vcpu: -1 },
      { vcpu: 0 },
      { vcpu: 1.5 },
      { vcpu: 5 },
      { memoryMb: 100 },
      { memoryMb: 131_072 },
      { diskGb: 0 },
      { diskGb: 500 },
      { vcpu: "2" as unknown as number },
    ]) {
      expect(await deniedCode(h.conway.createSandbox({ name: "x", ...spec }))).toBe("INVALID_AMOUNT");
    }
    expect(h.inner.calls.createSandbox).toHaveLength(0);
  });

  it("never reserves below the sandbox price floor and picks the cheapest covering tier", async () => {
    const h = harness({
      balance: 100_000,
      pricing: [
        { name: "tiny", vcpu: 1, memoryMb: 512, diskGb: 5, monthlyCents: 1 },
        { name: "big", vcpu: 4, memoryMb: 8192, diskGb: 80, monthlyCents: 2400 },
        { name: "mid", vcpu: 2, memoryMb: 2048, diskGb: 20, monthlyCents: 900 },
        { name: "free", vcpu: 4, memoryMb: 8192, diskGb: 80, monthlyCents: 0 },
      ],
    });
    await h.conway.createSandbox({ name: "a" });
    await h.conway.createSandbox({ name: "b", vcpu: 2, memoryMb: 1024 });
    const rows = h.rows("infra", "committed");
    expect(rows.map((r) => r.amount_cents).sort((a, b) => a - b)).toEqual([500, 900]);
  });

  it("C13: the reserve applies to sandboxes", async () => {
    const h = harness({ pricing: [SMALL_TIER], balance: 2500 });
    const res = await run(h, "create_sandbox", { name: "box" }, { source: "agent" });
    expect(res.error).toContain("RESERVE_VIOLATION");
    expect(h.inner.calls.createSandbox).toHaveLength(0);
  });

  it("C14: domains need an exact quote and whole years, and count against infra", async () => {
    const h = harness({ balance: 100_000 });
    const one = await run(h, "register_domain", { domain: "test.com", years: 1 }, { source: "agent" });
    expect(one.error).toBeUndefined();
    const [row] = h.rows("infra", "committed");
    expect(row).toMatchObject({ amount_cents: 1200, amount_basis: "quote", external_ref: "dom_1", counterparty: "test.com" });
    expect(h.inner.calls.registerDomain[0].idempotencyKey).toBe(row.id);

    const three = await run(h, "register_domain", { domain: "test.com", years: 3 }, { source: "agent" });
    expect(three.error).toContain("SPEND_LIMIT_EXCEEDED");
    const fractional = await run(h, "register_domain", { domain: "test.com", years: 1.5 }, { source: "agent" });
    expect(fractional.error).toContain("INVALID_AMOUNT");
    const tooLong = await run(h, "register_domain", { domain: "test.com", years: 11 }, { source: "agent" });
    expect(tooLong.error).toContain("INVALID_AMOUNT");
    const unknown = await run(h, "register_domain", { domain: "nope.com" }, { source: "agent" });
    expect(unknown.error).toContain("PRICE_UNKNOWN");
    h.inner.domains = [{ domain: "taken.com", available: false, registrationPrice: 1200, currency: "USD" }];
    const taken = await run(h, "register_domain", { domain: "taken.com" }, { source: "agent" });
    expect(taken.error).toContain("PRICE_UNKNOWN");
    expect(h.inner.calls.registerDomain).toHaveLength(1);
  });

  it("C14 (units): small or fractional prices are dollars, whole cents above $1 are cents", async () => {
    for (const [price, perYear] of [
      [12.99, 1299],
      [12, 1200],
      [1200, 1200],
    ] as const) {
      const h = harness({ balance: 100_000 });
      h.inner.domains = [{ domain: "test.com", available: true, registrationPrice: price, currency: "USD" }];
      await h.conway.registerDomain("test.com", 1);
      expect(h.rows("infra", "committed")[0].amount_cents).toBe(perYear);
      h.close();
    }
  });

  it("C14 (years): every year after the first is reserved at the higher of registration and renewal", async () => {
    const h = harness({ balance: 100_000, policy: { maxInfraSingleCents: 100_000, maxInfraDailyCents: 100_000 } });
    // A $1.99 promotional first year that renews at $15.00.
    h.inner.domains = [{ domain: "test.com", available: true, registrationPrice: 199, renewalPrice: 1500, currency: "USD" }];
    await h.conway.registerDomain("test.com", 3);
    expect(h.rows("infra", "committed")[0].amount_cents).toBe(199 + 2 * 1500);
    // A renewal cheaper than the first year never lowers later years.
    h.inner.domains = [{ domain: "two.com", available: true, registrationPrice: 12.99, renewalPrice: 9.99, currency: "USD" }];
    await h.conway.registerDomain("two.com", 2);
    expect(h.rows("infra", "committed").find((r) => r.counterparty === "two.com")?.amount_cents).toBe(2 * 1299);
  });

  it("C14 (years): a multi-year promotional quote above the single cap is refused unsent", async () => {
    const h = harness({ balance: 100_000 });
    h.inner.domains = [{ domain: "test.com", available: true, registrationPrice: 199, renewalPrice: 1500, currency: "USD" }];
    const res = await run(h, "register_domain", { domain: "test.com", years: 3 }, { source: "agent" });
    expect(res.error).toContain("SPEND_LIMIT_EXCEEDED");
    expect(h.inner.calls.registerDomain).toHaveLength(0);
  });

  it("C14 (currency): a price in another currency is not a quote", async () => {
    const h = harness({ balance: 100_000 });
    h.inner.domains = [{ domain: "test.com", available: true, registrationPrice: 1200, currency: "EUR" }];
    expect(await deniedCode(h.conway.registerDomain("test.com", 1))).toBe("PRICE_UNKNOWN");
    expect(h.inner.calls.registerDomain).toHaveLength(0);
  });

  it("C15: untrusted input sources are refused by the gate itself", async () => {
    const h = harness({ pricing: [SMALL_TIER], balance: 100_000 });
    // The inbox policy refuses these first; without it the gate still does.
    const viaPolicy = await run(h, "create_sandbox", { name: "box" }, { source: "external" });
    expect(viaPolicy.error).toMatch(/^Policy denied/);
    for (const source of ["external", "peer"]) {
      const sandbox = await run(h, "create_sandbox", { name: `box-${source}` }, { source, engine: false, turnContext: true });
      expect(sandbox.error).toContain("Policy denied: UNTRUSTED_SOURCE");
      const domain = await run(h, "register_domain", { domain: "test.com" }, { source, engine: false, turnContext: true });
      expect(domain.error).toContain("UNTRUSTED_SOURCE");
      const transfer = await run(
        h,
        "transfer_credits",
        { to_address: OTHER_ADDRESS, amount_cents: 100 },
        { source, engine: false, turnContext: true },
      );
      expect(transfer.error).toContain("UNTRUSTED_SOURCE");
    }
    expect(h.inner.calls.createSandbox).toHaveLength(0);
    expect(h.inner.calls.registerDomain).toHaveLength(0);
    expect(h.inner.calls.transferCredits).toHaveLength(0);
    // Identical denials within a minute collapse into one row with a count.
    const refused = denials(h, "UNTRUSTED_SOURCE");
    expect(refused.reduce((n, r) => n + r.deny_count, 0)).toBe(6);
    expect(new Set(refused.map((r) => r.input_source))).toEqual(new Set(["external", "peer"]));

    const heartbeat = await run(h, "create_sandbox", { name: "hb" }, { source: "heartbeat", engine: false, turnContext: true });
    expect(heartbeat.error).toBeUndefined();
    const worker = await run(h, "create_sandbox", { name: "worker" }, { engine: false });
    expect(worker.error).toBeUndefined();
    expect(h.inner.calls.createSandbox).toHaveLength(2);
  });

  it("scoped clients are gated too", async () => {
    const h = harness({ pricing: [SMALL_TIER], balance: 100_000 });
    const scoped = h.conway.createScopedClient("child-sandbox");
    await scoped.createSandbox({ name: "nested" });
    expect(h.rows("infra", "committed")).toHaveLength(1);
    expect(h.inner.calls.createSandbox).toHaveLength(1);
  });

  it("spawn_child creates its sandbox through the gate and surfaces a denial", async () => {
    const h = harness({ pricing: [], balance: 2000 });
    const res = await run(h, "spawn_child", { name: "kid" }, { source: "agent" });
    expect(res.error).toContain("Policy denied: RESERVE_VIOLATION");
    expect(h.inner.calls.createSandbox).toHaveLength(0);
    const [row] = denials(h, "RESERVE_VIOLATION");
    expect(row.kind).toBe("sandbox_create");
    expect(row.origin_name).toBe("spawn_child");
  });
});

// ─── F074, F068: automatic child funding ───────────────────────

describe("automatic child funding goes through the gate (F074, F068)", () => {
  it("C16: the health monitor cannot fund children below the parent's reserve", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 600 });
    const a = addr(1);
    const b = addr(2);
    addChild(h, "a", a, "healthy", 5);
    addChild(h, "b", b, "healthy", 5);
    const funding = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db, "health.fund_child");
    // Auto-funding is off by default; this pins the gate when it is on.
    const monitor = new HealthMonitor(h.db, funding, { autoFund: true });
    const actions = await monitor.autoHeal(healthReport([a, b]));
    expect(actions.map((x) => x.success)).toEqual([false, false]);
    expect(h.inner.calls.transferCredits).toHaveLength(0);
    expect(h.inner.creditsCents).toBe(600);
    const rows = denials(h, "RESERVE_VIOLATION");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.origin_name === "health.fund_child" && r.origin_type === "auto")).toBe(true);
    expect(funded(h, "a")).toBe(5);
  });

  it("C17: orchestrator funding is refused at 600c and recorded when it succeeds", async () => {
    const low = harness({ policy: AUDIT_POLICY, balance: 600 });
    const lowFunding = new SimpleFundingProtocol(low.conway, createTestIdentity(), low.db);
    expect(await lowFunding.fundChild(CHILD_ADDRESS, 590)).toEqual({ success: false });
    expect(low.inner.calls.transferCredits).toHaveLength(0);
    low.close();

    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    addChild(h, "kid", CHILD_ADDRESS, "healthy", 0);
    const funding = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db);
    expect(await funding.fundChild(CHILD_ADDRESS, 250)).toEqual({ success: true });
    const [row] = h.rows("transfer", "committed");
    expect(row).toMatchObject({ amount_cents: 250, origin_type: "auto", origin_name: "orchestrator.fund_child" });
    expect(transferOutRows(h)).toBe(1);
    expect(h.tracker.getHourlySpend("transfer")).toBe(250);
    expect(funded(h, "kid")).toBe(250);
  });

  it("C18: a task estimate above the transfer single cap is never sent", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    const funding = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db);
    const orchestrator = new Orchestrator({
      db: h.raw,
      agentTracker: {} as never,
      funding,
      messaging: {} as never,
      inference: {} as never,
      identity: createTestIdentity(),
      config: {},
    });
    await expect(
      orchestrator.fundAgentForTask(CHILD_ADDRESS, { metadata: { estimatedCostCents: 15_000 } } as never),
    ).rejects.toThrow(/Funding transfer failed/);
    expect(h.inner.calls.transferCredits).toHaveLength(0);
    expect(denials(h, "SPEND_LIMIT_EXCEEDED")[0].origin_name).toBe("orchestrator.fund_child");
  });

  it("C19: recallCredits is a refused self-transfer and leaves the child ledger alone", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    addChild(h, "kid", CHILD_ADDRESS, "healthy", 500);
    const funding = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db);
    expect(await funding.recallCredits(CHILD_ADDRESS)).toEqual({ success: false, amountCents: 0 });
    expect(h.inner.calls.transferCredits).toHaveLength(0);
    expect(funded(h, "kid")).toBe(500);
    expect(denials(h, "SELF_TRANSFER")).toHaveLength(1);
  });

  it("automatic funding: one transfer per child per cooldown", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    const funding = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db, "health.fund_child");
    expect((await funding.fundChild(CHILD_ADDRESS, 250)).success).toBe(true);
    expect((await funding.fundChild(CHILD_ADDRESS, 250)).success).toBe(false);
    expect((await funding.fundChild(OTHER_ADDRESS, 250)).success).toBe(true);
    expect(denials(h, "TRANSFER_COOLDOWN")).toHaveLength(1);
  });
});

// ─── H1-005, H1-006: ambiguous and rejected transfers ─────────

describe("ambiguous and rejected transfers (H1-005, H1-006)", () => {
  it("C20: replays reuse the original idempotency key, are charged, and stop after two", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    const args = { to_address: CHILD_ADDRESS, amount_cents: 500 };

    h.inner.failNext("transferCredits", { status: 504 });
    const first = await run(h, "transfer_credits", args, { source: "agent" });
    const [original] = h.rows("transfer", "unknown");
    expect(first.error).toContain(`Outcome unknown (ledger ${original.id})`);
    expect(first.error).toContain("counts against your limits");
    expect(h.inner.calls.transferCredits[0].idempotencyKey).toBe(original.id);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(500);

    h.inner.failNext("transferCredits", { status: 504 });
    await run(h, "transfer_credits", args, { source: "agent" });
    h.inner.failNext("transferCredits", "timeout");
    await run(h, "transfer_credits", args, { source: "agent" });
    const replays = h.rows("transfer").filter((r) => r.replay_of === original.id);
    expect(replays).toHaveLength(2);
    expect(replays.every((r) => r.idempotency_key === original.id && r.status === "unknown")).toBe(true);
    expect(h.inner.calls.transferCredits.map((c) => c.idempotencyKey)).toEqual([original.id, original.id, original.id]);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(1500);

    const third = await run(h, "transfer_credits", args, { source: "agent" });
    expect(third.error).toContain("AMBIGUOUS_PENDING");
    expect(h.inner.calls.transferCredits).toHaveLength(3);

    const different = await run(h, "transfer_credits", { ...args, amount_cents: 499 }, { source: "agent" });
    expect(different.error).toBeUndefined();
    expect(h.inner.calls.transferCredits[3].idempotencyKey).not.toBe(original.id);
  });

  it("C20: a replay that commits resolves the original; the next identical transfer is new", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    const args = { to_address: CHILD_ADDRESS, amount_cents: 500 };
    h.inner.failNext("transferCredits", "reset");
    await run(h, "transfer_credits", args, { source: "agent" });
    const [original] = h.rows("transfer", "unknown");
    const replay = await run(h, "transfer_credits", args, { source: "agent" });
    expect(replay.error).toBeUndefined();
    expect(h.inner.calls.transferCredits[1].idempotencyKey).toBe(original.id);
    const next = await run(h, "transfer_credits", args, { source: "agent" });
    expect(next.error).toBeUndefined();
    expect(h.inner.calls.transferCredits[2].idempotencyKey).not.toBe(original.id);
  });

  it("C20 (orchestrator): an ambiguous funding transfer is retried with the same key", async () => {
    const h = harness({ policy: { ...AUDIT_POLICY, autoFundCounterpartyCooldownMs: 0 }, balance: 100_000 });
    const funding = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db);
    h.inner.failNext("transferCredits", { status: 502 });
    expect((await funding.fundChild(CHILD_ADDRESS, 25)).success).toBe(false);
    expect((await funding.fundChild(CHILD_ADDRESS, 25)).success).toBe(true);
    const keys = h.inner.calls.transferCredits.map((c) => c.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(50);
  });

  it("C21: failures that cannot have reached Conway are released and not counted", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    const args = { to_address: CHILD_ADDRESS, amount_cents: 500 };
    h.inner.failNext("transferCredits", "refused");
    const refused = await run(h, "transfer_credits", args, { source: "agent" });
    expect(refused.error).toContain("fetch failed");
    h.inner.failNext("transferCredits", "circuit");
    const circuit = await run(h, "transfer_credits", args, { source: "agent" });
    expect(circuit.error).toContain("Circuit breaker");
    h.inner.failNext("transferCredits", { status: 422, body: "bad address" });
    const invalid = await run(h, "transfer_credits", args, { source: "agent" });
    expect(invalid.error).toContain("422");
    expect(h.rows("transfer", "released")).toHaveLength(3);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(0);
    expect(transferOutRows(h)).toBe(0);
  });

  it("C22: a rejected status is released, not recorded, and the child is not marked funded", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    addChild(h, "kid", CHILD_ADDRESS);
    h.inner.transferResult = { status: "rejected", amountCents: 0 };
    const res = await run(h, "fund_child", { child_id: "kid", amount_cents: 500 }, { source: "agent" });
    expect(res.error).toBe("Transfer rejected (status rejected); nothing recorded as spent.");
    expect(h.rows("transfer", "released")).toHaveLength(1);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(0);
    expect(transferOutRows(h)).toBe(0);
    expect(funded(h, "kid")).toBe(0);
    expect(h.db.getChildById("kid")!.status).toBe("wallet_verified");

    const transfer = await run(h, "transfer_credits", { to_address: OTHER_ADDRESS, amount_cents: 100 }, { source: "agent" });
    expect(transfer.error).toContain("Transfer rejected (status rejected)");
    const auto = new SimpleFundingProtocol(h.conway, createTestIdentity(), h.db);
    expect((await auto.fundChild(OTHER_ADDRESS, 100)).success).toBe(false);
  });

  it("R4: a lower server-reported amount never lowers what is counted", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    h.inner.transferResult = { amountCents: 1 };
    await h.conway.transferCredits(CHILD_ADDRESS, 1000);
    const [row] = h.rows("transfer", "committed");
    expect(row.committed_cents).toBe(1000);
    expect(h.treasury.usage("transfer", HOUR_MS)).toBe(1000);
    expect(h.tracker.getHourlySpend("transfer")).toBe(1000);
  });

  it("an ambiguous sandbox blocks identical requests (no replay)", async () => {
    const h = harness({ pricing: [SMALL_TIER], balance: 100_000 });
    h.inner.failNext("createSandbox", { status: 503 });
    const first = await run(h, "create_sandbox", { name: "box" }, { source: "agent" });
    expect(first.error).toContain("Outcome unknown");
    expect(first.error).toContain("refused for 24h");
    const again = await run(h, "create_sandbox", { name: "box" }, { source: "agent" });
    expect(again.error).toContain("AMBIGUOUS_PENDING");
    expect(h.inner.calls.createSandbox).toHaveLength(1);
  });

  it("C23: rows left open by a dead process are recovered", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000 });
    const dead = h.newTreasury({ bootId: "dead-boot" });
    const reserved = await dead.reserve(transferQuote(CHILD_ADDRESS, 100));
    const sent = await dead.reserve(transferQuote(OTHER_ADDRESS, 100));
    dead.markSent(sent);
    h.clock.advance(1000);
    h.newTreasury({ bootId: "next-boot", processStartMs: h.clock.now() });
    expect(getLedgerRow(h.raw, reserved.id)!.status).toBe("released");
    expect(getLedgerRow(h.raw, sent.id)!.status).toBe("unknown");
  });

  it("C24: rolling windows, not calendar buckets", async () => {
    const h = harness({ policy: AP_WIDE, balance: 100_000 });
    h.clock.set(Date.UTC(2026, 2, 1, 13, 59, 30));
    await h.conway.transferCredits(addr(1), 5000);
    await h.conway.transferCredits(addr(2), 5000);
    h.clock.set(Date.UTC(2026, 2, 1, 14, 0, 5));
    expect(await deniedCode(h.conway.transferCredits(addr(3), 100))).toBe("SPEND_LIMIT_EXCEEDED");
    h.clock.set(Date.UTC(2026, 2, 1, 14, 59, 31));
    await h.conway.transferCredits(addr(3), 100);
    expect(h.inner.calls.transferCredits).toHaveLength(3);
  });
});

// ─── I6: no outflow without a row ──────────────────────────────

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
}

type Route = (call: FetchCall) => Response | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Stub global fetch with a router; returns the recorded calls. */
function stubFetch(route: Route): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: typeof init?.body === "string" ? init.body : undefined,
        redirect: init?.redirect,
      };
      calls.push(call);
      const res = route(call);
      if (!res) throw new Error(`unexpected request ${call.method} ${call.url}`);
      // Like Node's fetch: a redirect is followed unless redirect is "manual";
      // here every redirect target is a closed port.
      if (res.status >= 300 && res.status < 400 && init?.redirect !== "manual") {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }
      return res;
    }),
  );
  return calls;
}

const API = "https://api.conway.tech";

function conwayRoutes(overrides: Partial<Record<string, (c: FetchCall) => Response>> = {}): Route {
  return (c) => {
    const p = new URL(c.url).pathname;
    const key = `${c.method} ${p}`;
    if (overrides[key]) return overrides[key]!(c);
    switch (key) {
      case "GET /v1/credits/pricing":
        return json(200, { tiers: [{ name: "s", vcpu: 1, memory_mb: 512, disk_gb: 5, monthly_cents: 600 }] });
      case "POST /v1/sandboxes":
        return json(201, { id: "sb-new", status: "running" });
      case "GET /v1/domains/search":
        return json(200, { results: [{ domain: "test.com", available: true, registration_price: 1200 }] });
      case "POST /v1/domains/register":
        return json(200, { domain: "test.com", status: "registered", transaction_id: "dom-1" });
      case "POST /v1/credits/transfer": {
        const body = JSON.parse(c.body ?? "{}");
        return json(200, { transfer_id: "t-1", status: "completed", amount_cents: body.amount_cents, balance_after_cents: 99_000 });
      }
      default:
        return undefined;
    }
  };
}

function posts(calls: FetchCall[], pathname: string): FetchCall[] {
  return calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === pathname);
}

describe("raw primitives and the guarded client (I6, S7, F144)", () => {
  it("C25: without a treasury nothing is sent", async () => {
    resetTreasuryForTests();
    const calls = stubFetch(conwayRoutes());
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "" });
    await expect(client.transferCredits(CHILD_ADDRESS, 100)).rejects.toBeInstanceOf(TreasuryNotInstalledError);
    await expect(client.createScopedClient("s").createSandbox({ name: "x" })).rejects.toBeInstanceOf(
      TreasuryNotInstalledError,
    );
    await expect(client.registerDomain("test.com", 1)).rejects.toBeInstanceOf(TreasuryNotInstalledError);
    expect(calls).toHaveLength(0);
  });

  it("C25: the raw client factory is not exported", () => {
    expect((conwayClientModule as Record<string, unknown>).createRawConwayClient).toBeUndefined();
  });

  it("C27: each credit outflow kind commits exactly one row, one transaction and one mirror row", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000, install: false });
    const calls = stubFetch(conwayRoutes());
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });

    const cases: Array<[string, string, () => Promise<unknown>]> = [
      ["credit_transfer", "/v1/credits/transfer", () => client.transferCredits(CHILD_ADDRESS, 400)],
      ["sandbox_create", "/v1/sandboxes", () => client.createSandbox({ name: "box" })],
      ["domain_register", "/v1/domains/register", () => client.registerDomain("test.com", 1)],
    ];
    for (const [kind, pathname, call] of cases) {
      const txBefore = count(h, "SELECT COUNT(*) FROM transactions");
      const mirrorBefore = count(h, "SELECT COUNT(*) FROM spend_tracking");
      await call();
      const rows = listLedgerRows(h.raw).filter((r) => r.kind === kind);
      expect(rows.map((r) => r.status)).toEqual(["committed"]);
      expect(count(h, "SELECT COUNT(*) FROM transactions") - txBefore).toBe(1);
      expect(count(h, "SELECT COUNT(*) FROM spend_tracking") - mirrorBefore).toBe(1);
      const sent = posts(calls, pathname);
      expect(sent).toHaveLength(1);
      expect(sent[0].headers["Idempotency-Key"]).toBe(rows[0].id);
    }
    const tx = h.raw.prepare("SELECT type, amount_cents, balance_after_cents FROM transactions ORDER BY rowid").all();
    expect(tx).toEqual([
      { type: "transfer_out", amount_cents: 400, balance_after_cents: 99_000 },
      { type: "tool_use", amount_cents: 600, balance_after_cents: null },
      { type: "tool_use", amount_cents: 1200, balance_after_cents: null },
    ]);
  });

  it("a transfer falls back to the second endpoint with the same key, sending onSend once", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000, install: false });
    const calls = stubFetch(
      conwayRoutes({
        "POST /v1/credits/transfer": () => json(404, { error: "not found" }),
        "POST /v1/credits/transfers": () => json(200, { id: "t-2", status: "completed" }),
      }),
    );
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });
    const result = await client.transferCredits(CHILD_ADDRESS, 300);
    expect(result.transferId).toBe("t-2");
    const [row] = h.rows("transfer", "committed");
    const sent = calls.filter((c) => c.method === "POST");
    expect(sent.map((c) => new URL(c.url).pathname)).toEqual(["/v1/credits/transfer", "/v1/credits/transfers"]);
    expect(sent.map((c) => c.headers["Idempotency-Key"])).toEqual([row.id, row.id]);
  });

  it("404 on both transfer endpoints is released; 504 is unknown and not retried", async () => {
    const h = harness({ policy: AUDIT_POLICY, balance: 100_000, install: false });
    let mode: "404" | "504" | "422" = "404";
    const calls = stubFetch(
      conwayRoutes({
        "POST /v1/credits/transfer": () => json(Number(mode), { error: mode }),
        "POST /v1/credits/transfers": () => json(Number(mode), { error: mode }),
      }),
    );
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });

    const notFound = await client.transferCredits(CHILD_ADDRESS, 100).catch((e) => e);
    expect(notFound.status).toBe(404);
    expect(h.rows("transfer", "released")).toHaveLength(1);

    mode = "422";
    const invalid = await client.transferCredits(CHILD_ADDRESS, 101).catch((e) => e);
    expect(invalid.status).toBe(422);
    expect(invalid.responseText).toContain("422");
    expect(h.rows("transfer", "released")).toHaveLength(2);

    mode = "504";
    const before = calls.length;
    const ambiguous = await client.transferCredits(CHILD_ADDRESS, 102).catch((e) => e);
    expect(ambiguous).toBeInstanceOf(OutcomeUnknownError);
    expect(calls.length - before).toBe(1);
    expect(h.rows("transfer", "unknown")).toHaveLength(1);
  });

  it("createSandbox and registerDomain are never auto-retried (F144)", async () => {
    const h = harness({ balance: 100_000, install: false });
    const calls = stubFetch(
      conwayRoutes({
        "POST /v1/sandboxes": () => json(503, { error: "busy" }),
        "POST /v1/domains/register": () => json(502, { error: "bad gateway" }),
      }),
    );
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });
    await expect(client.createSandbox({ name: "box" })).rejects.toBeInstanceOf(OutcomeUnknownError);
    await expect(client.registerDomain("test.com")).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(posts(calls, "/v1/sandboxes")).toHaveLength(1);
    expect(posts(calls, "/v1/domains/register")).toHaveLength(1);
    const unknown = h.rows("infra", "unknown");
    expect(unknown).toHaveLength(2);
    expect(posts(calls, "/v1/sandboxes")[0].headers["Idempotency-Key"]).toBe(unknown[0].id);
    expect(posts(calls, "/v1/domains/register")[0].headers["Idempotency-Key"]).toBe(unknown[1].id);
  });

  it("the 404 re-send of createSandbox reuses the key and marks the row sent once", async () => {
    const h = harness({ balance: 100_000, install: false });
    let first = true;
    const calls = stubFetch(
      conwayRoutes({
        "POST /v1/sandboxes": () => {
          if (first) {
            first = false;
            return json(404, { error: "routing" });
          }
          return json(201, { id: "sb-2" });
        },
      }),
    );
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });
    const info = await client.createSandbox({ name: "box" });
    expect(info.id).toBe("sb-2");
    const [row] = h.rows("infra", "committed");
    expect(posts(calls, "/v1/sandboxes").map((c) => c.headers["Idempotency-Key"])).toEqual([row.id, row.id]);
  });

  it("value-moving requests do not follow redirects: a redirect after sending is unknown, not released", async () => {
    const h = harness({ balance: 100_000, install: false });
    const moved = () => new Response(null, { status: 307, headers: { location: "https://127.0.0.1:1/x" } });
    const calls = stubFetch(
      conwayRoutes({
        "POST /v1/credits/transfer": moved,
        "POST /v1/sandboxes": moved,
        "POST /v1/domains/register": moved,
      }),
    );
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });
    await expect(client.transferCredits(CHILD_ADDRESS, 100)).rejects.toBeInstanceOf(OutcomeUnknownError);
    await expect(client.createSandbox({ name: "box" })).rejects.toBeInstanceOf(OutcomeUnknownError);
    await expect(client.registerDomain("test.com")).rejects.toBeInstanceOf(OutcomeUnknownError);
    const sent = calls.filter((c) => c.method === "POST");
    expect(sent).toHaveLength(3);
    expect(sent.every((c) => c.redirect === "manual")).toBe(true);
    expect(h.rows("transfer", "unknown")).toHaveLength(1);
    expect(h.rows("infra", "unknown")).toHaveLength(2);
  });

  it("the gate's balance reader retries Conway's intermittent 404 like the main client", async () => {
    let n = 0;
    let always404 = false;
    const calls = stubFetch((c) => {
      if (new URL(c.url).pathname !== "/v1/credits/balance") return undefined;
      n++;
      return always404 || n % 2 === 1 ? json(404, { error: "not found" }) : json(200, { balance_cents: 5000 });
    });
    const read = createCreditBalanceReader({ apiUrl: API, apiKey: "k", notFoundRetryDelayMs: 0 });
    expect(await read()).toBe(5000);
    expect(calls).toHaveLength(2);
    always404 = true;
    await expect(read()).rejects.toThrow(/404/);
    expect(calls).toHaveLength(6);
  });

  it("the gate's balance reader has its own client and refuses a missing balance", async () => {
    let body: unknown = { balance_cents: 4321 };
    const calls = stubFetch((c) => (new URL(c.url).pathname === "/v1/credits/balance" ? json(200, body) : undefined));
    const read = createCreditBalanceReader({ apiUrl: API, apiKey: "k" });
    expect(await read()).toBe(4321);
    body = { credits_cents: 12 };
    expect(await read()).toBe(12);
    body = {};
    await expect(read()).rejects.toThrow(/no numeric balance/);
    expect(calls.every((c) => c.headers.Authorization === "k")).toBe(true);
  });
});

// ─── C26: static guard ─────────────────────────────────────────

const SRC = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Source text without comments, so prose about an endpoint is not flagged. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("C26: no value-moving call outside the gated primitives", () => {
  const files = sourceFiles(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join("/"), text: code(f) }));
  const outsidePrimitives = files.filter(
    (f) => !f.rel.startsWith("treasury/") && f.rel !== "conway/client.ts" && f.rel !== "conway/x402.ts",
  );

  it("scans the source tree", () => {
    expect(files.some((f) => f.rel === "agent/tools.ts")).toBe(true);
  });

  it.each([
    ["/v1/credits/transfer", /\/v1\/credits\/transfer/],
    ["POST /v1/sandboxes", /["'`]\/v1\/sandboxes["'`]/],
    ["/v1/domains/register", /\/v1\/domains\/register/],
    ["X-Payment", /X-Payment/],
    ["signPayment(", /signPayment\(/],
    ["createRawConwayClient", /createRawConwayClient/],
  ])("%s appears only in the primitives", (_label, pattern) => {
    expect(outsidePrimitives.filter((f) => pattern.test(f.text)).map((f) => f.rel)).toEqual([]);
  });

  it("/pay/ appears only in topup.ts", () => {
    expect(outsidePrimitives.filter((f) => /\/pay\//.test(f.text)).map((f) => f.rel)).toEqual(["conway/topup.ts"]);
  });

  it("EIP-3009 signatures are made only in x402.ts; client.ts signs only the Register message", () => {
    const signers = files.filter(
      (f) => f.rel !== "conway/x402.ts" && /TransferWithAuthorization|signTypedData\(/.test(f.text),
    );
    expect(signers.map((f) => f.rel)).toEqual(["conway/client.ts"]);
    const client = signers[0].text;
    expect(client).not.toMatch(/TransferWithAuthorization/);
    expect(client.match(/signTypedData\(/g)).toHaveLength(1);
    expect(client).toMatch(/primaryType: "Register"/);
  });
});

// ─── C28, C29: legacy usage and config ─────────────────────────

describe("upgrade and configuration", () => {
  it("C28: the last day of legacy transfer spend still counts after the upgrade", async () => {
    const h = harness({
      policy: AP_WIDE,
      balance: 100_000,
      beforeTreasury: (raw) => {
        // A database from before schema 12 has no ledger yet. Rows are dated
        // against the harness clock, as the old SpendTracker dated them.
        raw.exec("DROP TABLE treasury_ledger");
        const at = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
        const ins = raw.prepare(
          `INSERT INTO spend_tracking (id, tool_name, amount_cents, recipient, domain, category, window_hour, window_day, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, 'h', 'd', ?)`,
        );
        ins.run("recent", "transfer_credits", 9000, CHILD_ADDRESS, "transfer", at(T0 - 10 * 60_000));
        ins.run("zero", "x402_fetch", 0, null, "x402", at(T0 - 10 * 60_000));
        ins.run("old", "transfer_credits", 5000, CHILD_ADDRESS, "transfer", at(T0 - 2 * 24 * HOUR_MS));
      },
    });
    const legacy = () => listLedgerRows(h.raw).filter((r) => r.kind === "legacy");
    expect(legacy().map((r) => [r.id, r.amount_cents])).toEqual([["recent", 9000]]);
    expect(legacy()[0].created_at_ms).toBe(T0 - 10 * 60_000);
    h.newTreasury();
    expect(legacy()).toHaveLength(1);
    expect(await deniedCode(h.conway.transferCredits(CHILD_ADDRESS, 1001))).toBe("SPEND_LIMIT_EXCEEDED");
    await h.conway.transferCredits(CHILD_ADDRESS, 1000);
  });

  it("C29: a mistyped limit falls back to its default with a warning", () => {
    const warnings: string[] = [];
    const policy = normalizeTreasuryPolicy(
      { maxSingleTransferCents: "5,000" as unknown as number },
      { onWarning: (m) => warnings.push(m) },
    );
    expect(policy.maxSingleTransferCents).toBe(5000);
    expect(warnings.join("\n")).toMatch(/maxSingleTransferCents/);
  });
});
