/**
 * MCP client session over a transport: JSON-RPC ids, the pending-request
 * map, initialize, tools/list paging, tools/call with cancellation, ping.
 *
 * The session refuses everything the server asks of the client (sampling,
 * elicitation, roots): those would spend inference or expose files on a
 * third party's behalf. Responses with unknown ids are dropped.
 */

import { createLogger } from "../observability/logger.js";
import { escapeForTerminal } from "../observability/terminal-safe.js";
import { redactSecrets } from "../security/secret-redaction.js";

const logger = createLogger("mcp");

/** Largest single JSON-RPC message either transport accepts. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
const HTTP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const STDIO_PROTOCOL_VERSIONS = [...HTTP_PROTOCOL_VERSIONS, "2024-11-05"];

const MAX_LIST_PAGES = 10;
const MAX_LISTED_TOOLS = 500;
const MAX_IN_FLIGHT = 4;
/**
 * Refusals to server requests not yet written. A server that floods
 * requests while not reading its input would otherwise grow write buffers
 * and timers without bound; past this it is a protocol error.
 */
export const MAX_PENDING_SERVER_REPLIES = 64;

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface SendOptions {
  /** Aborts an HTTP request still in progress (ignored by stdio). */
  signal?: AbortSignal;
  /** Overall time the transport may spend on this send. */
  timeoutMs: number;
  /** Id of the response this message waits for (HTTP closes the stream once it arrives). */
  expectId?: JsonRpcId;
  /** True for the initialize request (HTTP reads the session id from its response). */
  initialize?: boolean;
}

export interface McpTransport {
  readonly kind: "stdio" | "http";
  /** Start receiving. onClose fires once, with why the transport ended. */
  start(onMessage: (msg: JsonRpcMessage) => void, onClose: (why: string) => void): Promise<void>;
  /** Write one message. Resolves when written (stdio) or when the POST completed (HTTP). */
  send(msg: JsonRpcMessage, opts: SendOptions): Promise<void>;
  /** The negotiated protocol version (HTTP sends it as a header). */
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
  /** End now for a protocol error: kill or disconnect, then onClose(why). */
  abort(why: string): void;
}

/** A JSON-RPC error answer from the server. */
export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

/** The call ran out of time (the server may still be working on it). */
export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

export interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface McpSessionOptions {
  serverName: string;
  clientVersion: string;
  onListChanged?: () => void;
}

/** Text from a server, safe for a log line. */
export function logSafe(text: string, max = 500): string {
  return escapeForTerminal(redactSecrets(String(text).slice(0, max)), { keepNewlines: false });
}

export class McpSession {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private closedWhy: string | null = null;
  private inFlight = 0;
  private pendingReplies = 0;
  private readonly waiters: (() => void)[] = [];
  protocolVersion: string | null = null;

  constructor(
    private readonly transport: McpTransport,
    private readonly opts: McpSessionOptions,
  ) {}

  get closed(): boolean {
    return this.closedWhy !== null;
  }

  get closeReason(): string | null {
    return this.closedWhy;
  }

  async start(onClose: (why: string) => void): Promise<void> {
    await this.transport.start(
      (msg) => this.onMessage(msg),
      (why) => {
        this.failAll(`MCP server "${this.opts.serverName}" ${why}`);
        onClose(why);
      },
    );
  }

  /** Reject every pending request; later requests fail at once. */
  failAll(why: string): void {
    if (this.closedWhy === null) this.closedWhy = why;
    const err = new Error(why);
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
    for (const w of [...this.waiters]) w();
  }

  /**
   * Reject pending tools/call requests (runtime shutdown) and tell the
   * server they are cancelled. The session stays open.
   */
  cancelCalls(reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.method !== "tools/call") continue;
      this.pending.delete(id);
      p.reject(new Error(reason));
      this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.failAll("MCP session closed");
    await this.transport.close();
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string") {
      if (hasId) {
        if (this.closedWhy !== null) return;
        if (this.pendingReplies >= MAX_PENDING_SERVER_REPLIES) {
          this.transport.abort(`over ${MAX_PENDING_SERVER_REPLIES} unanswered server requests`);
          return;
        }
        // A request from the server: refused, whatever it is.
        this.pendingReplies++;
        this.transport
          .send(
            { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by this client" } },
            { timeoutMs: 10_000 },
          )
          .catch(() => undefined)
          .finally(() => {
            this.pendingReplies--;
          });
        return;
      }
      if (msg.method === "notifications/tools/list_changed") {
        this.opts.onListChanged?.();
      } else if (msg.method === "notifications/message") {
        const params = msg.params as { level?: unknown; data?: unknown } | undefined;
        const data = typeof params?.data === "string" ? params.data : JSON.stringify(params?.data ?? "");
        logger.debug(`MCP server "${this.opts.serverName}" says: ${logSafe(data ?? "")}`);
      }
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(msg.id as JsonRpcId);
    if (!p) return;
    this.pending.delete(msg.id as JsonRpcId);
    if (msg.error && typeof msg.error === "object") {
      const code = typeof msg.error.code === "number" ? msg.error.code : -32603;
      const message = typeof msg.error.message === "string" ? msg.error.message : "unknown error";
      p.reject(new McpRpcError(code, message));
    } else {
      p.resolve(msg.result);
    }
  }

