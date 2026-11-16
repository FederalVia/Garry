/**
 * withEdge: unchanged client without publicAccess; DNS routed by zone
 * (Conway keeps its own domains, standalone refuses them); the registrar is
 * ignored in Conway mode; ports go through the exposer when public.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createEdge, withEdge, type Edge } from "../../edge/index.js";
import { FakeDnsProvider } from "../../edge/dns/fake.js";
import { FakeRegistrar } from "../../edge/registrar/fake.js";
import { resolveRuntime } from "../../providers/mode.js";
import { createStandaloneClient } from "../../providers/standalone-client.js";
import { createConwayClient } from "../../conway/client.js";
import { MockConwayClient, createTestConfig, createTestDb } from "../mocks.js";
import { StructuredLogger } from "../../observability/logger.js";
import { normalizeTreasuryPolicy } from "../../treasury/index.js";
import type { AutomatonConfig, ConwayClient } from "../../types.js";

const DNS = { provider: "cloudflare", zone: "example.com", apiToken: "cf-facade-token-" + "x".repeat(24) };
const edges: Edge[] = [];

afterEach(async () => {
  await Promise.allSettled(edges.splice(0).map((e) => e.close(1_000)));
});

function build(config: AutomatonConfig, inner: ConwayClient, deps: Parameters<typeof createEdge>[0]["deps"] = {}) {
  const runtime = resolveRuntime(config);
  const edge = createEdge({ config, runtime, db: createTestDb(), inner, env: {}, deps });
  edges.push(edge);
  return { edge, client: withEdge(inner, edge, runtime.mode), runtime };
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(() => r(undefined)));
  return port;
}

describe("withEdge without publicAccess", () => {
  it("returns the same object in both modes and exposePort is today's", async () => {
    const standaloneCfg = createTestConfig({ conwayApiKey: "", sandboxId: "", providers: { mode: "standalone" } });
    const inner = createStandaloneClient();
    const s = build(standaloneCfg, inner);
    expect(s.client).toBe(inner);
    expect(s.edge.summary.configured).toBe(false);
    expect([s.edge.ports, s.edge.dns, s.edge.registrar]).toEqual([null, null, null]);
    expect(s.edge.statusLines()).toEqual([]);
    expect(await s.client.exposePort(3000)).toEqual({ port: 3000, publicUrl: "http://localhost:3000", sandboxId: "local" });

    const conwayInner = createConwayClient({ apiUrl: "https://api.conway.tech", apiKey: "k", sandboxId: "" });
    const c = build(createTestConfig({ sandboxId: "" }), conwayInner);
    expect(c.client).toBe(conwayInner);
    expect(await c.client.exposePort(3000)).toEqual({ port: 3000, publicUrl: "http://localhost:3000", sandboxId: "local" });
  });
});

describe("edge facade DNS policy", () => {
  it("Conway + DNS: names under the zone go to the zone service, other domains to Conway", async () => {
    const inner = new MockConwayClient();
    const add = vi.spyOn(inner, "addDnsRecord");
    const list = vi.spyOn(inner, "listDnsRecords");
    const fake = new FakeDnsProvider("example.com");
    const { client, edge } = build(createTestConfig({ sandboxId: "sbx-1", publicAccess: { dns: DNS } }), inner, { dnsProvider: fake });
    expect(edge.summary).toMatchObject({ configured: true, ports: "conway", dns: { zone: "example.com" } });
    const rec = await client.addDnsRecord("example.com", "A", "app", "93.184.216.34", 300);
    expect(rec).toMatchObject({ type: "A", host: "app", value: "93.184.216.34", managed: true });
    expect(fake.callCount("create")).toBe(1);
    expect(add).not.toHaveBeenCalled();
    const listed = await client.listDnsRecords("app.example.com");
    expect(listed.map((r) => r.managed)).toEqual([true]);
    await client.addDnsRecord("other.com", "A", "@", "93.184.216.34");
    await client.listDnsRecords("other.com");
    expect(add).toHaveBeenCalledWith("other.com", "A", "@", "93.184.216.34", undefined);
    expect(list).toHaveBeenCalledWith("other.com");
    expect(fake.callCount("create")).toBe(1);
  });

  it("standalone + DNS: other domains are refused DNS_OUTSIDE_ZONE; neither the inner client nor the provider is called", async () => {
    const inner = createStandaloneClient();
    const innerAdd = vi.spyOn(inner, "addDnsRecord");
    const fake = new FakeDnsProvider("example.com");
    const { client, runtime } = build(
      createTestConfig({ conwayApiKey: "", sandboxId: "", providers: { mode: "standalone" }, publicAccess: { dns: DNS } }),
      inner,
      { dnsProvider: fake },
    );
    expect(runtime.features.dns).toBe(true);
    expect(runtime.features.domainPurchase).toBe(false);
    for (const call of [
      () => client.addDnsRecord("other.com", "A", "@", "93.184.216.34"),
      () => client.listDnsRecords("other.com"),
      () => client.deleteDnsRecord("example.com.evil.com", "rec-1"),
    ]) {
      await expect(call()).rejects.toMatchObject({ name: "DnsPolicyError", code: "DNS_OUTSIDE_ZONE" });
    }
    expect(innerAdd).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("edge facade registrar policy", () => {
  const REG = { provider: "porkbun", enabled: true, apiKey: "pk1_" + "k".repeat(30), secretApiKey: "sk1_" + "s".repeat(30) };

  it("is ignored in Conway mode", async () => {
    const inner = new MockConwayClient();
    const reg = new FakeRegistrar();
    const { client, edge } = build(createTestConfig({ sandboxId: "", publicAccess: { dns: DNS, registrar: REG } }), inner, {
      dnsProvider: new FakeDnsProvider("example.com"),
      registrar: reg,
    });
    expect(edge.registrar).toBeNull();
    expect(edge.summary.ignored.join("\n")).toMatch(/^registrar: /m);
    const innerRegister = vi.spyOn(inner, "registerDomain");
    const innerSearch = vi.spyOn(inner, "searchDomains");
    await client.searchDomains("shop.com");
    await client.registerDomain("shop.com", 1);
    expect(innerSearch).toHaveBeenCalledWith("shop.com");
    expect(innerRegister).toHaveBeenCalledWith("shop.com", 1);
    expect(reg.searches).toEqual([]);
    expect(reg.registered).toEqual([]);
  });

  it("startup says when the registrar cannot buy (no budget, or infrastructure caps of 0) and that its keys are readable", async () => {
    const lines: string[] = [];
    StructuredLogger.setSink((e) => {
      if (e.level === "warn") lines.push(e.message);
    });
    try {
      const base = { conwayApiKey: "", sandboxId: "", providers: { mode: "standalone" as const }, publicAccess: { registrar: REG } };
      const cases = [
        { name: "no budget", extra: {}, warn: /stay hidden until a budget/, status: "Registrar: fake, not usable until your owner sets a budget" },
        {
          name: "caps 0",
          extra: { budget: { allowanceCents: 5000, period: "monthly" as const }, treasuryPolicy: normalizeTreasuryPolicy({ maxInfraSingleCents: 0, maxInfraDailyCents: 0 }) },
          warn: /maxInfraSingleCents and maxInfraDailyCents are not both set .*every purchase will be refused/,
          status: "Registrar: fake, not usable until your owner sets the infrastructure spending caps",
        },
        {
          name: "one cap 0",
          extra: { budget: { allowanceCents: 5000, period: "monthly" as const }, treasuryPolicy: normalizeTreasuryPolicy({ maxInfraSingleCents: 2000, maxInfraDailyCents: 0 }) },
          warn: /every purchase will be refused/,
          status: "Registrar: fake, not usable until your owner sets the infrastructure spending caps",
        },
        {
          name: "usable",
          extra: { budget: { allowanceCents: 5000, period: "monthly" as const }, treasuryPolicy: normalizeTreasuryPolicy({ maxInfraSingleCents: 2000, maxInfraDailyCents: 4000 }) },
          warn: null,
          status: "Registrar: fake (purchases go through your budget and treasury limits)",
        },
      ];
      for (const c of cases) {
        lines.length = 0;
        const { edge } = build(createTestConfig({ ...base, ...c.extra }), createStandaloneClient(), { registrar: new FakeRegistrar() });
        await edge.start();
        const refusal = lines.filter((l) => /stay hidden|will be refused/.test(l));
        if (c.warn) expect(refusal.join("\n"), c.name).toMatch(c.warn);
        else expect(refusal, c.name).toEqual([]);
        expect(lines.filter((l) => /registrar keys are readable by this runtime/.test(l)), c.name).toHaveLength(1);
        expect(edge.statusLines().join(" / "), c.name).toContain(c.status);
      }
      // Without a registrar none of this is logged.
      lines.length = 0;
      const { edge } = build(createTestConfig({ ...base, publicAccess: { dns: DNS } }), createStandaloneClient(), {
        dnsProvider: new FakeDnsProvider("example.com"),
      });
      await edge.start();
      expect(lines.filter((l) => /registrar/i.test(l))).toEqual([]);
    } finally {
      StructuredLogger.resetSink();
    }
  });

  it("standalone: search goes to the registrar", async () => {
    const reg = new FakeRegistrar();
    reg.setDomain("shop.com", { available: true, registrationCents: 1099 });
    const { client, edge } = build(
      createTestConfig({ conwayApiKey: "", sandboxId: "", providers: { mode: "standalone" }, publicAccess: { registrar: REG } }),
      createStandaloneClient(),
      { registrar: reg },
    );
    expect(edge.registrar).toBe(reg);
    expect(await client.searchDomains("shop.com")).toEqual([
      { domain: "shop.com", available: true, registrationPrice: 1099, currency: "USD" },
    ]);
  });
});

describe("edge facade port policy", () => {
  it("public modes route exposePort and removePort through the exposer", async () => {
    const gw = await freePort();
    const inner = createStandaloneClient();
    const innerExpose = vi.spyOn(inner, "exposePort");
    const { client, edge } = build(
      createTestConfig({
        conwayApiKey: "",
        sandboxId: "",
        providers: { mode: "standalone" },
        publicAccess: { ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com", gateway: { port: gw } } },
      }),
      inner,
      { probe: async () => false },
    );
    await edge.start();
    const info = await client.exposePort(3000, { name: "api" });
    expect(info).toMatchObject({ port: 3000, publicUrl: "https://api.agents.example.com", sandboxId: "local", scope: "public" });
    expect(info.note).toMatch(/127\.0\.0\.1 or 0\.0\.0\.0/);
    expect(info.note).toMatch(/Nothing is listening on 127\.0\.0\.1:3000 yet/);
    expect(innerExpose).not.toHaveBeenCalled();
    expect(edge.statusLines()).toContain("port 3000 (api): https://api.agents.example.com up");
    await client.removePort(3000);
    expect(edge.ports!.list()).toEqual([]);
    // A second remove says the port was not public instead of "removed".
    await expect(client.removePort(3000)).rejects.toThrow(/^NOT_EXPOSED: port 3000 was not public$/);
  });

  it("security: the edge reserves the ports of loopback MCP servers in the operator's file", async () => {
    const saved = process.env.HOME;
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edge-facade-mcp-")));
    try {
      process.env.HOME = home;
      fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
      const file = path.join(home, ".automaton", "mcp-servers.json");
      fs.writeFileSync(file, JSON.stringify({ version: 1, servers: { docs: { transport: "http", url: "http://127.0.0.1:7811/mcp", local: true } } }));
      fs.chmodSync(file, 0o600);
      const gw = await freePort();
      const { client, edge } = build(
        createTestConfig({
          conwayApiKey: "",
          sandboxId: "",
          providers: { mode: "standalone" },
          publicAccess: { ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com", gateway: { port: gw } } },
        }),
        createStandaloneClient(),
        { probe: async () => true },
      );
      await edge.start();
      await expect(client.exposePort(7811)).rejects.toThrow(/^PORT_RESERVED/);
      await expect(client.exposePort(7812)).resolves.toMatchObject({ port: 7812 });
    } finally {
      process.env.HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("security: Conway mode on this machine reserves OPENAI_BASE_URL and the loopback providers of inference-providers.json", async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edge-facade-conway-")));
    try {
      fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".automaton", "inference-providers.json"),
        JSON.stringify({
          providers: [
            {
              id: "local",
              baseUrl: "http://localhost:11437/v1",
              models: [{ id: "m", tier: "cheap", contextWindow: 8000, maxOutputTokens: 1000 }],
            },
          ],
        }),
      );
      const gw = await freePort();
      const config = createTestConfig({
        sandboxId: "",
        publicAccess: { ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com", gateway: { port: gw } } },
      });
      const inner = createConwayClient({ apiUrl: "https://api.conway.tech", apiKey: "k", sandboxId: "" });
      const runtime = resolveRuntime(config);
      expect(runtime.mode).toBe("conway");
      const edge = createEdge({
        config,
        runtime,
        db: createTestDb(),
        inner,
        env: { HOME: home, OPENAI_BASE_URL: "http://127.0.0.1:8002/v1" },
        deps: { probe: async () => true },
      });
      edges.push(edge);
      const client = withEdge(inner, edge, runtime.mode);
      await edge.start();
      await expect(client.exposePort(8002)).rejects.toThrow(/^PORT_RESERVED/);
      await expect(client.exposePort(11437)).rejects.toThrow(/^PORT_RESERVED/);
      await expect(client.exposePort(8003)).resolves.toMatchObject({ port: 8003, scope: "public" });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("Conway with a sandbox id keeps Conway's exposure", async () => {
    const inner = new MockConwayClient();
    const { client, edge } = build(
      createTestConfig({ sandboxId: "sbx-1", publicAccess: { ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com" } } }),
      inner,
    );
    expect(edge.ports).toBeNull();
    expect(client).toBe(inner);
    expect(await client.exposePort(3000)).toEqual({ port: 3000, publicUrl: "https://test-3000.conway.tech", sandboxId: "test-sandbox" });
  });
});
