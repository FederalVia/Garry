/**
 * JSON over HTTP for DNS provider and registrar APIs.
 *
 * - Redirects are errors: a credential sent in a header or body is never
 *   replayed to whatever host a redirect names.
 * - The caller's signal, the ambient task signal and a deadline covering
 *   headers and body all apply; the body is counted as it streams.
 * - Reads retry twice on 429/502/503/504 or a connection error, honouring
 *   Retry-After up to 10 s. Writes never retry: a resent create could make a
 *   second record or a second purchase.
 * - Error messages are redacted and cut short; request headers and bodies are
 *   never logged or put into a message.
 */

import { abortReason, abortableDelay, currentCancellationSignal, mergeSignals } from "../runtime/cancellation.js";
import { redactSecrets } from "../security/secret-redaction.js";
import { DnsProviderError, type EdgeHttpError, type EdgeHttpErrorInit } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const MAX_RETRY_AFTER_MS = 10_000;
const READ_ATTEMPTS = 3;
const BASE_BACKOFF_MS = [500, 1500];
const MAX_MESSAGE_CHARS = 300;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
/** Connection failures where the request certainly never reached the server. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export interface EdgeFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Serialised as JSON. */
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** True for reads: allows retries. */
  idempotent?: boolean;
  /** Provider name for messages ("Cloudflare"). */
  label?: string;
  /** Extracts the provider's message and code from an error answer. */
  describeError?: (body: unknown, status: number) => { message?: string; providerCode?: string } | undefined;
  /** Error class to throw (default DnsProviderError). */
  makeError?: (init: EdgeHttpErrorInit) => EdgeHttpError;
  /** Exact values to blank out of messages, for credentials too short to register. */
  secrets?: readonly string[];
  /** Base backoff between read attempts when no Retry-After is given (tests). */
  backoffMs?: readonly number[];
}

export interface EdgeResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/** True for loopback names, where plain http is allowed (tests, local fakes). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** https anywhere, http only on loopback. */
export function isAllowedApiUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
}

/** Retry-After as milliseconds: delta seconds or an HTTP date. Undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Wait before read attempt `attempt + 1`: Retry-After when given, capped at 10 s. */
export function retryDelayMs(retryAfterMs: number | undefined, attempt: number, backoff: readonly number[] = BASE_BACKOFF_MS): number {
  const base = retryAfterMs ?? backoff[Math.min(attempt, backoff.length - 1)] ?? 1000;
  return Math.min(Math.max(0, base), MAX_RETRY_AFTER_MS);
}

/** Redact, then cut: cutting first could leave a recognisable piece of a secret. */
export function cleanMessage(text: string, secrets: readonly string[] = []): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 4) out = out.split(s).join("[REDACTED:edge]");
  }
  out = redactSecrets(out).replace(/\s+/g, " ").trim();
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS - 3)}...` : out;
}

function defaultDescribe(body: unknown): { message?: string; providerCode?: string } | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" ? { message: body } : undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.message === "string") return { message: b.message };
  if (typeof b.error === "string") return { message: b.error };
  return undefined;
}

interface Attempt {
  error: EdgeHttpError;
  retryable: boolean;
}

class AttemptFailed extends Error {
  constructor(readonly attempt: Attempt) {
    super(attempt.error.message);
  }
}

export async function edgeFetchJson<T = unknown>(url: string, opts: EdgeFetchOptions = {}): Promise<EdgeResponse<T>> {
  const label = opts.label ?? "The provider";
  const secrets = opts.secrets ?? [];
  const makeError = opts.makeError ?? ((init: EdgeHttpErrorInit) => new DnsProviderError(init));
  const fail = (init: Omit<EdgeHttpErrorInit, "message"> & { message: string }) =>
    makeError({ ...init, message: cleanMessage(init.message, secrets) });

  if (!isAllowedApiUrl(url)) {
    // "Invalid URL" also tells the treasury's classifier that nothing was sent.
    throw fail({ message: `Invalid URL for ${label} (https required)`, sent: false });
  }
  const outer = mergeSignals(opts.signal, currentCancellationSignal());
  const attempts = opts.idempotent ? READ_ATTEMPTS : 1;
  for (let attempt = 0; ; attempt++) {
    if (outer?.aborted) throw abortReason(outer);
    try {
      return await fetchOnce<T>(url, opts, label, outer, fail);
    } catch (err) {
      if (!(err instanceof AttemptFailed)) throw err;
      const { error, retryable } = err.attempt;
      if (!retryable || attempt + 1 >= attempts) throw error;
      await abortableDelay(retryDelayMs(error.retryAfterMs, attempt, opts.backoffMs), outer);
    }
  }
}

async function fetchOnce<T>(
  url: string,
  opts: EdgeFetchOptions,
  label: string,
  outer: AbortSignal | undefined,
  fail: (init: EdgeHttpErrorInit) => EdgeHttpError,
): Promise<EdgeResponse<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("timeout")), timeoutMs);
  const signal = mergeSignals(outer, deadline.signal);
  const timedOut = () =>
    new AttemptFailed({ error: fail({ message: `${label} did not answer within ${Math.round(timeoutMs / 1000)} s`, sent: true }), retryable: false });
  try {
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    let res: Response;
    try {
      res = await fetch(url, { method: opts.method ?? "GET", headers, body, redirect: "error", signal });
    } catch (err) {
      if (outer?.aborted) throw abortReason(outer);
      if (deadline.signal.aborted) throw timedOut();
      const cause = (err as { cause?: { code?: unknown; message?: unknown } })?.cause;
      const code = typeof cause?.code === "string" ? cause.code : undefined;
      const causeText = typeof cause?.message === "string" ? cause.message : err instanceof Error ? err.message : String(err);
      if (/redirect/i.test(causeText)) {
        // The server answered with a redirect: the request did arrive.
        throw new AttemptFailed({ error: fail({ message: `${label} answered with a redirect, which is refused`, sent: true }), retryable: false });
      }
      const sent = !(code !== undefined && NOT_SENT_CODES.has(code));
      throw new AttemptFailed({
        error: fail({ message: `${label} request failed: ${code ?? causeText}`, sent, code }),
        retryable: true,
      });
    }

    let text: string;
    try {
      text = await readBounded(res, maxBytes);
    } catch (err) {
      if (outer?.aborted) throw abortReason(outer);
      if (deadline.signal.aborted) throw timedOut();
      if (err instanceof TooLarge) {
        throw new AttemptFailed({
          error: fail({ message: `${label} answer is larger than ${maxBytes} bytes`, status: res.status, sent: true }),
          retryable: false,
        });
      }
      throw new AttemptFailed({
        error: fail({ message: `${label} answer was cut off: ${err instanceof Error ? err.message : String(err)}`, status: res.status, sent: true }),
        retryable: true,
      });
    }

    let parsed: unknown = null;
    let parseFailed = false;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }
    if (res.status < 200 || res.status > 299) {
      const described = (opts.describeError ?? defaultDescribe)(parseFailed ? text.slice(0, 500) : parsed, res.status);
      const providerCode = described?.providerCode;
      const detail = described?.message ? `: ${described.message}` : "";
      throw new AttemptFailed({
        error: fail({
          message: `${label} answered HTTP ${res.status}${providerCode ? ` (code ${providerCode})` : ""}${detail}`,
          status: res.status,
          providerCode,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
          sent: true,
        }),
        retryable: RETRY_STATUSES.has(res.status),
      });
    }
    if (parseFailed) {
      throw new AttemptFailed({ error: fail({ message: `${label} answer is not JSON`, status: res.status, sent: true }), retryable: false });
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

class TooLarge extends Error {}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new TooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
