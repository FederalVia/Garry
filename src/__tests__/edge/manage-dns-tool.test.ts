/**
 * manage_dns through executeTool on an owner zone (fake provider): records
 * the agent created are marked, names outside the zone are refused before
 * any provider call, add and delete inside the zone work, and the
 * description names the zone.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinTools, edgeToolOverrides, executeTool } from "../../agent/tools.js";
import { summarizeEdge } from "../../edge/config.js";
import { createEdge, installEdge, withEdge, type Edge } from "../../edge/index.js";
import { FakeDnsProvider } from "../../edge/dns/fake.js";
import { resolveRuntime } from "../../providers/mode.js";
import { createStandaloneClient } from "../../providers/standalone-client.js";
import { visibleTools } from "../../providers/features.js";
import { MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";
import type { ToolContext } from "../../types.js";

const edges: Edge[] = [];
afterEach(async () => {
  installEdge(null);
  await Promise.allSettled(edges.splice(0).map((e) => e.close(500)));
});

function setup(extra: Record<string, unknown> = {}) {
  const config = createTestConfig({
    conwayApiKey: "",
    sandboxId: "",
    providers: { mode: "standalone" },
    publicAccess: { dns: { provider: "cloudflare", zone: "example.com", apiToken: "cf-tool-token-" + "q".repeat(24) }, ...extra },
  });
  const runtime = resolveRuntime(config);
  const db = createTestDb();
  const fake = new FakeDnsProvider("example.com");
  fake.seed({ type: "A", name: "example.com", content: "93.184.216.34", ttl: 300 });
  fake.seed({ type: "CNAME", name: "blog.example.com", content: "hosting.example.net", ttl: 300 });
  const inner = createStandaloneClient();
  const edge = createEdge({ config, runtime, db, inner, env: {}, deps: { dnsProvider: fake } });
  edges.push(edge);
  installEdge(edge);
  const ctx: ToolContext = {
    identity: { ...createTestIdentity(), sandboxId: "" },
    config,
    db,
    conway: withEdge(inner, edge, runtime.mode),
    inference: new MockInferenceClient(),
  };
  const tools = visibleTools(createBuiltinTools("", { standalone: true }), runtime.features);
  const run = (args: Record<string, unknown>) => executeTool("manage_dns", args, tools, ctx);
  return { fake, tools, run };
}

describe("manage_dns zone policy on an owner zone", () => {
  it("is visible with a description naming the zone and caution risk", () => {
    const { tools } = setup();
    const tool = tools.find((t) => t.name === "manage_dns")!;
    expect(tool).toBeDefined();
    expect(tool.description).toContain("example.com");
    expect(tool.description).toMatch(/only records you created/);
    expect(tool.riskLevel).toBe("caution");
    expect(tools.find((t) => t.name === "register_domain")).toBeUndefined();
  });

  it("parameter descriptions match the zone's rules, not Conway's", () => {
    const params = (tools: { name: string; parameters: unknown }[]) =>
      (tools.find((t) => t.name === "manage_dns")!.parameters as { properties: Record<string, { description: string }> }).properties;
    const p = params(setup().tools);
    expect(p.type.description).toBe("Record type for add. For example.com: A, AAAA, CNAME, TXT.");
    expect(p.type.description).not.toMatch(/MX/);
    expect(p.host.description).not.toMatch(/'@' for root|'www'\)/);
    expect(p.host.description).toMatch(/the apex \('@'\) and www are off-limits/);
    // Cloudflare: the owner's default (300) stands.
    expect(p.ttl.description).toMatch(/default 300/);
    expect(p.ttl.description).not.toMatch(/3600/);
    const sub = params(
      setup({ dns: { provider: "cloudflare", zone: "example.com", apiToken: "cf-tool-token-" + "q".repeat(24), allowedSubtree: "agent", defaultTtl: 120 } }).tools,
    );
    expect(sub.host.description).toMatch(/'app\.agent' or 'agent'/);
    expect(sub.ttl.description).toMatch(/default 120/);
  });

  it("Porkbun's 600 s minimum shows as the default TTL; search_domains names the owner's TLDs", () => {
    const config = createTestConfig({
      conwayApiKey: "",
      sandboxId: "",
      providers: { mode: "standalone" },
      publicAccess: {
        dns: { provider: "porkbun", zone: "example.com", apiKey: "pk1_" + "k".repeat(30), secretApiKey: "sk1_" + "s".repeat(30), allowBroadToken: true },
        registrar: { provider: "porkbun", enabled: true, apiKey: "pk1_" + "k".repeat(30), secretApiKey: "sk1_" + "s".repeat(30), allowedTlds: ["com", "dev"] },
      },
    });
    const o = edgeToolOverrides(summarizeEdge(config, "standalone", {}), true);
    const props = (name: string) => (o[name]!.parameters as { properties: Record<string, { description: string }> }).properties;
    expect(props("manage_dns").ttl.description).toMatch(/default 600/);
    expect(props("search_domains").tlds.description).toMatch(/\(com,dev\)/);
    expect(props("search_domains").tlds.description).not.toMatch(/io|ai|xyz/);
  });

  it("refuses names outside the zone with zero provider calls", async () => {
    const { fake, run } = setup();
    const cases: Record<string, unknown>[] = [
      { action: "add", domain: "evil.com", type: "A", host: "@", value: "93.184.216.34" },
      { action: "add", domain: "x.example.com.evil.com", type: "A", host: "@", value: "93.184.216.34" },
      // Cyrillic "е" in place of the Latin "e".
      { action: "add", domain: "еxample.com", type: "A", host: "app", value: "93.184.216.34" },
      { action: "list", domain: "evil.com" },
      { action: "delete", domain: "evil.com", record_id: "owner-1" },
    ];
    for (const args of cases) {
      const r = await run(args);
      expect(r.error, JSON.stringify(args)).toMatch(/^DNS_OUTSIDE_ZONE: /);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("adds, lists with (yours) and deletes inside the zone; owner records stay untouchable", async () => {
    const { fake, run } = setup();
    const added = await run({ action: "add", domain: "example.com", type: "A", host: "app", value: "93.184.216.34" });
    expect(added.error).toBeUndefined();
    expect(added.result).toMatch(/^DNS record added: \[rec-\d+\] A app -> 93\.184\.216\.34$/);
    const id = /\[(rec-\d+)\]/.exec(added.result)![1];

    const listed = await run({ action: "list", domain: "example.com" });
    const lines = listed.result.split("\n");
    expect(lines.find((l) => l.includes("app ->"))).toMatch(/\(yours\)$/);
    expect(lines.find((l) => l.includes("blog ->"))).not.toMatch(/\(yours\)/);

    const ownerDelete = await run({ action: "delete", domain: "example.com", record_id: "owner-2" });
    expect(ownerDelete.error).toMatch(/^DNS_NOT_OWNED: /);
    const held = await run({ action: "add", domain: "example.com", type: "TXT", host: "blog", value: "v=1" });
    expect(held.error).toMatch(/^DNS_NAME_HELD_BY_OWNER: /);
    const www = await run({ action: "add", domain: "example.com", type: "A", host: "www", value: "93.184.216.34" });
    expect(www.error).toMatch(/^DNS_PROTECTED_NAME: /);

    const del = await run({ action: "delete", domain: "example.com", record_id: id });
    expect(del.error).toBeUndefined();
    expect(del.result).toBe(`DNS record ${id} deleted from example.com`);
    expect(fake.records.has(id)).toBe(false);
    expect(fake.callCount("create")).toBe(1);
    expect(fake.callCount("delete")).toBe(1);
  });

  it("names under the gateway's proxy suffix are the runtime's: no record can shadow the wildcard", async () => {
    const { fake, run } = setup({ ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com" } });
    for (const host of ["api.agents", "agent.agents", "agents", "_acme-challenge.agents"]) {
      const type = host.startsWith("_") ? "TXT" : "CNAME";
      const r = await run({ action: "add", domain: "example.com", type, host, value: type === "TXT" ? "token" : "evil.example.net" });
      expect(r.error, host).toMatch(/^DNS_PROTECTED_NAME: .*port gateway/);
    }
    expect(fake.callCount("create")).toBe(0);
    const ok = await run({ action: "add", domain: "example.com", type: "A", host: "app", value: "93.184.216.34" });
    expect(ok.error).toBeUndefined();
  });
});
