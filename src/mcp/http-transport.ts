/**
 * Streamable HTTP transport over node:https / node:http (no fetch).
 *
 * - https only, unless the operator marked the server local. Non-local
 *   servers: internal host names are refused, the name is resolved once per
 *   request, every address must be public, and the connection goes to the
 *   vetted address (no DNS rebinding window). Same policy as safe-fetch.
 * - No redirects at all: a 3xx is an error and Location is never contacted,
 *   so configured headers never reach another origin.
 * - Compressed responses are refused so byte counting stays honest. One
 *   response is at most 4 MiB; the caller's deadline covers connect,
 *   headers and body.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isInternalHostname, isPublicAddress, type ResolvedAddress } from "../registry/safe-fetch.js";
import { MAX_MESSAGE_BYTES, type JsonRpcMessage, type McpTransport, type SendOptions } from "./jsonrpc.js";

export interface HttpTransportDeps {
  request?: (url: URL, options: https.RequestOptions) => http.ClientRequest;
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  isAllowedAddress?: (ip: string) => boolean;
}

export interface HttpTransportOptions {
  serverName: string;
  url: string;
  headers: Record<string, string>;
  local: boolean;
  deps?: HttpTransportDeps;
  /** Override for tests: largest response body. */
  maxResponseBytes?: number;
}

/** The server forgot our session (HTTP 404 with a session id). */
export class McpSessionExpiredError extends Error {
  constructor() {
    super("MCP session expired");
    this.name = "McpSessionExpiredError";
  }
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

export class HttpTransport implements McpTransport {
  readonly kind = "http" as const;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private onMessage: ((msg: JsonRpcMessage) => void) | null = null;
  private onCloseCb: ((why: string) => void) | null = null;
  private closed = false;
  private readonly live = new Set<http.ClientRequest>();

  constructor(private readonly opts: HttpTransportOptions) {}

  async start(onMessage: (msg: JsonRpcMessage) => void, onClose: (why: string) => void): Promise<void> {
    this.onMessage = onMessage;
    this.onCloseCb = onClose;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  /** Forget the session so the next initialize starts a new one. */
  resetSession(): void {
    this.sessionId = null;
    this.protocolVersion = null;
  }

  private async resolveTarget(url: URL): Promise<ResolvedAddress> {
    if (url.protocol !== "https:" && !(this.opts.local && url.protocol === "http:")) {
      throw new Error(`scheme ${url.protocol} is allowed only for a local server`);
    }
    if (url.username || url.password) throw new Error("credentials in URL");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!this.opts.local && isInternalHostname(host)) throw new Error(`internal host ${host} refused`);
    const lookup = this.opts.deps?.lookup ?? defaultLookup;
    const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host);
    if (addresses.length === 0) throw new Error(`no address for ${host}`);
    if (!this.opts.local) {
      const allowed = this.opts.deps?.isAllowedAddress ?? isPublicAddress;
      const bad = addresses.find((a) => !allowed(a.address));
      if (bad) throw new Error(`${host} resolves to non-public address ${bad.address}`);
    }
    return addresses[0];
  }

