/**
 * An empty child sandbox id ("", whitespace, "undefined", "null") makes the
 * Conway client run on this machine. No child path may reach that client:
 * scoped clients refuse such ids, a create answer without an id is an
 * error held as unknown, and the child tools, spawn, health probe and kill
 * all stop before touching it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A local exec spawns /bin/sh: record it instead, so a regression never runs
// child setup commands on the test machine.
const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnSpy },
    spawn: spawnSpy,
  };
});

import { createConwayClient } from "../conway/client.js";
import { spawnChild } from "../replication/spawn.js";
import { ChildLifecycle } from "../replication/lifecycle.js";
import { ChildHealthMonitor, killChildProcess } from "../replication/health.js";
import { createBuiltinTools } from "../agent/tools.js";
import { resetTreasuryForTests } from "../treasury/index.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import { makeHarness, type Harness } from "./treasury/harness.js";
import type {
  AutomatonDatabase,
  ConwayClient,
  CreateSandboxOptions,
  ExecResult,
  GenesisConfig,
  SandboxInfo,
  ToolContext,
} from "../types.js";

const EMPTY_IDS = ["", "  ", "undefined", "null"];
const API = "https://api.conway.tech";
const identity = createTestIdentity();

function genesis(name: string): GenesisConfig {
  return { name, genesisPrompt: "Own mission", creatorAddress: identity.address, parentAddress: identity.address };
}

function sandboxInfo(id: string, status = "running"): SandboxInfo {
  return { id, status, region: "x", vcpu: 1, memoryMb: 1024, diskGb: 10, createdAt: new Date().toISOString() };
}

/** Conway fake that logs every exec (parent or scoped) and every scoped id. */
class RecordingConway extends MockConwayClient {
  log: Array<{ sandbox: string; command: string }> = [];
  scopedIds: string[] = [];
  created: CreateSandboxOptions[] = [];
  sandboxes: SandboxInfo[] = [];
  listCalls = 0;
  createAnswer: () => SandboxInfo = () => sandboxInfo(`new-sbx-${this.created.length}`);
  scopedExec: (sandboxId: string, command: string) => Promise<ExecResult> = async () => ({
    stdout: "ok",
    stderr: "",
    exitCode: 0,
  });

  async exec(command: string): Promise<ExecResult> {
    this.log.push({ sandbox: "parent", command });
    return { stdout: "ok", stderr: "", exitCode: 0 };
  }

  async createSandbox(options: CreateSandboxOptions): Promise<SandboxInfo> {
    this.created.push(options);
    const info = this.createAnswer();
    this.sandboxes.push(info);
    return info;
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    this.listCalls += 1;
    return this.sandboxes;
  }

  createScopedClient(sandboxId: string): ConwayClient {
    this.scopedIds.push(sandboxId);
    const outer = this;
    const scoped = Object.create(this) as RecordingConway;
    scoped.exec = async (command: string) => {
      outer.log.push({ sandbox: sandboxId, command });
      return outer.scopedExec(sandboxId, command);
    };
    return scoped;
  }
}

interface FetchCall {
  method: string;
  path: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Conway API stub: pricing, and POST /v1/sandboxes answering 201 with `createBody`. */
function stubConway(createBody: unknown): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path: url.pathname });
      if (method === "GET" && url.pathname === "/v1/credits/pricing") {
        // A priced tier for every size used here (a child's default is 1024 MB):
        // an unpriced sandbox is refused before the POST.
        return json(200, {
          tiers: [
            { name: "s", vcpu: 1, memory_mb: 512, disk_gb: 5, monthly_cents: 600 },
            { name: "m", vcpu: 1, memory_mb: 1024, disk_gb: 10, monthly_cents: 1200 },
          ],
        });
      }
      if (method === "POST" && url.pathname === "/v1/sandboxes") return json(201, createBody);
      throw new Error(`unexpected request ${method} ${url.pathname}`);
    }),
  );
  return calls;
}

