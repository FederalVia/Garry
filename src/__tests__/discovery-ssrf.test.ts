/**
 * Agent-card fetches go to URLs anyone can register on chain. They reach
 * only public addresses (checked on the resolved answer, which is also the
 * one connected to), every redirect hop is re-validated, and the body is
 * bounded in size and time while it streams.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../observability/logger.js", () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

const { fetchAgentCard, isAllowedUri, isInternalNetwork } = await import("../registry/discovery.js");
const { fetchPublicHttps, isPublicAddress } = await import("../registry/safe-fetch.js");
type Deps = import("../registry/safe-fetch.js").SafeFetchDeps;

const CARD = JSON.stringify({ name: "Card", type: "agent", description: "ok" });
const CHUNK = Buffer.alloc(64 * 1024, 32);

let server: http.Server;
let port = 0;
let hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    switch (req.url) {
      case "/redirect-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      case "/redirect-https-metadata":
        res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      case "/big": {
        // 5 MB, chunked, no Content-Length
        res.writeHead(200, { "content-type": "application/json" });
        let n = 0;
        const pump = () => {
          while (n < 80) {
            n++;
            if (!res.write(CHUNK)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        res.on("error", () => {});
        pump();
        return;
      }
      case "/gzip":
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(CARD);
        return;
      case "/hang":
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        return; // never ends
      default:
        res.writeHead(200, { "content-type": "application/json" });
        res.end(CARD);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Test deps: every name resolves to loopback, which these tests treat as
 * public. The request connects through the lookup safe-fetch hands it (the
 * pinned answer), as https.request would, so pinning is exercised.
 */
function loopbackDeps(): Deps & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    isAllowedAddress: (ip) => ip === "127.0.0.1" || isPublicAddress(ip),
    request: (url, options) => {
      requests.push(url.toString());
      if (typeof options.lookup !== "function") throw new Error("request made without the pinned lookup");
      return http.request({
        host: url.hostname,
        port,
        path: url.pathname,
        method: "GET",
        headers: options.headers,
        lookup: options.lookup,
        signal: options.signal,
      });
    },
  };
}

describe("isPublicAddress", () => {
  const notPublic = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "203.0.113.5",
    "::", "::1", "[::1]", "fd00::1", "fe80::1", "fe80::1%eth0", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "2001::1", "2002:7f00:1::",
    "ff02::1", "not-an-ip",
  ];
  const isPublic = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of notPublic) it(`not public: ${ip}`, () => expect(isPublicAddress(ip)).toBe(false));
  for (const ip of isPublic) it(`public: ${ip}`, () => expect(isPublicAddress(ip)).toBe(true));
});

