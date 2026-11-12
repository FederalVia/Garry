/**
 * Cooperative shutdown: the first signal lets the in-flight step finish and
 * the cleanup run, then exits 0; a step that never ends, or a second
 * signal, forces exit 1 within the grace period.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createShutdownController,
  resolveShutdownGraceMs,
  withDeadline,
  finishShutdown,
  DEFAULT_SHUTDOWN_GRACE_MS,
  type ShutdownSteps,
} from "../runtime/shutdown.js";

const REPO = path.resolve(__dirname, "../..");
const SHUTDOWN_MODULE = path.join(REPO, "src/runtime/shutdown.ts");

describe("shutdown controller", () => {
  it("sleep resolves true when it runs out and false as soon as a stop is requested", async () => {
    const ctl = createShutdownController();
    expect(await ctl.sleep(5)).toBe(true);
    const start = Date.now();
    const pending = ctl.sleep(10_000);
    setTimeout(() => ctl.requestStop("SIGTERM"), 20);
    expect(await pending).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(await ctl.sleep(10_000)).toBe(false);
  });

  it("requestStop is idempotent and keeps the first reason", () => {
    const ctl = createShutdownController();
    expect(ctl.stopping).toBe(false);
    expect(ctl.requestStop("SIGTERM")).toBe(true);
    expect(ctl.requestStop("SIGINT")).toBe(false);
    expect(ctl.stopping).toBe(true);
    expect(ctl.reason).toBe("SIGTERM");
    expect(ctl.signal.aborted).toBe(true);
  });

  it("withDeadline returns the value, or undefined on timeout or rejection", async () => {
    expect(await withDeadline(Promise.resolve(7), 100)).toBe(7);
    expect(await withDeadline(new Promise(() => {}), 20)).toBeUndefined();
    expect(await withDeadline(Promise.reject(new Error("x")), 100)).toBeUndefined();
  });

  it("reads the grace period from AUTOMATON_SHUTDOWN_GRACE_MS", () => {
    expect(resolveShutdownGraceMs({})).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(resolveShutdownGraceMs({ AUTOMATON_SHUTDOWN_GRACE_MS: "300" })).toBe(300);
    expect(resolveShutdownGraceMs({ AUTOMATON_SHUTDOWN_GRACE_MS: "nope" })).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(resolveShutdownGraceMs({ AUTOMATON_SHUTDOWN_GRACE_MS: "-5" })).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
  });
});

describe("finishShutdown (the entrypoint's clean-stop sequence)", () => {
  function recordingSteps(overrides: Partial<ShutdownSteps> = {}): { steps: ShutdownSteps; calls: string[] } {
    const calls: string[] = [];
    const steps: ShutdownSteps = {
      remainingMs: () => 1000,
      stopHeartbeat: () => void calls.push("stopHeartbeat"),
      drainHeartbeat: async (ms) => void calls.push(`drainHeartbeat:${ms}`),
      drainWorkers: async (ms) => void calls.push(`drainWorkers:${ms}`),
      leaveState: () => void calls.push("leaveState"),
      releaseLock: () => void calls.push("releaseLock"),
      closeDb: () => void calls.push("closeDb"),
      ...overrides,
    };
    return { steps, calls };
  }

  it("stops and drains the heartbeat, then drains the workers, before saving state and closing", async () => {
    const { steps, calls } = recordingSteps();
    await finishShutdown(steps);
    expect(calls).toEqual([
      "stopHeartbeat",
      "drainHeartbeat:1000",
      "drainWorkers:1000",
      "leaveState",
      "releaseLock",
      "closeDb",
    ]);
  });

  it("waits for the workers to settle before the database is closed", async () => {
    const calls: string[] = [];
    const { steps } = recordingSteps({
      drainWorkers: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            calls.push("workers settled");
            resolve(undefined);
          }, 50),
        ),
      closeDb: () => void calls.push("closeDb"),
    });
    await finishShutdown(steps);
    expect(calls).toEqual(["workers settled", "closeDb"]);
  });

  it("bounds each wait by the remaining grace and still closes after failures", async () => {
    const calls: string[] = [];
    const { steps } = recordingSteps({
      remainingMs: () => 100,
      stopHeartbeat: () => {
        throw new Error("boom");
      },
      drainHeartbeat: () => new Promise(() => {}),
      drainWorkers: async () => {
        throw new Error("worker boom");
      },
      leaveState: () => void calls.push("leaveState"),
      releaseLock: () => {
        throw new Error("lock boom");
      },
      closeDb: () => void calls.push("closeDb"),
    });
    const start = Date.now();
    await finishShutdown(steps);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(calls).toEqual(["leaveState", "closeDb"]);
  });
});

describe("shutdown signals in a process", () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-"));
    fs.writeFileSync(
      path.join(dir, "runtime.mts"),
      `import fs from "node:fs";
import { createShutdownController, installShutdownSignals, resolveShutdownGraceMs } from ${JSON.stringify(SHUTDOWN_MODULE)};
const [mode, dir] = process.argv.slice(2);
const ctl = createShutdownController();
installShutdownSignals({
  controller: ctl,
  graceMs: resolveShutdownGraceMs(),
  forceExit: (why) => { fs.writeFileSync(dir + "/forced", String(why)); process.exit(1); },
});
// The step in flight when the signal arrives; it is not cancelled. A hung
// step holds a handle, as a stuck request holds its socket.
const step = mode === "hang"
  ? new Promise(() => { setInterval(() => {}, 1000); })
  : new Promise((resolve) => setTimeout(() => { fs.writeFileSync(dir + "/step-done", "1"); resolve(undefined); }, 500));
process.stdout.write("ready\\n");
await step;
while (!ctl.stopping) await ctl.sleep(60_000);
fs.writeFileSync(dir + "/cleanup", "1");
process.exit(0);
`,
    );
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

  async function start(mode: "step" | "hang", env: Record<string, string> = {}): Promise<ChildProcess> {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(dir, "runtime.mts"), mode, dir], {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let err = "";
      const timer = setTimeout(() => reject(new Error(`child not ready: ${err}`)), 20_000);
      child.stdout!.on("data", (d) => {
        if (String(d).includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr!.on("data", (d) => (err += String(d)));
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited early (${code}): ${err}`));
      });
    });
    return child;
  }

  function exitOf(child: ChildProcess): Promise<{ code: number | null; ms: number }> {
    const t0 = Date.now();
    return new Promise((resolve) => child.once("exit", (code) => resolve({ code, ms: Date.now() - t0 })));
  }

  it("SIGTERM lets the in-flight step finish, runs cleanup and exits 0", { timeout: 60_000 }, async () => {
    const child = await start("step");
    const exited = exitOf(child);
    child.kill("SIGTERM");
    const { code } = await exited;
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, "step-done"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "cleanup"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "forced"))).toBe(false);
  });

  it("a step that never ends is forced out with exit 1 at the grace deadline", { timeout: 60_000 }, async () => {
    const child = await start("hang", { AUTOMATON_SHUTDOWN_GRACE_MS: "300" });
    const exited = exitOf(child);
    child.kill("SIGTERM");
    const { code, ms } = await exited;
    expect(code).toBe(1);
    expect(ms).toBeLessThan(5000);
    expect(fs.readFileSync(path.join(dir, "forced"), "utf8")).toBe("deadline");
    expect(fs.existsSync(path.join(dir, "cleanup"))).toBe(false);
  });

  it("a second signal forces exit 1 at once", { timeout: 60_000 }, async () => {
    const child = await start("hang", { AUTOMATON_SHUTDOWN_GRACE_MS: "60000" });
    const exited = exitOf(child);
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.kill("SIGINT");
    const { code, ms } = await exited;
    expect(code).toBe(1);
    expect(ms).toBeLessThan(5000);
    expect(fs.readFileSync(path.join(dir, "forced"), "utf8")).toBe("SIGINT");
  });
});
