/**
 * Porkbun registrar: price parsing, search limits, and every refusal of
 * registerDomain before anything is sent. Spend-path checks (financial).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRegistrarSection } from "../../edge/registrar/config.js";
import { createRegistrarClient } from "../../edge/registrar/index.js";
import { PorkbunRegistrar, QUOTE_CACHE_MS, RegistrarRefusedError } from "../../edge/registrar/porkbun.js";
import { parsePriceCents } from "../../edge/registrar/raw-client.js";
import { EdgeConfigError, RegistrarError, type ResolvedRegistrarConfig } from "../../edge/types.js";
import { classifySendError } from "../../treasury/treasury.js";
import { clearRegisteredSecrets, redactSecrets } from "../../security/secret-redaction.js";
import { FakePorkbun } from "../fixtures/edge/fake-porkbun.js";

let pb: FakePorkbun;
let now: number;

beforeEach(async () => {
  pb = await new FakePorkbun().start();
  now = 1_000_000;
});

afterEach(async () => {
  await pb.close();
  clearRegisteredSecrets();
});

function cfg(over: Record<string, unknown> = {}): ResolvedRegistrarConfig {
  return parseRegistrarSection(
    { provider: "porkbun", enabled: true, apiKey: pb.apiKey, secretApiKey: pb.secretApiKey, apiUrl: pb.url, ...over },
    {},
  )!;
}

function client(over: Record<string, unknown> = {}): PorkbunRegistrar {
  return createRegistrarClient(cfg(over), { now: () => now }) as PorkbunRegistrar;
}

async function failure(p: Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { status?: number };
  }
  throw new Error("expected a failure");
}

describe("registrar config", () => {
  it("is off unless enabled, and has the owner's defaults", () => {
    expect(parseRegistrarSection(undefined, {})).toBeNull();
    expect(parseRegistrarSection({ provider: "porkbun", enabled: false }, {})).toBeNull();
    expect(parseRegistrarSection({ provider: "porkbun" }, {})).toBeNull();
    const c = cfg();
    expect(c.allowedTlds).toEqual(["com", "net", "org", "dev"]);
    expect(c.maxPriceCents).toBe(2000);
    expect(c.years).toBe(1);
  });

  it("validates the section and registers keys for redaction, from config or env", () => {
    expect(() => parseRegistrarSection({ provider: "namecheap", enabled: true }, {})).toThrow(EdgeConfigError);
    expect(() => parseRegistrarSection({ provider: "porkbun", enabled: "yes" }, {})).toThrow(EdgeConfigError);
    expect(() => parseRegistrarSection({ provider: "porkbun", enabled: true }, {})).toThrow(/apiKey/);
    expect(() => parseRegistrarSection({ provider: "porkbun", enabled: true, apiKey: "a", secretApiKey: "b", maxPriceCents: 0 }, {})).toThrow(EdgeConfigError);
    expect(() => parseRegistrarSection({ provider: "porkbun", enabled: true, apiKey: "a", secretApiKey: "b", allowedTlds: ["c om"] }, {})).toThrow(EdgeConfigError);
    expect(() => parseRegistrarSection({ provider: "porkbun", enabled: true, apiKey: "a", secretApiKey: "b", years: 2 }, {})).toThrow(/unknown setting/);
    const env = { AUTOMATON_REGISTRAR_API_KEY: "pk1_env_key_0123456789abcdef", AUTOMATON_REGISTRAR_SECRET_API_KEY: "sk1_env_secret_0123456789abcdef" };
    const c = parseRegistrarSection({ provider: "porkbun", enabled: true, allowedTlds: [".COM", "io"] }, env)!;
    expect(c.allowedTlds).toEqual(["com", "io"]);
    expect(c.credentials()).toEqual({ apiKey: env.AUTOMATON_REGISTRAR_API_KEY, secretApiKey: env.AUTOMATON_REGISTRAR_SECRET_API_KEY });
    expect(JSON.stringify(c)).not.toContain("sk1_env_secret");
    expect(redactSecrets(`x ${env.AUTOMATON_REGISTRAR_SECRET_API_KEY}`)).not.toContain(env.AUTOMATON_REGISTRAR_SECRET_API_KEY);
  });
});

describe("price parsing (string arithmetic)", () => {
  it("parses whole cents from decimal strings and nothing else", () => {
    expect(parsePriceCents("10.99")).toBe(1099);
    expect(parsePriceCents("9.7")).toBe(970);
    expect(parsePriceCents("9.73")).toBe(973);
    expect(parsePriceCents("12")).toBe(1200);
    expect(parsePriceCents("0.29")).toBe(29);
    for (const bad of ["10.995", "1e3", "-1", "0", "0.00", "", " ", "1,000.00", "10.", ".99", "1234567.00", "NaN", "Infinity"]) {
      expect([bad, parsePriceCents(bad)]).toEqual([bad, null]);
    }
    expect(parsePriceCents(10.99)).toBeNull();
    expect(parsePriceCents(null)).toBeNull();
  });
});

describe("Porkbun registrar search", () => {
  it("checks at most three names, only in allowed TLDs, one after another", async () => {
    for (const t of ["com", "net", "org", "dev", "io"]) pb.setPrice(`myagent.${t}`, { avail: "yes", type: "registration", price: "10.99", premium: "no" });
    const res = await client().searchDomains("myagent", "io,com,dev,net,org");
    expect(res.map((r) => r.domain)).toEqual(["myagent.com", "myagent.dev", "myagent.net"]);
    expect(pb.requestsTo("/domain/checkDomain/")).toHaveLength(3);
    expect(pb.requestsTo("/domain/checkDomain/myagent.io")).toHaveLength(0);
    expect(res[0]).toEqual({ domain: "myagent.com", available: true, registrationPrice: 1099, renewalPrice: 1099, currency: "USD" });
  });

  it("uses the allowed TLDs when none are asked for", async () => {
    const res = await client().searchDomains("myagent");
    expect(res.map((r) => r.domain)).toEqual(["myagent.com", "myagent.net", "myagent.org"]);
  });

  it("marks premium, non-registration, unpriced and disallowed names unavailable", async () => {
    pb.setPrice("rich.com", { avail: "yes", type: "registration", price: "4999.00", premium: "yes" });
    pb.setPrice("aftermarket.com", { avail: "yes", type: "transfer", price: "10.99", premium: "no" });
    pb.setPrice("odd.com", { avail: "yes", type: "registration", price: "10.995", premium: "no" });
    pb.setPrice("ok.com", { avail: "yes", type: "registration", price: "10.99", premium: "no", renewal: "12.50" });
    const c = client();
    expect((await c.searchDomains("rich.com"))[0].available).toBe(false);
    expect((await c.searchDomains("aftermarket.com"))[0].available).toBe(false);
    const odd = (await c.searchDomains("odd.com"))[0];
    expect(odd.available).toBe(false);
    expect(odd.registrationPrice).toBeUndefined();
    expect(await c.searchDomains("ok.com")).toEqual([{ domain: "ok.com", available: true, registrationPrice: 1099, renewalPrice: 1250, currency: "USD" }]);
    const before = pb.requests.length;
    expect(await c.searchDomains("ok.io")).toEqual([{ domain: "ok.io", available: false, currency: "USD" }]);
    expect(pb.requests.length).toBe(before);
  });

  it("ends a search at the provider's check limit with what was found", async () => {
    pb.checkLimit = 1;
    pb.setPrice("myagent.com", { avail: "yes", type: "registration", price: "10.99", premium: "no" });
    const res = await client().searchDomains("myagent");
    expect(res.map((r) => r.domain)).toEqual(["myagent.com"]);
    expect(pb.requestsTo("/domain/checkDomain/")).toHaveLength(2);
  });

  it("caches quotes for 60 s", async () => {
    pb.setPrice("ok.com", { avail: "yes", type: "registration", price: "10.99", premium: "no" });
    const c = client();
    await c.quote("ok.com");
    await c.quote("ok.com");
    expect(pb.requestsTo("/domain/checkDomain/")).toHaveLength(1);
    now += QUOTE_CACHE_MS + 1;
    await c.quote("ok.com");
    expect(pb.requestsTo("/domain/checkDomain/")).toHaveLength(2);
  });
});

describe("Porkbun registrar purchase (spend path, treasury classification)", () => {
  beforeEach(() => {
    pb.setPrice("myagent.com", { avail: "yes", type: "registration", price: "10.99", premium: "no" });
  });

  async function refusedBeforeSend(c: PorkbunRegistrar, domain: string, years: number, quotedCents?: number): Promise<Error> {
    let sent = false;
    const err = await failure(c.registerDomain(domain, years, { quotedCents, onSend: () => (sent = true) }));
    expect(sent).toBe(false);
    expect(pb.requestsTo("/domain/create/")).toHaveLength(0);
    return err;
  }

  it("refuses without quotedCents, with a mismatch, above the limit, for years other than 1 and disallowed TLDs", async () => {
    const c = client();
    await c.searchDomains("myagent.com");
    expect(await refusedBeforeSend(c, "myagent.com", 1, undefined)).toBeInstanceOf(RegistrarRefusedError);
    expect((await refusedBeforeSend(c, "myagent.com", 1, 999)).message).toMatch(/does not match/);
    expect((await refusedBeforeSend(c, "myagent.com", 1, 10.99)).message).toMatch(/exact reserved price/);
    expect((await refusedBeforeSend(c, "myagent.com", 1, -1099)).message).toMatch(/exact reserved price/);
    expect((await refusedBeforeSend(c, "myagent.com", 2, 1099)).message).toMatch(/one-year/);
    expect((await refusedBeforeSend(c, "myagent.io", 1, 1099)).message).toMatch(/not an allowed TLD/);
    const cheap = client({ maxPriceCents: 1000 });
    await cheap.searchDomains("myagent.com");
    expect((await refusedBeforeSend(cheap, "myagent.com", 1, 1099)).message).toMatch(/above the owner's limit/);
  });

  it("refuses premium and unavailable names before sending", async () => {
    pb.setPrice("rich.com", { avail: "yes", type: "registration", price: "15.00", premium: "yes" });
    pb.setPrice("taken.com", { avail: "no", type: "registration", price: "10.99", premium: "no" });
    const c = client();
    expect((await refusedBeforeSend(c, "rich.com", 1, 1500)).message).toMatch(/premium/);
    expect((await refusedBeforeSend(c, "taken.com", 1, 1099)).message).toMatch(/not available/);
  });

  it("sends cost equal to quotedCents, once, after onSend", async () => {
    const c = client();
    const [q] = await c.searchDomains("myagent.com");
    const order: string[] = [];
    const reg = await c.registerDomain("MyAgent.com", 1, {
      quotedCents: q.registrationPrice,
      idempotencyKey: "k1",
      onSend: () => order.push(`onSend:${pb.requestsTo("/domain/create/").length}`),
    });
    expect(order).toEqual(["onSend:0"]);
    expect(reg).toMatchObject({ domain: "myagent.com", status: "registered", transactionId: "9000" });
    expect(pb.created).toEqual([{ domain: "myagent.com", cost: 1099, agreeToTerms: "yes" }]);
    expect(pb.requestsTo("/domain/create/")).toHaveLength(1);
  });

  it("money: turns Porkbun's default auto-renew off after a purchase and records the renewal date", async () => {
    const kv = new Map<string, string>();
    const c = createRegistrarClient(cfg(), { now: () => now, kv: { getKV: (k) => kv.get(k), setKV: (k, v) => void kv.set(k, v) } }) as PorkbunRegistrar;
    const [q] = await c.searchDomains("myagent.com");
    const reg = await c.registerDomain("myagent.com", 1, { quotedCents: q.registrationPrice });
    expect(pb.autoRenew.get("myagent.com")).toBe("off");
    const due = new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(reg.expiresAt).toBe(due);
    expect(reg.note).toMatch(/^Auto-renew is off/);
    expect(c.renewals()).toEqual([{ domain: "myagent.com", renewalDue: due, autoRenew: "off" }]);
    expect(c.statusLines()).toEqual([]);
  });

  it("money: a failed auto-renew change keeps the purchase and is surfaced for the owner", async () => {
    const c = client();
    const [q] = await c.searchDomains("myagent.com");
    pb.respondNext({ status: 500, body: { status: "ERROR", message: "temporarily unavailable" } }, (r) => r.path.includes("/domain/updateAutoRenew/"));
    const reg = await c.registerDomain("myagent.com", 1, { quotedCents: q.registrationPrice });
    expect(reg.status).toBe("registered");
    expect(pb.created).toHaveLength(1);
    expect(pb.autoRenew.get("myagent.com")).toBe("on");
    expect(reg.note).toMatch(/^Auto-renew could not be turned off; .*Tell your owner\.$/);
    expect(c.statusLines()).toEqual([expect.stringMatching(/^Domain myagent\.com: auto-renew could not be turned off/)]);
  });

  it("a price that moved at the registrar is refused with a 4xx (released)", async () => {
    const c = client();
    await c.searchDomains("myagent.com");
    pb.setPrice("myagent.com", { avail: "yes", type: "registration", price: "12.99", premium: "no" });
    let sent = false;
    const err = await failure(c.registerDomain("myagent.com", 1, { quotedCents: 1099, onSend: () => (sent = true) }));
    expect(sent).toBe(true);
    expect(err).toBeInstanceOf(RegistrarError);
    expect(err.status).toBe(400);
    expect(classifySendError(err, { sent: true })).toBe("released");
    expect(pb.created).toEqual([]);
  });

  it("a 2xx without SUCCESS, a 5xx or a dropped connection is unknown", async () => {
    const c = client();
    await c.searchDomains("myagent.com");
    pb.respondNext({ status: 200, body: { status: "ERROR", message: "Something went wrong" } }, (r) => r.path.includes("/domain/create/"));
    const e1 = await failure(c.registerDomain("myagent.com", 1, { quotedCents: 1099 }));
    expect(e1.status).toBeUndefined();
    expect(classifySendError(e1, { sent: true })).toBe("unknown");

    await c.quote("myagent.com");
    pb.respondNext({ status: 502, body: { status: "ERROR", message: "bad gateway" } }, (r) => r.path.includes("/domain/create/"));
    const e2 = await failure(c.registerDomain("myagent.com", 1, { quotedCents: 1099 }));
    expect(classifySendError(e2, { sent: true })).toBe("unknown");

    await c.quote("myagent.com");
    pb.respondNext({ status: 200, destroy: true }, (r) => r.path.includes("/domain/create/"));
    const e3 = await failure(c.registerDomain("myagent.com", 1, { quotedCents: 1099 }));
    expect(classifySendError(e3, { sent: true })).toBe("unknown");
    // Writes are never retried.
    expect(pb.requestsTo("/domain/create/")).toHaveLength(3);
  });

  it("security: redacts keys a failing answer echoes", async () => {
    pb.echoKeys = true;
    const c = client();
    await c.searchDomains("myagent.com");
    pb.setPrice("myagent.com", { avail: "yes", type: "registration", price: "12.99", premium: "no" });
    const err = await failure(c.registerDomain("myagent.com", 1, { quotedCents: 1099 }));
    expect(err.message).not.toContain(pb.apiKey);
    expect(err.message).not.toContain(pb.secretApiKey);
  });
});
