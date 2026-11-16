/**
 * DNS zone security: the zone policy alone and through the service with the
 * in-memory provider. Every refusal must happen before any provider call.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listChanges, liveOwnedRecords } from "../../edge/dns/changelog.js";
import { parseDnsSection } from "../../edge/dns/config.js";
import { FakeDnsProvider } from "../../edge/dns/fake.js";
import { DnsZonePolicy } from "../../edge/dns/policy.js";
import { createDnsService } from "../../edge/dns/service.js";
import { DnsPolicyError, DnsProviderError, EdgeConfigError, type DnsService, type ResolvedDnsConfig } from "../../edge/types.js";
import { clearRegisteredSecrets, redactSecrets } from "../../security/secret-redaction.js";

const TOKEN = "cf-dns-token-ABCDEFGHIJKLMNOP-0123";
const PUBLIC_V4 = "8.8.8.8";
const PUBLIC_V6 = "2606:4700:4700::1111";

function cfg(over: Record<string, unknown> = {}): ResolvedDnsConfig {
  return parseDnsSection({ provider: "cloudflare", zone: "example.com", apiToken: TOKEN, ...over }, {})!;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DnsPolicyError) return err.code;
    throw err;
  }
  return "OK";
}

async function acode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DnsPolicyError) return err.code;
    throw err;
  }
  return "OK";
}

let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-dns-"));
  db = new Database(path.join(tmp, "state.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  clearRegisteredSecrets();
});

// ─── Config ──────────────────────────────────────────────────

describe("DNS config security", () => {
  it("normalises the zone and refuses non-ASCII, single-label and malformed zones", () => {
    expect(cfg({ zone: "Example.COM." }).zone).toBe("example.com");
    expect(() => cfg({ zone: "exаmple.com" })).toThrow(EdgeConfigError); // Cyrillic a
    expect(() => cfg({ zone: "com" })).toThrow(/at least two labels/);
    expect(() => cfg({ zone: "ex_ample.com" })).toThrow(EdgeConfigError);
    expect(() => cfg({ zone: "a..com" })).toThrow(EdgeConfigError);
    expect(cfg({ zone: "xn--mnchen-3ya.de" }).zone).toBe("xn--mnchen-3ya.de");
  });

  it("refuses NS, SOA, DS, DNSKEY, MX, CAA and SRV for the agent", () => {
    for (const t of ["NS", "SOA", "DS", "DNSKEY", "MX", "CAA", "SRV"]) {
      expect(() => cfg({ allowedTypes: ["A", t] })).toThrow(EdgeConfigError);
    }
    expect(cfg({ allowedTypes: ["txt", "A"] }).allowedTypes).toEqual(["A", "TXT"]);
    expect(cfg().allowedTypes).toEqual(["A", "AAAA", "CNAME", "TXT"]);
  });

  it("requires credentials, reads them from the environment, and registers them for redaction", () => {
    expect(() => parseDnsSection({ provider: "cloudflare", zone: "example.com" }, {})).toThrow(/apiToken/);
    const envToken = "env-dns-token-0123456789abcdef";
    const c = parseDnsSection({ provider: "cloudflare", zone: "example.com" }, { AUTOMATON_DNS_API_TOKEN: envToken })!;
    expect(c.credentials()).toMatchObject({ provider: "cloudflare", apiToken: envToken });
    expect(redactSecrets(`token=${envToken}`)).not.toContain(envToken);
    // The resolved config never serialises its secret.
    expect(JSON.stringify(c)).not.toContain(envToken);
  });

  it("requires allowBroadToken for Porkbun, whose keys are account-wide", () => {
    const base = { provider: "porkbun", zone: "example.com", apiKey: "pk1_aaaaaaaaaaaaaaaaaaaa", secretApiKey: "sk1_bbbbbbbbbbbbbbbbbbbb" };
    expect(() => parseDnsSection(base, {})).toThrow(/allowBroadToken/);
    expect(parseDnsSection({ ...base, allowBroadToken: true }, {})!.provider).toBe("porkbun");
  });

  it("refuses plain http API URLs off loopback, unknown keys and out-of-range limits", () => {
    expect(() => cfg({ apiUrl: "http://api.cloudflare.com/client/v4" })).toThrow(/https/);
    expect(cfg({ apiUrl: "http://127.0.0.1:9999/client/v4" }).apiUrl).toBe("http://127.0.0.1:9999/client/v4");
    expect(() => cfg({ maxChangesPerHr: 5 })).toThrow(/unknown setting/);
    expect(() => cfg({ maxRecords: 0 })).toThrow(EdgeConfigError);
    expect(() => cfg({ maxRecords: 501 })).toThrow(EdgeConfigError);
    expect(() => cfg({ maxChangesPerHour: 50, maxChangesPerDay: 10 })).toThrow(/at least maxChangesPerHour/);
    expect(() => cfg({ allowedSubtree: "agent.other.com." })).toThrow(/not under/);
    expect(cfg({ allowedSubtree: "Agent" }).allowedSubtree).toBe("agent.example.com");
  });

  it("has the owner's defaults", () => {
    const c = cfg();
    expect(c).toMatchObject({
      allowApex: false,
      manageExisting: false,
      maxRecords: 25,
      maxChangesPerHour: 20,
      maxChangesPerDay: 100,
      defaultTtl: 300,
      allowPrivateAddresses: false,
      allowBroadToken: false,
    });
  });
});

// ─── Policy alone ────────────────────────────────────────────

describe("DNS zone policy", () => {
  const policy = new DnsZonePolicy(cfg({ extraProtectedNames: ["shop"] }), { reservedSubtrees: ["agents.example.com"] });
  const add = (domain: string, host: string, type = "A", value = PUBLIC_V4, ttl?: number, p = policy) =>
    code(() => p.checkAdd(domain, { type, host, value, ttl }, 60));

  it("refuses domains outside the zone in every spelling", () => {
    expect(add("other.com", "x")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("example.com.evil.com", "x")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("evil.com.", "x")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("notexample.com", "x")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("exаmple.com", "x")).toBe("DNS_OUTSIDE_ZONE"); // Cyrillic a
    expect(add("a..example.com", "x")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("*.example.com", "x")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("", "x")).toBe("DNS_OUTSIDE_ZONE");
  });

  it("refuses hosts that leave the zone or are malformed", () => {
    expect(add("example.com", "x.example.com.evil.com")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("example.com", "evil.com.")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("example.com", "example.com.evil.com.")).toBe("DNS_OUTSIDE_ZONE");
    expect(add("example.com", "a..b")).toBe("DNS_NAME_INVALID");
    expect(add("example.com", ".x")).toBe("DNS_NAME_INVALID");
    expect(add("example.com", "*")).toBe("DNS_NAME_INVALID");
    expect(add("example.com", "*.app")).toBe("DNS_NAME_INVALID");
    expect(add("example.com", "")).toBe("DNS_NAME_INVALID");
    expect(add("example.com", "аpp")).toBe("DNS_NAME_INVALID"); // Cyrillic a
    expect(add("example.com", "bad space")).toBe("DNS_NAME_INVALID");
    expect(add("example.com", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`)).toBe("DNS_NAME_INVALID");
  });

  it("normalises case and resolves relative, full and @ names", () => {
    const r = policy.checkAdd("EXAMPLE.COM.", { type: "a", host: "App", value: PUBLIC_V4 }, 60);
    expect(r).toMatchObject({ domain: "example.com", name: "app.example.com", type: "A" });
    expect(policy.checkAdd("example.com", { type: "A", host: "api.app.example.com", value: PUBLIC_V4 }, 60).name).toBe("api.app.example.com");
    expect(policy.checkAdd("app.example.com", { type: "A", host: "@", value: PUBLIC_V4 }, 60).name).toBe("app.example.com");
    expect(policy.checkAdd("app.example.com", { type: "A", host: "v2", value: PUBLIC_V4 }, 60).name).toBe("v2.app.example.com");
    expect(policy.checkAdd("example.com", { type: "TXT", host: "_acme-challenge.app", value: "tok" }, 60).name).toBe(
      "_acme-challenge.app.example.com",
    );
  });

  it("limits names to the configured subtree", () => {
    const p = new DnsZonePolicy(cfg({ allowedSubtree: "agent" }));
    expect(add("example.com", "x.agent", "A", PUBLIC_V4, undefined, p)).toBe("OK");
    expect(add("example.com", "agent", "A", PUBLIC_V4, undefined, p)).toBe("OK");
    expect(add("example.com", "x", "A", PUBLIC_V4, undefined, p)).toBe("DNS_OUTSIDE_ZONE");
    expect(add("example.com", "xagent", "A", PUBLIC_V4, undefined, p)).toBe("DNS_OUTSIDE_ZONE");
  });

  it("protects the owner's site, mail and identity names", () => {
    for (const host of ["@", "www", "mail", "_dmarc", "s1._domainkey", "x._domainkey.app", "default._bimi", "x._bimi.app", "mta-sts", "_mta-sts", "_smtp._tls", "autoconfig", "autodiscover", "shop"]) {
      expect([host, add("example.com", host, "TXT", "v")]).toEqual([host, "DNS_PROTECTED_NAME"]);
    }
  });

  it("protects underscore names attached to the apex or a protected name (ACME challenge, atproto)", () => {
    for (const host of ["_acme-challenge", "_atproto", "_acme-challenge.www", "_foo._bar"]) {
      expect([host, add("example.com", host, "TXT", "v")]).toEqual([host, "DNS_PROTECTED_NAME"]);
    }
    // Still protected when the owner allows apex records.
    const apex = new DnsZonePolicy(cfg({ allowApex: true }));
    expect(add("example.com", "@", "A", PUBLIC_V4, undefined, apex)).toBe("OK");
    expect(add("example.com", "_acme-challenge", "TXT", "v", undefined, apex)).toBe("DNS_PROTECTED_NAME");
    // The agent's own names can have challenges.
    expect(add("example.com", "_acme-challenge.app", "TXT", "v")).toBe("OK");
  });

  it("protects the runtime's gateway names, including challenges for its wildcard", () => {
    expect(add("example.com", "x.agents", "CNAME", "evil.example.net")).toBe("DNS_PROTECTED_NAME");
    expect(add("example.com", "agents", "A")).toBe("DNS_PROTECTED_NAME");
    expect(add("example.com", "_acme-challenge.agents", "TXT", "v")).toBe("DNS_PROTECTED_NAME");
    expect(add("example.com", "agentsx", "A")).toBe("OK");
  });

  it("allows only the configured types", () => {
    expect(add("example.com", "app", "MX", "mail.example.net")).toBe("DNS_TYPE_NOT_ALLOWED");
    expect(add("example.com", "app", "NS", "ns1.example.net")).toBe("DNS_TYPE_NOT_ALLOWED");
    const onlyA = new DnsZonePolicy(cfg({ allowedTypes: ["A"] }));
    expect(add("example.com", "app", "TXT", "v", undefined, onlyA)).toBe("DNS_TYPE_NOT_ALLOWED");
    expect(add("example.com", "app", "A", PUBLIC_V4, undefined, onlyA)).toBe("OK");
  });

  it("refuses private, loopback, ULA and link-local addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1", "100.64.0.1", "0.0.0.0", "1.2.3", "01.2.3.4", "999.1.1.1", "8.8.8.8 "]) {
      const expected = ip === "8.8.8.8 " ? "OK" : "DNS_CONTENT_INVALID";
      expect([ip, add("example.com", "app", "A", ip)]).toEqual([ip, expected]);
    }
    for (const ip of ["::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "2001:db8::1", "fe80::1%eth0", PUBLIC_V4]) {
      expect([ip, add("example.com", "app", "AAAA", ip)]).toEqual([ip, "DNS_CONTENT_INVALID"]);
    }
    expect(add("example.com", "app", "AAAA", PUBLIC_V6)).toBe("OK");
    expect(add("example.com", "app", "A", PUBLIC_V4)).toBe("OK");
    const lan = new DnsZonePolicy(cfg({ allowPrivateAddresses: true }));
    expect(add("example.com", "app", "A", "10.0.0.1", undefined, lan)).toBe("OK");
  });

  it("refuses CNAMEs to internal names, IPs, single labels or themselves", () => {
    for (const target of ["localhost", "foo.localhost", "db.local", "x.internal", "10.0.0.1", "8.8.8.8", "single", "app.example.com", "bad_name.example.net"]) {
      expect([target, add("example.com", "app", "CNAME", target)]).toEqual([target, "DNS_CONTENT_INVALID"]);
    }
    for (const target of ["nas.lan", "intranet.corp", "router.home", "wiki.intranet", "db.private", "a.test", "x.invalid"]) {
      expect([target, add("example.com", "app", "CNAME", target)]).toEqual([target, "DNS_CONTENT_INVALID"]);
    }
    // An owner on a private network who allows private addresses allows these too.
    expect(add("example.com", "app", "CNAME", "nas.lan", undefined, new DnsZonePolicy(cfg({ allowPrivateAddresses: true })))).toBe("OK");
    expect(add("example.com", "app", "CNAME", "plan.example.net")).toBe("OK");
    expect(add("example.com", "app", "CNAME", "Host.Example.NET.")).toBe("OK");
    expect(policy.checkAdd("example.com", { type: "CNAME", host: "app", value: "Host.Example.NET." }, 60).content).toBe("host.example.net");
  });

  it("refuses TXT values with control characters or over 2048 characters", () => {
    expect(add("example.com", "app", "TXT", "a\u0007b")).toBe("DNS_CONTENT_INVALID");
    expect(add("example.com", "app", "TXT", "line\nbreak")).toBe("DNS_CONTENT_INVALID");
    expect(add("example.com", "app", "TXT", "é")).toBe("DNS_CONTENT_INVALID");
    expect(add("example.com", "app", "TXT", "")).toBe("DNS_CONTENT_INVALID");
    expect(add("example.com", "app", "TXT", "x".repeat(2049))).toBe("DNS_CONTENT_INVALID");
    expect(add("example.com", "app", "TXT", "x".repeat(2048))).toBe("OK");
    expect(add("example.com", "app", "TXT", 'v=verify "quoted" ok')).toBe("OK");
  });

  it("bounds TTLs by the provider minimum and a day", () => {
    const ttl = (t: unknown, min: number) => code(() => policy.resolveTtl(t, min));
    expect(ttl(59, 60)).toBe("DNS_TTL_INVALID");
    expect(ttl(60, 60)).toBe("OK");
    expect(ttl(86_400, 60)).toBe("OK");
    expect(ttl(86_401, 60)).toBe("DNS_TTL_INVALID");
    expect(ttl(1.5, 60)).toBe("DNS_TTL_INVALID");
    expect(ttl("300", 60)).toBe("DNS_TTL_INVALID");
    expect(ttl(300, 600)).toBe("DNS_TTL_INVALID");
    expect(policy.resolveTtl(undefined, 60)).toBe(300);
    expect(policy.resolveTtl(undefined, 600)).toBe(600);
    expect(policy.resolveTtl(undefined, 1)).toBe(300);
  });
});

// ─── Through the service ─────────────────────────────────────

describe("DNS service security", () => {
  let now: number;
  let fake: FakeDnsProvider;

  function service(over: Record<string, unknown> = {}, opts: { provider?: FakeDnsProvider; reserved?: string[] } = {}): DnsService {
    return createDnsService(cfg(over), {
      db,
      provider: opts.provider ?? fake,
      now: () => now,
      reservedSubtrees: opts.reserved,
    });
  }

  beforeEach(() => {
    now = Date.parse("2026-11-01T12:00:00Z");
    fake = new FakeDnsProvider("example.com");
  });

  it("creates its tables idempotently", () => {
    service();
    service();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'edge_dns%'").all();
    expect(names.map((n) => (n as { name: string }).name).sort()).toEqual(["edge_dns_changes", "edge_dns_changes_zone_at", "edge_dns_records"]);
  });

  it("with a subtree, list shows only records at or under it and the agent's own", async () => {
    fake.seed({ type: "TXT", name: "internal-notes.example.com", content: "vpn=10.0.0.1", ttl: 300 });
    fake.seed({ type: "A", name: "origin-db.example.com", content: "203.0.113.7", ttl: 300 });
    fake.seed({ type: "A", name: "agent.example.com", content: PUBLIC_V4, ttl: 300 });
    const s = service({ allowedSubtree: "agent" });
    const mine = await s.add("example.com", { type: "A", host: "x.agent", value: PUBLIC_V4 });
    const names = (await s.list("example.com")).map((r) => r.name).sort();
    expect(names).toEqual(["agent.example.com", mine.name].sort());
    expect(JSON.stringify(await s.list("example.com"))).not.toContain("203.0.113.7");
    // Without a subtree the whole zone is listed, as before.
    expect((await service().list("example.com")).map((r) => r.name)).toContain("origin-db.example.com");
  });

  it("makes zero provider requests for refused calls", async () => {
    const s = service();
    const refused: [string, Promise<unknown>][] = [
      ["other zone", s.add("evil.com", { type: "A", host: "x", value: PUBLIC_V4 })],
      ["suffix trick", s.add("example.com.evil.com", { type: "A", host: "x", value: PUBLIC_V4 })],
      ["host trick", s.add("example.com", { type: "A", host: "x.example.com.evil.com", value: PUBLIC_V4 })],
      ["homoglyph", s.add("exаmple.com", { type: "A", host: "x", value: PUBLIC_V4 })],
      ["wildcard", s.add("example.com", { type: "A", host: "*", value: PUBLIC_V4 })],
      ["protected", s.add("example.com", { type: "TXT", host: "_dmarc", value: "v=DMARC1; p=none" })],
      ["type", s.add("example.com", { type: "MX", host: "app", value: "mx.example.net" })],
      ["private", s.add("example.com", { type: "A", host: "app", value: "127.0.0.1" })],
      ["ttl", s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4, ttl: 5 })],
      ["list outside", s.list("other.com")],
      ["remove outside", s.remove("other.com", "rec-1")],
      ["remove not owned", s.remove("example.com", "owner-1")],
    ];
    for (const [label, p] of refused) {
      const c = await acode(p);
      expect([label, c]).not.toEqual([label, "OK"]);
    }
    expect(fake.calls).toEqual([]);
    expect(listChanges(db, "example.com")).toEqual([]);
  });

  it("adds, lists (marking the agent's records) and deletes its own records", async () => {
    fake.seed({ type: "MX", name: "example.com", content: "mx.example.net", ttl: 300 });
    const s = service();
    const rec = await s.add("example.com", { type: "A", host: "App", value: PUBLIC_V4 });
    expect(rec).toMatchObject({ name: "app.example.com", host: "app", value: PUBLIC_V4, ttl: 300, managed: true });
    const list = await s.list("example.com");
    expect(list.find((r) => r.id === rec.id)?.managed).toBe(true);
    expect(list.find((r) => r.type === "MX")?.managed).toBe(false);
    const sub = await s.list("app.example.com");
    expect(sub).toEqual([expect.objectContaining({ id: rec.id, host: "@" })]);

    await s.remove("example.com", rec.id);
    expect(fake.records.has(rec.id)).toBe(false);
    expect(liveOwnedRecords(db, "fake", "example.com")).toEqual([]);
    expect(listChanges(db, "example.com").map((c) => [c.action, c.outcome])).toEqual([
      ["create", "ok"],
      ["delete", "ok"],
    ]);
  });

  it("refuses names that hold the owner's records unless manageExisting", async () => {
    fake.seed({ type: "TXT", name: "app.example.com", content: "owner", ttl: 300 });
    const s = service();
    expect(await acode(s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 }))).toBe("DNS_NAME_HELD_BY_OWNER");
    expect(fake.callCount("create")).toBe(0);
    const m = service({ manageExisting: true });
    expect(await acode(m.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 }))).toBe("OK");
  });

  it("refuses a name the owner's wildcard serves: an explicit record would shadow it", async () => {
    fake.seed({ type: "A", name: "*.wild.example.com", content: "93.184.216.34", ttl: 300 });
    const s = service();
    const refused = await s.add("example.com", { type: "A", host: "x.wild", value: PUBLIC_V4 }).catch((e: unknown) => e as DnsPolicyError);
    expect(refused).toBeInstanceOf(DnsPolicyError);
    expect((refused as DnsPolicyError).code).toBe("DNS_NAME_HELD_BY_OWNER");
    expect((refused as DnsPolicyError).message).toContain("*.wild.example.com");
    expect(await acode(s.add("example.com", { type: "TXT", host: "a.b.wild", value: "t" }))).toBe("DNS_NAME_HELD_BY_OWNER");
    expect(await acode(s.add("example.com", { type: "TXT", host: "_acme-challenge.x.wild", value: "t" }))).toBe("DNS_NAME_HELD_BY_OWNER");
    expect(fake.callCount("create")).toBe(0);
    // Names the wildcard does not answer for: its own parent, and anything outside it.
    expect(await acode(s.add("example.com", { type: "A", host: "wild", value: PUBLIC_V4 }))).toBe("OK");
    expect(await acode(s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 }))).toBe("OK");
    const m = service({ manageExisting: true });
    expect(await acode(m.add("example.com", { type: "A", host: "x.wild", value: PUBLIC_V4 }))).toBe("OK");
  });

  it("a zone-wide owner wildcard holds every unlisted name, except under a subtree the owner gave the agent", async () => {
    fake.seed({ type: "A", name: "*.example.com", content: "93.184.216.34", ttl: 300 });
    fake.seed({ type: "A", name: "blog.example.com", content: "93.184.216.34", ttl: 300 });
    const s = service();
    for (const host of ["shop", "login", "deep.er"]) {
      expect(await acode(s.add("example.com", { type: "A", host, value: PUBLIC_V4 })), host).toBe("DNS_NAME_HELD_BY_OWNER");
    }
    // blog exists, so the wildcard does not reach below it.
    expect(await acode(s.add("example.com", { type: "A", host: "api.blog", value: PUBLIC_V4 }))).toBe("OK");
    expect(fake.callCount("create")).toBe(1);

    const sub = service({ allowedSubtree: "agent" });
    expect(await acode(sub.add("example.com", { type: "A", host: "app.agent", value: PUBLIC_V4 }))).toBe("OK");
    // A wildcard the owner keeps inside the subtree still holds its names.
    fake.seed({ type: "CNAME", name: "*.sites.agent.example.com", content: "owner.example.net", ttl: 300 });
    expect(await acode(sub.add("example.com", { type: "A", host: "x.sites.agent", value: PUBLIC_V4 }))).toBe("DNS_NAME_HELD_BY_OWNER");
  });

  it("does not adopt an identical record the provider says is not ours", async () => {
    const s = service();
    fake.failNext(undefined, "socket hang up", { only: "create", sent: true });
    await expect(s.add("example.com", { type: "A", host: "later", value: PUBLIC_V4 })).rejects.toThrow(/no reliable answer/);
    // The owner makes the same record afterwards; the provider's marker says so.
    const theirs = fake.seed({ type: "A", name: "later.example.com", content: PUBLIC_V4, ttl: 300, ours: false });
    const listed = await s.list("example.com");
    expect(listed.find((r) => r.id === theirs.id)?.managed).toBe(false);
    expect(await acode(s.remove("example.com", theirs.id))).toBe("DNS_NOT_OWNED");
    expect(fake.records.has(theirs.id)).toBe(true);
  });

  it("refuses underscore names attached to a host that holds the owner's records unless manageExisting", async () => {
    fake.seed({ type: "A", name: "blog.example.com", content: PUBLIC_V4, ttl: 300 });
    fake.seed({ type: "CNAME", name: "shop.example.com", content: "shops.example.net", ttl: 300 });
    const s = service();
    expect(await acode(s.add("example.com", { type: "TXT", host: "_acme-challenge.blog", value: "token" }))).toBe("DNS_NAME_HELD_BY_OWNER");
    expect(await acode(s.add("example.com", { type: "CNAME", host: "_acme-challenge.shop", value: "acme.agent-owned.net" }))).toBe(
      "DNS_NAME_HELD_BY_OWNER",
    );
    expect(await acode(s.add("example.com", { type: "TXT", host: "_atproto.blog", value: "did=did:plc:x" }))).toBe("DNS_NAME_HELD_BY_OWNER");
    expect(await acode(s.add("example.com", { type: "TXT", host: "_x._dmarc.blog", value: "v=DMARC1" }))).toBe("DNS_NAME_HELD_BY_OWNER");
    expect(fake.callCount("create")).toBe(0);
    // A host of the agent's own, or with no records, is the agent's to attach names to.
    await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
    expect(await acode(s.add("example.com", { type: "TXT", host: "_acme-challenge.app", value: "token" }))).toBe("OK");
    expect(await acode(s.add("example.com", { type: "TXT", host: "_acme-challenge.fresh", value: "token" }))).toBe("OK");
    const m = service({ manageExisting: true });
    expect(await acode(m.add("example.com", { type: "TXT", host: "_acme-challenge.blog", value: "token" }))).toBe("OK");
  });

  it("refuses to delete records it did not create, and records under another domain", async () => {
    const owner = fake.seed({ type: "A", name: "site.example.com", content: PUBLIC_V4, ttl: 300 });
    const s = service();
    expect(await acode(s.remove("example.com", owner.id))).toBe("DNS_NOT_OWNED");
    const mine = await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
    expect(await acode(s.remove("other.example.com", mine.id))).toBe("DNS_NOT_OWNED");
    expect(fake.callCount("delete")).toBe(0);
    expect(fake.records.has(owner.id)).toBe(true);
  });

  it("refuses to delete when the provider's record under that id changed name or type", async () => {
    const s = service();
    const mine = await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
    fake.records.set(mine.id, { ...fake.records.get(mine.id)!, name: "site.example.com" });
    expect(await acode(s.remove("example.com", mine.id))).toBe("DNS_NOT_OWNED");
    expect(fake.callCount("delete")).toBe(0);
  });

  it("marks a record already gone at the provider as deleted without a call", async () => {
    const s = service();
    const mine = await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
    fake.records.delete(mine.id);
    await s.remove("example.com", mine.id);
    expect(fake.callCount("delete")).toBe(0);
    expect(liveOwnedRecords(db, "fake", "example.com")).toEqual([]);
  });

  it("never exceeds maxRecords under concurrent adds", async () => {
    fake.createDelayMs = 20;
    const s = service({ maxRecords: 3 });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => acode(s.add("example.com", { type: "A", host: `h${i}`, value: PUBLIC_V4 }))),
    );
    expect(results.filter((r) => r === "OK")).toHaveLength(3);
    expect(results.filter((r) => r === "DNS_RECORD_LIMIT")).toHaveLength(3);
    expect(fake.records.size).toBe(3);
    expect(liveOwnedRecords(db, "fake", "example.com")).toHaveLength(3);
  });

  it("returns an identical owned record instead of creating it again", async () => {
    const s = service();
    const a = await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
    const b = await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
    expect(b.id).toBe(a.id);
    expect(fake.callCount("create")).toBe(1);
  });

  it("enforces hourly and daily caps from the log, across service instances", async () => {
    const s = service({ maxChangesPerHour: 2, maxChangesPerDay: 3 });
    await s.add("example.com", { type: "A", host: "a", value: PUBLIC_V4 });
    fake.failNext(400, "invalid content", { only: "create" });
    // A failing change still spends the cap.
    await expect(s.add("example.com", { type: "A", host: "b", value: PUBLIC_V4 })).rejects.toBeInstanceOf(DnsProviderError);
    expect(await acode(s.add("example.com", { type: "A", host: "c", value: PUBLIC_V4 }))).toBe("DNS_RATE_LIMITED");

    const callsBefore = fake.calls.length;
    const fresh = new FakeDnsProvider("example.com");
    const s2 = service({ maxChangesPerHour: 2, maxChangesPerDay: 3 }, { provider: fresh });
    expect(await acode(s2.add("example.com", { type: "A", host: "c", value: PUBLIC_V4 }))).toBe("DNS_RATE_LIMITED");
    expect(fresh.calls).toEqual([]);
    expect(fake.calls.length).toBe(callsBefore);

    now += 61 * 60 * 1000;
    expect(await acode(s.add("example.com", { type: "A", host: "c", value: PUBLIC_V4 }))).toBe("OK");
    expect(await acode(s.add("example.com", { type: "A", host: "d", value: PUBLIC_V4 }))).toBe("DNS_RATE_LIMITED");
    try {
      await s.add("example.com", { type: "A", host: "d", value: PUBLIC_V4 });
    } catch (err) {
      expect((err as DnsPolicyError).message).toMatch(/per day/);
      expect((err as DnsPolicyError).retryAfterMs).toBeGreaterThan(0);
    }
    now += 24 * 60 * 60 * 1000;
    expect(await acode(s.add("example.com", { type: "A", host: "d", value: PUBLIC_V4 }))).toBe("OK");
  });

  it("logs outcomes: ok, failed and unknown, and adopts an unknown create on reconcile", async () => {
    const s = service();
    await s.add("example.com", { type: "A", host: "ok", value: PUBLIC_V4 });
    fake.failNext(422, "bad request", { only: "create" });
    await expect(s.add("example.com", { type: "A", host: "failed", value: PUBLIC_V4 })).rejects.toThrow();
    fake.failNext(502, "bad gateway", { only: "create", applied: true });
    await expect(s.add("example.com", { type: "TXT", host: "lost", value: "hello" })).rejects.toThrow(/no reliable answer/);
    expect(listChanges(db, "example.com").map((c) => c.outcome)).toEqual(["ok", "failed", "unknown"]);
    fake.failNext(undefined, "socket hang up", { only: "create", sent: true });
    await expect(s.add("example.com", { type: "A", host: "never", value: PUBLIC_V4 })).rejects.toThrow(/no reliable answer/);

    // The next fresh list (inside that add) already adopted the lost create.
    const before = listChanges(db, "example.com").map((c) => [c.name, c.outcome]);
    expect(before).toEqual([
      ["ok.example.com", "ok"],
      ["failed.example.com", "failed"],
      ["lost.example.com", "ok"],
      ["never.example.com", "unknown"],
    ]);

    const list = await s.list("example.com");
    const lost = list.find((r) => r.name === "lost.example.com");
    expect(lost?.managed).toBe(true);
    const after = listChanges(db, "example.com").map((c) => [c.name, c.outcome]);
    expect(after).toContainEqual(["lost.example.com", "ok"]);
    expect(after).toContainEqual(["never.example.com", "unknown"]);
    // Adopted, so it can be deleted.
    await s.remove("example.com", lost!.id);
    expect(fake.records.has(lost!.id)).toBe(false);
  });

  it("treats a pending row left by a crash as unknown and prunes rows older than 90 days", () => {
    service();
    db.prepare(
      "INSERT INTO edge_dns_changes (id, at_ms, provider, zone, action, outcome) VALUES ('p1', ?, 'fake', 'example.com', 'create', 'pending')",
    ).run(now - 1000);
    db.prepare(
      "INSERT INTO edge_dns_changes (id, at_ms, provider, zone, action, outcome) VALUES ('old', ?, 'fake', 'example.com', 'create', 'ok')",
    ).run(now - 91 * 24 * 60 * 60 * 1000);
    service();
    const rows = listChanges(db, "example.com");
    expect(rows.map((r) => [r.id, r.outcome])).toEqual([["p1", "unknown"]]);
  });

  it("refuses a broad token unless allowed, and a rejected token, as unavailable", async () => {
    fake.verifyResult = { ok: true, broadToken: true };
    const s = service();
    try {
      await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as DnsPolicyError).code).toBe("DNS_UNAVAILABLE");
      expect((err as Error).message).toMatch(/limited to example\.com/);
    }
    expect(s.availability()).toMatchObject({ state: "unavailable" });
    expect(fake.callCount("create")).toBe(0);
    expect(fake.callCount("list")).toBe(0);

    const broad = new FakeDnsProvider("example.com");
    broad.verifyResult = { ok: true, broadToken: true };
    const allowed = service({ allowBroadToken: true }, { provider: broad });
    await allowed.verify();
    expect(allowed.availability()).toEqual({ state: "ok", broadToken: true });

    const rejected = new FakeDnsProvider("example.com");
    rejected.verifyResult = { ok: false, reason: "Cloudflare rejected the token (HTTP 403)" };
    const r = service({}, { provider: rejected });
    expect(await acode(r.verify())).toBe("DNS_UNAVAILABLE");
    expect(r.availability()).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/rejected/) });
  });

  it("maps a provider 429 to DNS_RATE_LIMITED with the retry time", async () => {
    const s = service();
    fake.failNext(429, "rate limited", { only: "list", retryAfterMs: 30_000 });
    try {
      await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as DnsPolicyError).code).toBe("DNS_RATE_LIMITED");
      expect((err as DnsPolicyError).retryAfterMs).toBe(30_000);
    }
  });

  it("applies the provider's minimum TTL", async () => {
    const pb = new FakeDnsProvider("example.com", { minTtl: 600 });
    const s = service({}, { provider: pb });
    expect(await acode(s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4, ttl: 300 }))).toBe("DNS_TTL_INVALID");
    const rec = await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
    expect(rec.ttl).toBe(600);
  });

  it("covers only the zone", () => {
    const s = service();
    expect(s.covers("example.com")).toBe(true);
    expect(s.covers("App.Example.com.")).toBe(true);
    expect(s.covers("example.com.evil.com")).toBe(false);
    expect(s.covers("exаmple.com")).toBe(false);
    expect(s.covers("other.com")).toBe(false);
  });

  it("refuses names under the runtime's gateway suffix through the service", async () => {
    const s = service({}, { reserved: ["agents.example.com"] });
    expect(await acode(s.add("example.com", { type: "CNAME", host: "agent.agents", value: "evil.example.net" }))).toBe("DNS_PROTECTED_NAME");
    expect(fake.calls).toEqual([]);
  });

  it("redacts the token from provider errors and the change log", async () => {
    const s = service();
    fake.failNext(400, `invalid request with Authorization: Bearer ${TOKEN}`, { only: "create" });
    try {
      await s.add("example.com", { type: "A", host: "app", value: PUBLIC_V4 });
      throw new Error("expected failure");
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
    const rows = listChanges(db, "example.com");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(rows[0].error).toContain("REDACTED");
  });
});
