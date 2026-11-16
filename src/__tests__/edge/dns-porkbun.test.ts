/**
 * Porkbun DNS adapter against a loopback fake of the JSON API v3.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PorkbunDnsProvider } from "../../edge/dns/porkbun.js";
import { DnsProviderError } from "../../edge/types.js";
import { clearRegisteredSecrets } from "../../security/secret-redaction.js";
import { FakePorkbun } from "../fixtures/edge/fake-porkbun.js";

let pb: FakePorkbun;

beforeEach(async () => {
  pb = await new FakePorkbun().start();
  pb.enableZone("example.com");
});

afterEach(async () => {
  await pb.close();
  clearRegisteredSecrets();
});

function provider(): PorkbunDnsProvider {
  return new PorkbunDnsProvider({ zone: "example.com", apiKey: pb.apiKey, secretApiKey: pb.secretApiKey, apiUrl: pb.url, backoffMs: [5, 5] });
}

async function failure(p: Promise<unknown>): Promise<DnsProviderError> {
  try {
    await p;
  } catch (err) {
    return err as DnsProviderError;
  }
  throw new Error("expected a failure");
}

describe("Porkbun DNS adapter", () => {
  it("security: sends the keys in the JSON body only, never in the URL or headers", async () => {
    await provider().verify();
    expect(pb.requests.length).toBeGreaterThan(0);
    for (const r of pb.requests) {
      expect(r.method).toBe("POST");
      expect(r.body).toMatchObject({ apikey: pb.apiKey, secretapikey: pb.secretApiKey });
      expect(r.path + r.query).not.toContain(pb.apiKey);
      expect(r.path + r.query).not.toContain(pb.secretApiKey);
      expect(JSON.stringify(r.headers)).not.toContain(pb.apiKey);
      expect(JSON.stringify(r.headers)).not.toContain(pb.secretApiKey);
    }
  });

  it("verify pings, retrieves, and always reports a broad token", async () => {
    await expect(provider().verify()).resolves.toEqual({ ok: true, broadToken: true });
    expect(pb.requests.map((r) => r.path)).toEqual(["/api/json/v3/ping", "/api/json/v3/dns/retrieve/example.com"]);
  });

  it("verify fails when API access is not enabled on the domain", async () => {
    const p = new PorkbunDnsProvider({ zone: "other.com", apiKey: pb.apiKey, secretApiKey: pb.secretApiKey, apiUrl: pb.url });
    const v = await p.verify();
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toMatch(/not opted in/);
  });

  it("retrieve maps FQDN names and string TTLs", async () => {
    pb.seed("example.com", { name: "example.com", type: "A", content: "203.0.113.1", ttl: 600 });
    pb.seed("example.com", { name: "app.example.com", type: "CNAME", content: "host.example.net", ttl: 3600 });
    const list = await provider().list();
    expect(list).toEqual([
      expect.objectContaining({ name: "example.com", type: "A", content: "203.0.113.1", ttl: 600 }),
      expect.objectContaining({ name: "app.example.com", type: "CNAME", ttl: 3600 }),
    ]);
    expect(typeof list[0].id).toBe("string");
  });

  it("create sends the relative name and a TTL of at least 600", async () => {
    const p = provider();
    expect(p.minTtl).toBe(600);
    const rec = await p.create({ type: "A", name: "app.example.com", content: "203.0.113.5", ttl: 300 });
    const body = pb.requestsTo("/dns/create/example.com")[0].body!;
    expect(body).toMatchObject({ name: "app", type: "A", content: "203.0.113.5", ttl: "600" });
    expect(rec).toMatchObject({ name: "app.example.com", ttl: 600 });
    expect(pb.zones.get("example.com")!.map((r) => r.name)).toContain("app.example.com");

    await p.create({ type: "TXT", name: "example.com", content: "apex", ttl: 900 });
    expect(pb.requestsTo("/dns/create/example.com")[1].body).toMatchObject({ name: "", ttl: "900" });
  });

  it("delete calls the record path", async () => {
    const r = pb.seed("example.com", { name: "x.example.com", type: "A", content: "203.0.113.2" });
    await provider().delete(r.id);
    expect(pb.requestsTo("/dns/delete/")[0].path).toBe(`/api/json/v3/dns/delete/example.com/${r.id}`);
    expect(pb.zones.get("example.com")).toHaveLength(0);
  });

  it("maps ERROR answers, on 4xx and on 200", async () => {
    const err = await failure(provider().delete("999"));
    expect(err).toBeInstanceOf(DnsProviderError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("Invalid record id");

    pb.respondNext({ status: 200, body: { status: "ERROR", message: "Something odd" } });
    const err2 = await failure(provider().list());
    expect(err2.status).toBe(200);
    expect(err2.message).toContain("Something odd");
  });

  it("security: redacts keys a failing answer echoes", async () => {
    pb.echoKeys = true;
    const err = await failure(provider().delete("999"));
    expect(err.message).not.toContain(pb.apiKey);
    expect(err.message).not.toContain(pb.secretApiKey);
  });
});
