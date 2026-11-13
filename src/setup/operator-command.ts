/**
 * Operator commands (--provision, --setup, --configure, --pick-model) write
 * automaton.json as a trusted writer. The running agent can start a new
 * process with exec, so these refuse while an agent holds the state
 * database, and the interactive ones refuse without a terminal (exec has
 * none). Neither check is a boundary against an agent running as the same
 * OS user; they stop the one-line route out of standalone mode.
 */

import { DEFAULT_CONFIG } from "../types.js";
import { loadConfig, resolvePath } from "../config.js";
import { acquireInstanceLock, InstanceLockedError } from "../state/instance-lock.js";

export interface OperatorCommandOptions {
  /** The command needs a terminal on stdin and stdout. */
  interactive: boolean;
  isTTY?: boolean;
  /** Defaults to automaton.json's dbPath. */
  dbPath?: string;
}

function configuredDbPath(): string {
  try {
    return resolvePath(loadConfig()?.dbPath || DEFAULT_CONFIG.dbPath!);
  } catch {
    // A corrupt config is the command's own error to report.
    return resolvePath(DEFAULT_CONFIG.dbPath!);
  }
}

/** Why the command must not run now, or null. */
export function operatorCommandRefusal(command: string, opts: OperatorCommandOptions): string | null {
  const isTTY = opts.isTTY ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  if (opts.interactive && !isTTY) {
    return `${command} is interactive and needs a terminal; run it yourself in a shell.`;
  }
  const dbPath = opts.dbPath ?? configuredDbPath();
  try {
    acquireInstanceLock(`${dbPath}.lock`).release();
  } catch (err) {
    if (err instanceof InstanceLockedError) {
      return (
        `An automaton${err.pid ? ` (pid ${err.pid})` : ""} is running on ${dbPath}. ` +
        `Stop it before ${command}: the running agent must not change its own configuration.`
      );
    }
    throw err;
  }
  return null;
}
