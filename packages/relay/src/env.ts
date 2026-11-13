/**
 * RELAY_* environment variables to relay options. Strict: any value that is
 * present but not understood is an error naming the variable, never a
 * silent default.
 */

import os from "node:os";
import path from "node:path";
import { DEFAULT_LIMITS, type RelayLimits } from "./limits.js";
import { normalize } from "./protocol.js";
import type { RelayOptions } from "./server.js";

export class RelayEnvError extends Error {
  constructor(
    readonly variable: string,
    problem: string,
  ) {
    super(`${variable}: ${problem}`);
    this.name = "RelayEnvError";
  }
}

export interface RelayEnvConfig {
  host: string;
  port: number;
  options: RelayOptions;
}

type Env = Record<string, string | undefined>;

const MAX_LIMIT = 1_000_000_000;
/** Byte budgets may go past MAX_LIMIT (up to 10 TB). */
const MAX_BYTES_LIMIT = 10_000_000_000_000;
const MAX_RETENTION_HOURS = 24 * 366;

/** maxBodyBytes -> RELAY_LIMIT_MAX_BODY_BYTES */
export function limitVariable(key: keyof RelayLimits): string {
  return `RELAY_LIMIT_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

function present(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function integer(env: Env, name: string, min: number, max: number): number | undefined {
  const v = present(env, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new RelayEnvError(name, `must be a whole number from ${min} to ${max}`);
  const n = Number(v);
  if (n < min || n > max) throw new RelayEnvError(name, `must be a whole number from ${min} to ${max}`);
  return n;
}

function flag(env: Env, name: string): boolean {
  const v = present(env, name);
  if (v === undefined) return false;
  const lower = v.toLowerCase();
  if (lower === "1" || lower === "true") return true;
  if (lower === "0" || lower === "false") return false;
  throw new RelayEnvError(name, "must be 0 or 1");
}

function addressList(env: Env, name: string): string[] | undefined {
  const v = present(env, name);
  if (v === undefined) return undefined;
  const out: string[] = [];
  for (const part of v.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const n = normalize(entry);
    if (!n) throw new RelayEnvError(name, "contains an entry that is not an EVM or Solana address");
    out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

export function defaultDbPath(env: Env, home: string): string {
  const xdg = present(env, "XDG_STATE_HOME");
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "state");
  return path.join(base, "automaton-relay", "relay.db");
}

/** Throws RelayEnvError naming the first variable it cannot accept. */
export function parseRelayEnv(env: Env = process.env, home: string = os.homedir()): RelayEnvConfig {
  const host = present(env, "RELAY_HOST") ?? "127.0.0.1";
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) {
    throw new RelayEnvError("RELAY_HOST", "must be a hostname or an IP address");
  }
  const port = integer(env, "RELAY_PORT", 1, 65_535) ?? 8787;

  const dbRaw = present(env, "RELAY_DB");
  const dbPath = dbRaw ? path.resolve(dbRaw) : defaultDbPath(env, home);

  const retentionHours = integer(env, "RELAY_RETENTION_HOURS", 1, MAX_RETENTION_HOURS) ?? 168;

  const limits: Partial<RelayLimits> = {};
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof RelayLimits)[]) {
    const n = integer(env, limitVariable(key), 1, key === "totalBytes" ? MAX_BYTES_LIMIT : MAX_LIMIT);
    if (n !== undefined) limits[key] = n;
  }

  return {
    host,
    port,
    options: {
      dbPath,
      retentionMs: retentionHours * 3_600_000,
      legacyConway: flag(env, "RELAY_LEGACY_CONWAY"),
      trustProxy: flag(env, "RELAY_TRUST_PROXY"),
      accessLog: flag(env, "RELAY_ACCESS_LOG"),
      allowedSenders: addressList(env, "RELAY_ALLOWED_SENDERS"),
      allowedRecipients: addressList(env, "RELAY_ALLOWED_RECIPIENTS"),
      limits,
    },
  };
}

/** True for addresses only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Warnings the entry point prints at startup. `agentHome` is set when this
 * user also has an agent state folder (~/.automaton).
 */
export function startupWarnings(config: RelayEnvConfig, agentHome?: string): string[] {
  const out: string[] = [];
  const o = config.options;
  const reachable = !isLoopbackHost(config.host) || o.trustProxy === true;
  if (!isLoopbackHost(config.host)) {
    out.push("listening beyond loopback: put a TLS proxy in front, clients refuse plain HTTP off loopback");
  }
  if (reachable && !o.allowedSenders?.length && !o.allowedRecipients?.length) {
    out.push(
      "reachable from outside with no RELAY_ALLOWED_SENDERS or RELAY_ALLOWED_RECIPIENTS: anyone can fill the relay " +
        "to its total limits (then every send gets 503 until messages expire) and use its disk",
    );
  }
  if (o.legacyConway) {
    out.push("legacy Conway protocol on: Conway polls are replayable within 5 minutes");
  }
  if (agentHome) {
    out.push(
      `this user also runs an agent (${agentHome} exists): its exec tool can read and change the relay database. ` +
        "Run the relay as a separate user (systemd unit or Docker)",
    );
  }
  return out;
}