let harnesses: Harness[] = [];
let db: AutomatonDatabase;

beforeEach(() => {
  spawnSpy.mockReset();
  spawnSpy.mockImplementation(() => {
    throw new Error("local spawn attempted");
  });
  db = createTestDb();
});

afterEach(() => {
  for (const h of harnesses) h.close();
  harnesses = [];
  db.close();
  resetTreasuryForTests();
  vi.unstubAllGlobals();
});

describe("scoped clients refuse local-looking ids", () => {
  it.each(EMPTY_IDS)("createScopedClient(%j) throws and runs nothing here", async (id) => {
    const calls = stubConway({ id: "unused" });
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "parent-sbx" });
    expect(() => client.createScopedClient(id)).toThrow(/empty sandbox id/);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("a real sandbox id still gives a remote client", async () => {
    stubConway({ id: "unused" });
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "" });
    expect(() => client.createScopedClient("sbx-child")).not.toThrow();
  });
});

describe("a sandbox create answer without an id", () => {
  it.each([{}, { id: "" }, { sandbox_id: "undefined" }])(
    "%j throws and the ledger row stays unknown (money may have left)",
    async (body) => {
      const h = makeHarness({ balance: 100_000, install: false });
      harnesses.push(h);
      const calls = stubConway(body);
      const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });

      await expect(client.createSandbox({ name: "box" })).rejects.toThrow(/no id/);

      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(h.rows("infra", "unknown")).toHaveLength(1);
      expect(h.rows("infra", "committed")).toHaveLength(0);
      expect(h.rows("infra", "released")).toHaveLength(0);
    },
  );

  it.each([{}, { sandbox_id: "undefined" }])("spawnChild over the real client (create answer %j) stops before any setup command runs anywhere", async (body) => {
    const h = makeHarness({ balance: 100_000, install: false });
    harnesses.push(h);
    const calls = stubConway(body);
    const client = createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury });
    const lifecycle = new ChildLifecycle(h.db.raw);

    await expect(spawnChild(client, identity, h.db, genesis("kid"), lifecycle, { maxChildren: 3 })).rejects.toThrow();

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(calls.map((c) => `${c.method} ${c.path}`).filter((c) => c.startsWith("POST"))).toEqual([
      "POST /v1/sandboxes",
    ]);
    const [child] = h.db.getChildren();
    expect(lifecycle.getCurrentState(child.id)).toBe("failed");
  });

  it.each(EMPTY_IDS)("spawnChild with a backend that returns id %j never execs or scopes", async (id) => {
    const conway = new RecordingConway();
    conway.createAnswer = () => sandboxInfo(id);

    await expect(
      spawnChild(conway, identity, db, genesis("kid"), new ChildLifecycle(db.raw), { maxChildren: 3 }),
    ).rejects.toThrow(/no id/);

    expect(conway.log).toEqual([]);
    expect(conway.scopedIds).toEqual([]);
  });

  it("the legacy spawn path (no lifecycle) refuses the same way", async () => {
    const conway = new RecordingConway();
    conway.createAnswer = () => sandboxInfo("");

    await expect(spawnChild(conway, identity, db, genesis("kid"), undefined, { maxChildren: 3 })).rejects.toThrow(
      /no id/,
    );
    expect(conway.log).toEqual([]);
    expect(conway.scopedIds).toEqual([]);
  });
});

