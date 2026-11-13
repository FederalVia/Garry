/**
 * The Conway client and the worker harness decide "is this machine local?"
 * with one check, so a command or file write never takes the remote path in
 * one place and the plain local fs path in the other. Workers carry the
 * parent's sandbox id, so parent tools a worker calls take the parent's path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentHarness, HarnessContext, HarnessTool } from "../agent/harness-types.js";
import type { TaskNode, TaskResult } from "../orchestration/task-graph.js";
import type { AutomatonIdentity } from "../types.js";

const savedHome = process.env.HOME;
let home: string;

let isLocalSandboxId: typeof import("../conway/client.js").isLocalSandboxId;
let createConwayClient: typeof import("../conway/client.js").createConwayClient;
let isLocalMode: typeof import("../agent/harnesses/worker-fs-tools.js").isLocalMode;
let LocalWorkerPool: typeof import("../orchestration/local-worker.js").LocalWorkerPool;
let HarnessRegistry: typeof import("../agent/harness-registry.js").HarnessRegistry;
let createBuiltinTools: typeof import("../agent/tools.js").createBuiltinTools;
let mocks: typeof import("./mocks.js");
let testDb: typeof import("./orchestration/test-db.js");

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-checks-home-")));
  process.env.HOME = home;
  // State paths are fixed when the modules load: import after HOME is set.
  const { vi } = await import("vitest");
  vi.resetModules();
  ({ isLocalSandboxId, createConwayClient } = await import("../conway/client.js"));
  ({ isLocalMode } = await import("../agent/harnesses/worker-fs-tools.js"));
  ({ LocalWorkerPool } = await import("../orchestration/local-worker.js"));
  ({ HarnessRegistry } = await import("../agent/harness-registry.js"));
  ({ createBuiltinTools } = await import("../agent/tools.js"));
  mocks = await import("./mocks.js");
  testDb = await import("./orchestration/test-db.js");
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("isLocalMode equals isLocalSandboxId", () => {
  const ids: Array<string | undefined> = [
    undefined,
    "",
    " ",
    "\t\n",
    "undefined",
    "null",
    "  undefined  ",
    " null",
    "sbx-123",
    "  sbx-123  ",
    "Undefined",
    "NULL",
    "local",
    "0",
  ];
  it.each(ids.map((id) => [JSON.stringify(id), id]))("sandboxId %s", (_label, id) => {
    const config = mocks.createTestConfig({ sandboxId: id as string });
    expect(isLocalMode(config)).toBe(isLocalSandboxId(id));
  });

  it("'undefined' and 'null' count as local for both", () => {
    for (const id of ["undefined", "null", "   "]) {
      expect(isLocalSandboxId(id)).toBe(true);
      expect(isLocalMode(mocks.createTestConfig({ sandboxId: id }))).toBe(true);
    }
  });
});

/** Captures the context a worker is started with. */
class CaptureHarness implements AgentHarness {
  readonly id = "capture";
  readonly description = "captures the worker context";
  static captured: HarnessContext | null = null;
  async initialize(_task: TaskNode, context: HarnessContext): Promise<void> {
    CaptureHarness.captured = context;
  }
  async execute(): Promise<TaskResult> {
    return { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };
  }
  getToolDefs(): HarnessTool[] {
    return [];
  }
  buildSystemPrompt(): string {
    return "";
  }
  buildTaskPrompt(): string {
    return "";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

/** Run one task in a pool whose parent has `parentSandboxId`; return the worker context. */
async function workerContext(parentSandboxId: string): Promise<HarnessContext> {
  const db = testDb.createInMemoryDb();
  db.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "goal-1",
    "Goal",
    "Goal description",
    "active",
    new Date().toISOString(),
  );
  db.prepare(
    `INSERT INTO task_graph (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, max_retries, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("task-1", "goal-1", "Task", "Task description", "pending", null, "capture", 50, "[]", 0, new Date().toISOString());
  const { getTaskNode } = await import("../orchestration/task-graph.js");
  const task = getTaskNode(db, "task-1")!;

  const registry = new HarnessRegistry();
  registry.register("capture", CaptureHarness);
  const parentIdentity: AutomatonIdentity = { ...mocks.createTestIdentity(), sandboxId: parentSandboxId };
  const config = mocks.createTestConfig({ sandboxId: parentSandboxId });
  const appDb = mocks.createTestDb();
  const conway = createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "x", sandboxId: parentSandboxId });
  const pool = new LocalWorkerPool({
    db,
    conway,
    inference: { chat: async () => ({ content: "done" }) },
    harnessRegistry: registry,
    identity: parentIdentity,
    config,
    allowedEditRoot: home,
    tools: createBuiltinTools(parentIdentity.sandboxId),
    toolContext: { identity: parentIdentity, config, db: appDb, conway, inference: new mocks.MockInferenceClient() },
  });
  CaptureHarness.captured = null;
  const spawned = pool.spawn(task);
  expect(spawned).not.toBeNull();
  await waitFor(() => CaptureHarness.captured !== null && pool.getActiveCount() === 0);
  await pool.shutdown();
  db.close();
  return CaptureHarness.captured!;
}

describe("worker identity keeps the parent's sandbox id", () => {
  it.each(["", "sbx-parent"])("parent sandbox id %j", async (parentSandboxId) => {
    const ctx = await workerContext(parentSandboxId);
    expect(ctx.identity.sandboxId).toBe(parentSandboxId);
    expect(ctx.toolContext?.identity.sandboxId).toBe(parentSandboxId);
    // The worker is still told apart by its own address and name.
    expect(ctx.identity.address).toMatch(/^local:\/\/local-worker-/);
    expect(ctx.identity.name).toMatch(/^worker-capture-/);
  });
});

describe("a worker's parent write_file under a local parent takes the hardened path", () => {
  const PRIVATE = `{"privateKey":"0x${"11".repeat(32)}"}`;
  let wallet: string;
  let link: string;

  beforeEach(() => {
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    wallet = path.join(home, ".automaton", "wallet.json");
    fs.writeFileSync(wallet, PRIVATE, { mode: 0o600 });
    link = path.join(home, "notes.txt");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(wallet, link);
  });

  it("a link to wallet.json is refused by writeFileVerified and the wallet is unchanged", async () => {
    const ctx = await workerContext("");
    const writeFile = ctx.toolCatalog!.find((t) => t.name === "write_file")!;

    const out = await writeFile.execute({ path: link, content: "overwritten" }, ctx.toolContext!);

    expect(out).toMatch(/^Blocked: /);
    expect(out).toMatch(/symbolic link|protected path/);
    expect(fs.readFileSync(wallet, "utf8")).toBe(PRIVATE);
  });
});
