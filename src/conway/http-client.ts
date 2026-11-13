/**
 * Resilient HTTP Client
 *
 * Shared HTTP client with timeouts, retries, jittered exponential backoff,
 * and circuit breaker for all outbound Conway API calls.
 *
 * Phase 1.3: Network Resilience (P1-8, P1-9)
 */

import type { HttpClientConfig } from "../types.js";
import { DEFAULT_HTTP_CLIENT_CONFIG } from "../types.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** URL.hostname keeps the brackets of an IPv6 literal ("[::1]"). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTS.has(host);
}

/** True for a plain-HTTP URL on a loopback host. */
export function isLoopbackHttpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol.toLowerCase() === "http:" && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function assertSecureUrl(
  url: string,
  allowHttpOnLoopback: boolean,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "https:") {
    return;
  }

  if (protocol === "http:" && allowHttpOnLoopback && isLoopbackHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `HTTPS required: refusing insecure URL ${url}. ` +
      "For local development, only loopback HTTP (localhost/127.0.0.1/::1) can be explicitly enabled.",
  );
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

export class CircuitOpenError extends Error {
  constructor(public readonly resetAt: number) {
    super(
      `Circuit breaker is open until ${new Date(resetAt).toISOString()}`,
    );
    this.name = "CircuitOpenError";
  }
}

/** Methods that may be re-sent without asking: repeating them changes nothing more. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Most redirect hops a caller may opt in to. */
export const MAX_FOLLOW_REDIRECTS = 3;

/** A redirect the client would not follow (another origin, a downgrade, a paid request...). */
export class RedirectRefusedError extends Error {
  constructor(
    public readonly status: number,
    public readonly location: string | null,
    reason: string,
  ) {
    super(`Redirect refused (HTTP ${status} to ${location ?? "(no location)"}): ${reason}`);
    this.name = "RedirectRefusedError";
  }
}

export interface HttpRequestOptions extends RequestInit {
  timeout?: number;
  idempotencyKey?: string;
  /** Cap on automatic re-sends. Never a grant: unsafe methods get 0 unless retryUnsafe. */
  retries?: number;
  /** The server deduplicates this non-idempotent call, so it may be re-sent. */
  retryUnsafe?: boolean;
  /**
   * Follow up to n (at most 3) same-origin HTTPS redirects. GET/HEAD only,
   * never with X-Payment. Without it a 3xx is returned to the caller.
   */
  followRedirects?: number;
}

interface OriginCircuit {
  failures: number;
  openUntil: number;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

export class ResilientHttpClient {
  // Breaker state per origin: a failing host never blocks the others.
  private readonly circuits = new Map<string, OriginCircuit>();
  private lastOrigin: string | null = null;
  private readonly config: HttpClientConfig;

  constructor(config?: Partial<HttpClientConfig>) {
    this.config = { ...DEFAULT_HTTP_CLIENT_CONFIG, ...config };
  }

  async request(url: string, options?: HttpRequestOptions): Promise<Response> {
    assertSecureUrl(url, this.config.allowHttpOnLoopback);

    const origin = originOf(url);
    this.lastOrigin = origin;
    const circuit = this.circuit(origin);
    if (Date.now() < circuit.openUntil) {
      throw new CircuitOpenError(circuit.openUntil);
    }

    const {
      timeout: timeoutOpt,
      idempotencyKey,
      retries,
      retryUnsafe,
      followRedirects,
      ...init
    } = options ?? {};
    const method = (init.method ?? "GET").toUpperCase();
    const timeout = timeoutOpt ?? this.config.baseTimeout;
    // A non-idempotent request may already have done its work when it
    // failed (a 504, our own timeout), so it is sent once unless the
    // caller vouches that the server deduplicates it.
    const mayRetry = IDEMPOTENT_METHODS.has(method) || retryUnsafe === true;
    const maxRetries = mayRetry ? Math.max(0, retries ?? this.config.maxRetries) : 0;
    const callerSignal = init.signal ?? undefined;
    const headers: Record<string, string> = { ...headerRecord(init.headers) };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Never send (or resend) once the caller gave up.
      if (callerSignal?.aborted) throw abortError(callerSignal);

      try {
        const response = await this.sendFollowing(url, { ...init, method, headers }, {
          timeout,
          callerSignal,
          followRedirects: followRedirects ?? 0,
        });

        // Count retryable HTTP errors toward circuit breaker, regardless of
        // whether we will actually retry. A server consistently returning 502
        // should eventually trip the circuit breaker.
        if (this.config.retryableStatuses.includes(response.status)) {
          this.recordFailure(circuit);
          if (attempt < maxRetries && !callerSignal?.aborted) {
            await response.body?.cancel().catch(() => {});
            await this.backoff(attempt);
            continue;
          }
          return response;
        }

        // Only reset failure counter on truly successful responses
        circuit.failures = 0;
        return response;
      } catch (error) {
        // A refused redirect is our decision, not a server failure.
        if (error instanceof RedirectRefusedError) throw error;
        // The caller's abort is not a server failure and is never retried.
        if (callerSignal?.aborted) throw error;
        this.recordFailure(circuit);
        if (attempt >= maxRetries) throw error;
        await this.backoff(attempt);
      }
    }

