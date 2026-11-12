/**
 * Local exec: runs without blocking the event loop, kills the whole process
 * group on timeout, lets background jobs outlive the command, and never
 * hands the runtime's credentials to the command.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConwayClient } from "../conway/client.js";
import { createBuiltinTools } from "../agent/tools.js";
import { MockConwayClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { ToolContext } from "../types.js";

const savedEnv = { ...process.env };
let dir: string;
const groupsToKill: number[] = [];
const pidsToKill: number[] = [];

function localClient() {
  return createConwayClient({ apiUrl: "https://api.conway.invalid", apiKey: "k", sandboxId: "" });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie waiting for its reaper is dead for our purposes.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-exec-"));
  process.env.HOME = dir;
});

afterEach(() => {
  for (const pgid of groupsToKill.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const pid of pidsToKill.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("local exec", () => {
  it("does not block the event loop while the command runs", async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 100);
    try {
      const res = await localClient().exec("sleep 1", 10_000);
      expect(res.exitCode).toBe(0);
    } finally {
      clearInterval(interval);
    }
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  it("returns when the shell exits, even if a background job still holds stdout", async () => {
    const pgidFile = path.join(dir, "pgid");
    const started = Date.now();
    const res = await localClient().exec(`echo $$ > ${pgidFile}; (sleep 5; echo late) & echo started`, 3_000);
    const elapsed = Date.now() - started;
    const pgid = Number(fs.readFileSync(pgidFile, "utf8").trim());
    if (pgid > 0) groupsToKill.push(pgid);

    expect(elapsed).toBeLessThan(1_500);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("started");
    expect(res.stderr).not.toContain("ETIMEDOUT");
    // The background job keeps running after a normal exit.
    expect(() => process.kill(-pgid, 0)).not.toThrow();
  });

  it("kills the whole process group on timeout and returns 124", async () => {
    const pidFile = path.join(dir, "bg.pid");
    const started = Date.now();
    const res = await localClient().exec(`sleep 30 & echo $! > ${pidFile}; wait`, 500);
    const elapsed = Date.now() - started;
    const bgPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (bgPid > 0) pidsToKill.push(bgPid);

    expect(res.exitCode).toBe(124);
    expect(res.stderr).toContain("timed out");
    expect(elapsed).toBeLessThan(4_000);
    expect(await waitUntil(() => !alive(bgPid), 2_000)).toBe(true);
  });

  it("does not pass credential variables to the command", async () => {
    process.env.OPENAI_API_KEY = "sk-local-exec-secret";
    process.env.GITHUB_TOKEN = "ghp_local_exec_secret";
    process.env.CONWAY_API_KEY = "cnwy_local_exec_secret";
    const res = await localClient().exec("echo k=$OPENAI_API_KEY g=$GITHUB_TOKEN c=$CONWAY_API_KEY p=${PATH:+set}", 5_000);
    expect(res.stdout.trim()).toBe("k= g= c= p=set");
  });
});

describe("exec tool timeout bounds", () => {
  function run(timeout: unknown) {
    const conway = new MockConwayClient();
    const db = createTestDb();
    const tool = createBuiltinTools("test-sandbox").find((t) => t.name === "exec")!;
    const ctx = {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference: {} as ToolContext["inference"],
    } as ToolContext;
    return tool.execute({ command: "true", timeout }, ctx).then(() => {
      db.close();
      return conway.execCalls[0]?.timeout;
    });
  }

  it("clamps the model's timeout to 1 s .. 10 min, default 30 s", async () => {
    expect(await run(86_400_000)).toBe(600_000);
    expect(await run("soon")).toBe(30_000);
    expect(await run(undefined)).toBe(30_000);
    expect(await run(10)).toBe(1_000);
    expect(await run(45_000)).toBe(45_000);
  });
});
