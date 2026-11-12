/**
 * One local worker pool per database, shared by every wake cycle. Workers
 * outlive the cycle that spawned them, so the next cycle's liveness check
 * must see them; otherwise stale recovery resets a live worker's task and a
 * second worker runs it again.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as loop from "../agent/loop.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const identity = createTestIdentity();
const WORKER = "local://local-worker-01JTESTWORKER0000000000000";

describe("shared worker pool", () => {
  let db: AutomatonDatabase;
  let home: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    home = fs.mkdtempSync(path.join(os.tmpdir(), "worker-pool-"));
    process.env.HOME = home;
    db = createTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await loop.shutdownWorkerPools(1000);
    db.close();
    process.env = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function cycle(): Promise<void> {
    db.deleteKV("sleep_until");
    return loop.runAgentLoop({
      identity,
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient([noToolResponse("ok")]),
    });
  }

  it("a worker spawned in an earlier cycle is still alive for the next cycle's orchestrator", async () => {
    // A goal being executed, with a task assigned to a local worker that the
    // first cycle's pool is running.
    db.raw
      .prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES ('g1', 'Goal', 'd', 'active', ?)")
      .run(new Date().toISOString());
    db.raw
      .prepare(
        `INSERT INTO task_graph (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at)
         VALUES ('t1', 'g1', 'Task', 'd', 'assigned', ?, 'generalist', 50, '[]', ?)`,
      )
      .run(WORKER, new Date().toISOString());
    db.setKV(
      "orchestrator.state",
      JSON.stringify({ phase: "executing", goalId: "g1", replanCount: 0, failedTaskId: null, failedError: null }),
    );

    // The pool that exists during the first cycle is the one running WORKER.
    let firstPool: LocalWorkerPool | undefined;
    vi.spyOn(LocalWorkerPool.prototype, "getActiveCount").mockImplementation(function (this: LocalWorkerPool) {
      firstPool ??= this;
      return this === firstPool ? 1 : 0;
    });
    vi.spyOn(LocalWorkerPool.prototype, "hasWorker").mockImplementation(function (this: LocalWorkerPool, address: string) {
      firstPool ??= this;
      return this === firstPool && address === WORKER;
    });

    await cycle();
    const afterFirst = (loop as { getSharedWorkerPool?: (d: AutomatonDatabase) => unknown }).getSharedWorkerPool?.(db);
    await cycle();

    const task = db.raw.prepare("SELECT status, assigned_to FROM task_graph WHERE id = 't1'").get() as {
      status: string;
      assigned_to: string | null;
    };
    expect(task).toEqual({ status: "assigned", assigned_to: WORKER });
    expect(afterFirst).toBeDefined();
    expect(loop.getSharedWorkerPool(db)).toBe(afterFirst);
    expect(loop.getSharedWorkerPool(db)).toBe(firstPool);
  });

  it("shutdownWorkerPools aborts the workers and returns within its time limit", async () => {
    await cycle();
    const pool = loop.getSharedWorkerPool(db)!;
    let aborted = false;
    // A worker that only ends when aborted.
    (pool as any).activeWorkers.set("w", {
      promise: new Promise<void>(() => {}),
      abortController: { abort: () => { aborted = true; } },
    });
    const start = Date.now();
    await loop.shutdownWorkerPools(200);
    expect(aborted).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(loop.getSharedWorkerPool(db)).toBeUndefined();
  });
});
