/**
 * MCP server lifecycle: one manager per database (per process in practice).
 *
 * - loadMcpTools re-reads the operator file at the start of every wake
 *   cycle, stops servers that were removed, disabled or changed (a changed
 *   spec hash also resets that server's backoff and circuit), connects
 *   missing ones in parallel within a per-server and an overall deadline,
 *   and returns the tools of the servers that are ready. A connect that
 *   misses its deadline is killed (stdio) or abandoned (HTTP).
 * - A crash, a protocol error or 3 call timeouts with a failed ping mark a
 *   server down; the next use restarts it after a backoff. After 5 restarts
 *   in an hour its circuit opens until the next runtime start.
 * - Shutdown rejects in-flight calls at once (notifications/cancelled is
 *   sent) and closes every server.
 *
 * MCP code never reads an ambient cancellation signal, and loadMcpTools is
 * called only from the agent loop, never from heartbeat tasks: servers are
 * long-lived and must not be tied to a task that first touched them. Connects
 * also run outside any cancellation scope, so a server's process and socket
 * callbacks never carry a heartbeat task's signal.
 */

import fs from "node:fs";
import type Database from "better-sqlite3";
import type { AutomatonIdentity, AutomatonTool, InstalledTool } from "../types.js";
import { isLocalSandboxId } from "../conway/client.js";
import { getForbiddenCommandMatch } from "../agent/policy-rules/command-safety.js";
import { createLogger } from "../observability/logger.js";
import { redactSecrets } from "../security/secret-redaction.js";
import { runOutsideCancellation } from "../runtime/cancellation.js";
import {
  checkAgentPackageIntegrity,
  loadMcpConfig,
  mcpConfigPath,
  npmGlobalPrefix,
  resolveAgentRow,
  type McpServerSpec,
} from "./config.js";
import { McpRpcError, McpSession, McpTimeoutError, logSafe, type RawMcpTool } from "./jsonrpc.js";
import { HttpTransport, McpSessionExpiredError, type HttpTransportDeps } from "./http-transport.js";
import { StdioTransport } from "./stdio-transport.js";
import { buildMcpTools, formatToolError, type McpCaller } from "./tools.js";

const logger = createLogger("mcp");

const CLIENT_VERSION = "0.2.1";
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000];
const RESTARTS_PER_HOUR_BEFORE_CIRCUIT = 5;
const HOUR_MS = 60 * 60 * 1000;
const TIMEOUTS_BEFORE_PING = 3;

export interface McpManagerOptions {
  configPath?: string;
  backoffMs?: number[];
  /** initialize + tools/list per server (default 15 s). */
  connectTimeoutMs?: number;
  /** All connects of one load (default 20 s). */
  overallTimeoutMs?: number;
  httpDeps?: HttpTransportDeps;
  /** Test override of the stdio partial-line cap. */
  maxLineBytes?: number;
}

type Status = "idle" | "connecting" | "ready" | "down" | "open";

interface ServerState {
  spec: McpServerSpec;
  status: Status;
  session: McpSession | null;
  transport: StdioTransport | HttpTransport | null;
  tools: RawMcpTool[] | null;
  stale: boolean;
  generation: number;
  restarts: number[];
  backoffIdx: number;
  nextRetryAt: number;
  consecutiveTimeouts: number;
  connecting: Promise<void> | null;
}

interface InstalledRowsDb {
  getInstalledTools(): InstalledTool[];
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

export class McpManager implements McpCaller {
  private readonly servers = new Map<string, ServerState>();
  private npmPrefix: string | null = null;
  private readonly backoff: number[];
  private readonly connectTimeoutMs: number;
  private readonly overallTimeoutMs: number;
  private shutdownListener: { signal: AbortSignal; fn: () => void } | null = null;
  private closed = false;

  constructor(private readonly opts: McpManagerOptions = {}) {
    this.backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
    this.overallTimeoutMs = opts.overallTimeoutMs ?? 20_000;
  }