    throw new Error("Unreachable");
  }

  /**
   * One attempt: fetch with redirects off, then follow opted-in redirects
   * hop by hop, each checked like the first URL and kept on its origin.
   */
  private async sendFollowing(
    url: string,
    init: RequestInit & { method: string; headers: Record<string, string> },
    opts: { timeout: number; callerSignal?: AbortSignal; followRedirects: number },
  ): Promise<Response> {
    const origin = originOf(url);
    const wantFollow = opts.followRedirects > 0;
    const maxHops = Math.min(Math.max(0, Math.floor(opts.followRedirects)), MAX_FOLLOW_REDIRECTS);
    let current = url;
    for (let hop = 0; ; hop++) {
      const response = await this.fetchOnce(current, init, opts.timeout, opts.callerSignal);
      if (!REDIRECT_STATUSES.has(response.status) || !wantFollow) return response;

      const location = response.headers.get("location");
      const refuse = (reason: string): never => {
        void response.body?.cancel().catch(() => {});
        throw new RedirectRefusedError(response.status, location, reason);
      };
      if (init.method !== "GET" && init.method !== "HEAD") refuse(`${init.method} requests are never redirected`);
      if (hasHeader(init.headers, "x-payment")) refuse("a paid request (payment header) is never redirected");
      if (!location) refuse("no Location header");
      if (hop >= maxHops) refuse(`more than ${maxHops} redirect(s)`);
      let next: string;
      try {
        next = new URL(location!, current).toString();
      } catch {
        return refuse("invalid Location");
      }
      try {
        assertSecureUrl(next, this.config.allowHttpOnLoopback);
      } catch (err) {
        refuse(err instanceof Error ? err.message : String(err));
      }
      if (originOf(next) !== origin) refuse(`cross-origin redirect from ${origin}`);
      await response.body?.cancel().catch(() => {});
      current = next;
    }
  }

  private async fetchOnce(
    url: string,
    init: RequestInit,
    timeout: number,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    // The deadline covers the whole exchange: the timer stays armed after the
    // headers arrive, so a server that stalls mid-body makes json()/text()
    // reject instead of waiting for undici's 300 s body timeout. Aborting
    // after the body was read does nothing. unref: never keeps the process up.
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    try {
      return await fetch(url, { ...init, signal, redirect: "manual" });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  private circuit(origin: string): OriginCircuit {
    let c = this.circuits.get(origin);
    if (!c) {
      c = { failures: 0, openUntil: 0 };
      this.circuits.set(origin, c);
    }
    return c;
  }

  private recordFailure(circuit: OriginCircuit): void {
    circuit.failures++;
    if (circuit.failures >= this.config.circuitBreakerThreshold) {
      circuit.openUntil = Date.now() + this.config.circuitBreakerResetMs;
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = Math.min(
      this.config.backoffBase *
        Math.pow(2, attempt) *
        (0.5 + Math.random()),
      this.config.backoffMax,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** With a URL: is that origin's breaker open. Without: is any open. */
  isCircuitOpen(url?: string): boolean {
    const now = Date.now();
    if (url !== undefined) {
      const c = this.circuits.get(originOf(url));
      return !!c && now < c.openUntil;
    }
    for (const c of this.circuits.values()) {
      if (now < c.openUntil) return true;
    }
    return false;
  }

  resetCircuit(): void {
    this.circuits.clear();
    this.lastOrigin = null;
  }

  /** With a URL: that origin's count. Without: the most recently used origin's. */
  getConsecutiveFailures(url?: string): number {
    const origin = url !== undefined ? originOf(url) : this.lastOrigin;
    if (origin === null) return 0;
    return this.circuits.get(origin)?.failures ?? 0;
  }
}
