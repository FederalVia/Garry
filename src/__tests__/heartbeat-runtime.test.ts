/**
 * Heartbeat runtime behaviour: seeding keeps run state, runtime schedule
 * changes reach the scheduler and survive restarts, aliases run, retries
 * and the low-compute multiplier work, timed-out tasks are aborted and drop
 * their late wakes (only a task that ignores the abort keeps its lease), and
 * balance-driven tasks ignore unread balances.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const topupStub = vi.hoisted(() => ({ result: null as unknown, calls: 0 }));
vi.mock("../conway/topup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/topup.js")>();
  return {
    ...actual,
    bootstrapTopup: async () => {
      topupStub.calls++;
      return topupStub.result;
    },
  };
});

import { createHeartbeatDaemon } from "../heartbeat/daemon.js";
import { DurableScheduler, type DurableSchedulerOptions } from "../heartbeat/scheduler.js";
import { abortableDelay, currentCancellationSignal } from "../runtime/cancellation.js";
import { buildTickContext } from "../heartbeat/tick-context.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { acquireScheduleLease, clearExpiredScheduleLeases } from "../heartbeat/schedule-store.js";
import { createBuiltinTools } from "../agent/tools.js";
import { getHeartbeatSchedule, updateHeartbeatSchedule, upsertHeartbeatSchedule } from "../state/database.js";
import { MockConwayClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type {
  AutomatonDatabase,
  HeartbeatConfig,
  HeartbeatLegacyContext,
  HeartbeatScheduleRow,
  HeartbeatTaskFn,
  TickContext,
  ToolContext,
} from "../types.js";

let db: AutomatonDatabase;
let conway: MockConwayClient;

beforeEach(() => {
  db = createTestDb();
  conway = new MockConwayClient();
  topupStub.result = null;
  topupStub.calls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function hbConfig(entries: HeartbeatConfig["entries"]): HeartbeatConfig {
  return { entries, defaultIntervalMs: 60_000, lowComputeMultiplier: 4 };
}

function daemon(entries: HeartbeatConfig["entries"]) {
  return createHeartbeatDaemon({
    identity: createTestIdentity(),
    config: createTestConfig(),
    heartbeatConfig: hbConfig(entries),
    db,
    rawDb: db.raw,
    conway,
  });
}

function row(name: string): HeartbeatScheduleRow | undefined {
  return getHeartbeatSchedule(db.raw).find((r) => r.taskName === name);
}

function legacy(overrides: Partial<HeartbeatLegacyContext> = {}): HeartbeatLegacyContext {
  return { identity: createTestIdentity(), config: createTestConfig(), db, conway, ...overrides };
}

function tick(overrides: Partial<TickContext> = {}): TickContext {
  return {
    tickId: "t",
    startedAt: new Date(),
    creditBalance: 10_000,
    usdcBalance: 0,
    creditRead: { known: true, value: 10_000, at: new Date().toISOString() },
    usdcRead: { known: true, value: 0, at: new Date().toISOString() },
    survivalTier: "high",
    survivalTierKnown: true,
    lowComputeMultiplier: 4,
    config: hbConfig([]),
    db: db.raw,
    ...overrides,
  };
}

function seedRow(name: string, overrides: Partial<HeartbeatScheduleRow> = {}): void {
  upsertHeartbeatSchedule(db.raw, {
    taskName: name,
    cronExpression: "* * * * *",
    intervalMs: null,
    enabled: 1,
    priority: 0,
    timeoutMs: 30_000,
    maxRetries: 1,
    tierMinimum: "dead",
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    lastError: null,
    runCount: 0,
    failCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...overrides,
  });
}

function scheduler(
  tasks: Record<string, HeartbeatTaskFn>,
  onWake?: (r: string) => void,
  options?: DurableSchedulerOptions,
) {
  return new DurableScheduler(db.raw, hbConfig([]), new Map(Object.entries(tasks)), legacy(), onWake, options);
}

function modifyHeartbeat(args: Record<string, unknown>): Promise<string> {
  const tool = createBuiltinTools("test-sandbox").find((t) => t.name === "modify_heartbeat")!;
  return tool.execute(args, { identity: createTestIdentity(), config: createTestConfig(), db, conway } as unknown as ToolContext);
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ok: HeartbeatTaskFn = async () => ({ shouldWake: false });

describe("seeding (restart)", () => {
  const entries = [{ name: "check_credits", schedule: "0 */6 * * *", task: "check_credits", enabled: true }];

  it("keeps lastRunAt, runCount, failCount and a pending retry across a restart", () => {
    daemon(entries);
    const lastRun = minutesAgo(5);
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    updateHeartbeatSchedule(db.raw, "check_credits", { lastRunAt: lastRun, runCount: 7, failCount: 2, nextRunAt: retryAt });
    daemon(entries);
    const r = row("check_credits")!;
    expect(r.lastRunAt).toBe(lastRun);
    expect(r.runCount).toBe(7);
    expect(r.failCount).toBe(2);
    expect(r.nextRunAt).toBe(retryAt);
  });

  it("clears a last run in the future (clock stepped back) instead of stalling the task", () => {
    daemon(entries);
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    updateHeartbeatSchedule(db.raw, "check_credits", { lastRunAt: future });
    const sched = scheduler({ check_credits: ok });
    expect(sched.getDueTasks(tick()).map((r) => r.taskName)).toContain("check_credits");
    daemon(entries);
    expect(row("check_credits")!.lastRunAt).toBeNull();
  });
});

