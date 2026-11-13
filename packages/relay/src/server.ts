/**
 * The relay's HTTP server: the three endpoints the Automaton client already
 * calls (send, poll, count) plus a data-free health check.
 *
 * Every cheap check that can refuse a request runs before the one expensive
 * step (signature verification); the limits that count stored mail run after
 * it, so a forger cannot use up anyone's quota. Nothing is stored unless the
 * sender's signature covers the stored recipient, content and signed_at
 * (reply_to is stored as given: no signed string covers it). Error replies
 * are fixed short texts and never echo request data.
 */

import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  PREFIX_CONWAY,
  PREFIX_V1,
  type Prefix,
  canonicalPoll,
  canonicalSend,
  chainOf,
  normalize,
  parseIsoUtc,
  protocolTag,
  signatureFormatOk,
  verify,
} from "./protocol.js";
import { openStore, type Store } from "./store.js";
import { type RelayLimits, ipBuckets, ipKey, ipStoreBuckets, pollBuckets, resolveLimits } from "./limits.js";

export const RELAY_VERSION = "0.1.0";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
export const DEFAULT_RETENTION_MS = 7 * 24 * HOUR_MS;
/** Far longer than the signed_at window, so a replayed payload is always a duplicate or stale. */
export const MIN_RETENTION_MS = HOUR_MS;
/** The client's replay window and the future skew it tolerates. */
const SIGNED_AT_MAX_AGE_MS = 300_000;
const SIGNED_AT_MAX_FUTURE_MS = 120_000;
const POLL_TIMESTAMP_WINDOW_MS = 300_000;
/** Covers a timestamp up to the window into the future plus the window after it. */
const NONCE_TTL_MS = 600_000;
const MAX_CONTENT_UNITS = 64_000;
const DEFAULT_POLL_LIMIT = 50;
const MAX_POLL_LIMIT = 100;
const REPLY_TO = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE = /^[0-9a-f]{32}$/;
const CURSOR = /^([0-9a-f]{16})\.(\d{1,15})$/;
/** In u-mode only an unpaired surrogate matches. SQLite cannot store one exactly, so it would come back changed and fail verification. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const CLOSE_GRACE_MS = 5_000;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RelayOptions {
  dbPath: string;
  /** Default 7 days; below 1 hour throws. */
  retentionMs?: number;
  /** Accept Conway-signed sends and nonce-less Conway polls (replayable within 5 minutes). */
  legacyConway?: boolean;
  allowedSenders?: string[];
  allowedRecipients?: string[];
  limits?: Partial<RelayLimits>;
  /** Use the rightmost X-Forwarded-For hop as the client IP (behind a TLS proxy only). */
  trustProxy?: boolean;
  /** Log method, route, status and duration for each request. Never content, signatures or addresses. */
  accessLog?: boolean;
  now?: () => number;
  log?: (level: LogLevel, msg: string) => void;
}

export interface Relay {
  readonly server: http.Server;
  /** Exposed for tests and maintenance; schema in store.ts. */
  readonly db: Database.Database;
  /** Resolves "http://host:port". Defaults: port 0 (any free port), host 127.0.0.1. */
  listen(port?: number, host?: string): Promise<string>;
  prune(): void;
  close(): Promise<void>;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly text: string,
    readonly headers?: Record<string, string>,
  ) {
    super(text);
  }
}

function fail(status: number, text: string, headers?: Record<string, string>): never {
  throw new HttpError(status, text, headers);
}

function retryAfter(seconds: number): Record<string, string> {
  return { "Retry-After": String(Math.max(1, Math.ceil(seconds))) };
}

