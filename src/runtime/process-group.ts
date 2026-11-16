/**
 * Long-lived child processes in their own process groups (MCP servers,
 * tunnels).
 *
 * Every signal goes to the whole group: launchers such as npx start the real
 * program as a grandchild, which a signal to the direct child would leave
 * behind. A process exit hook SIGKILLs every group still alive, so a forced
 * exit leaves nothing running.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killLiveGroups(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  liveGroups.clear();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", killLiveGroups);
  // Node's default SIGHUP action ends the process without an exit event, and
  // the groups (their own sessions) never see the hangup. When nothing else
  // handles SIGHUP, stop them and exit as the default action would.
  process.on("SIGHUP", () => {
    if (process.listenerCount("SIGHUP") > 1) return;
    killLiveGroups();
    process.exit(129);
  });
}

/** Signal a whole group; false when it no longer exists. */
export function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Process groups started here and still alive (for tests and diagnostics). */
export function liveProcessGroups(): number[] {
  return [...liveGroups];
}

export interface SpawnInGroupOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Create cwd (0700) when missing. */
  createCwd?: boolean;
  /** stdin: "pipe" (MCP stdio) or "ignore" (tunnels). stdout and stderr are always piped. */
  stdin?: "pipe" | "ignore";
}

/** Start a program in its own process group with piped output and no shell. */
export function spawnInGroup(opts: SpawnInGroupOptions): ChildProcess {
  if (opts.createCwd && opts.cwd) fs.mkdirSync(opts.cwd, { recursive: true, mode: 0o700 });
  installExitHook();
  const child = spawn(opts.command, opts.args, {
    shell: false,
    detached: true,
    stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
  });
  const pid = child.pid;
  if (typeof pid === "number") {
    liveGroups.add(pid);
    child.once("exit", () => {
      // The group may outlive its leader (a grandchild that ignored SIGTERM);
      // a last SIGKILL makes sure nothing of it stays.
      signalGroup(pid, "SIGKILL");
      liveGroups.delete(pid);
    });
  }
  return child;
}

/**
 * Stop a group: close stdin, SIGTERM the group, SIGKILL after graceMs.
 * Resolves once the leader exited or after graceMs + 1 s, whichever is first.
 */
export function terminateGroup(child: ChildProcess, graceMs = 2_000): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== "number") return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) {
    signalGroup(pid, "SIGKILL");
    liveGroups.delete(pid);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(giveUp);
      resolve();
    };
    child.once("exit", finish);
    try {
      child.stdin?.end();
    } catch {
      // stdin already closed
    }
    signalGroup(pid, "SIGTERM");
    const killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), graceMs);
    const giveUp = setTimeout(() => {
      signalGroup(pid, "SIGKILL");
      liveGroups.delete(pid);
      finish();
    }, graceMs + 1_000);
    killTimer.unref?.();
    giveUp.unref?.();
  });
}

/** SIGKILL a group at once. */
export function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid !== "number") return;
  signalGroup(pid, "SIGKILL");
}