describe("modify_heartbeat reaches the scheduler", () => {
  const entries = [
    { name: "check_credits", schedule: "0 */6 * * *", task: "check_credits", enabled: true },
    { name: "check_usdc_balance", schedule: "*/5 * * * *", task: "check_usdc_balance", enabled: true },
  ];

  it("remove disables the schedule row and the task is no longer due", async () => {
    daemon(entries);
    const out = await modifyHeartbeat({ action: "remove", name: "check_usdc_balance" });
    expect(out).toContain("disabled");
    expect(row("check_usdc_balance")!.enabled).toBe(0);
    const sched = scheduler({ check_usdc_balance: ok, check_credits: ok });
    expect(sched.getDueTasks(tick()).map((r) => r.taskName)).not.toContain("check_usdc_balance");
  });

  it("add with a task alias creates a row that runs the aliased task", async () => {
    daemon(entries);
    const out = await modifyHeartbeat({ action: "add", name: "ping_fast", schedule: "* * * * *", task: "heartbeat_ping" });
    expect(out).toContain("added");
    let ran = 0;
    const sched = scheduler({ heartbeat_ping: async () => (ran++, { shouldWake: false }) });
    expect(sched.getDueTasks(tick()).map((r) => r.taskName)).toContain("ping_fast");
    await sched.executeTask("ping_fast", tick());
    expect(ran).toBe(1);
  });

  it("rejects a bad cron, an unknown task and a wrong-typed schedule", async () => {
    daemon(entries);
    expect(await modifyHeartbeat({ action: "update", name: "check_credits", schedule: "every day" })).toMatch(/^Error: invalid cron/);
    expect(await modifyHeartbeat({ action: "add", name: "x", schedule: "* * * * *", task: "rm_rf" })).toMatch(/^Error: task must be one of/);
    expect(await modifyHeartbeat({ action: "update", name: "check_credits", schedule: 5 })).toMatch(/^Error: schedule must be/);
    expect(row("check_credits")!.cronExpression).toBe("0 */6 * * *");
  });

  it("a runtime change survives a restart, but an operator edit to heartbeat.yml wins", async () => {
    daemon(entries);
    await modifyHeartbeat({ action: "update", name: "check_credits", schedule: "*/30 * * * *" });
    await modifyHeartbeat({ action: "remove", name: "check_usdc_balance" });

    daemon(entries);
    expect(row("check_credits")!.cronExpression).toBe("*/30 * * * *");
    expect(row("check_usdc_balance")!.enabled).toBe(0);

    daemon([
      { ...entries[0], schedule: "0 */3 * * *" },
      entries[1],
    ]);
    expect(row("check_credits")!.cronExpression).toBe("0 */3 * * *");
    expect(row("check_usdc_balance")!.enabled).toBe(0);
  });
});