describe("syntactic URI pre-check", () => {
  for (const uri of [
    "https://[::1]/c.json",
    "https://[fd00::1]/c.json",
    "https://[::ffff:127.0.0.1]/c.json",
    "https://[fe80::1]/c.json",
    "https://100.64.0.1/c.json",
    "https://localhost./c.json",
    "https://a.localhost/c.json",
    "https://0x7f000001/c.json",
    "https://2130706433/c.json",
    "https://metadata.google.internal/c.json",
    "https://printer.local/c.json",
    "https://router.home.arpa/c.json",
    "http://example.com/c.json",
  ]) {
    it(`refuses ${uri}`, () => expect(isAllowedUri(uri)).toBe(false));
  }
  it("still allows public names and IPs", () => {
    expect(isAllowedUri("https://example.com/card.json")).toBe(true);
    expect(isAllowedUri("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toBe(true);
    expect(isInternalNetwork("8.8.8.8")).toBe(false);
  });
});

describe("fetchPublicHttps", () => {
  it("connects to the vetted answer even if the name resolves elsewhere later (no rebinding window)", async () => {
    let lookups = 0;
    const connected: string[] = [];
    const result = await fetchPublicHttps(
      "https://cards.example/card",
      { maxBytes: 64_000, timeoutMs: 2_000 },
      {
        // First answer is the vetted one; any later resolution is private.
        lookup: async () => [{ address: lookups++ === 0 ? "127.0.0.1" : "10.0.0.1", family: 4 }],
        isAllowedAddress: (ip) => ip === "127.0.0.1",
        request: (url, options) => {
          const pinned = options.lookup as unknown as (h: string, o: object, cb: (e: unknown, a: string) => void) => void;
          if (typeof pinned !== "function") throw new Error("no pinned lookup");
          pinned(url.hostname, { all: false }, (_e, address) => connected.push(address));
          return http.request({ host: url.hostname, port, path: url.pathname, headers: options.headers, lookup: options.lookup });
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(lookups).toBe(1);
    expect(connected).toEqual(["127.0.0.1"]);
  });

  it("starts no request once the deadline passed during DNS", async () => {
    const request = vi.fn();
    const result = await fetchPublicHttps(
      "https://cards.example/card",
      { maxBytes: 64_000, timeoutMs: 100 },
      {
        lookup: () => new Promise((resolve) => setTimeout(() => resolve([{ address: "127.0.0.1", family: 4 }]), 300)),
        isAllowedAddress: () => true,
        request: request as unknown as Deps["request"],
      },
    );
    expect(result).toMatchObject({ ok: false, error: "timed out after 100 ms" });
    await new Promise((r) => setTimeout(r, 400));
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a private address, before any request", async () => {
    const request = vi.fn();
    const result = await fetchPublicHttps(
      "https://cards.example/c.json",
      { maxBytes: 64_000, timeoutMs: 2_000 },
      { lookup: async () => [{ address: "127.0.0.1", family: 4 }], request: request as unknown as Deps["request"] },
    );
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses when any answer is private (one public, one private)", async () => {
    const request = vi.fn();
    const result = await fetchPublicHttps(
      "https://cards.example/c.json",
      { maxBytes: 64_000, timeoutMs: 2_000 },
      {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
        request: request as unknown as Deps["request"],
      },
    );
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses plain http", async () => {
    const deps = loopbackDeps();
    const result = await fetchPublicHttps(`http://cards.example/c.json`, { maxBytes: 64_000, timeoutMs: 2_000 }, deps);
    expect(result.ok).toBe(false);
    expect(deps.requests).toHaveLength(0);
  });

  it("reads a small card", async () => {
    const result = await fetchPublicHttps("https://cards.example/card", { maxBytes: 64_000, timeoutMs: 2_000 }, loopbackDeps());
    expect(result.ok && result.body).toBe(CARD);
  });

  it("aborts a 5 MB chunked body after at most the limit plus one chunk", async () => {
    const result = await fetchPublicHttps("https://cards.example/big", { maxBytes: 64_000, timeoutMs: 5_000 }, loopbackDeps());
    expect(result.ok).toBe(false);
    expect(result.bytesRead).toBeLessThanOrEqual(64_000 + CHUNK.length);
    expect(result.bytesRead).toBeLessThan(5 * 1024 * 1024);
  });

  it("refuses a compressed body", async () => {
    const result = await fetchPublicHttps("https://cards.example/gzip", { maxBytes: 64_000, timeoutMs: 2_000 }, loopbackDeps());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/content-encoding/);
  });

  it("cuts off a server that never finishes at the timeout", async () => {
    const started = Date.now();
    const result = await fetchPublicHttps("https://cards.example/hang", { maxBytes: 64_000, timeoutMs: 300 }, loopbackDeps());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("fetchAgentCard", () => {
  it("does not follow a redirect to the metadata service", async () => {
    hits = [];
    const deps = loopbackDeps();
    expect(await fetchAgentCard("https://cards.example/redirect-metadata", {}, deps)).toBeNull();
    expect(hits).toEqual(["/redirect-metadata"]);
    expect(deps.requests).toHaveLength(1);
  });

  it("re-validates the address of an https redirect target", async () => {
    hits = [];
    const deps = loopbackDeps();
    expect(await fetchAgentCard("https://cards.example/redirect-https-metadata", {}, deps)).toBeNull();
    expect(hits).toEqual(["/redirect-https-metadata"]);
    expect(deps.requests).toHaveLength(1);
  });

  it("returns null for an oversized streamed card", async () => {
    expect(await fetchAgentCard("https://cards.example/big", { fetchTimeoutMs: 5_000 }, loopbackDeps())).toBeNull();
  });

  it("lets the configured IPFS gateway origin skip the address check but keeps the size cap", async () => {
    const gateway = `http://127.0.0.1:${port}`;
    hits = [];
    const card = await fetchAgentCard("ipfs://bafycid/card.json", { ipfsGateway: gateway });
    expect(card?.name).toBe("Card");
    expect(hits).toEqual(["/ipfs/bafycid/card.json"]);
    // a CID path that leaves /ipfs/ is refused
    expect(await fetchAgentCard("ipfs://bafycid/../../big", { ipfsGateway: gateway })).toBeNull();
    expect(hits).toHaveLength(1);
  });
});
