/**
 * Proxy mode: names from the URL template, the port rules, and the gateway
 * routing by Host to loopback backends only (404 for anything else, no
 * backend contacted), streaming, hop-by-hop headers, 502, WebSocket
 * upgrades, a busy gateway port, and the listening probe.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ProxyExposer, inferenceProviderLoopbackPorts, loopbackServicePorts, mcpLoopbackPorts, probeListening } from "../../edge/ports.js";
import { loadMcpConfig } from "../../mcp/config.js";
import type { ResolvedPortsConfig } from "../../edge/config.js";

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((c) => c()));
});

function cfg(over: Partial<ResolvedPortsConfig> = {}): ResolvedPortsConfig {
  return {
    mode: "proxy",
    urlTemplate: "https://{name}.agents.example.com",
    suffix: "agents.example.com",
    gateway: { host: "127.0.0.1", port: 0 },
    maxExposed: 3,
    allowedPorts: { min: 1024, max: 65535 },
    deniedPorts: [],
    restoreOnStart: false,
    ...over,
  };
}

async function exposer(over: Partial<ResolvedPortsConfig> = {}, reserved: number[] = []): Promise<ProxyExposer> {
  const ex = new ProxyExposer(cfg(over), { reservedPorts: () => reserved, probe: async () => true });
  closers.push(() => ex.close(1_000));
  await ex.start();
  return ex;
}

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: number;
}

async function backend(handler?: http.RequestListener): Promise<{ port: number; seen: Seen[]; server: http.Server }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = 0;
    req.on("data", (c: Buffer) => (body += c.length));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (handler) return handler(req, res);
      res.writeHead(200, { "content-type": "text/plain", connection: "keep-alive", "keep-alive": "timeout=5" });
      res.end(`hello from ${req.url}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  return { port: (server.address() as net.AddressInfo).port, seen, server };
}

function gwPort(ex: ProxyExposer): number {
  return ex.gateway.address()!.port;
}

function request(
  port: number,
  host: string,
  opts: { method?: string; path?: string; body?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/", headers: { host, ...opts.headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.end(opts.body);
    else req.end();
  });
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(() => r(undefined)));
  return port;
}

describe("proxy exposure policy", () => {
  it("builds the URL from the template and the name; the default name is p<port>", async () => {
    const ex = await exposer();
    const a = await ex.expose(3000, { name: "API" });
    expect(a).toMatchObject({ port: 3000, name: "api", url: "https://api.agents.example.com", scope: "public", state: "up" });
    const b = await ex.expose(3001);
    expect(b.url).toBe("https://p3001.agents.example.com");
  });

  it("refuses invalid, reserved and duplicate names; re-exposing is idempotent", async () => {
    const ex = await exposer();
    ex.reserveName("agent");
    await expect(ex.expose(3000, { name: "bad_name" })).rejects.toThrow(/^NAME_INVALID:/);
    await expect(ex.expose(3000, { name: "-x" })).rejects.toThrow(/^NAME_INVALID:/);
    await expect(ex.expose(3000, { name: "a".repeat(41) })).rejects.toThrow(/^NAME_INVALID:/);
    await expect(ex.expose(3000, { name: "agent" })).rejects.toThrow(/^NAME_TAKEN:/);
    const first = await ex.expose(3000, { name: "web" });
    expect(await ex.expose(3000, { name: "web" })).toMatchObject({ url: first.url });
    expect(await ex.expose(3000)).toMatchObject({ url: first.url });
    await expect(ex.expose(3000, { name: "other" })).rejects.toThrow(/^NAME_TAKEN: port 3000 is already public as web/);
    await expect(ex.expose(3001, { name: "web" })).rejects.toThrow(/^NAME_TAKEN: the name web is already used/);
    expect(ex.list()).toHaveLength(1);
  });

  it("allows at most maxExposed agent ports", async () => {
    const ex = await exposer({ maxExposed: 2 });
    await ex.expose(3000);
    await ex.expose(3001);
    await expect(ex.expose(3002)).rejects.toThrow(/^PORT_LIMIT: at most 2/);
    await ex.remove(3000);
    await expect(ex.expose(3002)).resolves.toMatchObject({ port: 3002 });
  });

  it("concurrent exposes of different ports count toward maxExposed, and a name is given once", async () => {
    const ex = await exposer({ maxExposed: 3 });
    await ex.expose(3000);
    const many = await Promise.allSettled([31001, 31002, 31003, 31004, 31005].map((p) => ex.expose(p)));
    expect(many.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of many.filter((r) => r.status === "rejected")) {
      expect(String((r as PromiseRejectedResult).reason)).toMatch(/PORT_LIMIT/);
    }
    expect(ex.list()).toHaveLength(3);

    const named = await exposer({ maxExposed: 5 });
    const pair = await Promise.allSettled([named.expose(32001, { name: "same" }), named.expose(32002, { name: "same" })]);
    expect(pair.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(String((pair[1] as PromiseRejectedResult).reason)).toMatch(/NAME_TAKEN/);
    expect(named.list().map((e) => [e.port, e.name])).toEqual([[32001, "same"]]);
    // A settled expose frees its slot and name for the next one.
    await named.remove(32001);
    await expect(named.expose(32002, { name: "same" })).resolves.toMatchObject({ port: 32002, name: "same" });
  });

  it("refuses the ports of the operator's loopback MCP HTTP servers (security)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-mcp-"));
    closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "mcp-servers.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        enabled: true,
        servers: {
          docs: { transport: "http", url: "http://127.0.0.1:7801/mcp", local: true },
          off: { transport: "http", url: "http://localhost:7802/mcp", local: true, enabled: false },
          remote: { transport: "http", url: "https://mcp.example.com:7803/mcp" },
        },
      }),
    );
    fs.chmodSync(file, 0o600);
    const ports = mcpLoopbackPorts(() => loadMcpConfig({ path: file }));
    expect(ports.sort()).toEqual([7801, 7802]);
    const ex = await exposer({}, ports);
    await expect(ex.expose(7801)).rejects.toThrow(/^PORT_RESERVED/);
    await expect(ex.expose(7802)).rejects.toThrow(/^PORT_RESERVED/);
    await expect(ex.expose(7803)).resolves.toMatchObject({ port: 7803 });
    expect(mcpLoopbackPorts(() => loadMcpConfig({ path: path.join(dir, "missing.json") }))).toEqual([]);
  });

  it("refuses ports outside allowedPorts, denied ports, well-known service ports and reserved loopback service ports", async () => {
    const reserved = loopbackServicePorts({
      ollamaBaseUrl: "http://127.0.0.1:11434",
      providers: { openai: { baseUrl: "http://localhost:8000/v1" } },
      socialRelayUrl: "https://relay.example.org",
    });
    expect(reserved.sort()).toEqual([11434, 8000].sort());
    const ex = await exposer({ deniedPorts: [5000], gateway: { host: "127.0.0.1", port: 0 } }, reserved);
    await expect(ex.expose(80)).rejects.toThrow(/^PORT_NOT_ALLOWED: port 80 is outside/);
    await expect(ex.expose(3000.5)).rejects.toThrow(/^PORT_NOT_ALLOWED/);
    await expect(ex.expose(5000)).rejects.toThrow(/^PORT_NOT_ALLOWED: port 5000 is denied/);
    for (const p of [2375, 4040, 5432, 6379, 9229]) await expect(ex.expose(p)).rejects.toThrow(/^PORT_NOT_ALLOWED/);
    await expect(ex.expose(11434)).rejects.toThrow(
      "PORT_RESERVED: port 11434 is used by a local service of this runtime and cannot be made public",
    );
    await expect(ex.expose(8000)).rejects.toThrow(/^PORT_RESERVED/);
    await expect(ex.expose(gwPort(ex))).rejects.toThrow(/^PORT_RESERVED/);
    // An explicit allow list overrides the well-known defaults.
    const listed = await exposer({ allowedPorts: [6379] });
    await expect(listed.expose(6379)).resolves.toMatchObject({ port: 6379 });
    await expect(listed.expose(3000)).rejects.toThrow(/^PORT_NOT_ALLOWED/);
  });

  it("reserves the loopback endpoints of every configured provider (Ollama, compatible servers, a local Conway)", () => {
    const reserved = loopbackServicePorts(
      {
        providers: {
          compatible: [
            { id: "vllm", baseUrl: "http://127.0.0.1:8001/v1", free: true },
            { id: "lmstudio", baseUrl: "http://[::1]:1234/v1" },
            { id: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_x" },
          ],
        },
        conwayApiUrl: "http://localhost:7070",
      },
      { OLLAMA_BASE_URL: "http://localhost:11435", OPENAI_BASE_URL: "http://127.0.0.1:8002/v1" },
    );
    expect(reserved.sort((a, b) => a - b)).toEqual([1234, 7070, 8001, 8002, 11435]);
  });

  it("reserves the loopback providers of inference-providers.json (Conway mode's planner and workers)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-providers-"));
    closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "inference-providers.json");
    const models = [{ id: "m", tier: "cheap", contextWindow: 8000, maxOutputTokens: 1000 }];
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { id: "local", baseUrl: "http://127.0.0.1:11436/v1", models, enabled: false },
          { id: "openai", models },
        ],
      }),
    );
    expect(inferenceProviderLoopbackPorts(file)).toEqual([11436]);
    expect(inferenceProviderLoopbackPorts(path.join(dir, "missing.json")).every((p) => Number.isInteger(p))).toBe(true);
  });

  it("treats every spelling of a loopback or any-address host as local", () => {
    const of = (baseUrl: string) => loopbackServicePorts({ providers: { compatible: [{ id: "a", baseUrl }] } }, {});
    for (const [url, port] of [
      ["http://[::ffff:127.0.0.1]:8005/v1", 8005],
      ["http://[::ffff:7f00:1]:8005/v1", 8005],
      ["http://[::]:8006/v1", 8006],
      ["http://localhost.:8007/v1", 8007],
      ["http://api.localhost:8008/v1", 8008],
      ["http://0.0.0.0:8009/v1", 8009],
      ["http://127.1:8010/v1", 8010],
    ] as const) {
      expect(of(url), url).toEqual([port]);
    }
    for (const url of ["https://api.groq.com/openai/v1", "http://[::ffff:8.8.8.8]:8011/v1", "https://notlocalhost:8012/v1", "http://[2001:db8::1]:8013"]) {
      expect(of(url), url).toEqual([]);
    }
  });

  it("the listening probe says when nothing listens yet", async () => {
    const ex = new ProxyExposer(cfg(), {});
    closers.push(() => ex.close(1_000));
    await ex.start();
    const port = await freePort();
    const e = await ex.expose(port);
    expect(e.listening).toBe(false);
    const be = await backend();
    expect((await ex.expose(be.port)).listening).toBe(true);
    expect(await probeListening(be.port)).toBe(true);
  });

  it("a busy gateway port makes the mode unavailable with the reason", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => blocker.close(() => r(undefined))));
    const port = (blocker.address() as net.AddressInfo).port;
    const ex = await exposer({ gateway: { host: "127.0.0.1", port } });
    expect(ex.available()).toEqual({ ok: false, reason: `the gateway port 127.0.0.1:${port} is already in use` });
    await expect(ex.expose(3000)).rejects.toThrow(/^UNAVAILABLE: the gateway port/);
  });
});

describe("gateway routing security", () => {
  it("routes by Host (case and port normalised) to the loopback backend with forwarded headers", async () => {
    const ex = await exposer();
    const be = await backend();
    await ex.expose(be.port, { name: "api" });
    const res = await request(gwPort(ex), "API.Agents.Example.COM:443", { path: "/x?y=1" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from /x?y=1");
    expect(be.seen[0].headers["x-forwarded-host"]).toBe("API.Agents.Example.COM:443");
    expect(be.seen[0].headers["x-forwarded-proto"]).toBe("https");
    expect(be.seen[0].headers["x-forwarded-for"]).toBe("127.0.0.1");
    // Hop-by-hop response headers are not passed back.
    expect(res.headers["keep-alive"]).toBeUndefined();
  });

  it("unknown names, several labels and foreign suffixes get 404 and the backend sees nothing", async () => {
    const ex = await exposer();
    const be = await backend();
    await ex.expose(be.port, { name: "api" });
    // The last two have exactly the length of "api." plus the suffix.
    const foreign = ["api.agents.example.org", "api-agents.example.com"];
    for (const host of ["web.agents.example.com", "a.api.agents.example.com", "api.example.org", "agents.example.com", "api.agents.example.com.evil.com", "", ...foreign]) {
      const res = await request(gwPort(ex), host);
      expect(res.status, host).toBe(404);
      expect(res.body).toBe("Not Found\n");
    }
    expect(be.seen).toHaveLength(0);
  });

  it("removal gives 404 at once", async () => {
    const ex = await exposer();
    const be = await backend();
    await ex.expose(be.port, { name: "api" });
    expect((await request(gwPort(ex), "api.agents.example.com")).status).toBe(200);
    expect(await ex.remove(be.port)).toBe(true);
    expect((await request(gwPort(ex), "api.agents.example.com")).status).toBe(404);
    expect(be.seen).toHaveLength(1);
  });

  it("streams a 1 MB POST body and strips hop-by-hop request headers", async () => {
    const ex = await exposer();
    const be = await backend((req, res) => {
      res.writeHead(200);
      res.end(String(be.seen[be.seen.length - 1].body));
    });
    await ex.expose(be.port, { name: "up" });
    const body = Buffer.alloc(1024 * 1024, 7);
    const res = await request(gwPort(ex), "up.agents.example.com", {
      method: "POST",
      body,
      headers: {
        connection: "keep-alive, x-hop",
        "x-hop": "1",
        "keep-alive": "timeout=5",
        "proxy-authorization": "Basic Zm9vOmJhcg==",
        te: "trailers",
        "x-forwarded-for": "10.9.9.9",
        "x-keep": "yes",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(String(1024 * 1024));
    const h = be.seen[0].headers;
    expect(h["x-hop"]).toBeUndefined();
    expect(h["keep-alive"]).toBeUndefined();
    expect(h["proxy-authorization"]).toBeUndefined();
    expect(h.te).toBeUndefined();
    expect(h["x-keep"]).toBe("yes");
    expect(h["x-forwarded-for"]).toBe("10.9.9.9, 127.0.0.1");
  });

  it("a backend that is down gives 502", async () => {
    const ex = await exposer();
    const port = await freePort();
    await ex.expose(port, { name: "down" });
    const res = await request(gwPort(ex), "down.agents.example.com");
    expect(res.status).toBe(502);
  });

  it("pipes a WebSocket upgrade both ways", async () => {
    const ex = await exposer();
    const be = await backend();
    let upgradeHeaders: http.IncomingHttpHeaders | null = null;
    be.server.on("upgrade", (req, socket) => {
      upgradeHeaders = req.headers;
      closers.unshift(async () => socket.destroy());
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (d: Buffer) => socket.write(`echo:${d.toString()}`));
    });
    await ex.expose(be.port, { name: "ws" });
    const client = net.connect(gwPort(ex), "127.0.0.1");
    closers.push(async () => client.destroy());
    let got = "";
    client.on("data", (d) => (got += d.toString()));
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(
      "GET /socket HTTP/1.1\r\nHost: ws.agents.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const start = Date.now();
    while (!got.includes("101 Switching Protocols")) {
      if (Date.now() - start > 3_000) throw new Error(`no 101: ${got}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    client.write("ping");
    while (!got.includes("echo:ping")) {
      if (Date.now() - start > 3_000) throw new Error(`no echo: ${got}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(upgradeHeaders!["x-forwarded-host"]).toBe("ws.agents.example.com");
    expect(upgradeHeaders!.upgrade).toBe("websocket");
  });

  it("an error thrown while forwarding answers 502 and the gateway keeps serving", async () => {
    const ex = await exposer();
    const be = await backend();
    await ex.expose(be.port, { name: "api" });
    const realRequest = http.request;
    const realConnect = net.connect;
    // What http.request and net.connect do with input their own checks refuse.
    const reqSpy = vi.spyOn(http, "request").mockImplementation(((o: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
      if (o.port === be.port) throw new TypeError('Invalid character in header content ["x"]');
      return realRequest(o, cb);
    }) as typeof http.request);
    const connSpy = vi.spyOn(net, "connect").mockImplementation(((...a: unknown[]) => {
      if (a[0] === be.port) throw new RangeError("Port should be >= 0 and < 65536");
      return (realConnect as (...x: unknown[]) => net.Socket)(...a);
    }) as typeof net.connect);
    try {
      const res = await request(gwPort(ex), "api.agents.example.com");
      expect(res.status).toBe(502);
      const client = net.connect(gwPort(ex), "127.0.0.1");
      closers.push(async () => client.destroy());
      await new Promise<void>((r) => client.once("connect", () => r()));
      client.write("GET / HTTP/1.1\r\nHost: api.agents.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      await new Promise<void>((r) => client.once("close", () => r()));
    } finally {
      reqSpy.mockRestore();
      connSpy.mockRestore();
    }
    expect(be.seen).toHaveLength(0);
    const ok = await request(gwPort(ex), "api.agents.example.com", { path: "/after" });
    expect([ok.status, ok.body]).toEqual([200, "hello from /after"]);
  });

  it("an upgrade for an unknown name gets 404 without contacting a backend", async () => {
    const ex = await exposer();
    const client = net.connect(gwPort(ex), "127.0.0.1");
    closers.push(async () => client.destroy());
    let got = "";
    client.on("data", (d) => (got += d.toString()));
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write("GET / HTTP/1.1\r\nHost: nope.agents.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    await new Promise<void>((r) => client.once("close", () => r()));
    expect(got).toMatch(/^HTTP\/1\.1 404 Not Found/);
  });
});