  private async acquire(deadline: number): Promise<void> {
    while (this.inFlight >= MAX_IN_FLIGHT) {
      if (this.closedWhy !== null) throw new Error(this.closedWhy);
      const left = deadline - Date.now();
      if (left <= 0) throw new McpTimeoutError("queue wait exceeded the call timeout");
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          const i = this.waiters.indexOf(done);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.waiters.push(done);
      });
    }
    this.inFlight++;
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.waiters[0]?.();
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closedWhy !== null) return;
    const msg: JsonRpcMessage = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    await this.transport.send(msg, { timeoutMs: 10_000 });
  }

  /**
   * One request. The timeout covers the queue wait, the send and the answer.
   * onSent runs once the request was handed to the transport (it may run).
   */
  async request<T = unknown>(
    method: string,
    params: unknown,
    opts: { timeoutMs: number; cancelOnTimeout?: boolean; onSent?: () => void; initialize?: boolean },
  ): Promise<T> {
    if (this.closedWhy !== null) throw new Error(this.closedWhy);
    const deadline = Date.now() + opts.timeoutMs;
    await this.acquire(deadline);
    const id = this.nextId++;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        const left = Math.max(1, deadline - Date.now());
        this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
        timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          abort.abort();
          if (opts.cancelOnTimeout) {
            this.notify("notifications/cancelled", { requestId: id, reason: "timeout" }).catch(() => undefined);
          }
          reject(new McpTimeoutError(`MCP call timed out after ${opts.timeoutMs} ms`));
        }, left);
        const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method };
        if (params !== undefined) msg.params = params;
        this.transport
          .send(msg, { signal: abort.signal, timeoutMs: left, expectId: id, initialize: opts.initialize })
          .then(
            () => {
              // HTTP: the POST completed without our answer in it.
              if (this.transport.kind === "http" && this.pending.has(id)) {
                this.pending.delete(id);
                reject(new Error("MCP server ended the response without an answer"));
              }
            },
            (err: unknown) => {
              if (!this.pending.has(id)) return;
              this.pending.delete(id);
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
        // stdio writes are synchronous enough to count as sent here; HTTP
        // has started the POST. Either way the server may act on it.
        opts.onSent?.();
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.release();
    }
  }

  async initialize(timeoutMs: number): Promise<void> {
    const result = await this.request<{ protocolVersion?: unknown; capabilities?: unknown }>(
      "initialize",
      {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "automaton", version: this.opts.clientVersion },
      },
      { timeoutMs, initialize: true },
    );
    const version = typeof result?.protocolVersion === "string" ? result.protocolVersion : "";
    const supported = this.transport.kind === "http" ? HTTP_PROTOCOL_VERSIONS : STDIO_PROTOCOL_VERSIONS;
    if (!supported.includes(version)) {
      throw new Error(`MCP server "${this.opts.serverName}" chose unsupported protocol version "${logSafe(version, 40)}"`);
    }
    this.protocolVersion = version;
    this.transport.setProtocolVersion(version);
    await this.notify("notifications/initialized");
  }

  async listTools(timeoutMs: number): Promise<RawMcpTool[]> {
    const deadline = Date.now() + timeoutMs;
    const out: RawMcpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new McpTimeoutError(`tools/list timed out after ${timeoutMs} ms`);
      const result = await this.request<{ tools?: unknown; nextCursor?: unknown }>(
        "tools/list",
        cursor ? { cursor } : {},
        { timeoutMs: left },
      );
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      for (const t of tools) {
        if (out.length >= MAX_LISTED_TOOLS) break;
        if (t && typeof t === "object" && typeof (t as RawMcpTool).name === "string") out.push(t as RawMcpTool);
      }
      if (out.length >= MAX_LISTED_TOOLS) break;
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs: number; onSent?: () => void },
  ): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, { ...opts, cancelOnTimeout: true });
  }

  async ping(timeoutMs: number): Promise<boolean> {
    try {
      await this.request("ping", undefined, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
}
