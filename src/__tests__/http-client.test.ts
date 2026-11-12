/**
 * Tests for ResilientHttpClient — Phase 1.3 Network Resilience
 *
 * Covers: timeouts, retries, backoff, circuit breaker, idempotency keys,
 * cached balance fallback, api_unreachable state handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ResilientHttpClient,
  CircuitOpenError,
  RedirectRefusedError,
} from "../conway/http-client.js";

// ─── Mock fetch ────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({
      "content-type": "application/json",
      ...headers,
    }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

// ─── Tests ─────────────────────────────────────────────────────

describe("ResilientHttpClient", () => {
  describe("HTTPS enforcement", () => {
    it("rejects remote HTTP URLs", async () => {
      const client = new ResilientHttpClient({ maxRetries: 0 });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      await expect(
        client.request("http://api.example.com/test"),
      ).rejects.toThrow("HTTPS required");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("allows HTTPS URLs", async () => {
      const client = new ResilientHttpClient({ maxRetries: 0 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(200));

      const resp = await client.request("https://api.example.com/test");
      expect(resp.status).toBe(200);
    });

    it("rejects loopback HTTP when not explicitly allowed", async () => {
      const client = new ResilientHttpClient({ maxRetries: 0 });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      await expect(
        client.request("http://localhost:11434/v1/chat/completions"),
      ).rejects.toThrow("HTTPS required");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("allows loopback HTTP when explicitly enabled", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 0,
        allowHttpOnLoopback: true,
      });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(200, { ok: true }));

      const resp = await client.request("http://127.0.0.1:11434/api/tags");
      expect(resp.status).toBe(200);
    });

    it("rejects invalid URL strings", async () => {
      const client = new ResilientHttpClient({ maxRetries: 0 });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      await expect(
        client.request("not-a-url"),
      ).rejects.toThrow("Invalid URL");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("timeout behavior", () => {
    it("aborts request after configured timeout", async () => {
      const client = new ResilientHttpClient({
        baseTimeout: 100,
        maxRetries: 0,
      });

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }
          });
        },
      );

      const pending = client.request("https://api.example.com/test");
      const assertion = expect(pending).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
    });
  });

  describe("retry on 5xx/429", () => {
    it("retries on 500 and succeeds on second attempt", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 2,
        backoffBase: 1,
        backoffMax: 10,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(mockResponse(500));
        }
        return Promise.resolve(mockResponse(200, { ok: true }));
      });

      const pending = client.request("https://api.example.com/test");
      await vi.runAllTimersAsync();
      const resp = await pending;
      expect(resp.status).toBe(200);
      expect(callCount).toBe(2);
    });

    it("retries on 429 with backoff", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 2,
        backoffBase: 1,
        backoffMax: 10,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(mockResponse(429));
        }
        return Promise.resolve(mockResponse(200, { ok: true }));
      });

      const pending = client.request("https://api.example.com/test");
      await vi.runAllTimersAsync();
      const resp = await pending;
      expect(resp.status).toBe(200);
      expect(callCount).toBe(3);
    });

    it("retries on 502, 503, 504", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 3,
        backoffBase: 1,
        backoffMax: 10,
      });

      const statusCodes = [502, 503, 504];
      let callCount = 0;

      globalThis.fetch = vi.fn().mockImplementation(() => {
        if (callCount < statusCodes.length) {
          const status = statusCodes[callCount];
          callCount++;
          return Promise.resolve(mockResponse(status));
        }
        callCount++;
        return Promise.resolve(mockResponse(200, { ok: true }));
      });

      const pending = client.request("https://api.example.com/test");
      await vi.runAllTimersAsync();
      const resp = await pending;
      expect(resp.status).toBe(200);
      expect(callCount).toBe(4);
    });
  });

  describe("no retry on 4xx", () => {
    it("does not retry on 400", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 3,
        backoffBase: 1,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(mockResponse(400, { error: "bad request" }));
      });

      const resp = await client.request("https://api.example.com/test");
      expect(resp.status).toBe(400);
      expect(callCount).toBe(1);
    });

    it("does not retry on 401", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 3,
        backoffBase: 1,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(mockResponse(401));
      });

      const resp = await client.request("https://api.example.com/test");
      expect(resp.status).toBe(401);
      expect(callCount).toBe(1);
    });

    it("does not retry on 404", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 3,
        backoffBase: 1,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(mockResponse(404));
      });

      const resp = await client.request("https://api.example.com/test");
      expect(resp.status).toBe(404);
      expect(callCount).toBe(1);
    });
  });

  describe("retry exhaustion", () => {
    it("throws after max retries on network error", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 2,
        backoffBase: 1,
        backoffMax: 10,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject(new Error("Network failure"));
      });

      const pending = client.request("https://api.example.com/test");
      const assertion = expect(pending).rejects.toThrow("Network failure");
      await vi.runAllTimersAsync();
      await assertion;
      expect(callCount).toBe(3); // 1 initial + 2 retries
    });

    it("returns last retryable status if all retries exhausted", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 2,
        backoffBase: 1,
        backoffMax: 10,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(mockResponse(503));
      });

      const pending = client.request("https://api.example.com/test");
      await vi.runAllTimersAsync();
      const resp = await pending;
      // After maxRetries exhausted, returns the last 503 response
      expect(resp.status).toBe(503);
      expect(callCount).toBe(3); // 1 initial + 2 retries
    });
  });

  describe("circuit breaker", () => {
    it("opens after threshold consecutive failures", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 0,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 5000,
      });

      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));

      // Trigger 3 consecutive failures
      for (let i = 0; i < 3; i++) {
        await expect(
          client.request("https://api.example.com/test"),
        ).rejects.toThrow("fail");
      }

      expect(client.isCircuitOpen()).toBe(true);
      expect(client.getConsecutiveFailures()).toBe(3);

      // Next call should throw CircuitOpenError immediately
      await expect(
        client.request("https://api.example.com/test"),
      ).rejects.toThrow(CircuitOpenError);
    });

    it("auto-resets after cooldown period", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitBreakerResetMs: 1000,
      });

      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        await expect(
          client.request("https://api.example.com/test"),
        ).rejects.toThrow("fail");
      }
      expect(client.isCircuitOpen()).toBe(true);

      // Advance time past reset period
      vi.advanceTimersByTime(1100);

      // Circuit should be closed now
      expect(client.isCircuitOpen()).toBe(false);

      // Should be able to make requests again
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(200));
      const resp = await client.request("https://api.example.com/test");
      expect(resp.status).toBe(200);
    });

    it("resets consecutive failures on success", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 0,
        circuitBreakerThreshold: 5,
      });

      // Fail 3 times
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));
      for (let i = 0; i < 3; i++) {
        await expect(
          client.request("https://api.example.com/test"),
        ).rejects.toThrow();
      }
      expect(client.getConsecutiveFailures()).toBe(3);

      // Succeed once
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(200));
      await client.request("https://api.example.com/test");
      expect(client.getConsecutiveFailures()).toBe(0);
    });

    it("CircuitOpenError includes resetAt timestamp", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 0,
        circuitBreakerThreshold: 1,
        circuitBreakerResetMs: 60_000,
      });

      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));
      await expect(
        client.request("https://api.example.com/test"),
      ).rejects.toThrow();

      try {
        await client.request("https://api.example.com/test");
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitOpenError);
        expect((err as CircuitOpenError).resetAt).toBeGreaterThan(Date.now());
      }
    });

    it("resetCircuit() clears state", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 0,
        circuitBreakerThreshold: 1,
        circuitBreakerResetMs: 60_000,
      });

      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));
      await expect(
        client.request("https://api.example.com/test"),
      ).rejects.toThrow();
      expect(client.isCircuitOpen()).toBe(true);

      client.resetCircuit();
      expect(client.isCircuitOpen()).toBe(false);
      expect(client.getConsecutiveFailures()).toBe(0);
    });

    it("counts retryable HTTP statuses toward circuit breaker threshold", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 0,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 5000,
      });

      // Return 502 three times (retryable status, no retries)
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(502));

      for (let i = 0; i < 3; i++) {
        await client.request("https://api.example.com/test");
      }

      // Circuit should be open because retryable statuses count as failures
      expect(client.getConsecutiveFailures()).toBe(3);
      expect(client.isCircuitOpen()).toBe(true);
    });

    it("resets failure counter only on non-retryable success", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 0,
        circuitBreakerThreshold: 5,
      });

      // Two 502 failures
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(502));
      await client.request("https://api.example.com/test");
      await client.request("https://api.example.com/test");
      expect(client.getConsecutiveFailures()).toBe(2);

      // One 200 success should reset
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(200));
      await client.request("https://api.example.com/test");
      expect(client.getConsecutiveFailures()).toBe(0);
    });
  });

  describe("idempotency key", () => {
    it("includes Idempotency-Key header when provided", async () => {
      const client = new ResilientHttpClient({ maxRetries: 0 });

      let capturedHeaders: HeadersInit | undefined;
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) => {
          capturedHeaders = init?.headers;
          return Promise.resolve(mockResponse(200));
        },
      );

      await client.request("https://api.example.com/test", {
        method: "POST",
        idempotencyKey: "test-key-123",
      });

      expect(capturedHeaders).toBeDefined();
      const headers = capturedHeaders as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("test-key-123");
    });

    it("does not include Idempotency-Key header when not provided", async () => {
      const client = new ResilientHttpClient({ maxRetries: 0 });

      let capturedHeaders: HeadersInit | undefined;
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) => {
          capturedHeaders = init?.headers;
          return Promise.resolve(mockResponse(200));
        },
      );

      await client.request("https://api.example.com/test", {
        method: "GET",
      });

      const headers = capturedHeaders as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBeUndefined();
    });
  });

  describe("default configuration", () => {
    it("uses default config when none provided", () => {
      const client = new ResilientHttpClient();
      expect(client.isCircuitOpen()).toBe(false);
      expect(client.getConsecutiveFailures()).toBe(0);
    });

    it("merges partial config with defaults", () => {
      const client = new ResilientHttpClient({ maxRetries: 5 });
      // Should still have defaults for other fields
      expect(client.isCircuitOpen()).toBe(false);
    });
  });

  describe("request options override", () => {
    it("allows per-request retry override", async () => {
      const client = new ResilientHttpClient({
        maxRetries: 3,
        backoffBase: 1,
        backoffMax: 10,
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject(new Error("fail"));
      });

      await expect(
        client.request("https://api.example.com/test", { retries: 0 }),
      ).rejects.toThrow("fail");
      expect(callCount).toBe(1); // No retries
    });

    it("allows per-request timeout override", async () => {
      const client = new ResilientHttpClient({
        baseTimeout: 30_000,
        maxRetries: 0,
      });

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }
          });
        },
      );

      const pending = client.request("https://api.example.com/test", { timeout: 50 });
      const assertion = expect(pending).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
    });
  });

  describe("timer cleanup on error", () => {
    it("clears timeout timer when fetch throws", async () => {
      const client = new ResilientHttpClient({
        baseTimeout: 5000,
        maxRetries: 0,
      });

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

      await expect(
        client.request("https://api.example.com/test"),
      ).rejects.toThrow("Network failure");

      // clearTimeout should have been called in the catch block
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });
});

// ─── Which requests are re-sent ────────────────────────────────

describe("retries follow the method", () => {
  it("a POST that gets a 504 is sent once", async () => {
    const client = new ResilientHttpClient({ backoffBase: 1 });
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(504));
    globalThis.fetch = fetchSpy as any;
    const resp = await client.request("https://api.example.com/v1/thing", { method: "POST", body: "{}" });
    expect(resp.status).toBe(504);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a POST whose send throws (or times out) is not re-sent", async () => {
    const client = new ResilientHttpClient({ backoffBase: 1 });
    const fetchSpy = vi.fn().mockRejectedValue(new Error("socket hang up"));
    globalThis.fetch = fetchSpy as any;
    await expect(client.request("https://api.example.com/v1/thing", { method: "POST", body: "{}" })).rejects.toThrow(
      "socket hang up",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("an idempotency key alone does not make a POST retryable", async () => {
    const client = new ResilientHttpClient({ backoffBase: 1 });
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(503));
    globalThis.fetch = fetchSpy as any;
    await client.request("https://api.example.com/v1/thing", { method: "POST", idempotencyKey: "k1", retries: 3 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a GET that gets a 504 is still retried up to maxRetries", async () => {
    const client = new ResilientHttpClient({ maxRetries: 3, backoffBase: 1, backoffMax: 1 });
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(504));
    globalThis.fetch = fetchSpy as any;
    const pending = client.request("https://api.example.com/v1/thing");
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(504);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("a POST marked retryUnsafe is retried", async () => {
    const client = new ResilientHttpClient({ maxRetries: 2, backoffBase: 1, backoffMax: 1 });
    const fetchSpy = vi.fn().mockResolvedValueOnce(mockResponse(503)).mockResolvedValueOnce(mockResponse(200));
    globalThis.fetch = fetchSpy as any;
    const pending = client.request("https://api.example.com/v1/poll", { method: "POST", retryUnsafe: true });
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fetch is always called with redirect: manual", async () => {
    const client = new ResilientHttpClient({ maxRetries: 0 });
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200));
    globalThis.fetch = fetchSpy as any;
    await client.request("https://api.example.com/x", { redirect: "follow" });
    expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual");
  });
});

// ─── Circuit breaker per origin ────────────────────────────────

describe("circuit breaker per origin", () => {
  it("a flaky host opens only its own breaker (paid fetches to other hosts still go out)", async () => {
    const client = new ResilientHttpClient({ maxRetries: 0, circuitBreakerThreshold: 3 });
    const fetchSpy = vi.fn(async (url: string) =>
      url.startsWith("https://flaky.example") ? mockResponse(503) : mockResponse(200),
    );
    globalThis.fetch = fetchSpy as any;
    for (let i = 0; i < 3; i++) await client.request("https://flaky.example/data");
    await expect(client.request("https://flaky.example/data")).rejects.toThrow(CircuitOpenError);
    expect(client.isCircuitOpen("https://flaky.example/x")).toBe(true);
    expect(client.isCircuitOpen("https://other.example/x")).toBe(false);
    expect(client.isCircuitOpen()).toBe(true);

    const other = await client.request("https://other.example/pay", { headers: { "X-Payment": "sig" } });
    expect(other.status).toBe(200);
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("https://other.example"))).toHaveLength(1);
    expect(client.getConsecutiveFailures("https://flaky.example/")).toBeGreaterThanOrEqual(3);
    expect(client.getConsecutiveFailures()).toBe(0); // the most recent origin
  });
});

// ─── Redirects (real loopback servers) ─────────────────────────

describe("redirects", () => {
  type Seen = { path: string; host?: string; idem?: string; xpay?: string; auth?: string };
  let servers: http.Server[] = [];

  beforeEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return (server.address() as AddressInfo).port;
  }

  function recorder(seen: Seen[]) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      seen.push({
        path: req.url ?? "",
        host: req.headers.host,
        idem: req.headers["idempotency-key"] as string | undefined,
        xpay: req.headers["x-payment"] as string | undefined,
        auth: req.headers["authorization"] as string | undefined,
      });
      res.setHeader("content-type", "application/json");
      res.end("{}");
    };
  }

  it("a 302 to another origin is never followed: the target receives nothing (F146)", async () => {
    const seenB: Seen[] = [];
    const bPort = await serve(recorder(seenB));
    const aPort = await serve((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${bPort}/landing` });
      res.end();
    });
    const client = new ResilientHttpClient({ allowHttpOnLoopback: true, maxRetries: 0 });
    const url = `http://127.0.0.1:${aPort}/v1/x`;
    const headers = { Authorization: "secret", "X-Payment": "sig", "x-api-key": "key" };

    // Default: the 3xx comes back to the caller.
    const resp = await client.request(url, { headers, idempotencyKey: "idem1" });
    expect(resp.status).toBe(302);
    expect(resp.ok).toBe(false);

    // Opted in: refused as cross-origin, and a paid request is never followed.
    await expect(client.request(url, { headers, idempotencyKey: "idem1", followRedirects: 3 })).rejects.toBeInstanceOf(
      RedirectRefusedError,
    );
    await expect(client.request(url, { followRedirects: 3 })).rejects.toThrow(/cross-origin/);
    expect(seenB).toEqual([]);
  });

  it("a paid request is not followed even to the same origin", async () => {
    const seen: Seen[] = [];
    const port = await serve((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/next" });
        res.end();
        return;
      }
      recorder(seen)(req, res);
    });
    const client = new ResilientHttpClient({ allowHttpOnLoopback: true, maxRetries: 0 });
    await expect(
      client.request(`http://127.0.0.1:${port}/start`, { headers: { "X-Payment": "sig" }, followRedirects: 1 }),
    ).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(seen).toEqual([]);
  });

  it("an opted-in same-origin GET redirect is followed", async () => {
    const seen: Seen[] = [];
    const port = await serve((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/next" });
        res.end();
        return;
      }
      recorder(seen)(req, res);
    });
    const client = new ResilientHttpClient({ allowHttpOnLoopback: true, maxRetries: 0 });
    const resp = await client.request(`http://127.0.0.1:${port}/start`, { followRedirects: 1 });
    expect(resp.status).toBe(200);
    expect(seen.map((s) => s.path)).toEqual(["/next"]);
  });

  it("a redirect loop stops at the opted-in hop count", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });
    const client = new ResilientHttpClient({ allowHttpOnLoopback: true, maxRetries: 0 });
    await expect(client.request(`http://127.0.0.1:${port}/start`, { followRedirects: 2 })).rejects.toThrow(
      /more than 2 redirect/,
    );
  });

  it("a POST is never redirected, even when opted in", async () => {
    const seen: Seen[] = [];
    const port = await serve((req, res) => {
      if (req.url === "/start") {
        res.writeHead(307, { location: "/next" });
        res.end();
        return;
      }
      recorder(seen)(req, res);
    });
    const client = new ResilientHttpClient({ allowHttpOnLoopback: true, maxRetries: 0 });
    await expect(
      client.request(`http://127.0.0.1:${port}/start`, { method: "POST", body: "{}", followRedirects: 1 }),
    ).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(seen).toEqual([]);
  });
});

describe("redirect hops are checked like the first URL", () => {
  it("a redirect from https to http on a non-loopback host is refused", async () => {
    const client = new ResilientHttpClient({ maxRetries: 0 });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, { status: 301, headers: { location: "http://api.example.com/plain" } }),
    );
    globalThis.fetch = fetchSpy as any;
    await expect(client.request("https://api.example.com/start", { followRedirects: 3 })).rejects.toThrow(
      /HTTPS required/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
