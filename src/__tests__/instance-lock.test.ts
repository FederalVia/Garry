/**
 * One running agent per state database. A live holder in another process
 * refuses a second start, naming its pid; once the holder dies, even by
 * SIGKILL, the lock is free again (the OS drops it, so there is no stale
 * lock and no takeover race).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { acquireInstanceLock, InstanceLockedError, holdsInstanceLock } from "../state/instance-lock.js";
import { createBuiltinTools } from "../agent/tools.js";
import { createConwayClient } from "../conway/client.js";
import { createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { ToolContext } from "../types.js";

const REPO = path.resolve(__dirname, "../..");
const LOCK_MODULE = path.join(REPO, "src/state/instance-lock.ts");

describe("instance lock", () => {
  let dir: string;
  let lockPath: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "instance-lock-"));
    lockPath = path.join(dir, "state.db.lock");
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Start a process that takes the lock and holds it until killed. */
  async function startHolder(): Promise<ChildProcess> {
    const script = path.join(dir, "holder.mts");
    fs.writeFileSync(
      script,
      `import { acquireInstanceLock } from ${JSON.stringify(LOCK_MODULE)};
acquireInstanceLock(${JSON.stringify(lockPath)});
process.stdout.write("locked\\n");
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => reject(new Error(`holder did not lock in time: ${err}`)), 20_000);
      child.stdout!.on("data", (d) => {
        out += String(d);
        if (out.includes("locked")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr!.on("data", (d) => {
        err += String(d);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`holder exited early (${code}): ${err}`));
      });
    });
    return child;
  }

  it("refuses while another process holds it, naming that pid, and is free once the holder is killed", { timeout: 60_000 }, async () => {
    const holder = await startHolder();

    let caught: unknown;
    try {
      acquireInstanceLock(lockPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InstanceLockedError);
    expect((caught as InstanceLockedError).pid).toBe(holder.pid);
    expect((caught as InstanceLockedError).lockPath).toBe(path.resolve(lockPath));
    expect(holdsInstanceLock(lockPath)).toBe(false);

    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));

    const lock = acquireInstanceLock(lockPath);
    expect(holdsInstanceLock(lockPath)).toBe(true);
    lock.release();
    expect(holdsInstanceLock(lockPath)).toBe(false);
  });

  it("a lock file left by a dead process (any pid inside, even ours) does not block", () => {
    const first = acquireInstanceLock(lockPath);
    first.release();
    // The file stays, holding our pid, but no lock.
    expect(fs.existsSync(lockPath)).toBe(true);
    const again = acquireInstanceLock(lockPath);
    expect(holdsInstanceLock(lockPath)).toBe(true);
    again.release();
  });

  it("taking it twice in one process shares the lock until both handles are released", () => {
    const a = acquireInstanceLock(lockPath);
    const b = acquireInstanceLock(lockPath);
    a.release();
    expect(holdsInstanceLock(lockPath)).toBe(true);
    b.release();
    expect(holdsInstanceLock(lockPath)).toBe(false);
  });

  it("survives the agent reading or writing the lock file in this process, wherever it lives", { timeout: 60_000 }, async () => {
    const savedHome = process.env.HOME;
    const home = fs.realpathSync(dir);
    process.env.HOME = home;
    const db = createTestDb();
    const outside = path.join(home, "data", "state.db.lock");
    const lock = acquireInstanceLock(outside);
    try {
      const ctx = {
        identity: { ...createTestIdentity(), sandboxId: "" },
        config: { ...createTestConfig(), sandboxId: "" },
        db,
        conway: createConwayClient({ apiUrl: "https://api.conway.invalid", apiKey: "k", sandboxId: "" }),
        inference: {} as ToolContext["inference"],
      } as ToolContext;
      const tools = createBuiltinTools("");
      const read = tools.find((t) => t.name === "read_file")!;
      const write = tools.find((t) => t.name === "write_file")!;
      expect(await read.execute({ path: outside }, ctx)).toMatch(/^Blocked:/);
      expect(await read.execute({ path: "data/state.db.lock" }, ctx)).toMatch(/^Blocked:/);
      expect(await write.execute({ path: outside, content: "x" }, ctx)).toMatch(/^Blocked:/);

      // Another process is still refused: the lock was never dropped.
      const probe = `import(${JSON.stringify(LOCK_MODULE)}).then((m) => { try { m.acquireInstanceLock(process.argv[1]); console.log("ACQUIRED"); } catch (e) { console.log("REFUSED " + e.message); } })`;
      const out = execFileSync(process.execPath, ["--import", "tsx", "-e", probe, outside], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(out).toContain("REFUSED");
    } finally {
      lock.release();
      db.close();
      process.env.HOME = savedHome;
    }
  });
});
