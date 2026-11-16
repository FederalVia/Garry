/**
 * The gateway: a small Host-routing reverse proxy for proxy mode.
 *
 * The owner's reverse proxy (Caddy, nginx, a named Cloudflare Tunnel)
 * forwards one wildcard name to it once. The gateway serves only the names
 * the agent exposed, each to 127.0.0.1:<port> and nowhere else; any other
 * Host gets a fixed 404 without a backend being contacted, so it reveals
 * nothing about what runs locally.
 */

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("edge.gateway");

const NOT_FOUND_BODY = "Not Found\n";
const BAD_GATEWAY_BODY = "Bad Gateway\n";
const MAX_CONNECTIONS = 256;
const HEADERS_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 120_000;

// Headers that describe one hop and must not be forwarded.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
]);

function isHopByHop(name: string, connectionTokens: Set<string>): boolean {
  const n = name.toLowerCase();
  return HOP_BY_HOP.has(n) || n.startsWith("proxy-") || connectionTokens.has(n);
}

function connectionTokens(value: string | string[] | undefined): Set<string> {
  const raw = Array.isArray(value) ? value.join(",") : value ?? "";
  return new Set(
    raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface GatewayOptions {
  host: string;
  port: number;
  /** The hostname suffix after the agent's label, e.g. agents.example.com. */
  suffix: string;
}

export class Gateway {
  private server: http.Server | null = null;
  private readonly routes = new Map<string, number>();
  private readonly sockets = new Set<Duplex>();
  /** Sockets serving each backend port, destroyed when its route goes. */
  private readonly byPort = new Map<number, Set<Duplex>>();
  private listening: { host: string; port: number } | null = null;
  private failure: string | null = null;
  readonly suffix: string;

  constructor(private readonly opts: GatewayOptions) {
    this.suffix = opts.suffix.toLowerCase();
  }

  /** The bound address once listening. */
  address(): { host: string; port: number } | null {
    return this.listening;
  }

  /** Why the gateway could not listen, or null. */
  failureReason(): string | null {
    return this.failure;
  }

  setRoute(label: string, port: number): void {
    this.routes.set(label.toLowerCase(), port);
  }

  removeRoute(label: string): void {
    const port = this.routes.get(label.toLowerCase());
    this.routes.delete(label.toLowerCase());
    if (port === undefined) return;
    if ([...this.routes.values()].includes(port)) return;
    for (const s of this.byPort.get(port) ?? []) s.destroy();
    this.byPort.delete(port);
  }

  routeCount(): number {
    return this.routes.size;
  }

  /** The backend port for a Host header, or null (unknown, foreign, several labels). */
  resolveHost(hostHeader: string | undefined): number | null {
    if (!hostHeader) return null;
    let host = hostHeader.trim().toLowerCase();
    // Drop an explicit port; names here are never IPv6 literals.
    const colon = host.lastIndexOf(":");
    if (colon >= 0 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
    host = host.replace(/\.$/, "");
    const tail = `.${this.suffix}`;
    if (!host.endsWith(tail)) return null;
    const label = host.slice(0, -tail.length);
    if (!label || label.includes(".")) return null;
    return this.routes.get(label) ?? null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => this.onRequest(req, res));
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.timeout = IDLE_TIMEOUT_MS;
    // Streams may be long; only idle sockets are closed.
    server.requestTimeout = 0;
    server.on("connection", (s) => this.track(s));
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    server.on("clientError", (_err, socket) => {
      try {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      } catch {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.opts.port, this.opts.host);
    }).catch((err: NodeJS.ErrnoException) => {
      this.failure =
        err?.code === "EADDRINUSE"
          ? `the gateway port ${this.opts.host}:${this.opts.port} is already in use`
          : `the gateway could not listen on ${this.opts.host}:${this.opts.port} (${err?.code ?? err?.message ?? String(err)})`;
      throw new Error(this.failure);
    });
    server.on("error", (err) => logger.warn(`Gateway error: ${err.message}`));
    this.server = server;
    const addr = server.address();
    this.listening =
      addr && typeof addr === "object" ? { host: this.opts.host, port: addr.port } : { host: this.opts.host, port: this.opts.port };
    this.failure = null;
  }

  async close(ms: number): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const s of this.sockets) s.destroy();
    server.closeAllConnections?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.once("close", () => this.sockets.delete(s));
  }

  private trackForPort(port: number, s: Duplex): void {
    let set = this.byPort.get(port);
    if (!set) {
      set = new Set();
      this.byPort.set(port, set);
    }
    const ref = set;
    ref.add(s);
    s.once("close", () => ref.delete(s));
  }

  private forwardedHeaders(req: http.IncomingMessage): Record<string, string> {
    const prior = req.headers["x-forwarded-for"];
    const remote = req.socket.remoteAddress ?? "";
    const chain = [Array.isArray(prior) ? prior.join(", ") : prior, remote].filter((v) => v && v.length > 0).join(", ");
    return {
      "x-forwarded-host": req.headers.host ?? "",
      "x-forwarded-proto": "https",
      "x-forwarded-for": chain,
    };
  }

  // http.request and net.connect throw on input their own checks refuse.
  // Nothing sent to the gateway may end the runtime: answer 502 instead.
  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.forward(req, res);
    } catch (err) {
      logger.warn(`Gateway request failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        if (res.headersSent) throw err;
        res.writeHead(502, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(BAD_GATEWAY_BODY),
          connection: "close",
        });
        res.end(BAD_GATEWAY_BODY);
      } catch {
        req.socket.destroy();
      }
    }
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      this.forwardUpgrade(req, socket, head);
    } catch (err) {
      logger.warn(`Gateway upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.destroy();
    }
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const port = this.resolveHost(req.headers.host);
    if (port === null) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(NOT_FOUND_BODY) });
      res.end(NOT_FOUND_BODY);
      return;
    }
    this.trackForPort(port, req.socket);
    const tokens = connectionTokens(req.headers.connection);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || isHopByHop(name, tokens)) continue;
      if (name === "x-forwarded-for" || name === "x-forwarded-host" || name === "x-forwarded-proto") continue;
      headers[name] = value;
    }
    Object.assign(headers, this.forwardedHeaders(req));
    const upstream = http.request({
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers,
      // No pooling: each client request gets its own backend socket, closed with it.
      agent: false,
    });
    upstream.on("socket", (s) => this.trackForPort(port, s));
    upstream.on("response", (up) => {
      const upTokens = connectionTokens(up.headers.connection);
      const out: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (value === undefined || isHopByHop(name, upTokens)) continue;
        out[name] = value;
      }
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
      up.on("error", () => res.destroy());
    });
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(BAD_GATEWAY_BODY) });
        res.end(BAD_GATEWAY_BODY);
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  private forwardUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    this.track(socket);
    const port = this.resolveHost(req.headers.host);
    if (port === null) {
      socket.end(
        `HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(NOT_FOUND_BODY)}\r\nConnection: close\r\n\r\n${NOT_FOUND_BODY}`,
      );
      return;
    }
    this.trackForPort(port, socket);
    const upstream = net.connect(port, "127.0.0.1");
    this.trackForPort(port, upstream);
    const fwd = this.forwardedHeaders(req);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const n = name.toLowerCase();
      // An upgrade keeps Connection and Upgrade; proxy-* and forwarded headers are replaced.
      if (n.startsWith("proxy-") || n === "keep-alive" || n === "te" || n === "trailer" || n === "transfer-encoding") continue;
      if (n === "x-forwarded-for" || n === "x-forwarded-host" || n === "x-forwarded-proto") continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    for (const [k, v] of Object.entries(fwd)) lines.push(`${k}: ${v}`);
    const onError = (): void => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.once("error", () => {
      if (socket.writable) {
        socket.end(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(BAD_GATEWAY_BODY)}\r\nConnection: close\r\n\r\n${BAD_GATEWAY_BODY}`,
        );
      }
      upstream.destroy();
    });
    socket.once("error", onError);
    upstream.once("connect", () => {
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
    (socket as net.Socket).setTimeout(IDLE_TIMEOUT_MS, () => onError());
  }
}
