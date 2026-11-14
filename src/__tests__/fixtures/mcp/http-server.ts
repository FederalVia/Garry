/**
 * Loopback streamable-HTTP MCP server for tests (127.0.0.1, random port).
 */

import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface FixtureHttpServer {
  url: string;
  requests: RecordedRequest[];
  /** Change behaviour between tests. */
  mode: { redirectTo?: string; gzip?: boolean; destroyMidBody?: boolean; expireSessionOnce?: boolean };
  close(): Promise<void>;
}

const tools = [
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "sse_echo", description: "Echo over SSE", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "slow", description: "Sleep", inputSchema: { type: "object", properties: { ms: { type: "integer" } } } },
  { name: "huge", description: "Big body", inputSchema: { type: "object", properties: {} } },
  { name: "flood_requests", description: "Many server requests", inputSchema: { type: "object", properties: {} } },
];

export async function startFixtureHttpServer(): Promise<FixtureHttpServer> {
  const requests: RecordedRequest[] = [];
  const mode: FixtureHttpServer["mode"] = {};
  let session = 1;
  const sockets = new Set<import("node:net").Socket>();

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    if (mode.gzip) {
      const gz = zlib.gzipSync(text);
      res.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip", ...headers });
      res.end(gz);
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? "", headers: req.headers, body });
      if (mode.redirectTo) {
        res.writeHead(307, { location: mode.redirectTo });
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      const sid = `sess-${session}`;
      if (body?.method === "initialize") {
        json(res, 200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } } }, { "mcp-session-id": sid });
        return;
      }
      if (req.headers["mcp-session-id"] !== sid) {
        res.writeHead(400);
        res.end("missing session");
        return;
      }
      if (body?.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body.method === undefined) {
        // The client's answer to a server request: never acknowledged, so
        // those POSTs stay open.
        return;
      }
      if (mode.expireSessionOnce && body.method === "tools/list") {
        mode.expireSessionOnce = false;
        session++;
        res.writeHead(404);
        res.end();
        return;
      }
      if (body.method === "tools/list") {
        json(res, 200, { jsonrpc: "2.0", id: body.id, result: { tools } });
        return;
      }
      if (body.method === "ping") {
        json(res, 200, { jsonrpc: "2.0", id: body.id, result: {} });
        return;
      }
      if (body.method === "tools/call") {
        const name = body.params?.name;
        const args = body.params?.arguments ?? {};
        if (mode.destroyMidBody) {
          res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
          res.write('{"jsonrpc":"2.0",');
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        if (name === "echo") {
          json(res, 200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: String(args.text) }] } });
          return;
        }
        if (name === "sse_echo") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`);
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `sse:${args.text}` }] } })}\n\n`);
          // The stream stays open: the client must stop reading once its answer arrived.
          return;
        }
        if (name === "slow") {
          setTimeout(() => {
            if (!res.writableEnded && !res.destroyed) {
              json(res, 200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "slept" }] } });
            }
          }, Number(args.ms ?? 1000));
          return;
        }
        if (name === "flood_requests") {
          const batch = Array.from({ length: 1_000 }, (_, i) => ({ jsonrpc: "2.0", id: 1_000_000 + i, method: "sampling/createMessage" }));
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify(batch)}\n\n`);
          return;
        }
        if (name === "huge") {
          json(res, 200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "h".repeat(5 * 1024 * 1024) }] } });
          return;
        }
      }
      json(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    mode,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
