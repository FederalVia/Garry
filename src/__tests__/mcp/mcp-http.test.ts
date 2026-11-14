/**
 * Streamable HTTP MCP servers: loopback fixture, address policy, redirects,
 * encodings, caps and session handling.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../../agent/tools.js";
import { loadMcpConfig, setNpmGlobalPrefixResolver } from "../../mcp/config.js";
import { HttpTransport } from "../../mcp/http-transport.js";
import { McpSession } from "../../mcp/jsonrpc.js";
import { McpManager } from "../../mcp/manager.js";
import { formatToolResult } from "../../mcp/tools.js";
import { currentCancellationSignal, runWithCancellation } from "../../runtime/cancellation.js";
import { clearRegisteredSecrets } from "../../security/secret-redaction.js";
import type { AutomatonDatabase, AutomatonTool, ToolContext } from "../../types.js";
import { startFixtureHttpServer, type FixtureHttpServer } from "../fixtures/mcp/http-server.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";

let tmp: string;
let originalHome: string | undefined;
let cfgPath: string;
let db: AutomatonDatabase;
let ctx: ToolContext;
let server: FixtureHttpServer;
let managers: McpManager[] = [];
const TOKEN = "Bearer http-fixture-token-0123456789";

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-")));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(path.join(tmp, "home", ".automaton"), { recursive: true });
  cfgPath = path.join(tmp, "home", ".automaton", "mcp-servers.json");
  setNpmGlobalPrefixResolver(async () => null);
});

afterAll(() => {
  setNpmGlobalPrefixResolver(null);
  clearRegisteredSecrets();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

beforeEach(async () => {
  server = await startFixtureHttpServer();
  db = createTestDb();
  ctx = {
    identity: { ...createTestIdentity(), sandboxId: "" },
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  managers = [];
  await server.close();
  db.close();
});

function writeConfig(servers: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, servers }));
  fs.chmodSync(cfgPath, 0o600);
}

function local(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { transport: "http", url: server.url, local: true, headers: { Authorization: TOKEN }, ...extra };
}

async function load(): Promise<{ m: McpManager; tools: AutomatonTool[] }> {
  const m = new McpManager({ configPath: cfgPath, connectTimeoutMs: 5_000 });
  managers.push(m);
  const tools = await m.loadTools({ db, identity: { sandboxId: "" }, otherToolCount: 80 });
  return { m, tools };
}

describe("HTTP MCP servers", () => {
  it("lists and calls tools with JSON and SSE answers, sending the session and version headers", async () => {
    writeConfig({ docs: local() });
    const { tools } = await load();
    expect(tools.map((t) => t.name)).toEqual(["mcp__docs__echo", "mcp__docs__flood_requests", "mcp__docs__huge", "mcp__docs__slow", "mcp__docs__sse_echo"]);
    const json = await executeTool("mcp__docs__echo", { text: "hi" }, tools, ctx);
    expect(json.result).toContain("hi");
    const sse = await executeTool("mcp__docs__sse_echo", { text: "streamed" }, tools, ctx);
    expect(sse.error).toBeUndefined();
    expect(sse.result).toContain("sse:streamed");
    const call = server.requests.find((r) => r.body?.method === "tools/call");
    expect(call?.headers["mcp-session-id"]).toBe("sess-1");
    expect(call?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(call?.headers["accept-encoding"]).toBe("identity");
    expect(call?.headers.authorization).toBe(TOKEN);
  });

  it("treats the bare token of an Authorization header as a secret, in results and in arguments", async () => {
    const bare = TOKEN.slice("Bearer ".length);
    writeConfig({ docs: local(), other: local() });
    const { tools } = await load();
    for (const name of ["mcp__docs__echo", "mcp__other__echo"]) {
      const out = await executeTool(name, { text: bare }, tools, ctx);
      expect(out.error).toMatch(/contain a secret value; the call was not sent/);
    }
    expect(server.requests.filter((r) => r.body?.method === "tools/call")).toHaveLength(0);
    const shown = formatToolResult({ content: [{ type: "text", text: `token ${bare}` }] }, "docs", "echo", 10_000);
    expect(shown).not.toContain(bare);
    expect(shown).toContain("[REDACTED:mcp:");
  });

  it("drops a server that floods requests while leaving the answers unacknowledged", async () => {
    writeConfig({ docs: local() });
    const { m, tools } = await load();
    const out = await executeTool("mcp__docs__flood_requests", {}, tools, ctx);
    expect(out.error).toMatch(/protocol error: over 64 unanswered server requests/);
    const replies = server.requests.filter((r) => r.body?.method === undefined && r.body?.error?.code === -32601);
    // Arrival of the last POSTs can lag; the bound is what matters.
    expect(replies.length).toBeLessThanOrEqual(64);
    expect(m.serverStatus("docs")).not.toBe("ready");
  });

  it("connects outside any heartbeat cancellation scope, so the server outlives the task", async () => {
    writeConfig({ docs: local() });
    const seen: (AbortSignal | undefined)[] = [];
    const m = new McpManager({
      configPath: cfgPath,
      connectTimeoutMs: 5_000,
      httpDeps: {
        request: (u, o) => {
          seen.push(currentCancellationSignal());
          return http.request(u, o);
        },
      },
    });
    managers.push(m);
    const task = new AbortController();
    const tools = await runWithCancellation(task.signal, () =>
      m.loadTools({ db, identity: { sandboxId: "" }, otherToolCount: 80 }),
    );
    expect(tools.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === undefined)).toBe(true);
    // Aborting the task that first touched the server leaves it usable.
    task.abort();
    const res = await executeTool("mcp__docs__echo", { text: "after" }, tools, ctx);
    expect(res.error).toBeUndefined();
    expect(res.result).toContain("after");
  });

  it("refuses http:// without local, in the config and in the transport", async () => {
    writeConfig({ docs: local({ local: false }) });
    const cfg = loadMcpConfig({ path: cfgPath });
    expect(cfg.servers).toHaveLength(0);
    expect(cfg.warnings.join("\n")).toMatch(/scheme http: is allowed only with "local": true/);

    const t = new HttpTransport({ serverName: "x", url: server.url, headers: {}, local: false });
    await t.start(() => undefined, () => undefined);
    await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" }, { timeoutMs: 2_000 })).rejects.toThrow(/scheme http:/);
    expect(server.requests).toHaveLength(0);
  });

  it("connects to the address it checked, never a fresh resolution (no DNS rebinding)", async () => {
    // First answer public, every later answer loopback: a rebinding host.
    let lookups = 0;
    const lookup = async () => (lookups++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    const seen: unknown[] = [];
    const request = (_u: URL, o: import("node:https").RequestOptions): http.ClientRequest => {
      const pin = o.lookup as unknown as (h: string, opts: object, cb: (...a: unknown[]) => void) => void;
      expect(typeof pin).toBe("function");
      pin("mcp.example.test", {}, (_e: unknown, address: unknown, family: unknown) => seen.push({ address, family }));
      pin("mcp.example.test", { all: true }, (_e: unknown, all: unknown) => seen.push(all));
      // Deliver the request to the loopback fixture so the send completes.
      return http.request(new URL(server.url), { method: o.method, headers: o.headers, agent: false, signal: o.signal });
    };
    const t = new HttpTransport({ serverName: "x", url: "https://mcp.example.test/mcp", headers: {}, local: false, deps: { lookup, request } });
    const got: unknown[] = [];
    await t.start((m) => got.push(m), () => undefined);
    await t.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { timeoutMs: 2_000, expectId: 1, initialize: true });
    expect(lookups).toBe(1);
    expect(seen).toEqual([{ address: "93.184.216.34", family: 4 }, [{ address: "93.184.216.34", family: 4 }]]);
    expect(got).toHaveLength(1);
  });

  it("refuses a name that resolves to a private address", async () => {
    const t = new HttpTransport({
      serverName: "x",
      url: "https://mcp.example.test/mcp",
      headers: {},
      local: false,
      deps: { lookup: async () => [{ address: "10.0.0.5", family: 4 }] },
    });
    await t.start(() => undefined, () => undefined);
    await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" }, { timeoutMs: 2_000 })).rejects.toThrow(
      /resolves to non-public address 10\.0\.0\.5/,
    );
    const internal = new HttpTransport({ serverName: "x", url: "https://localhost/mcp", headers: {}, local: false });
    await internal.start(() => undefined, () => undefined);
    await expect(internal.send({ jsonrpc: "2.0", id: 1, method: "ping" }, { timeoutMs: 2_000 })).rejects.toThrow(/internal host/);
  });

  it("never follows a redirect, so the headers never reach the second server", async () => {
    const second = await startFixtureHttpServer();
    try {
      server.mode.redirectTo = second.url;
      writeConfig({ docs: local() });
      const { m, tools } = await load();
      expect(tools).toHaveLength(0);
      expect(m.serverStatus("docs")).toBe("down");
      expect(second.requests).toHaveLength(0);
    } finally {
      await second.close();
    }
  });

  it("refuses a compressed response", async () => {
    server.mode.gzip = true;
    writeConfig({ docs: local() });
    const { tools } = await load();
    expect(tools).toHaveLength(0);
  });

  it("fails a call whose response is over 4 MiB, or whose socket dies mid-body", async () => {
    writeConfig({ docs: local() });
    const { tools } = await load();
    const huge = await executeTool("mcp__docs__huge", {}, tools, ctx);
    expect(huge.error).toMatch(/over 4194304 bytes/);
    server.mode.destroyMidBody = true;
    const cut = await executeTool("mcp__docs__echo", { text: "x" }, tools, ctx);
    expect(cut.error).toBeDefined();
  });

  it("times out a slow call", async () => {
    writeConfig({ docs: local({ callTimeoutMs: 1_000 }) });
    const { tools } = await load();
    const out = await executeTool("mcp__docs__slow", { ms: 5_000 }, tools, ctx);
    expect(out.error).toMatch(/timed out after 1000 ms/);
  });

  it("re-initializes once when the session expires during tools/list", async () => {
    writeConfig({ docs: local() });
    const m = new McpManager({ configPath: cfgPath });
    managers.push(m);
    const t = new HttpTransport({ serverName: "docs", url: server.url, headers: {}, local: true });
    const session = new McpSession(t, { serverName: "docs", clientVersion: "test" });
    await session.start(() => undefined);
    await session.initialize(2_000);
    server.mode.expireSessionOnce = true;
    await expect(session.listTools(2_000)).rejects.toThrow(/session expired/);
    await session.close();

    // Through the manager: the stale list is refreshed after a re-initialize.
    const first = await m.loadTools({ db, identity: { sandboxId: "" }, otherToolCount: 80 });
    expect(first).toHaveLength(5);
    server.mode.expireSessionOnce = true;
    // Force a re-list on the next load.
    await executeTool("mcp__docs__echo", { text: "x" }, first, ctx);
    (m as any).servers.get("docs").stale = true;
    const second = await m.loadTools({ db, identity: { sandboxId: "" }, otherToolCount: 80 });
    expect(second).toHaveLength(5);
    expect(server.requests.filter((r) => r.body?.method === "initialize")).toHaveLength(3);
  });

  it("ends the session with DELETE on shutdown", async () => {
    writeConfig({ docs: local() });
    const { m } = await load();
    await m.shutdown();
    managers = [];
    const del = server.requests.find((r) => r.method === "DELETE");
    expect(del?.headers["mcp-session-id"]).toBe("sess-1");
  });
});