describe("sandbox reuse skips local-looking ids", () => {
  it("a failed child whose sandbox id is 'undefined' is never reused", async () => {
    const lifecycle = new ChildLifecycle(db.raw);
    lifecycle.initChild("old", "old", "undefined", "genesis");
    lifecycle.transition("old", "failed", "test");
    const conway = new RecordingConway();
    conway.sandboxes.push(sandboxInfo("undefined"));
    conway.scopedExec = async (_id, command) =>
      command.includes("busy") ? { stdout: "idle", stderr: "", exitCode: 0 } : { stdout: "ok", stderr: "", exitCode: 0 };

    // The rest of the spawn may fail on the fake's answers; only the sandbox choice matters.
    await spawnChild(conway, identity, db, genesis("kid"), new ChildLifecycle(db.raw), { maxChildren: 3 }).catch(
      () => undefined,
    );

    expect(conway.created).toHaveLength(1);
    expect(conway.scopedIds).not.toContain("undefined");
    expect(conway.log.some((entry) => entry.sandbox === "undefined")).toBe(false);
  });
});

describe("child tools refuse before any lifecycle transition", () => {
  function fundedChild(id: string, sandboxId: string): void {
    const lifecycle = new ChildLifecycle(db.raw);
    lifecycle.initChild(id, id, sandboxId, "genesis");
    db.raw.prepare("UPDATE children SET address = ? WHERE id = ?").run(`0x${"ab".repeat(20)}`, id);
    for (const s of ["sandbox_created", "runtime_ready", "wallet_verified", "funded"] as const) {
      lifecycle.transition(id, s);
    }
  }

  function events(id: string): number {
    return db.raw.prepare("SELECT COUNT(*) FROM child_lifecycle_events WHERE child_id = ?").pluck().get(id) as number;
  }

  function ctx(conway: ConwayClient): ToolContext {
    return {
      identity,
      config: createTestConfig(),
      db,
      conway,
      inference: new MockInferenceClient(),
    } as ToolContext;
  }

  async function runTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
    const tool = createBuiltinTools("test-sandbox").find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute(args, context);
  }

  it.each(EMPTY_IDS)("start_child with sandbox id %j", async (id) => {
    fundedChild("kid", id);
    const before = events("kid");
    const conway = new RecordingConway();

    const out = await runTool("start_child", { child_id: "kid" }, ctx(conway));

    expect(out).toBe("Child kid has no sandbox id; refusing to run its setup on this machine.");
    expect(new ChildLifecycle(db.raw).getCurrentState("kid")).toBe("funded");
    expect(events("kid")).toBe(before);
    expect(conway.scopedIds).toEqual([]);
    expect(conway.log).toEqual([]);
  });

  it.each(EMPTY_IDS)("verify_child_constitution with sandbox id %j", async (id) => {
    fundedChild("kid", id);
    const before = events("kid");
    const conway = new RecordingConway();

    const out = await runTool("verify_child_constitution", { child_id: "kid" }, ctx(conway));

    expect(out).toBe("Child kid has no sandbox id; refusing to run its setup on this machine.");
    expect(events("kid")).toBe(before);
    expect(conway.scopedIds).toEqual([]);
    expect(conway.log).toEqual([]);
  });
});

describe("health probe and kill with an empty id", () => {
  it.each(EMPTY_IDS)("killChildProcess(%j) is unknown without listing sandboxes", async (id) => {
    const conway = new RecordingConway();
    // What a local client would answer for a gone process: the exec fails and
    // the listing has no such sandbox, which reads as "stopped".
    conway.scopedExec = async () => {
      throw new Error("exec failed");
    };

    const result = await killChildProcess(conway, id);

    expect(result).toEqual({ outcome: "unknown", detail: "child has no sandbox id" });
    expect(conway.listCalls).toBe(0);
    expect(conway.scopedIds).toEqual([]);
  });

  it.each(["undefined", "null", "  "])("the probe does not scope a client for sandbox id %j", async (id) => {
    const lifecycle = new ChildLifecycle(db.raw);
    lifecycle.initChild("kid", "kid", id, "genesis");
    const conway = new RecordingConway();
    const monitor = new ChildHealthMonitor(db.raw, conway, lifecycle);

    const result = await monitor.checkHealth("kid");

    expect(result.healthy).toBe(false);
    expect(result.issues).toContain("child has no sandbox");
    expect(conway.scopedIds).toEqual([]);
  });
});
