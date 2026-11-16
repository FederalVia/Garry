/**
 * Edge JSON HTTP helper: redirects refused (no credential replay), bounded
 * bodies, deadlines, Retry-After handling, the sent flag and redaction.
 */

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanMessage,
  edgeFetchJson,
  isAllowedApiUrl,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  retryDelayMs,
} from "../../edge/http.js";
import { DnsProviderError, RegistrarError } from "../../edge/types.js";
import { clearRegisteredSecrets, registerSecret } from "../../security/secret-redaction.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];

async function serve(handler: Handler): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits };
}

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

afterEach(async () => {
  clearRegisteredSecrets();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function failure(p: Promise<unknown>): Promise<DnsProviderError> {
  try {
    await p;
  } catch (err) {
    return err as DnsProviderError;
  }
  throw new Error("expected a failure");
}

describe("edgeFetchJson security", () => {
  it("parses a JSON answer", async () => {
    const s = await serve((_req, res) => res.end(JSON.stringify({ ok: 1 })));
    const r = await edgeFetchJson<{ ok: number }>(`${s.url}/x`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: 1 });
  });

  it("refuses a redirect, and the redirect target never sees the request (no credential replay)", async () => {
    const target = await serve((_req, res) => res.end("{}"));
    const first = await serve((_req, res) => {
      res.writeHead(302, { location: `${target.url}/steal` });
      res.end();
    });
    const err = await failure(
      edgeFetchJson(`${first.url}/zones`, { headers: { authorization: "Bearer secret-token-value-123456" }, idempotent: true }),
    );
    expect(err).toBeInstanceOf(DnsProviderError);
    expect(err.message).toMatch(/redirect/);
    expect(err.sent).toBe(true);
    expect(first.hits()).toBe(1);
    expect(target.hits()).toBe(0);
  });

  it("caps the body size, by declared length and while streaming", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const declared = await serve((_req, res) => res.end(JSON.stringify({ big })));
    const err = await failure(edgeFetchJson(`${declared.url}/`, { maxBytes: 1024 * 1024 }));
    expect(err.message).toMatch(/larger than/);

    const chunked = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      for (let i = 0; i < 64; i++) res.write("x".repeat(32 * 1024));
      res.end();
    });
    const err2 = await failure(edgeFetchJson(`${chunked.url}/`, { maxBytes: 1024 * 1024 }));
    expect(err2.message).toMatch(/larger than/);
  });

  it("times out a server that never answers", async () => {
    const s = await serve(() => {
      /* never answers */
    });
    const started = Date.now();
    const err = await failure(edgeFetchJson(`${s.url}/`, { timeoutMs: 300 }));
    expect(err).toBeInstanceOf(DnsProviderError);
    expect(err.message).toMatch(/did not answer/);
    expect(err.sent).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects with the caller's abort reason", async () => {
    const s = await serve(() => {});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const err = await failure(edgeFetchJson(`${s.url}/`, { signal: ac.signal, timeoutMs: 5000 }));
    expect((err as Error).name).toBe("AbortError");
  });

  it("retries reads on 429 with Retry-After, never writes", async () => {
    let n = 0;
    const s = await serve((_req, res) => {
      n++;
      if (n === 1) {
        res.writeHead(429, { "retry-after": "0" });
        res.end(JSON.stringify({ message: "slow down" }));
        return;
      }
      res.end(JSON.stringify({ n }));
    });
    const r = await edgeFetchJson<{ n: number }>(`${s.url}/`, { idempotent: true, backoffMs: [10] });
    expect(r.body.n).toBe(2);

    n = 0;
    const err = await failure(edgeFetchJson(`${s.url}/`, { method: "POST", body: { a: 1 } }));
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(0);
    expect(s.hits()).toBe(3);
  });

  it("gives up after three read attempts on 503", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(503);
      res.end("{}");
    });
    const err = await failure(edgeFetchJson(`${s.url}/`, { idempotent: true, backoffMs: [5, 5] }));
    expect(err.status).toBe(503);
    expect(s.hits()).toBe(3);
  });

  it("does not retry other 4xx answers", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ message: "bad" }));
    });
    const err = await failure(edgeFetchJson(`${s.url}/`, { idempotent: true, backoffMs: [5] }));
    expect(err.status).toBe(400);
    expect(err.message).toContain("bad");
    expect(s.hits()).toBe(1);
  });

  it("caps Retry-After at 10 s and parses dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("3600")).toBe(3_600_000);
    expect(retryDelayMs(3_600_000, 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryDelayMs(2000, 0)).toBe(2000);
    expect(retryDelayMs(undefined, 0, [7])).toBe(7);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("sets sent=false only when the request certainly never left", async () => {
    const port = await closedPort();
    const refused = await failure(edgeFetchJson(`http://127.0.0.1:${port}/`, { method: "POST", body: {} }));
    expect(refused.sent).toBe(false);
    expect(refused.code).toBe("ECONNREFUSED");

    const invalid = await failure(edgeFetchJson("http://example.com/", { method: "POST", body: {} }));
    expect(invalid.sent).toBe(false);
    expect(invalid.message).toMatch(/^Invalid URL/);

    const reset = await serve((req) => req.socket.destroy());
    const dropped = await failure(edgeFetchJson(`${reset.url}/`, { method: "POST", body: {} }));
    expect(dropped.sent).toBe(true);
    expect(dropped.status).toBeUndefined();
    expect(reset.hits()).toBe(1);
  });

  it("allows https anywhere and http on loopback only", () => {
    expect(isAllowedApiUrl("https://api.cloudflare.com/client/v4")).toBe(true);
    expect(isAllowedApiUrl("http://127.0.0.1:8080/x")).toBe(true);
    expect(isAllowedApiUrl("http://localhost:8080/x")).toBe(true);
    expect(isAllowedApiUrl("http://api.cloudflare.com/client/v4")).toBe(false);
    expect(isAllowedApiUrl("https://user:pw@api.cloudflare.com/")).toBe(false);
    expect(isAllowedApiUrl("ftp://x/")).toBe(false);
  });

  it("redacts registered and listed secrets from error messages and cuts them short", async () => {
    registerSecret("registered-secret-value-abcdef", "edge-dns");
    const s = await serve((_req, res) => {
      res.writeHead(401);
      res.end(JSON.stringify({ message: `bad token registered-secret-value-abcdef short-tok ${"y".repeat(600)}` }));
    });
    const err = await failure(
      edgeFetchJson(`${s.url}/`, { secrets: ["short-tok"], makeError: (i) => new RegistrarError(i) }),
    );
    expect(err).toBeInstanceOf(RegistrarError);
    expect(err.message).not.toContain("registered-secret-value-abcdef");
    expect(err.message).not.toContain("short-tok");
    expect(err.message.length).toBeLessThanOrEqual(300);
    expect(cleanMessage("a\n\nb")).toBe("a b");
  });
});