describe("aliases from heartbeat.yml", () => {
  it("an entry whose task differs from its name runs that task and writes history", async () => {
    daemon([{ name: "inbox_fast", schedule: "* * * * *", task: "heartbeat_ping", enabled: true }]);
    let ran = 0;
    const sched = scheduler({ heartbeat_ping: async () => (ran++, { shouldWake: false }) });
    expect(sched.getDueTasks(tick()).map((r) => r.taskName)).toContain("inbox_fast");
    await sched.executeTask("inbox_fast", tick());
    expect(ran).toBe(1);
    const history = db.raw.prepare("SELECT result FROM heartbeat_history WHERE task_name = 'inbox_fast'").all() as { result: string }[];
    expect(history.map((h) => h.result)).toEqual(["success"]);
  });

  it("an entry with no task function records a failure instead of vanishing", async () => {
    seedRow("ghost");
    await scheduler({}).executeTask("ghost", tick());
    const h = db.raw.prepare("SELECT result, error FROM heartbeat_history WHERE task_name = 'ghost'").get() as { result: string; error: string };
    expect(h.result).toBe("failure");
    expect(h.error).toContain("no task function for 'ghost'");
  });
});

describe("retries", () => {
  it("maxRetries 1 retries once after the first failure and not after the second", async () => {
    seedRow("flaky", { maxRetries: 1 });
    const sched = scheduler({ flaky: async () => { throw new Error("transient"); } });
    await sched.executeTask("flaky", tick());
    expect(row("flaky")!.nextRunAt).not.toBeNull();
    await sched.executeTask("flaky", tick());
    expect(row("flaky")!.nextRunAt).toBeNull();
  });
});

describe("low compute multiplier", () => {
  it("slows non-essential tasks by the multiplier but not check_credits", () => {
    seedRow("social", { cronExpression: "*/2 * * * *", lastRunAt: minutesAgo(3) });
    seedRow("check_credits", { cronExpression: "*/2 * * * *", lastRunAt: minutesAgo(3) });
    const sched = scheduler({ social: ok, check_credits: ok });
    const lowCompute = tick({ survivalTier: "low_compute", creditBalance: 30 });

    let due = sched.getDueTasks(lowCompute).map((r) => r.taskName);
    expect(due).not.toContain("social");
    expect(due).toContain("check_credits");

    updateHeartbeatSchedule(db.raw, "social", { lastRunAt: minutesAgo(9) });
    due = sched.getDueTasks(lowCompute).map((r) => r.taskName);
    expect(due).toContain("social");

    // Normal tier: the plain cron applies.
    updateHeartbeatSchedule(db.raw, "social", { lastRunAt: minutesAgo(3) });
    expect(sched.getDueTasks(tick()).map((r) => r.taskName)).toContain("social");
  });
});

describe("timeouts", () => {
  it("aborts on timeout, releases the lease when it settles, drops the late wake", async () => {
    seedRow("slow", { timeoutMs: 50 });
    let starts = 0;
    let aborted = 0;
    const wakes: string[] = [];
    const sched = scheduler(
      {
        slow: async () => {
          starts++;
          try {
            await abortableDelay(5_000, currentCancellationSignal());
          } catch (err) {
            aborted++;
            throw err;
          }
          return { shouldWake: true, message: "late result" };
        },
      },
      (r) => wakes.push(r),
    );

    const t0 = Date.now();
    await sched.executeTask("slow", tick());
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(aborted).toBe(1);
    expect(row("slow")!.lastResult).toBe("timeout");
    // Settled within the grace: the lease is free and a second run starts.
    expect(row("slow")!.leaseOwner).toBeNull();
    expect(sched.getInFlightTasks()).toEqual([]);

    await sched.executeTask("slow", tick());
    expect(starts).toBe(2);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM wake_events").get()).toEqual({ n: 0 });
    expect(wakes).toEqual([]);
  });

  it("gives up on a task that never settles, so it can run again", async () => {
    seedRow("stuck", { timeoutMs: 50 });
    let starts = 0;
    // The task ignores its abort, so after the settle grace it keeps its lease.
    const sched = scheduler({ stuck: () => (starts++, new Promise(() => {})) }, undefined, { abortSettleGraceMs: 30 });
    await sched.executeTask("stuck", tick());
    await sched.executeTask("stuck", tick());
    expect(starts).toBe(1);

    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 11 * 60_000);
    await sched.executeTask("stuck", tick());
    expect(starts).toBe(2);
  });

  it("drain waits for a task past its timeout", async () => {
    seedRow("slow", { timeoutMs: 20 });
    let done = false;
    // Ignores the abort and outlasts the settle grace.
    const sched = scheduler(
      { slow: async () => { await new Promise((r) => setTimeout(r, 150)); done = true; return { shouldWake: false }; } },
      undefined,
      { abortSettleGraceMs: 20 },
    );
    await sched.executeTask("slow", tick());
    expect(done).toBe(false);
    await sched.drain(2_000);
    expect(done).toBe(true);
  });

  it("an expired lease from earlier today can be taken over", () => {
    seedRow("leased");
    const expired = new Date(Date.now() - 1_000).toISOString();
    db.raw.prepare("UPDATE heartbeat_schedule SET lease_owner = 'old', lease_expires_at = ? WHERE task_name = 'leased'").run(expired);
    expect(acquireScheduleLease(db.raw, "leased", "new", 60_000)).toBe(true);
    db.raw.prepare("UPDATE heartbeat_schedule SET lease_owner = 'old', lease_expires_at = ? WHERE task_name = 'leased'").run(expired);
    expect(clearExpiredScheduleLeases(db.raw)).toBe(1);
  });
});

