/**
 * Cancellable heartbeat tasks: a timeout or a shutdown aborts the running
 * task (exec process groups killed, HTTP requests destroyed), settles its
 * lease and records the outcome; an aborted run delivers no wake; and the
 * built-in tasks turn an abort into no state (no failure status, backoff,
 * failed probe or upstream status).
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../conway/balance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/balance.js")>();
  // No chain read: the tick's USDC balance is a fixed known value.
  return { ...actual, readUsdc: vi.fn(async () => ({ known: true, value: 0, at: new Date().toISOString() })) };
});

import { createHeartbeatDaemon } from "../heartbeat/daemon.js";
import { DurableScheduler, type DurableSchedulerOptions } from "../heartbeat/scheduler.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { execLocalCommand } from "../conway/client.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { ChildLifecycle } from "../replication/lifecycle.js";
import { TaskAbortedError, currentCancellationSignal, runWithCancellation } from "../runtime/cancellation.js";
import { getHeartbeatSchedule, insertHeartbeatHistory, upsertHeartbeatSchedule } from "../state/database.js";
import { MockConwayClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type {
  AutomatonDatabase,
  ConwayClient,
  ExecResult,
  HeartbeatLegacyContext,
  HeartbeatScheduleRow,
  HeartbeatTaskFn,
  SandboxInfo,
  SocialClientInterface,
  TickContext,
} from "../types.js";

let db: AutomatonDatabase;
let tmp: string;
const ORIGINAL_PATH = process.env.PATH;

beforeEach(() => {
  db = createTestDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-cancel-"));
});

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.GIT_STUB_PIDFILE;
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function legacy(overrides: Partial<HeartbeatLegacyContext> = {}): HeartbeatLegacyContext {
  return { identity: createTestIdentity(), config: createTestConfig(), db, conway: new MockConwayClient(), ...overrides };
}

function tick(): TickContext {
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
    config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
    db: db.raw,
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
  opts: { legacy?: HeartbeatLegacyContext; onWake?: (r: string) => void; options?: DurableSchedulerOptions } = {},
) {
  return new DurableScheduler(
    db.raw,
    { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
    new Map(Object.entries(tasks)),
    opts.legacy ?? legacy(),
    opts.onWake,
    opts.options,
  );
}

function row(name: string): HeartbeatScheduleRow {
  return getHeartbeatSchedule(db.raw).find((r) => r.taskName === name)!;
}

function history(name: string): Array<{ result: string; error: string | null }> {
  return db.raw
    .prepare("SELECT result, error FROM heartbeat_history WHERE task_name = ? ORDER BY rowid")
    .all(name) as Array<{ result: string; error: string | null }>;
}

function wakeCount(): number {
  return (db.raw.prepare("SELECT COUNT(*) AS n FROM wake_events").get() as { n: number }).n;
}

function gone(pid: number, group = true): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 250; i++) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (/^\d+$/.test(text)) return Number(text);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no pid written to ${file}`);
}

/** Resolves when the ambient (task) signal aborts. */
function untilAborted(): Promise<void> {
  const signal = currentCancellationSignal();
  if (!signal) throw new Error("not in a cancellation scope");
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("timeout", () => {
  it("kills a hung task's exec group, releases the lease and lets the task run again", async () => {
    seedRow("hung", { timeoutMs: 300 });
    const pidFile = path.join(tmp, "pid");
    let starts = 0;
    const sched = scheduler({
      hung: async () => {
        starts++;
        if (starts === 1) {
          await execLocalCommand(`echo $$ > '${pidFile}'; sleep 60 & sleep 60; wait`, 120_000);
        }
        return { shouldWake: false };
      },
    });

    const started = Date.now();
    await sched.executeTask("hung", tick());
    const pid = await readPid(pidFile);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(history("hung").map((h) => h.result)).toEqual(["timeout"]);
    expect(gone(pid)).toBe(true);
    expect(row("hung").leaseOwner).toBeNull();
    expect(sched.getInFlightTasks()).toEqual([]);

    await sched.executeTask("hung", tick());
    expect(starts).toBe(2);
    expect(history("hung").map((h) => h.result)).toEqual(["timeout", "success"]);
  });

  it("destroys a hung HTTP request and sends no retry after the abort", async () => {
    let requests = 0;
    let closed = 0;
    const server = http.createServer((req) => {
      requests++;
      req.socket.on("close", () => closed++);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      seedRow("fetcher", { timeoutMs: 300 });
      const client = new ResilientHttpClient({ allowHttpOnLoopback: true, baseTimeout: 60_000, maxRetries: 3 });
      const sched = scheduler({
        fetcher: async () => {
          await client.request(`http://127.0.0.1:${port}/hang`);
          return { shouldWake: false };
        },
      });
      await sched.executeTask("fetcher", tick());
      expect(row("fetcher").lastResult).toBe("timeout");
      expect(row("fetcher").leaseOwner).toBeNull();
      await expect.poll(() => closed).toBe(1);
      await new Promise((r) => setTimeout(r, 300));
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("drops the wake of a task that ignores the abort and settles late", async () => {
    seedRow("late", { timeoutMs: 30 });
    const wakes: string[] = [];
    const sched = scheduler(
      {
        late: async () => {
          await new Promise((r) => setTimeout(r, 150));
          return { shouldWake: true, message: "late result" };
        },
      },
      { onWake: (r) => wakes.push(r) },
    );
    await sched.executeTask("late", tick());
    await sched.drain(2_000);
    expect(row("late").lastResult).toBe("timeout");
    expect(row("late").leaseOwner).toBeNull();
    expect(wakeCount()).toBe(0);
    expect(wakes).toEqual([]);
  });
});

describe("shutdown", () => {
  it("aborts the running task: drain is quick, the run is 'skipped', no fail_count, no wake, group gone", async () => {
    const pidFile = path.join(tmp, "pid");
    class HangingConway extends MockConwayClient {
      async exec(): Promise<ExecResult> {
        return execLocalCommand(`echo $$ > '${pidFile}'; sleep 60 & sleep 60; wait`, 120_000);
      }
    }
    const daemon = createHeartbeatDaemon({
      identity: createTestIdentity(),
      config: createTestConfig(),
      heartbeatConfig: {
        entries: [{ name: "health_check", schedule: "* * * * *", task: "health_check", enabled: true }],
        defaultIntervalMs: 60_000,
        lowComputeMultiplier: 4,
      },
      db,
      rawDb: db.raw,
      conway: new HangingConway(),
    });
    const failBefore = row("health_check").failCount;
    daemon.start();
    const pid = await readPid(pidFile);

    daemon.stop();
    const started = Date.now();
    await daemon.drain(5_000);
    expect(Date.now() - started).toBeLessThan(4_000);

    const runs = history("health_check");
    expect(runs).toHaveLength(1);
    expect(runs[0].result).toBe("skipped");
    expect(runs[0].error).toContain("cancelled: runtime shutdown");
    expect(row("health_check").failCount).toBe(failBefore);
    expect(row("health_check").nextRunAt).toBeNull();
    // Due again after a restart.
    expect(row("health_check").lastRunAt).toBeNull();
    expect(row("health_check").leaseOwner).toBeNull();
    expect(wakeCount()).toBe(0);
    expect(db.getKV("health_check_status")).toBeUndefined();
    expect(gone(pid)).toBe(true);
  });

  it("a run that completes despite the shutdown is a success and keeps its wake row", async () => {
    seedRow("finisher");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const wakes: string[] = [];
    const sched = scheduler(
      {
        finisher: async () => {
          await gate;
          return { shouldWake: true, message: "finished anyway" };
        },
      },
      { onWake: (r) => wakes.push(r) },
    );
    const run = sched.executeTask("finisher", tick());
    await new Promise((r) => setTimeout(r, 20));
    sched.stop();
    release();
    await run;
    expect(history("finisher").map((h) => h.result)).toEqual(["success"]);
    // The row is handled at the next start; the stopping loop is not notified.
    expect(wakeCount()).toBe(1);
    expect(wakes).toEqual([]);
  });

  it("no task starts once the scheduler is stopped", async () => {
    seedRow("never");
    let ran = 0;
    const sched = scheduler({ never: async () => (ran++, { shouldWake: false }) });
    sched.stop();
    await sched.executeTask("never", tick());
    expect(ran).toBe(0);
    sched.resume();
    await sched.executeTask("never", tick());
    expect(ran).toBe(1);
  });

  it("a cancelled run does not count as a consecutive failure for retries", async () => {
    seedRow("flaky", { maxRetries: 1 });
    insertHeartbeatHistory(db.raw, {
      id: "h-skipped",
      taskName: "flaky",
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      completedAt: new Date(Date.now() - 1_000).toISOString(),
      result: "skipped",
      durationMs: 1_000,
      error: "cancelled: runtime shutdown after 1000 ms",
      idempotencyKey: null,
    });
    const sched = scheduler({
      flaky: async () => {
        throw new Error("boom");
      },
    });
    await sched.executeTask("flaky", tick());
    expect(row("flaky").lastResult).toBe("failure");
    // One real failure: still within maxRetries, so a retry is scheduled.
    expect(row("flaky").nextRunAt).not.toBeNull();
  });
});

describe("built-in tasks on abort", () => {
  it("memory_maintenance: stops between steps once aborted and records no counts", async () => {
    const ctl = new AbortController();
    const reason = new TaskAbortedError("timeout", "cancelled: timed out");
    ctl.abort(reason);
    await expect(
      runWithCancellation(ctl.signal, () => BUILTIN_TASKS.memory_maintenance(tick(), legacy())),
    ).rejects.toBe(reason);
    expect(db.getKV("last_memory_maintenance")).toBeUndefined();
  });

  it("memory_maintenance runs in its task scope in standalone mode", async () => {
    seedRow("memory_maintenance");
    let scoped: AbortSignal | undefined;
    const sched = scheduler(
      {
        memory_maintenance: async (ctx, taskCtx) => {
          scoped = currentCancellationSignal();
          return BUILTIN_TASKS.memory_maintenance(ctx, taskCtx);
        },
      },
      { legacy: legacy({ config: createTestConfig({ conwayApiKey: "", socialRelayUrl: "", openaiApiKey: "sk" }) }) },
    );
    await sched.executeTask("memory_maintenance", tick());
    expect(scoped).toBeInstanceOf(AbortSignal);
    expect(row("memory_maintenance").lastResult).toBe("success");
    expect(db.getKV("last_memory_maintenance")).toBeDefined();
  });

  it("health_check: an aborted probe leaves health_check_status unset and wakes nobody", async () => {
    seedRow("health_check", { timeoutMs: 200 });
    class SlowConway extends MockConwayClient {
      async exec(): Promise<ExecResult> {
        await untilAborted();
        // What a destroyed remote request looks like to the task.
        throw new Error("fetch failed");
      }
    }
    const wakes: string[] = [];
    const sched = scheduler(
      { health_check: BUILTIN_TASKS.health_check },
      { legacy: legacy({ conway: new SlowConway() }), onWake: (r) => wakes.push(r) },
    );
    await sched.executeTask("health_check", tick());
    expect(row("health_check").lastResult).toBe("timeout");
    expect(db.getKV("health_check_status")).toBeUndefined();
    expect(wakeCount()).toBe(0);
    expect(wakes).toEqual([]);
  });

  it("check_social_inbox: an aborted poll sets no backoff and no error", async () => {
    seedRow("check_social_inbox", { timeoutMs: 200 });
    const social: SocialClientInterface = {
      send: async () => ({ id: "x" }),
      unreadCount: async () => 0,
      poll: async () => {
        await untilAborted();
        throw new Error("socket hang up");
      },
    };
    const sched = scheduler({ check_social_inbox: BUILTIN_TASKS.check_social_inbox }, { legacy: legacy({ social }) });
    await sched.executeTask("check_social_inbox", tick());
    expect(row("check_social_inbox").lastResult).toBe("timeout");
    expect(db.getKV("social_inbox_backoff_until")).toBeUndefined();
    expect(db.getKV("last_social_inbox_error")).toBeUndefined();
  });

  it("check_child_health: an aborted probe makes no transition and writes no last_checked", async () => {
    seedRow("check_child_health", { timeoutMs: 200 });
    const lifecycle = new ChildLifecycle(db.raw);
    lifecycle.initChild("child-1", "kid", "sandbox-1", "genesis");
    for (const s of ["sandbox_created", "runtime_ready", "wallet_verified", "funded", "starting", "healthy"] as const) {
      lifecycle.transition("child-1", s);
    }
    db.raw.prepare("UPDATE children SET last_checked = '2000-01-01 00:00:00' WHERE id = 'child-1'").run();
    class ProbeConway extends MockConwayClient {
      createScopedClient(): ConwayClient {
        return this;
      }
      async exec(): Promise<ExecResult> {
        await untilAborted();
        throw new Error("fetch failed");
      }
      // Would prove the sandbox gone if the aborted probe were trusted.
      async listSandboxes(): Promise<SandboxInfo[]> {
        return [{ id: "sandbox-other", status: "running" } as SandboxInfo];
      }
    }
    const sched = scheduler(
      { check_child_health: BUILTIN_TASKS.check_child_health },
      { legacy: legacy({ conway: new ProbeConway() }) },
    );
    await sched.executeTask("check_child_health", tick());
    expect(row("check_child_health").lastResult).toBe("timeout");
    expect(lifecycle.getCurrentState("child-1")).toBe("healthy");
    const child = db.raw.prepare("SELECT last_checked FROM children WHERE id = 'child-1'").get() as { last_checked: string | null };
    expect(child.last_checked).toBe("2000-01-01 00:00:00");
    expect(db.getKV("child_health.last_states")).toBeUndefined();
  });

  it("check_for_updates: a hanging git fetch is killed and does not block timers", async () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const pidFile = path.join(tmp, "git.pid");
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = "fetch" ]; then echo $$ > "$GIT_STUB_PIDFILE"; exec sleep 60; fi\necho stub\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${ORIGINAL_PATH}`;
    process.env.GIT_STUB_PIDFILE = pidFile;

    seedRow("check_for_updates", { timeoutMs: 400 });
    const sched = scheduler({ check_for_updates: BUILTIN_TASKS.check_for_updates });
    let timerTicks = 0;
    const interval = setInterval(() => timerTicks++, 50);
    const started = Date.now();
    try {
      await sched.executeTask("check_for_updates", tick());
    } finally {
      clearInterval(interval);
    }
    const pid = await readPid(pidFile);
    expect(Date.now() - started).toBeLessThan(4_000);
    // The event loop kept running while git hung.
    expect(timerTicks).toBeGreaterThanOrEqual(4);
    expect(row("check_for_updates").lastResult).toBe("timeout");
    expect(gone(pid, false)).toBe(true);
    expect(db.getKV("upstream_status")).toBeUndefined();
  });

  it("check_for_updates still records a failed fetch as upstream_status", async () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = "fetch" ]; then echo "fatal: no remote https://u:secret@x/y" >&2; exit 128; fi\necho stub\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${ORIGINAL_PATH}`;
    const result = await BUILTIN_TASKS.check_for_updates(tick(), legacy());
    expect(result.shouldWake).toBe(false);
    const status = JSON.parse(db.getKV("upstream_status")!);
    expect(status.error).toContain("exit 128");
    expect(status.error).not.toContain("secret");
  });
});
