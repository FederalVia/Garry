/**
 * Bounded HTTPS GET for attacker-chosen URLs (agent cards from the
 * permissionless registry).
 *
 * - HTTPS only; internal names (localhost, *.local, *.internal ...) refused.
 * - The name is resolved once, every answer must be a public address, and
 *   the connection goes to that vetted address (no DNS rebinding window).
 * - Redirects are followed by hand, each hop re-validated in full.
 * - No compressed bodies; the body is counted as it streams and the request
 *   is destroyed past maxBytes. One deadline covers DNS, connect, headers,
 *   body and every redirect.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// ─── Address policy ────────────────────────────────────────────

const BLOCKED_V4 = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(addr, prefix, "ipv4");
}

// Global unicast only, minus documentation, Teredo and 6to4.
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_V6 = new net.BlockList();
BLOCKED_V6.addSubnet("2001:db8::", 32, "ipv6");
BLOCKED_V6.addSubnet("2001::", 32, "ipv6");
BLOCKED_V6.addSubnet("2002::", 16, "ipv6");

/** Eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const groups: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let tail: number[] = [];
  if (v4) {
    const octets = v4[1].split(".").map(Number);
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = text.slice(0, -v4[1].length) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((h) => parseInt(h, 16)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  groups.push(...head, ...new Array(fill).fill(0), ...rest);
  if (v4) groups.splice(6, 2, ...tail);
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** IPv4 inside an IPv4-mapped (::ffff:a.b.c.d) or compatible (::a.b.c.d) address. */
function embeddedIPv4(groups: number[]): string | null {
  if (groups.slice(0, 5).some((g) => g !== 0)) return null;
  if (groups[5] !== 0xffff && groups[5] !== 0) return null;
  if (groups[5] === 0 && groups[6] === 0) return null; // :: and ::1 are not IPv4
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = net.isIP(bare);
  if (family === 4) return !BLOCKED_V4.check(bare, "ipv4");
  if (family !== 6) return false;
  const groups = ipv6Groups(bare.toLowerCase());
  if (!groups) return false;
  const v4 = embeddedIPv4(groups);
  if (v4) return !BLOCKED_V4.check(v4, "ipv4");
  return GLOBAL_V6.check(bare, "ipv6") && !BLOCKED_V6.check(bare, "ipv6");
}

/** Host names that never point at a public service. */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!h) return true;
  if (net.isIP(h)) return !isPublicAddress(h);
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "home.arpa" ||
    h.endsWith(".home.arpa")
  );
}

// ─── Fetch ─────────────────────────────────────────────────────

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SafeFetchDeps {
  /** Issue the request (default https.request). For tests. */
  request?: (url: URL, options: https.RequestOptions) => http.ClientRequest;
  /** Resolve a name to every address (default dns.lookup all:true). For tests. */
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Address policy (default isPublicAddress). For tests. */
  isAllowedAddress?: (ip: string) => boolean;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  /** An operator-configured origin exempt from the address check (still bounded). */
  trustedOrigin?: string;
}

export type SafeFetchResult =
  | { ok: true; status: number; body: string; url: string; bytesRead: number }
  | { ok: false; error: string; bytesRead: number };

class FetchRefused extends Error {}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

export async function fetchPublicHttps(
  rawUrl: string,
  opts: SafeFetchOptions,
  deps: SafeFetchDeps = {},
): Promise<SafeFetchResult> {
  // http only ever reaches the operator's trusted origin (checked per hop).
  const request =
    deps.request ?? ((url, options) => (url.protocol === "http:" ? http.request(url, options) : https.request(url, options)));
  const lookup = deps.lookup ?? defaultLookup;
  const allowed = deps.isAllowedAddress ?? isPublicAddress;
  const maxRedirects = opts.maxRedirects ?? 3;
  const trustedOrigin = opts.trustedOrigin ? safeOrigin(opts.trustedOrigin) : null;

  let bytesRead = 0;
  const live: { req: http.ClientRequest | null } = { req: null };
  let timer: NodeJS.Timeout | undefined;
  // Settling the race does not stop run(): once the deadline passes (or the
  // fetch fails) it must not start a request, so it checks this after every
  // await, and the abort signal cancels a request already started.
  const stop = new AbortController();
  const timeoutMessage = `timed out after ${opts.timeoutMs} ms`;
  const halt = () => {
    stop.abort();
    live.req?.destroy();
  };
  const checkLive = () => {
    if (stop.signal.aborted) throw new FetchRefused(timeoutMessage);
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      halt();
      reject(new FetchRefused(timeoutMessage));
    }, opts.timeoutMs);
  });

  const run = async (): Promise<SafeFetchResult> => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new FetchRefused("invalid URL");
    }
    for (let hop = 0; ; hop++) {
      const trusted = trustedOrigin !== null && url.origin === trustedOrigin;
      if (url.protocol !== "https:" && !(trusted && url.protocol === "http:")) {
        throw new FetchRefused(`scheme ${url.protocol} not allowed`);
      }
      if (url.username || url.password) throw new FetchRefused("credentials in URL");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!trusted && isInternalHostname(host)) throw new FetchRefused(`internal host ${host}`);

      const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host);
      checkLive();
      if (addresses.length === 0) throw new FetchRefused(`no address for ${host}`);
      if (!trusted) {
        const bad = addresses.find((a) => !allowed(a.address));
        if (bad) throw new FetchRefused(`${host} resolves to non-public address ${bad.address}`);
      }
      const pinned = addresses[0];

      checkLive();
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = request(url, {
          method: "GET",
          headers: { accept: "application/json", "accept-encoding": "identity" },
          agent: false,
          signal: stop.signal,
          // Connect to the address that was checked, never a fresh answer.
          lookup: ((_h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) => {
            if (o?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
            else cb(null, pinned.address, pinned.family);
          }) as unknown as https.RequestOptions["lookup"],
        });
        live.req = req;
        req.on("response", resolve);
        req.on("error", reject);
        req.end();
      });
      if (stop.signal.aborted) {
        response.destroy();
        checkLive();
      }

      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        live.req?.destroy();
        if (hop >= maxRedirects) throw new FetchRefused(`more than ${maxRedirects} redirects`);
        try {
          url = new URL(response.headers.location, url);
        } catch {
          throw new FetchRefused("invalid redirect location");
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new FetchRefused(`HTTP ${status}`);
      }
      const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase().trim();
      if (encoding !== "identity" && encoding !== "") {
        response.destroy();
        throw new FetchRefused(`content-encoding ${encoding} not accepted`);
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        response.destroy();
        throw new FetchRefused(`body of ${declared} bytes exceeds ${opts.maxBytes}`);
      }

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        response.on("data", (chunk: Buffer) => {
          bytesRead += chunk.length;
          if (bytesRead > opts.maxBytes) {
            response.destroy();
            live.req?.destroy();
            reject(new FetchRefused(`body exceeds ${opts.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", resolve);
        response.on("error", reject);
        response.on("aborted", () => reject(new FetchRefused("response aborted")));
      });
      return { ok: true, status, body: Buffer.concat(chunks).toString("utf-8"), url: url.toString(), bytesRead };
    }
  };

  try {
    return await Promise.race([run(), deadline]);
  } catch (err) {
    halt();
    return { ok: false, error: err instanceof Error ? err.message : String(err), bytesRead };
  } finally {
    clearTimeout(timer);
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