describe("auto-topup wakes", () => {
  const critical = () => tick({ creditBalance: 5, usdcBalance: 20, survivalTier: "critical" });

  it("never wakes a Solana agent (auto-topup is EVM-only)", async () => {
    const res = await BUILTIN_TASKS.check_usdc_balance(
      critical(),
      legacy({ identity: { ...createTestIdentity(), chainType: "solana" }, config: { ...createTestConfig(), chainType: "solana" } }),
    );
    expect(res.shouldWake).toBe(false);
    expect(topupStub.calls).toBe(0);
  });

  it("does not wake when the topup was not attempted (null)", async () => {
    topupStub.result = null;
    const res = await BUILTIN_TASKS.check_usdc_balance(critical(), legacy());
    expect(res.shouldWake).toBe(false);
  });

  it("wakes once per distinct failure, and again only after 6 hours", async () => {
    topupStub.result = { success: false, amountUsd: 5, error: "payment rejected" };
    const first = await BUILTIN_TASKS.check_usdc_balance(critical(), legacy());
    expect(first.shouldWake).toBe(true);

    db.deleteKV("last_auto_topup_attempt");
    expect((await BUILTIN_TASKS.check_usdc_balance(critical(), legacy())).shouldWake).toBe(false);

    const notice = JSON.parse(db.getKV("auto_topup_fail_notice")!);
    db.setKV("auto_topup_fail_notice", JSON.stringify({ ...notice, at: new Date(Date.now() - 7 * 3600_000).toISOString() }));
    db.deleteKV("last_auto_topup_attempt");
    expect((await BUILTIN_TASKS.check_usdc_balance(critical(), legacy())).shouldWake).toBe(true);
  });
});

describe("zero-credit tracking", () => {
  it("a successful non-zero balance read clears zero_credits_since", async () => {
    db.setKV("zero_credits_since", minutesAgo(360));
    conway.creditsCents = 500;
    const ctx = await buildTickContext(db.raw, conway, hbConfig([]));
    expect(ctx.creditBalance).toBe(500);
    expect(ctx.survivalTierKnown).toBe(true);
    expect(db.getKV("zero_credits_since")).toBeUndefined();
  });

  it("an unread balance never marks the agent dead", async () => {
    db.setKV("zero_credits_since", minutesAgo(360));
    db.setAgentState("sleeping");
    conway.getCreditsBalance = async () => {
      throw new Error("API down");
    };
    const ctx = await buildTickContext(db.raw, conway, hbConfig([]));
    expect(ctx.creditBalance).toBeNull();
    expect(ctx.survivalTierKnown).toBe(false);
    const res = await BUILTIN_TASKS.check_credits(ctx, legacy());
    expect(res.shouldWake).toBe(false);
    expect(db.getAgentState()).toBe("sleeping");
    const ping = await BUILTIN_TASKS.heartbeat_ping(ctx, legacy());
    expect(ping.shouldWake).toBe(false);
  });

  it("a stale zero streak does not kill an agent that was funded in between", async () => {
    // 00:00 zero seen; funded; back to zero at 06:00. The funded tick in between clears the streak.
    db.setKV("zero_credits_since", minutesAgo(360));
    conway.creditsCents = 2_000;
    await buildTickContext(db.raw, conway, hbConfig([]));
    conway.creditsCents = 0;
    const ctx = await buildTickContext(db.raw, conway, hbConfig([]));
    const res = await BUILTIN_TASKS.check_credits(ctx, legacy());
    expect(db.getAgentState()).not.toBe("dead");
    expect(res.message ?? "").not.toContain("Dead");
  });
});

