/**
 * Cloudflare DNS adapter against a loopback fake of the v4 API.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudflareDnsProvider } from "../../edge/dns/cloudflare.js";
import { DnsProviderError } from "../../edge/types.js";
import { clearRegisteredSecrets } from "../../security/secret-redaction.js";
import { FakeCloudflare } from "../fixtures/edge/fake-cloudflare.js";

let cf: FakeCloudflare;

beforeEach(async () => {
  cf = await new FakeCloudflare({ zones: ["example.com"] }).start();
});

afterEach(async () => {
  await cf.close();
  clearRegisteredSecrets();
});

function provider(extra: Partial<ConstructorParameters<typeof CloudflareDnsProvider>[0]> = {}): CloudflareDnsProvider {
  return new CloudflareDnsProvider({ zone: "example.com", apiToken: cf.token, apiUrl: cf.url, backoffMs: [5, 5], ...extra });
}

async function failure(p: Promise<unknown>): Promise<DnsProviderError> {
  try {
    await p;
  } catch (err) {
    return err as DnsProviderError;
  }
  throw new Error("expected a failure");
}

describe("Cloudflare adapter", () => {
  it("finds the zone by name and reports a narrow token", async () => {
    const p = provider();
    await expect(p.verify()).resolves.toEqual({ ok: true, broadToken: false });
    const byName = cf.requestsTo("GET", "/zones").find((r) => r.query.name === "example.com");
    expect(byName).toBeDefined();
    expect(byName!.headers.authorization).toBe(`Bearer ${cf.token}`);
  });

  it("checks a configured zoneId against the zone name", async () => {
    const ok = provider({ zoneId: cf.zoneId("example.com") });
    await expect(ok.verify()).resolves.toEqual({ ok: true, broadToken: false });
    expect(cf.requests.some((r) => r.path.endsWith(`/zones/${cf.zoneId("example.com")}`))).toBe(true);

    const otherId = cf.addZone("other.org");
    const wrong = provider({ zoneId: otherId });
    const v = await wrong.verify();
    expect(v.ok).toBe(false);
  });

  it("detects a broad token (two zones visible)", async () => {
    cf.addZone("other.org");
    await expect(provider().verify()).resolves.toEqual({ ok: true, broadToken: true });
  });

  it("reports a zone the token cannot see and a rejected token", async () => {
    const missing = new CloudflareDnsProvider({ zone: "absent.net", apiToken: cf.token, apiUrl: cf.url });
    const v = await missing.verify();
    expect(v.ok).toBe(false);

    const bad = new CloudflareDnsProvider({ zone: "example.com", apiToken: "wrong-token-000000000000", apiUrl: cf.url });
    const v2 = await bad.verify();
    expect(v2).toMatchObject({ ok: false });
    expect((v2 as { reason: string }).reason).toMatch(/rejected the token/);
  });

  it("pages through dns_records", async () => {
    for (let i = 0; i < 7; i++) cf.seed("example.com", { type: "A", name: `h${i}.example.com`, content: `203.0.113.${i + 1}`, ttl: 300 });
    const p = provider({ pageSize: 3 });
    const list = await p.list();
    expect(list).toHaveLength(7);
    expect(list.map((r) => r.name)).toContain("h6.example.com");
    const pages = cf.requestsTo("GET", "/dns_records").map((r) => r.query.page);
    expect(pages).toEqual(["1", "2", "3"]);
    expect(cf.requestsTo("GET", "/dns_records").every((r) => r.query.per_page === "3")).toBe(true);
  });

  it("refuses a partial list beyond 20 pages", async () => {
    for (let i = 0; i < 21; i++) cf.seed("example.com", { type: "TXT", name: `t${i}.example.com`, content: "x", ttl: 300 });
    const err = await failure(provider({ pageSize: 1 }).list());
    expect(err.message).toMatch(/refusing a partial list/);
  });

  it("creates with the FQDN, proxied false and a comment; TXT omits proxied", async () => {
    const p = provider();
    const rec = await p.create({ type: "A", name: "app.example.com", content: "203.0.113.7", ttl: 300 });
    expect(rec).toMatchObject({ type: "A", name: "app.example.com", content: "203.0.113.7", ttl: 300 });
    const post = cf.requestsTo("POST", "/dns_records")[0];
    expect(post.body).toEqual({ type: "A", name: "app.example.com", content: "203.0.113.7", ttl: 300, proxied: false, comment: "automaton" });

    await p.create({ type: "TXT", name: "_v.app.example.com", content: "hello", ttl: 300 });
    const txt = cf.requestsTo("POST", "/dns_records")[1];
    expect(txt.body).not.toHaveProperty("proxied");
  });

  it("tells its own records from the owner's by the comment it writes", async () => {
    const p = provider();
    const mine = await p.create({ type: "A", name: "app.example.com", content: "203.0.113.7", ttl: 300 });
    expect(mine.ours).toBe(true);
    cf.seed("example.com", { type: "A", name: "site.example.com", content: "203.0.113.8", ttl: 300 });
    cf.seed("example.com", { type: "A", name: "noted.example.com", content: "203.0.113.9", ttl: 300, comment: "the owner's note" });
    const byName = new Map((await p.list()).map((r) => [r.name, r.ours]));
    expect(byName.get("app.example.com")).toBe(true);
    expect(byName.get("site.example.com")).toBe(false);
    expect(byName.get("noted.example.com")).toBe(false);
  });

  it("deletes by zone and record id", async () => {
    const rec = cf.seed("example.com", { type: "A", name: "x.example.com", content: "203.0.113.9", ttl: 300 });
    await provider().delete(rec.id);
    const del = cf.requestsTo("DELETE", "/dns_records")[0];
    expect(del.path).toBe(`/client/v4/zones/${cf.zoneId("example.com")}/dns_records/${rec.id}`);
    expect(cf.recordsOf("example.com")).toHaveLength(0);
  });

  it("maps the error envelope (code and message)", async () => {
    const p = provider();
    await p.create({ type: "A", name: "dup.example.com", content: "203.0.113.1", ttl: 300 });
    const err = await failure(p.create({ type: "A", name: "dup.example.com", content: "203.0.113.1", ttl: 300 }));
    expect(err).toBeInstanceOf(DnsProviderError);
    expect(err.status).toBe(400);
    expect(err.providerCode).toBe("81057");
    expect(err.message).toContain("Record already exists");
  });

  it("maps success:false on a 200 answer", async () => {
    const p = provider();
    await p.verify();
    cf.respondNext({ status: 200, body: { success: false, errors: [{ code: 1004, message: "DNS Validation Error" }] } });
    const err = await failure(p.create({ type: "A", name: "v.example.com", content: "203.0.113.1", ttl: 300 }));
    expect(err.status).toBe(200);
    expect(err.providerCode).toBe("1004");
  });

  it("retries 429 with Retry-After on reads, never on writes", async () => {
    const p = provider();
    await p.verify();
    cf.respondNext({ status: 429, headers: { "retry-after": "0" }, body: { success: false, errors: [{ code: 10000, message: "rate limited" }] } }, (r) => r.method === "GET");
    await expect(p.list()).resolves.toEqual([]);
    expect(cf.requestsTo("GET", "/dns_records")).toHaveLength(2);

    cf.respondNext({ status: 429, headers: { "retry-after": "7" }, body: { success: false, errors: [{ code: 10000, message: "rate limited" }] } }, (r) => r.method === "POST");
    const err = await failure(p.create({ type: "A", name: "r.example.com", content: "203.0.113.1", ttl: 300 }));
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
    expect(cf.requestsTo("POST", "/dns_records")).toHaveLength(1);
    expect(cf.recordsOf("example.com")).toHaveLength(0);
  });

  it("security: does not follow a redirect to another server (no credential replay)", async () => {
    let seen = 0;
    const other = http.createServer((_req, res) => {
      seen++;
      res.end("{}");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const { port } = other.address() as AddressInfo;
    try {
      cf.respondNext({ status: 302, headers: { location: `http://127.0.0.1:${port}/client/v4/zones` } });
      const v = await provider().verify();
      expect(v.ok).toBe(false);
      expect((v as { reason: string }).reason).toMatch(/redirect/);
      expect(seen).toBe(0);
    } finally {
      other.closeAllConnections();
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it("bounds the body, times out and honours abort", async () => {
    const p = provider({ timeoutMs: 300 });
    await p.verify();
    cf.respondNext({ status: 200, raw: JSON.stringify({ success: true, result: [], pad: "x".repeat(1100 * 1024) }) });
    const big = await failure(p.list());
    expect(big.message).toMatch(/larger than/);

    // A timed-out read is not retried, so one slow answer is enough.
    cf.respondNext({ status: 200, body: { success: true, result: [] }, delayMs: 2000 });
    const slow = await failure(p.list());
    expect(slow.message).toMatch(/did not answer/);

    const q = provider({ timeoutMs: 5000 });
    await q.verify();
    cf.respondNext({ status: 200, body: { success: true, result: [] }, delayMs: 2000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const aborted = await failure(q.list({ signal: ac.signal }));
    expect((aborted as Error).name).toBe("AbortError");
  });

  it("security: redacts the token when the API echoes it", async () => {
    cf.echoAuth = true;
    const p = provider();
    await p.verify();
    const err = await failure(p.delete("missing-id"));
    expect(err.status).toBe(404);
    expect(err.message).not.toContain(cf.token);
    expect(err.message).toContain("REDACTED");
  });
});
