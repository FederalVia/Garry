/**
 * In-process agent card server: serves the card from memory on a loopback
 * port, which the port exposer then publishes under a reserved name. No
 * file, no child process, no listener on other interfaces.
 */

import http from "node:http";
import type { AgentCard } from "../types.js";

const MAX_CARD_BYTES = 64 * 1024;
const CARD_PATHS = new Set(["/.well-known/agent-card.json", "/agent-card.json"]);

export interface CardServer {
  readonly port: number;
  setCard(card: AgentCard): void;
  close(): Promise<void>;
}

function baseHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function startCardServer(
  opts: { host?: string; port?: number; card?: AgentCard } = {},
): Promise<CardServer> {
  let body = "";
  const setCard = (card: AgentCard): void => {
    const json = JSON.stringify(card, null, 2);
    if (Buffer.byteLength(json) > MAX_CARD_BYTES) {
      throw new Error(`The agent card is larger than ${MAX_CARD_BYTES} bytes`);
    }
    body = json;
  };
  if (opts.card) setCard(opts.card);

  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const headers = baseHeaders();
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if ((req.method === "GET" || req.method === "HEAD") && CARD_PATHS.has(path) && body) {
      res.writeHead(200, {
        ...headers,
        "Content-Type": "application/json",
        "Cache-Control": "max-age=300",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    port,
    setCard,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  };
}