describe("an unreadable balance after a critical or dead reading", () => {
  const outage = () => {
    conway.getCreditsBalance = async () => {
      throw new Error("Conway API error: GET /v1/credits/balance -> 503");
    };
  };

  it("after a live zero (critical): no distress, no wake, and the zero streak is neither ended nor restarted", async () => {
    db.setAgentState("sleeping");
    conway.creditsCents = 0;
    const live = await buildTickContext(db.raw, conway, hbConfig([]));
    expect(live.survivalTier).toBe("critical");
    await BUILTIN_TASKS.check_credits(live, legacy());
    const since = db.getKV("zero_credits_since");
    expect(typeof since).toBe("string");

    outage();
    const ctx = await buildTickContext(db.raw, conway, hbConfig([]));
    expect(ctx.creditBalance).toBeNull();
    expect(ctx.survivalTier).toBe("critical");
    const ping = await BUILTIN_TASKS.heartbeat_ping(ctx, legacy());
    expect(ping.shouldWake).toBe(false);
    expect(db.getKV("last_distress")).toBeUndefined();
    await BUILTIN_TASKS.check_credits(ctx, legacy());
    expect(db.getKV("zero_credits_since")).toBe(since);
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("after a live 5c reading (critical): no distress and no streak starts", async () => {
    conway.creditsCents = 5;
    await buildTickContext(db.raw, conway, hbConfig([]));
    outage();
    const ctx = await buildTickContext(db.raw, conway, hbConfig([]));
    expect(ctx.survivalTier).toBe("critical");
    const ping = await BUILTIN_TASKS.heartbeat_ping(ctx, legacy());
    expect(ping.shouldWake).toBe(false);
    expect(db.getKV("last_distress")).toBeUndefined();
    await BUILTIN_TASKS.check_credits(ctx, legacy());
    expect(db.getKV("zero_credits_since")).toBeUndefined();
  });

  it("after a live negative reading (dead): no distress and no wake", async () => {
    conway.creditsCents = -50;
    const live = await buildTickContext(db.raw, conway, hbConfig([]));
    expect(live.survivalTier).toBe("dead");
    outage();
    const ctx = await buildTickContext(db.raw, conway, hbConfig([]));
    expect(ctx.creditBalance).toBeNull();
    const ping = await BUILTIN_TASKS.heartbeat_ping(ctx, legacy());
    expect(ping.shouldWake).toBe(false);
    expect(db.getKV("last_distress")).toBeUndefined();
  });
});

describe("an unreadable credit balance over an hour (F143)", () => {
  const realFetch = globalThis.fetch;
  const savedRpc = process.env.AUTOMATON_RPC_URL;
  let payRequests: string[];
  let balanceRequests: number;

  /** Balance endpoint answers `balance()`; the USDC RPC says 100 USDC; /pay is recorded. */
  function stubNetwork(balance: () => Response): void {
    payRequests = [];
    balanceRequests = 0;
    process.env.AUTOMATON_RPC_URL = "https://rpc.stub.invalid";
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes('"jsonrpc"')) {
        const req = JSON.parse(body);
        const result = "0x" + (100n * 1_000_000n).toString(16).padStart(64, "0");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/pay/")) {
        payRequests.push(url);
        return new Response("{}", { status: 402 });
      }
      if (url.endsWith("/v1/credits/balance")) {
        balanceRequests++;
        return balance();
      }
      throw new Error(`no network in this test: ${url}`);
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedRpc === undefined) delete process.env.AUTOMATON_RPC_URL;
    else process.env.AUTOMATON_RPC_URL = savedRpc;
    vi.useRealTimers();
  });

  async function runHour(balance: () => Response, firstLive?: number) {
    const { createConwayClient } = await import("../conway/client.js");
    const { ResilientHttpClient } = await import("../conway/http-client.js");
    const { getMetrics } = await import("../observability/metrics.js");
    // Skip retry backoff sleeps; the retry counts are unchanged.
    const proto = ResilientHttpClient.prototype as unknown as { backoff: (attempt: number) => Promise<void> };
    vi.spyOn(proto, "backoff").mockResolvedValue(undefined);
    getMetrics().reset();

    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = { ...createTestIdentity(), account, address: account.address };
    const real = createConwayClient({ apiUrl: "https://api.conway.tech", apiKey: "k", sandboxId: "sb", treasury: () => undefined });
    const ctxFor = (): HeartbeatLegacyContext => ({ identity, config: createTestConfig(), db, conway: real });

    vi.useFakeTimers({ toFake: ["Date"] });
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    db.setAgentState("sleeping");
    const wakes: string[] = [];
    const tiers: string[] = [];

    if (firstLive !== undefined) {
      stubNetwork(() => new Response(JSON.stringify({ balance_cents: firstLive }), { status: 200, headers: { "content-type": "application/json" } }));
      vi.setSystemTime(now);
      const ctx = await buildTickContext(db.raw, real, hbConfig([]), identity.address);
      await BUILTIN_TASKS.report_metrics(ctx, ctxFor());
      now += 5 * 60_000;
    }

    stubNetwork(balance);
    for (let i = 0; i < 13; i++) {
      vi.setSystemTime(now);
      const ctx = await buildTickContext(db.raw, real, hbConfig([]), identity.address);
      tiers.push(ctx.survivalTier);
      for (const task of ["check_usdc_balance", "check_credits", "heartbeat_ping", "report_metrics"] as const) {
        const r = await BUILTIN_TASKS[task](ctx, ctxFor());
        if (r.shouldWake) wakes.push(`${task}: ${r.message}`);
      }
      now += 5 * 60_000;
    }
    return { wakes, tiers };
  }

  function expectNothingSpentOrEscalated(r: { wakes: string[]; tiers: string[] }) {
    expect(payRequests).toEqual([]);
    expect(topupStub.calls).toBe(0);
    expect(r.tiers.every((t) => t !== "critical" && t !== "dead")).toBe(true);
    expect(db.getKV("last_distress")).toBeUndefined();
    expect(db.getKV("zero_credits_since")).toBeUndefined();
    expect(db.getAgentState()).not.toBe("dead");
    expect(r.wakes).toEqual([]);
    const ping = JSON.parse(db.getKV("last_heartbeat_ping")!);
    expect(ping).toMatchObject({ creditsCents: null, balanceKnown: false });
    expect(typeof db.getKV("balance_unknown_since")).toBe("string");
  }

  it("a 503 balance endpoint for 65 minutes buys nothing, wakes nothing and never kills", async () => {
    const r = await runHour(() => new Response("upstream down", { status: 503 }));
    expect(balanceRequests).toBeGreaterThan(0);
    expectNothingSpentOrEscalated(r);
    expect(r.tiers.every((t) => t === "low_compute")).toBe(true);
  });

  it("a malformed 200 balance body is unknown too, not a known zero", async () => {
    const r = await runHour(
      () => new Response(JSON.stringify({ balance: 8000 }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    expectNothingSpentOrEscalated(r);
  });

  it("an HTML proxy page is unknown", async () => {
    const r = await runHour(
      () => new Response("<html>proxy error</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expectNothingSpentOrEscalated(r);
  });

  it("keeps the last known tier through the outage", async () => {
    const r = await runHour(() => new Response("upstream down", { status: 503 }), 8000);
    expect(r.tiers.every((t) => t === "high")).toBe(true);
    expectNothingSpentOrEscalated(r);
  });

  it("a stale low balance gauge from before the outage does not keep the reserve alert waking", async () => {
    // 500c is below the 1000c reserve: the alert fires once on the live read,
    // then the outage leaves the stale gauge out of evaluation.
    const r = await runHour(() => new Response("upstream down", { status: 503 }), 500);
    expect(r.wakes.filter((w) => w.startsWith("report_metrics"))).toEqual([]);
    const snapshots = db.raw
      .prepare("SELECT metrics_json, alerts_json FROM metric_snapshots ORDER BY snapshot_at")
      .all() as Array<{ metrics_json: string; alerts_json: string }>;
    expect(snapshots.length).toBe(14);
    expect(JSON.parse(snapshots[0].alerts_json).map((a: any) => a.rule)).toContain("balance_below_reserve");
    for (const s of snapshots.slice(1)) {
      expect(JSON.parse(s.alerts_json).map((a: any) => a.rule)).not.toContain("balance_below_reserve");
      expect(JSON.parse(s.metrics_json).some((m: any) => m.name === "balance_cents")).toBe(false);
    }
  });
});
