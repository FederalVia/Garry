/**
 * Process groups of stdio MCP servers.
 *
 * Every server runs in its own process group, and every signal goes to the
 * whole group: launchers such as npx start the real server as a grandchild,
 * which a signal to the direct child would leave behind. A process exit hook
 * SIGKILLs every group still alive, so a forced exit leaves nothing running.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";

const liveGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pid of liveGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    liveGroups.clear();
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

/** Process groups of MCP servers still alive (for tests and diagnostics). */
export function liveMcpGroups(): number[] {
  return [...liveGroups];
}

export interface SpawnServerOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Create cwd (0700) when missing: the runtime-owned default directory. */
  createCwd: boolean;
}

/** Start a server in its own process group with piped stdio and no shell. */
export function spawnServerProcess(opts: SpawnServerOptions): ChildProcessWithoutNullStreams {
  if (opts.createCwd) fs.mkdirSync(opts.cwd, { recursive: true, mode: 0o700 });
  installExitHook();
  const child = spawn(opts.command, opts.args, {
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
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
 * Stop a server: close stdin, SIGTERM the group, SIGKILL after graceMs.
 * Resolves once the leader exited or after graceMs + 1 s, whichever is first.
 */
export function terminateServerProcess(child: ChildProcessWithoutNullStreams, graceMs = 2_000): Promise<void> {
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
      child.stdin.end();
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

/** SIGKILL a group at once (protocol error, cap breach, missed deadline). */
export function killServerProcess(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (typeof pid !== "number") return;
  signalGroup(pid, "SIGKILL");
}
