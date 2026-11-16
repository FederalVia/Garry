/**
 * The agent card: the in-process server, publishing through the gateway
 * (served at the public URL), republishing from update_agent_card, its own
 * tunnel in tunnel mode (URL updated after a restart), nothing in local
 * mode, and the card's port kept away from the agent's tools.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCardServer, type CardServer } from "../../edge/card-server.js";
import { AGENT_CARD_URL_KV, createEdge, installEdge, withEdge, type Edge } from "../../edge/index.js";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { resolveRuntime } from "../../providers/mode.js";
import { createStandaloneClient } from "../../providers/standalone-client.js";
import { MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";
import type { AgentCard, AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "..", "fixtures", "edge", "fake-tunnel.mjs");
const savedHome = process.env.HOME;
let home: string;
const edges: Edge[] = [];
const servers: CardServer[] = [];

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edge-card-")));
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});
afterEach(async () => {
  installEdge(null);
  await Promise.allSettled([...edges.splice(0).map((e) => e.close(2_000)), ...servers.splice(0).map((s) => s.close())]);
});

const CARD: AgentCard = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "card-test",
  description: "Autonomous agent: card-test",
  services: [{ name: "agentWallet", endpoint: "eip155:8453:0x1234567890abcdef1234567890abcdef12345678" }],
  x402Support: false,
  active: true,
};

function get(port: number, p: string, opts: { method?: string; host?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: opts.method ?? "GET", headers: opts.host ? { host: opts.host } : {}, agent: false },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(() => r(undefined)));
  return port;
}

async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function standalone(publicAccess: Record<string, unknown>): AutomatonConfig {
  return createTestConfig({ name: "card-test", conwayApiKey: "", sandboxId: "", providers: { mode: "standalone" }, publicAccess });
}

function build(config: AutomatonConfig, deps: Parameters<typeof createEdge>[0]["deps"] = {}) {
  const runtime = resolveRuntime(config);
  const db: AutomatonDatabase = createTestDb();
  const identity = { ...createTestIdentity(), sandboxId: "" };
  const inner = createStandaloneClient();
  const edge = createEdge({ config, runtime, db, inner, env: { PATH: process.env.PATH }, identity, deps: { probe: async () => true, ...deps } });
  edges.push(edge);
  installEdge(edge);
  const ctx: ToolContext = { identity, config, db, conway: withEdge(inner, edge, runtime.mode), inference: new MockInferenceClient() };
  return { edge, db, ctx, runtime };
}

describe("card server", () => {
  it("serves the card from memory with CORS, nosniff and cache headers, and 404 otherwise", async () => {
    const s = await startCardServer({ card: CARD });
    servers.push(s);
    for (const p of ["/.well-known/agent-card.json", "/agent-card.json"]) {
      const r = await get(s.port, p);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual(CARD);
      expect(r.headers["access-control-allow-origin"]).toBe("*");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["cache-control"]).toBe("max-age=300");
      expect(r.headers["content-type"]).toBe("application/json");
    }
    const head = await get(s.port, "/.well-known/agent-card.json", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect((await get(s.port, "/")).status).toBe(404);
    expect((await get(s.port, "/.well-known/agent-card.json", { method: "POST" })).status).toBe(404);
    s.setCard({ ...CARD, name: "renamed" });
    expect(JSON.parse((await get(s.port, "/agent-card.json")).body).name).toBe("renamed");
    expect(() => s.setCard({ ...CARD, description: "x".repeat(70_000) })).toThrow(/larger than/);
  });
});

describe("publishing", () => {
  it("proxy mode: the card is served at the public URL; update_agent_card republishes", async () => {
    const gw = await freePort();
    const { edge, db, ctx } = build(
      standalone({
        ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com", gateway: { port: gw } },
        agentCard: { publish: true },
      }),
    );
    expect(edge.summary.agentCard).toBe(true);
    await edge.start();
    const url = "https://agent.agents.example.com/.well-known/agent-card.json";
    expect(edge.agentCardUrl()).toBe(url);
    expect(db.getKV(AGENT_CARD_URL_KV)).toBe(url);
    expect(edge.statusLines()).toContain(`Agent card: ${url} (usable as agent_uri for register_erc8004)`);
    const u = new URL(url);
    const served = await get(gw, u.pathname, { host: u.host });
    expect(served.status).toBe(200);
    expect(JSON.parse(served.body)).toMatchObject({ name: "card-test", active: true });

    ctx.config.name = "renamed-agent";
    const tools = createBuiltinTools("", { standalone: true });
    const r = await executeTool("update_agent_card", {}, tools, ctx);
    expect(r.error).toBeUndefined();
    expect(r.result).toContain(`Published at ${url}`);
    expect(JSON.parse((await get(gw, u.pathname, { host: u.host })).body).name).toBe("renamed-agent");
  });

  it("policy: the card's port and name are the runtime's: the agent cannot remove, expose or take them", async () => {
    const gw = await freePort();
    const { edge, ctx } = build(
      standalone({
        ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com", gateway: { port: gw } },
        agentCard: { publish: true },
      }),
    );
    await edge.start();
    const cardPort = edge.ports!.list().find((e) => e.managedBy === "runtime")!.port;
    await expect(ctx.conway.removePort(cardPort)).rejects.toThrow(/^MANAGED_BY_RUNTIME: /);
    await expect(ctx.conway.exposePort(cardPort)).rejects.toThrow(/^PORT_RESERVED: /);
    await expect(ctx.conway.exposePort(3000, { name: "agent" })).rejects.toThrow(/^NAME_TAKEN: /);
    const tools = createBuiltinTools("", { standalone: true });
    const r = await executeTool("remove_port", { port: cardPort }, tools, ctx);
    expect(r.error).toMatch(/^MANAGED_BY_RUNTIME: /);
    // The card does not count against the agent's limit, and is not listed as the agent's port.
    expect(edge.statusLines().some((l) => l.startsWith(`port ${cardPort}`))).toBe(false);
  });

  it("tunnel mode: the card gets its own tunnel; the KV and the prompt follow a restart", async () => {
    const dir = fs.mkdtempSync(path.join(home, "tun-"));
    const argsFile = path.join(dir, "args.json");
    const { edge, db } = build(
      standalone({
        ports: {
          mode: "tunnel",
          tunnel: {
            preset: "custom",
            command: process.execPath,
            args: [FAKE, "--port", "{port}", "--args-dump", argsFile, "--crash-once", path.join(dir, "crashed")],
            urlPattern: "https://[a-z0-9-]+\\.trycloudflare\\.com",
          },
        },
        agentCard: { publish: true },
      }),
      { backoffMs: [50] },
    );
    await edge.start();
    const first = edge.agentCardUrl()!;
    expect(first).toMatch(/^https:\/\/t[0-9a-f]+\.trycloudflare\.com\/\.well-known\/agent-card\.json$/);
    const cardPort = edge.ports!.list().find((e) => e.managedBy === "runtime")!.port;
    expect(JSON.parse(fs.readFileSync(argsFile, "utf8"))).toContain(String(cardPort));
    expect(db.getKV(AGENT_CARD_URL_KV)).toBe(first);
    await waitFor(() => !!edge.agentCardUrl() && edge.agentCardUrl() !== first);
    const second = edge.agentCardUrl()!;
    expect(second).toMatch(/\.trycloudflare\.com\/\.well-known\/agent-card\.json$/);
    expect(db.getKV(AGENT_CARD_URL_KV)).toBe(second);
    expect(edge.statusLines()).toContain(`Agent card: ${second} (usable as agent_uri for register_erc8004)`);
  });

  it("local mode: nothing is published and the reason is recorded", async () => {
    const { edge, db, ctx } = build(standalone({ ports: { mode: "local" }, agentCard: { publish: true } }));
    expect(edge.summary.agentCard).toBe(false);
    expect(edge.summary.ignored.join("\n")).toMatch(/^agentCard: needs ports in proxy or tunnel mode/m);
    await edge.start();
    expect(await edge.publishAgentCard(CARD)).toBeNull();
    expect(db.getKV(AGENT_CARD_URL_KV)).toBeUndefined();
    const tools = createBuiltinTools("", { standalone: true });
    const r = await executeTool("update_agent_card", {}, tools, ctx);
    expect(r.result).not.toContain("Published at");
  });
});