/** Shortened for logs: enough to tell addresses apart, not to copy one. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
}

function isJson(req: http.IncomingMessage): boolean {
  const type = header(req, "content-type");
  return type !== undefined && type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Reads at most `max` bytes. A larger declared or streamed body is refused with 413. */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const declared = header(req, "content-length");
  if (declared !== undefined && Number(declared) > max) {
    return Promise.reject(new HttpError(413, "body too large", { Connection: "close" }));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (err: Error | null, body?: Buffer) => {
      if (done) return;
      done = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      if (err) reject(err);
      else resolve(body!);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        req.pause();
        finish(new HttpError(413, "body too large", { Connection: "close" }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = (err: Error) => finish(err);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function parseJsonObject(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    fail(400, "invalid json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid json");
  return value as Record<string, unknown>;
}

function normalizeList(list: string[] | undefined, what: string): Set<string> | null {
  if (!list || list.length === 0) return null;
  const out = new Set<string>();
  for (const entry of list) {
    const n = normalize(entry.trim());
    if (!n) throw new Error(`invalid address in ${what}`);
    out.add(n);
  }
  return out;
}

export function createRelay(opts: RelayOptions): Relay {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  if (!Number.isFinite(retentionMs) || retentionMs < MIN_RETENTION_MS) {
    throw new Error("relay retention must be at least 1 hour");
  }
  const limits = resolveLimits(opts.limits);
  const allowedSenders = normalizeList(opts.allowedSenders, "allowedSenders");
  const allowedRecipients = normalizeList(opts.allowedRecipients, "allowedRecipients");
  const sendPrefixes: Prefix[] = opts.legacyConway ? [PREFIX_V1, PREFIX_CONWAY] : [PREFIX_V1];

  const store: Store = openStore(opts.dbPath);
  const ipLimiter = ipBuckets(limits, now);
  const ipStoreLimiter = ipStoreBuckets(limits, now);
  const pollLimiter = pollBuckets(limits, now);

  function clientIp(req: http.IncomingMessage): string {
    if (opts.trustProxy) {
      const xff = header(req, "x-forwarded-for");
      const hop = xff?.split(",").pop()?.trim();
      if (hop) return ipKey(hop);
    }
    return ipKey(req.socket.remoteAddress ?? "unknown");
  }

  // ─── send ───────────────────────────────────────────────────

  async function send(req: http.IncomingMessage): Promise<Reply> {
    if (!isJson(req)) fail(415, "content type must be application/json");
    const msg = parseJsonObject(await readBody(req, limits.maxBodyBytes));
    const { from: rawFrom, to: rawTo, content, signed_at: signedAt, signature } = msg;
    const replyTo = msg.reply_to ?? null;
    if (
      typeof rawFrom !== "string" ||
      typeof rawTo !== "string" ||
      typeof content !== "string" ||
      typeof signedAt !== "string" ||
      typeof signature !== "string" ||
      (replyTo !== null && typeof replyTo !== "string")
    ) {
      fail(400, "invalid message");
    }

    const from = normalize(rawFrom);
    if (!from) fail(400, "invalid sender");
    const to = normalize(rawTo);
    if (!to) fail(400, "invalid recipient");
    if (from === to) fail(400, "sender is recipient");
    // UTF-16 units, the client's own measure.
    if (content.length < 1 || content.length > MAX_CONTENT_UNITS) fail(400, "invalid content");
    if (LONE_SURROGATE.test(content)) fail(400, "invalid content");
    if (replyTo !== null && !REPLY_TO.test(replyTo)) fail(400, "invalid reply_to");

    const signedMs = parseIsoUtc(signedAt);
    if (signedMs === null) fail(400, "invalid signed_at");
    const t = now();
    if (signedMs < t - SIGNED_AT_MAX_AGE_MS || signedMs > t + SIGNED_AT_MAX_FUTURE_MS) {
      fail(400, "signed_at outside window");
    }
    if (!signatureFormatOk(chainOf(from)!, signature)) fail(400, "invalid signature");

    if (allowedSenders && !allowedSenders.has(from)) fail(403, "sender not allowed");
    if (allowedRecipients && !allowedRecipients.has(to)) fail(403, "recipient not allowed");

    let matched: { prefix: Prefix; canonical: string } | null = null;
    for (const prefix of sendPrefixes) {
      const canonical = canonicalSend(prefix, to, content, signedAt);
      if (await verify(from, canonical, signature)) {
        matched = { prefix, canonical };
        break;
      }
    }
    if (!matched) fail(401, "signature does not match sender");

    // Everything below is synchronous, so concurrent requests cannot interleave
    // between the duplicate check, the limits and the insert.
    const sigHash = createHash("sha256").update(`v|${from}|${matched.canonical}`).digest("hex");
    const existing = store.idForSigHash(sigHash);
    if (existing) return { status: 200, body: { id: existing, duplicate: true } };

    const at = now();
    const windowLimit = (
      counted: { count: number; oldest: number | null },
      max: number,
      windowMs: number,
      text: string,
    ) => {
      if (counted.count >= max) {
        fail(429, text, retryAfter(((counted.oldest ?? at) + windowMs - at) / 1000));
      }
    };
    windowLimit(store.countFromSince(from, at - MINUTE_MS), limits.senderPerMinute, MINUTE_MS, "sender rate limit");
    windowLimit(store.countFromSince(from, at - HOUR_MS), limits.senderPerHour, HOUR_MS, "sender rate limit");
    windowLimit(store.countToSince(to, at - HOUR_MS), limits.recipientPerHour, HOUR_MS, "recipient rate limit");
    const box = store.mailbox(to, at);
    if (box.count >= limits.recipientMailbox) {
      fail(429, "recipient mailbox full", retryAfter(((box.firstExpiry ?? at + HOUR_MS) - at) / 1000));
    }
    const size = Buffer.byteLength(content, "utf8") + Buffer.byteLength(signature, "utf8");
    const total = store.total(at);
    if (total.count >= limits.totalMessages || total.bytes + size > limits.totalBytes) {
      fail(503, "relay full", retryAfter(((store.firstExpiry(at) ?? at + HOUR_MS) - at) / 1000));
    }
    // Last, so only a message that would really be stored uses the IP's budget.
    const ipWait = ipStoreLimiter.take(clientIp(req));
    if (ipWait > 0) fail(429, "too many messages from this address", retryAfter(ipWait));

    // A random UUID, so a wiped relay never reuses an id a client has marked seen.
    const id = randomUUID();
    store.insert({
      id,
      from_addr: from,
      to_addr: to,
      content,
      signed_at: signedAt,
      signature,
      protocol: protocolTag(matched.prefix),
      reply_to: replyTo,
      sig_hash: sigHash,
      size,
      created_at: at,
      expires_at: at + retentionMs,
    });
    return { status: 200, body: { id, created_at: new Date(at).toISOString() } };
  }

  // ─── poll and count auth ────────────────────────────────────

  /** Checks the poll credential and takes one poll token for the address. */
  async function authenticate(req: http.IncomingMessage): Promise<string> {
    const denied = (reason: string, address?: string): never => {
      log("debug", `poll auth refused${address ? ` for ${shortAddress(address)}` : ""}: ${reason}`);
      fail(401, "unauthorized");
    };
    const rawAddress = header(req, "x-wallet-address");
    const timestamp = header(req, "x-timestamp");
    const signature = header(req, "x-signature");
    const nonce = header(req, "x-auth-nonce");
    if (!rawAddress || !timestamp || !signature) return denied("missing headers");
    const address = normalize(rawAddress);
    if (!address) return denied("invalid address");
    const ts = parseIsoUtc(timestamp);
    if (ts === null) return denied("invalid timestamp", address);
    const t = now();
    if (Math.abs(t - ts) > POLL_TIMESTAMP_WINDOW_MS) return denied("timestamp outside window", address);

    if (nonce !== undefined) {
      if (!NONCE.test(nonce)) return denied("invalid nonce", address);
      if (!(await verify(address, canonicalPoll(PREFIX_V1, address, timestamp, nonce), signature))) {
        return denied("bad signature", address);
      }
      // Valid signature, then rate limit, then record: forgeries and polls over
      // the limit never add a nonce row.
      pollBucket(address);
      if (!store.useNonce(address, nonce, now() + NONCE_TTL_MS)) return denied("nonce reused", address);
      return address;
    }
    if (!opts.legacyConway) return denied("nonce required", address);
    if (!(await verify(address, canonicalPoll(PREFIX_CONWAY, address, timestamp), signature))) {
      return denied("bad signature", address);
    }
    pollBucket(address);
    return address;
  }

  function pollBucket(address: string): void {
    const wait = pollLimiter.take(address);
    if (wait > 0) fail(429, "poll rate limit", retryAfter(wait));
  }

  /** The relay's own cursor form is "{epoch}.{seq}"; anything else (a foreign or stale cursor) starts over. */
  function cursorSeq(cursor: string): number {
    const m = CURSOR.exec(cursor);
    if (!m || m[1] !== store.epoch) return 0;
    return Number(m[2]);
  }

  async function poll(req: http.IncomingMessage): Promise<Reply> {
    if (!isJson(req)) fail(415, "content type must be application/json");
    const body = await readBody(req, limits.maxPollBodyBytes);
    const address = await authenticate(req);
    const input = parseJsonObject(body);

    let after = 0;
    if (input.cursor !== undefined && input.cursor !== null) {
      if (typeof input.cursor !== "string") fail(400, "invalid cursor");
      after = cursorSeq(input.cursor);
    }
    let limit = DEFAULT_POLL_LIMIT;
    if (input.limit !== undefined && input.limit !== null) {
      if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) fail(400, "invalid limit");
      limit = Math.min(MAX_POLL_LIMIT, Math.max(1, Math.trunc(input.limit)));
    }

    const rows = store.poll(address, after, now(), limit);
    const last = rows.length > 0 ? rows[rows.length - 1]!.seq : after;
    store.markPolled(address, last);
    return {
      status: 200,
      body: {
        messages: rows.map((r) => ({
          id: r.id,
          from: r.from_addr,
          to: r.to_addr,
          content: r.content,
          signature: r.signature,
          signed_at: r.signed_at,
          createdAt: new Date(r.created_at).toISOString(),
          replyTo: r.reply_to,
          protocol: r.protocol,
        })),
        next_cursor: `${store.epoch}.${last}`,
      },
    };
  }

  async function count(req: http.IncomingMessage): Promise<Reply> {
    const address = await authenticate(req);
    return { status: 200, body: { unread: store.unread(address, now()) } };
  }

  // ─── routing ────────────────────────────────────────────────

  const routes: Record<string, { method: string; handle: (req: http.IncomingMessage) => Promise<Reply> }> = {
    "/v1/messages": { method: "POST", handle: send },
    "/v1/messages/poll": { method: "POST", handle: poll },
    "/v1/messages/count": { method: "GET", handle: count },
    "/healthz": { method: "GET", handle: async () => ({ status: 200, body: { ok: true, version: RELAY_VERSION } }) },
  };

  function write(res: http.ServerResponse, reply: Reply): void {
    if (res.headersSent || res.destroyed) return;
    const body = JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...reply.headers,
    });
    res.end(body);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0]!;
    const route = Object.prototype.hasOwnProperty.call(routes, path) ? routes[path] : undefined;
    if (opts.accessLog) {
      const method = /^[A-Z]{1,10}$/.test(req.method ?? "") ? req.method : "OTHER";
      res.on("finish", () =>
        log("info", `${method} ${route ? path : "(unknown)"} ${res.statusCode} ${Date.now() - started}ms`),
      );
    }
    let reply: Reply;
    try {
      const wait = ipLimiter.take(clientIp(req));
      if (wait > 0) fail(429, "too many requests", retryAfter(wait));
      if (!route) fail(404, "not found");
      if (req.method !== route.method) fail(405, "method not allowed", { Allow: route.method });
      reply = await route.handle(req);
    } catch (err) {
      if (err instanceof HttpError) {
        reply = { status: err.status, body: { error: err.text }, headers: err.headers };
      } else {
        log("error", `request failed: ${err instanceof Error ? err.message : String(err)}`);
        reply = { status: 500, body: { error: "internal error" } };
      }
    }
    // A refused body may still be arriving: close the connection rather than read it.
    if (reply.headers?.Connection === "close") res.on("finish", () => req.destroy());
    write(res, reply);
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 256;

  let closing: Promise<void> | null = null;

  return {
    server,
    db: store.db,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          resolve(`http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`);
        });
      });
    },
    prune() {
      const r = store.prune(now());
      if (r.messages || r.nonces || r.recipients) {
        log("info", `pruned ${r.messages} messages, ${r.nonces} nonces, ${r.recipients} recipients`);
      }
    },
    close() {
      if (closing) return closing;
      closing = new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          store.close();
          resolve();
        };
        const timer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
        timer.unref();
        if (!server.listening) {
          finish();
          return;
        }
        server.close(() => finish());
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
