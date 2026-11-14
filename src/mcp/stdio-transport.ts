/**
 * stdio transport: newline-delimited JSON over a child's stdin/stdout.
 *
 * - The server runs in its own process group with the scrubbed child env
 *   plus only its own configured variables; stderr is never inherited.
 * - A buffered partial line over 4 MiB is a protocol error: the group is
 *   killed (a line with no newline would otherwise grow without limit).
 * - stderr goes to a 64 KiB ring buffer, logged at debug (escaped, redacted);
 *   its tail is quoted in crash warnings.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createLogger } from "../observability/logger.js";
import { childProcessEnv } from "../security/child-env.js";
import { MAX_MESSAGE_BYTES, logSafe, type JsonRpcMessage, type McpTransport, type SendOptions } from "./jsonrpc.js";
import { killServerProcess, spawnServerProcess, terminateServerProcess } from "./process.js";

const logger = createLogger("mcp");

const STDERR_RING_BYTES = 64 * 1024;
const STDERR_TAIL_BYTES = 2 * 1024;
const STDERR_LOG_LINES_PER_SEC = 20;
/** Unwritten bytes to a server that stopped reading, before it is killed. */
export const MAX_STDIN_BACKLOG_BYTES = 1024 * 1024;

export interface StdioTransportOptions {
  serverName: string;
  command: string;
  args: string[];
  /** The server's own variables, added to the scrubbed child env. */
  env: Record<string, string>;
  cwd: string;
  createCwd: boolean;
  /** Override for tests: largest partial line before the server is killed. */
  maxLineBytes?: number;
}

export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private stderrRing = Buffer.alloc(0);
  private stderrLogWindow = { start: 0, count: 0 };
  private closed = false;
  private onCloseCb: ((why: string) => void) | null = null;

  constructor(private readonly opts: StdioTransportOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The last 2 KiB of stderr, escaped and redacted. */
  stderrTail(): string {
    const tail = this.stderrRing.subarray(Math.max(0, this.stderrRing.length - STDERR_TAIL_BYTES)).toString("utf8");
    return logSafe(tail, STDERR_TAIL_BYTES);
  }

  setProtocolVersion(): void {
    // stdio carries no version header.
  }

  start(onMessage: (msg: JsonRpcMessage) => void, onClose: (why: string) => void): Promise<void> {
    this.onCloseCb = onClose;
    const env = { ...childProcessEnv(), ...this.opts.env };
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnServerProcess({
          command: this.opts.command,
          args: this.opts.args,
          env,
          cwd: this.opts.cwd,
          createCwd: this.opts.createCwd,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;
      const maxLine = this.opts.maxLineBytes ?? MAX_MESSAGE_BYTES;
      child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk, maxLine, onMessage));
      child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
      // EPIPE after the server died is reported through exit.
      child.stdin.on("error", () => undefined);
      child.once("error", (err) => {
        if (!child.pid) reject(err);
        this.end(`failed to start (${err.message})`);
      });
      child.once("spawn", () => resolve());
      child.once("exit", (code, signal) => {
        this.end(signal ? `exited (signal ${signal})` : `exited (code ${code})`);
      });
    });
  }

  private end(why: string): void {
    if (this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.buffered = 0;
    this.onCloseCb?.(why);
  }

  private protocolError(why: string): void {
    if (this.child) killServerProcess(this.child);
    this.end(`protocol error: ${why}`);
  }

  private onStdout(chunk: Buffer, maxLine: number, onMessage: (msg: JsonRpcMessage) => void): void {
    if (this.closed) return;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      if (this.buffered + piece.length > maxLine) {
        this.protocolError(`a message is over ${maxLine} bytes`);
        return;
      }
      const line = this.chunks.length > 0 ? Buffer.concat([...this.chunks, piece]) : piece;
      this.chunks = [];
      this.buffered = 0;
      this.dispatch(line, onMessage);
      if (this.closed) return;
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length === 0) return;
    if (this.buffered + rest.length > maxLine) {
      this.protocolError(`a message is over ${maxLine} bytes`);
      return;
    }
    this.chunks.push(Buffer.from(rest));
    this.buffered += rest.length;
  }

  private dispatch(line: Buffer, onMessage: (msg: JsonRpcMessage) => void): void {
    const text = line.toString("utf8").trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Servers must not print anything else on stdout; a stray line is
      // logged and skipped rather than killing the server.
      logger.debug(`MCP server "${this.opts.serverName}" wrote a non-JSON line: ${logSafe(text, 200)}`);
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const m of messages) {
      if (this.closed) return;
      if (m && typeof m === "object") onMessage(m as JsonRpcMessage);
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrRing = Buffer.concat([this.stderrRing, chunk]);
    if (this.stderrRing.length > STDERR_RING_BYTES) {
      this.stderrRing = Buffer.from(this.stderrRing.subarray(this.stderrRing.length - STDERR_RING_BYTES));
    }
    const now = Date.now();
    if (now - this.stderrLogWindow.start > 1_000) this.stderrLogWindow = { start: now, count: 0 };
    if (this.stderrLogWindow.count++ < STDERR_LOG_LINES_PER_SEC) {
      logger.debug(`MCP server "${this.opts.serverName}" stderr: ${logSafe(chunk.toString("utf8"), 500)}`);
    }
  }

  send(msg: JsonRpcMessage, opts: SendOptions): Promise<void> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new Error("MCP server is not running"));
    const line = JSON.stringify(msg) + "\n";
    if (child.stdin.writableLength + Buffer.byteLength(line) > MAX_STDIN_BACKLOG_BYTES) {
      this.protocolError(`it stopped reading its input (${MAX_STDIN_BACKLOG_BYTES} bytes unwritten)`);
      return Promise.reject(new Error("MCP server stopped reading its input"));
    }
    return new Promise<void>((resolve, reject) => {
      let ok: boolean;
      try {
        ok = child.stdin.write(line);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (ok) {
        resolve();
        return;
      }
      // Respect backpressure: wait for drain, bounded by the send deadline.
      const timer = setTimeout(() => {
        child.stdin.off("drain", onDrain);
        reject(new Error("MCP server stopped reading its input"));
      }, Math.max(1, opts.timeoutMs));
      const onDrain = (): void => {
        clearTimeout(timer);
        resolve();
      };
      child.stdin.once("drain", onDrain);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await terminateServerProcess(child, 2_000);
    this.end("closed");
  }

  abort(why: string): void {
    this.protocolError(why);
  }

  /** Kill at once (missed connect deadline). */
  kill(): void {
    if (this.child) killServerProcess(this.child);
  }
}