  private buildHeaders(body: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.opts.headers,
      accept: "application/json, text/event-stream",
      "accept-encoding": "identity",
    };
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    // The version header exists from 2025-06-18 on.
    if (this.protocolVersion && this.protocolVersion >= "2025-06-18") {
      headers["mcp-protocol-version"] = this.protocolVersion;
    }
    return headers;
  }

  private async open(
    method: "POST" | "DELETE",
    body: string | null,
    signal: AbortSignal | undefined,
  ): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
    const url = new URL(this.opts.url);
    const pinned = await this.resolveTarget(url);
    if (signal?.aborted) throw new Error("request aborted");
    const request =
      this.opts.deps?.request ??
      ((u: URL, o: https.RequestOptions) => (u.protocol === "http:" ? http.request(u, o) : https.request(u, o)));
    return await new Promise((resolve, reject) => {
      const req = request(url, {
        method,
        headers: this.buildHeaders(body),
        agent: false,
        signal,
        // Connect to the address that was checked, never a fresh answer.
        lookup: ((_h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (o?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        }) as unknown as https.RequestOptions["lookup"],
      });
      this.live.add(req);
      req.once("close", () => this.live.delete(req));
      req.once("response", (res) => resolve({ req, res }));
      req.once("error", reject);
      req.end(body ?? undefined);
    });
  }

  async send(msg: JsonRpcMessage, opts: SendOptions): Promise<void> {
    if (this.closed) throw new Error("MCP transport closed");
    const body = JSON.stringify(msg);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.max(1, opts.timeoutMs));
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
    let req: http.ClientRequest | null = null;
    let res: http.IncomingMessage | null = null;
    try {
      ({ req, res } = await this.open("POST", body, signal));
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        throw new Error(`MCP server answered with a redirect (HTTP ${status}); redirects are not followed`);
      }
      if (status === 404 && this.sessionId && !opts.initialize) throw new McpSessionExpiredError();
      if (status === 202 || status === 204) {
        res.resume();
        return;
      }
      if (status < 200 || status >= 300) throw new Error(`MCP server answered HTTP ${status}`);
      const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase().trim();
      if (encoding !== "identity" && encoding !== "") {
        throw new Error(`MCP server sent a ${encoding}-encoded response; only identity is accepted`);
      }
      if (opts.initialize) {
        const sid = res.headers["mcp-session-id"];
        if (typeof sid === "string" && /^[\x21-\x7e]{1,256}$/.test(sid)) this.sessionId = sid;
      }
      const max = this.opts.maxResponseBytes ?? MAX_MESSAGE_BYTES;
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > max) throw new Error(`MCP response of ${declared} bytes is over ${max}`);
      const type = String(res.headers["content-type"] ?? "").toLowerCase();
      if (type.startsWith("text/event-stream")) {
        await this.readSse(res, max, opts.expectId);
      } else {
        const text = await this.readBody(res, max);
        if (text.trim()) this.deliver(text);
      }
    } catch (err) {
      if (deadline.signal.aborted && !(opts.signal?.aborted ?? false)) {
        throw new Error(`MCP HTTP request timed out after ${opts.timeoutMs} ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      res?.destroy();
      req?.destroy();
    }
  }

  private deliver(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("MCP server sent invalid JSON");
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const m of messages) {
      if (this.closed) return;
      if (m && typeof m === "object") this.onMessage?.(m as JsonRpcMessage);
    }
  }

  private readBody(res: http.IncomingMessage, max: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
        res.destroy();
      };
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > max) {
          fail(new Error(`MCP response is over ${max} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.once("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      res.once("error", (err) => fail(err));
      res.once("aborted", () => fail(new Error("MCP response aborted")));
      res.once("close", () => {
        if (!res.complete) fail(new Error("MCP response ended early"));
      });
    });
  }

  /** Parse SSE until the response with expectId arrives, then stop reading. */
  private readSse(res: http.IncomingMessage, max: number, expectId: SendOptions["expectId"]): Promise<void> {
    return new Promise((resolve, reject) => {
      let total = 0;
      let buf = "";
      let data: string[] = [];
      let done = false;
      const finish = (err?: Error): void => {
        if (done) return;
        done = true;
        res.destroy();
        if (err) reject(err);
        else resolve();
      };
      const dispatch = (): void => {
        if (data.length === 0) return;
        const text = data.join("\n");
        data = [];
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const m of messages) {
          if (this.closed) {
            finish(new Error("MCP transport closed"));
            return;
          }
          if (!m || typeof m !== "object") continue;
          this.onMessage?.(m as JsonRpcMessage);
          const msg = m as JsonRpcMessage;
          if (expectId !== undefined && msg.id === expectId && msg.method === undefined) {
            finish();
            return;
          }
        }
      };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (done) return;
        total += Buffer.byteLength(chunk);
        if (total > max) {
          finish(new Error(`MCP response is over ${max} bytes`));
          return;
        }
        buf += chunk;
        let nl: number;
        while (!done && (nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") dispatch();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          // event:, id:, retry: and comments are not needed here.
        }
      });
      res.once("end", () => {
        dispatch();
        finish();
      });
      res.once("error", (err) => finish(err));
      res.once("close", () => finish(done ? undefined : new Error("MCP response ended early")));
    });
  }

  abort(why: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const req of this.live) req.destroy();
    this.onCloseCb?.(`protocol error: ${why}`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const req of this.live) req.destroy();
    if (this.sessionId) {
      // Best effort: tell the server the session is over.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        const { req, res } = await this.open("DELETE", null, controller.signal);
        res.resume();
        res.destroy();
        req.destroy();
      } catch {
        // ignored
      } finally {
        clearTimeout(timer);
      }
    }
    this.sessionId = null;
    this.onCloseCb?.("closed");
  }
}
