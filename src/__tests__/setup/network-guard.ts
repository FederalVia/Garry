/**
 * Tests never reach the internet:
 * - fetch to a non-loopback host fails before a socket opens;
 * - every other client (node:http/https, tls, raw sockets) fails at
 *   net.Socket#connect, and dns.lookup refuses non-loopback names;
 * - child processes inherit settings that keep git to local transports and
 *   stop npm's update check;
 * - the default RPC URL points at a closed local port, so code paths without
 *   a mock fail fast and deterministically instead of calling a public,
 *   rate-limited endpoint such as Base mainnet.
 *
 * Tests that install their own fetch stub replace the fetch wrapper and
 * still work; they are still held by the socket guard.
 */

import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const GUARDED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export function isLoopbackTestHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Hosts a socket may connect to: loopback, plus the unspecified address (also local). */
function isLocalSocketHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return isLoopbackTestHost(h) || h === "0.0.0.0" || h === "::" || h === "::ffff:127.0.0.1";
}

function blocked(host: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`network disabled in tests: ${host}`), { code: "ENOTFOUND", hostname: host });
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const maybe = input as { url?: unknown } | null;
  return typeof maybe?.url === "string" ? maybe.url : String(input);
}

if (!process.env.AUTOMATON_RPC_URL) {
  process.env.AUTOMATON_RPC_URL = "http://127.0.0.1:9/";
}
// Inherited by child processes (git, npm, spawned entrypoints).
process.env.GIT_ALLOW_PROTOCOL = "file";
process.env.npm_config_update_notifier = "false";

const realFetch = globalThis.fetch;

export const guardedFetch: typeof fetch = async (input, init) => {
  let parsed: URL | null = null;
  try {
    parsed = new URL(urlOf(input));
  } catch {
    parsed = null;
  }
  if (parsed && GUARDED_PROTOCOLS.has(parsed.protocol) && !isLoopbackTestHost(parsed.hostname)) {
    throw new TypeError(`network disabled in tests: ${parsed.hostname}`);
  }
  return realFetch(input, init);
};

globalThis.fetch = guardedFetch;

// ─── Socket and DNS guard (clients that do not use fetch) ─────────

/** Host a Socket#connect call targets, or null for IPC paths / fds. */
function connectHost(args: unknown[]): string | null {
  let first = args[0];
  // net.connect passes its normalized [options, cb] array.
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    const opts = first as { host?: unknown; path?: unknown; fd?: unknown };
    // http/https agents pass path: null for TCP; only a real path or fd is IPC.
    if (opts.path != null || opts.fd != null) return null;
    return typeof opts.host === "string" && opts.host !== "" ? opts.host : "localhost";
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null; // IPC path
  return typeof args[1] === "string" && args[1] !== "" ? args[1] : "localhost";
}

/** The options object of a Socket#connect call, if it was given one. */
function connectOptions(args: unknown[]): { lookup?: unknown } | null {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  return first && typeof first === "object" ? (first as { lookup?: unknown }) : null;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const host = connectHost(args);
  const opts = connectOptions(args);
  if (host !== null && !isLocalSocketHost(host) && opts && typeof opts.lookup === "function") {
    // A caller-supplied lookup (address pinning) decides where the socket
    // really goes: allow it only when every address it returns is local.
    const lookup = opts.lookup as (h: string, o: unknown, cb: LookupCb) => void;
    opts.lookup = (h: string, o: unknown, cb: LookupCb) =>
      lookup(h, o, (err, address, family) => {
        if (err) return cb(err);
        const list = Array.isArray(address)
          ? (address as Array<{ address: string }>).map((a) => a.address)
          : [String(address)];
        const outside = list.find((a) => !isLocalSocketHost(a));
        if (outside) return cb(blocked(outside));
        return cb(null, address, family);
      });
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  }
  if (host !== null && !isLocalSocketHost(host)) {
    // Fail like a refused connection (asynchronously), not with a throw from
    // inside an http.request call.
    process.nextTick(() => this.destroy(blocked(host)));
    return this;
  }
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const realLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
  if (typeof hostname === "string" && !isLocalSocketHost(hostname) && net.isIP(hostname) === 0) {
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") {
      process.nextTick(() => (cb as (err: Error) => void)(blocked(hostname)));
      return undefined as ReturnType<typeof dns.lookup>;
    }
  }
  return (realLookup as (...a: unknown[]) => unknown)(hostname, ...rest);
} as typeof dns.lookup;

const realPromisesLookup = dns.promises.lookup;
dns.promises.lookup = async function guardedPromisesLookup(hostname: string, ...rest: unknown[]) {
  if (typeof hostname === "string" && !isLocalSocketHost(hostname) && net.isIP(hostname) === 0) {
    throw blocked(hostname);
  }
  return (realPromisesLookup as (...a: unknown[]) => Promise<unknown>)(hostname, ...rest);
} as typeof dns.promises.lookup;

// ESM named imports of builtins see the patched functions only after this.
syncBuiltinESMExports();