  /** Reject in-flight calls as soon as a runtime shutdown starts. */
  attachShutdownSignal(signal: AbortSignal | undefined): void {
    if (!signal || this.shutdownListener?.signal === signal) return;
    if (this.shutdownListener) {
      this.shutdownListener.signal.removeEventListener("abort", this.shutdownListener.fn);
    }
    const fn = (): void => this.cancelCalls("MCP call cancelled: runtime shutdown");
    signal.addEventListener("abort", fn, { once: true });
    this.shutdownListener = { signal, fn };
    if (signal.aborted) fn();
  }

  cancelCalls(reason: string): void {
    for (const s of this.servers.values()) s.session?.cancelCalls(reason);
  }

  /** Process id of a running stdio server (tests and diagnostics). */
  serverPid(name: string): number | undefined {
    const t = this.servers.get(name)?.transport;
    return t instanceof StdioTransport ? t.pid : undefined;
  }

  serverStatus(name: string): Status | undefined {
    return this.servers.get(name)?.status;
  }

  async loadTools(opts: {
    db: InstalledRowsDb;
    identity: Pick<AutomatonIdentity, "sandboxId">;
    otherToolCount: number;
    reservedNames?: Set<string>;
    shouldStop?: () => boolean;
  }): Promise<AutomatonTool[]> {
    if (this.closed) return [];
    const file = this.opts.configPath ?? mcpConfigPath();
    try {
      fs.lstatSync(file);
    } catch {
      // No file: MCP is not configured; nothing runs, nothing is offered.
      await this.stopAll();
      return [];
    }
    this.npmPrefix = await npmGlobalPrefix();
    // Shutdown may have run while we waited: start nothing after it.
    if (this.closed) return [];
    const cfg = loadMcpConfig({ path: file, npmPrefix: this.npmPrefix });
    for (const w of cfg.warnings) warnOnce(`cfg:${w}`, w);
    if (!cfg.present || !cfg.enabled) {
      await this.stopAll();
      return [];
    }

    const desired: McpServerSpec[] = cfg.servers.filter((s) => s.enabled);
    const operatorNames = new Set(cfg.servers.map((s) => s.name));
    let rows: InstalledTool[] = [];
    try {
      rows = opts.db.getInstalledTools().filter((t) => t.type === "mcp" && t.enabled);
    } catch {
      rows = [];
    }
    const agentSpecs: McpServerSpec[] = [];
    for (const row of [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = resolveAgentRow(row, {
        approvals: cfg.agentApprovals,
        operatorNames,
        localExec: isLocalSandboxId(opts.identity.sandboxId),
        npmPrefix: this.npmPrefix,
      });
      if (r.skip) {
        warnOnce(`row:${row.id}:${r.skip}`, `Agent-installed MCP server "${logSafe(row.name, 64)}" does not start: ${r.skip}`);
      } else if (r.spec && !agentSpecs.some((s) => s.name === r.spec!.name)) {
        agentSpecs.push(r.spec);
      }
    }
    desired.push(...agentSpecs);

    // Stop what was removed, disabled or changed. Deleting the state also
    // resets a changed server's backoff and circuit.
    const wanted = new Map(desired.map((s) => [s.name, s]));
    for (const [name, state] of [...this.servers]) {
      const next = wanted.get(name);
      if (!next || next.specHash !== state.spec.specHash) {
        this.servers.delete(name);
        await this.closeState(state);
      }
    }

    const work: Promise<void>[] = [];
    for (const spec of desired) {
      let state = this.servers.get(spec.name);
      if (!state) {
        state = newState(spec);
        this.servers.set(spec.name, state);
      }
      state.spec = spec;
      if (state.status === "idle" || (state.status === "down" && Date.now() >= state.nextRetryAt)) {
        work.push(this.connect(state, this.connectTimeoutMs));
      } else if (state.status === "ready" && (state.stale || !state.tools)) {
        work.push(this.relist(state));
      } else if (state.status === "down") {
        warnOnce(
          `down:${spec.name}:${state.nextRetryAt}`,
          `MCP server "${spec.name}" is not running (next retry in ${Math.ceil((state.nextRetryAt - Date.now()) / 1000)} s).`,
        );
      }
    }
    if (work.length > 0) await this.waitForConnects(work, opts.shouldStop);

    const ready = desired
      .map((s) => this.servers.get(s.name)!)
      .filter((s) => s.status === "ready" && s.tools)
      .map((s) => ({ spec: s.spec, tools: s.tools! }));
    const built = buildMcpTools(ready, {
      maxTools: cfg.maxTools,
      otherToolCount: opts.otherToolCount,
      reservedNames: opts.reservedNames,
      caller: this,
    });
    for (const w of built.withheld) warnOnce(`withheld:${w}`, `MCP tool definition text withheld: ${w}`);
    if (built.dropped.length > 0) {
      logger.info(`MCP tools not offered this cycle: ${built.dropped.slice(0, 20).join("; ")}${built.dropped.length > 20 ? "; ..." : ""}`);
    }
    return built.tools;
  }

  private async waitForConnects(work: Promise<void>[], shouldStop?: () => boolean): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const overall = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.overallTimeoutMs);
      if (shouldStop) {
        poll = setInterval(() => {
          let stop = false;
          try {
            stop = shouldStop();
          } catch {
            stop = false;
          }
          if (stop) resolve();
        }, 200);
      }
    });
    await Promise.race([Promise.allSettled(work).then(() => undefined), overall]);
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    // Anything still connecting is killed or abandoned, never left pending.
    for (const s of this.servers.values()) {
      if (s.status === "connecting") this.markDown(s, "did not finish connecting in time");
    }
  }

  private async connect(state: ServerState, timeoutMs: number): Promise<void> {
    if (state.connecting) return state.connecting;
    const run = runOutsideCancellation(() => this.connectOnce(state, timeoutMs)).finally(() => {
      state.connecting = null;
    });
    state.connecting = run;
    return run;
  }

  private async connectOnce(state: ServerState, timeoutMs: number): Promise<void> {
    const spec = state.spec;
    const gen = ++state.generation;
    state.status = "connecting";
    state.tools = null;
    state.stale = false;
    try {
      if (spec.transport === "stdio" && spec.origin === "agent" && spec.agent) {
        // The approval pinned a package version and its files; check again
        // that they are unchanged and that the tripwire allows the launch.
        const loc = checkAgentPackageIntegrity(spec.agent, this.npmPrefix, { content: true });
        if ("error" in loc) throw new Error(loc.error);
        const match = getForbiddenCommandMatch([spec.agent.bin, ...spec.args.slice(1)].join(" "));
        if (match) throw new Error(`launch line refused: ${match.description}`);
      }
      const transport =
        spec.transport === "stdio"
          ? new StdioTransport({
              serverName: spec.name,
              command: spec.command,
              args: spec.args,
              env: spec.env,
              cwd: spec.cwd,
              createCwd: spec.defaultCwd,
              maxLineBytes: this.opts.maxLineBytes,
            })
          : new HttpTransport({
              serverName: spec.name,
              url: spec.url,
              headers: spec.headers,
              local: spec.local,
              deps: this.opts.httpDeps,
            });
      const session = new McpSession(transport, {
        serverName: spec.name,
        clientVersion: CLIENT_VERSION,
        onListChanged: () => {
          if (state.generation === gen) state.stale = true;
        },
      });
      state.transport = transport;
      state.session = session;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`connect timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      const started = Date.now();
      const steps = (async () => {
        await session.start((why) => this.onTransportClosed(state, gen, why));
        await session.initialize(Math.max(1, timeoutMs - (Date.now() - started)));
        return await session.listTools(Math.max(1, timeoutMs - (Date.now() - started)));
      })();
      steps.catch(() => undefined);
      try {
        const tools = await Promise.race([steps, deadline]);
        if (state.generation !== gen || state.status !== "connecting") return;
        state.tools = tools;
        state.status = "ready";
        state.consecutiveTimeouts = 0;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err) {
      if (state.generation !== gen) return;
      const tail = state.transport instanceof StdioTransport ? state.transport.stderrTail() : "";
      this.markDown(state, `failed to start: ${logSafe(errMessage(err), 300)}${tail ? ` (stderr: ${tail})` : ""}`);
    }
  }

  private async relist(state: ServerState): Promise<void> {
    const session = state.session;
    if (!session) return;
    try {
      state.tools = await session.listTools(this.connectTimeoutMs);
      state.stale = false;
    } catch (err) {
      if (err instanceof McpSessionExpiredError) {
        // One re-initialize, then one retry of tools/list.
        await this.closeState(state, true);
        state.status = "idle";
        await this.connect(state, this.connectTimeoutMs);
        return;
      }
      this.markDown(state, `could not list its tools: ${logSafe(errMessage(err), 300)}`);
    }
  }

  private onTransportClosed(state: ServerState, gen: number, why: string): void {
    if (state.generation !== gen) return;
    if (state.status === "down" || state.status === "open" || state.status === "idle") return;
    const tail = state.transport instanceof StdioTransport ? state.transport.stderrTail() : "";
    this.markDown(state, `${why}${tail ? ` (stderr: ${tail})` : ""}`);
  }

  private markDown(state: ServerState, reason: string): void {
    const now = Date.now();
    state.generation++;
    const transport = state.transport;
    const session = state.session;
    state.transport = null;
    state.session = null;
    state.tools = null;
    session?.failAll(`MCP server "${state.spec.name}" ${reason}`);
    if (transport instanceof StdioTransport) transport.kill();
    else transport?.close().catch(() => undefined);
    state.restarts = state.restarts.filter((t) => now - t < HOUR_MS);
    state.restarts.push(now);
    if (state.restarts.length >= RESTARTS_PER_HOUR_BEFORE_CIRCUIT) {
      state.status = "open";
      logger.warn(
        `MCP server "${state.spec.name}" failed ${state.restarts.length} times in an hour; ` +
          `it stays off until the runtime restarts or its entry changes. Last failure: ${reason}`,
      );
      return;
    }
    state.status = "down";
    const delay = this.backoff[Math.min(state.backoffIdx, this.backoff.length - 1)];
    state.backoffIdx++;
    state.nextRetryAt = now + delay;
    logger.warn(`MCP server "${state.spec.name}" ${reason}; next retry in ${Math.ceil(delay / 1000)} s.`);
  }

  private async ensureReady(state: ServerState, timeoutMs: number): Promise<McpSession> {
    const name = state.spec.name;
    if (state.status === "connecting" && state.connecting) await state.connecting;
    if (state.status === "open") {
      throw new Error(`MCP server "${name}" is off after repeated failures (until the runtime restarts).`);
    }
    if (state.status === "down" || state.status === "idle") {
      const wait = state.nextRetryAt - Date.now();
      if (wait > 0) throw new Error(`MCP server "${name}" is not running (next retry in ${Math.ceil(wait / 1000)} s).`);
      await this.connect(state, Math.min(timeoutMs, this.connectTimeoutMs));
    }
    const status = state.status as Status;
    if (status !== "ready" || !state.session) {
      throw new Error(`MCP server "${name}" is not running (next retry in ${Math.max(0, Math.ceil((state.nextRetryAt - Date.now()) / 1000))} s).`);
    }
    return state.session;
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { onSent: () => void },
  ): Promise<unknown> {
    const state = this.servers.get(server);
    if (!state || this.closed) throw new Error(`MCP server "${server}" is not configured.`);
    const timeoutMs = state.spec.callTimeoutMs;
    const started = Date.now();
    const session = await this.ensureReady(state, timeoutMs);
    const left = Math.max(1, timeoutMs - (Date.now() - started));
    try {
      const result = await session.callTool(tool, args, { timeoutMs: left, onSent: opts.onSent });
      state.consecutiveTimeouts = 0;
      state.backoffIdx = 0;
      return result;
    } catch (err) {
      if (err instanceof McpTimeoutError) {
        state.consecutiveTimeouts++;
        if (state.consecutiveTimeouts >= TIMEOUTS_BEFORE_PING && state.session === session) {
          const alive = await session.ping(5_000);
          if (!alive && state.session === session) {
            this.markDown(state, `did not answer a ping after ${state.consecutiveTimeouts} timed-out calls`);
          } else {
            state.consecutiveTimeouts = 0;
          }
        }
        throw new Error(`MCP call timed out after ${timeoutMs} ms`);
      }
      if (err instanceof McpRpcError) {
        throw new Error(formatToolError(err.message, server, tool));
      }
      if (err instanceof McpSessionExpiredError) {
        // The server did not take the call; reconnect on the next use.
        if (state.session === session) {
          await this.closeState(state, true);
          state.status = "idle";
          state.nextRetryAt = 0;
        }
        throw new Error(`MCP server "${server}" ended the session; the call was not run. Try again.`);
      }
      throw new Error(redactSecrets(errMessage(err)));
    }
  }

  private async closeState(state: ServerState, keepCounters = false): Promise<void> {
    state.generation++;
    const session = state.session;
    state.session = null;
    state.transport = null;
    state.tools = null;
    if (!keepCounters) state.status = "idle";
    if (session) await session.close().catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    const states = [...this.servers.values()];
    this.servers.clear();
    await Promise.allSettled(states.map((s) => this.closeState(s)));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.cancelCalls("MCP call cancelled: runtime shutdown");
    if (this.shutdownListener) {
      this.shutdownListener.signal.removeEventListener("abort", this.shutdownListener.fn);
      this.shutdownListener = null;
    }
    await this.stopAll();
  }
}

function newState(spec: McpServerSpec): ServerState {
  return {
    spec,
    status: "idle",
    session: null,
    transport: null,
    tools: null,
    stale: false,
    generation: 0,
    restarts: [],
    backoffIdx: 0,
    nextRetryAt: 0,
    consecutiveTimeouts: 0,
    connecting: null,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Process-wide access ──────────────────────────────────────

const managers = new Map<Database.Database | object, McpManager>();

export interface LoadMcpToolsOptions {
  db: InstalledRowsDb & { raw?: Database.Database };
  identity: Pick<AutomatonIdentity, "sandboxId">;
  /** Tools already in the request (built-in and installed), after any hiding. */
  otherToolCount: number;
  /** Names already taken by those tools. */
  reservedNames?: Set<string>;
  /** Polled while connecting; a stop returns what is ready at once. */
  shouldStop?: () => boolean;
  /** Runtime shutdown: rejects in-flight calls as soon as it fires. */
  shutdownSignal?: AbortSignal;
  /** Used when the manager for this database is first created. */
  managerOptions?: McpManagerOptions;
}

/** The manager for this database, once created. */
export function getMcpManager(db: { raw?: Database.Database } | object): McpManager | undefined {
  return managers.get(((db as { raw?: Database.Database }).raw ?? db) as object);
}

/**
 * MCP tools for the main agent loop: empty unless the operator file exists
 * and is enabled, and only servers that are approved and connected. Never
 * offered on inbox turns, to local workers or to children.
 */
export async function loadMcpTools(opts: LoadMcpToolsOptions): Promise<AutomatonTool[]> {
  const key = (opts.db.raw ?? opts.db) as object;
  let manager = managers.get(key);
  if (!manager) {
    manager = new McpManager(opts.managerOptions);
    managers.set(key, manager);
  }
  manager.attachShutdownSignal(opts.shutdownSignal);
  return manager.loadTools(opts);
}

/** Close every MCP server, for at most ms. Never rejects. */
export async function shutdownMcpServers(ms: number): Promise<void> {
  const all = [...managers.values()];
  managers.clear();
  if (all.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled(all.map((m) => m.shutdown())).then(() => undefined), deadline]);
  if (timer) clearTimeout(timer);
}
