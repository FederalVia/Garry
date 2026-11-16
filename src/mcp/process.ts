/**
 * Process groups of stdio MCP servers. The group logic lives in
 * runtime/process-group (tunnels use it too); these names stay for the MCP
 * code and its tests.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  killGroup,
  liveProcessGroups,
  signalGroup,
  spawnInGroup,
  terminateGroup,
} from "../runtime/process-group.js";

export { signalGroup };

/** Process groups still alive (MCP servers and any other group started here). */
export function liveMcpGroups(): number[] {
  return liveProcessGroups();
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
  return spawnInGroup({ ...opts, stdin: "pipe" }) as ChildProcessWithoutNullStreams;
}

/**
 * Stop a server: close stdin, SIGTERM the group, SIGKILL after graceMs.
 * Resolves once the leader exited or after graceMs + 1 s, whichever is first.
 */
export function terminateServerProcess(child: ChildProcessWithoutNullStreams, graceMs = 2_000): Promise<void> {
  return terminateGroup(child, graceMs);
}

/** SIGKILL a group at once (protocol error, cap breach, missed deadline). */
export function killServerProcess(child: ChildProcessWithoutNullStreams): void {
  killGroup(child);
}
