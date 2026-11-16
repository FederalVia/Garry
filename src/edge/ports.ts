/**
 * Port exposure behind one interface: local (today's localhost address), a
 * reverse proxy the owner runs (through the gateway), or a supervised tunnel.
 *
 * The rules below prevent accidents, not a determined agent: with exec it
 * can run its own forwarder. Real isolation is the container.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AutomatonConfig } from "../types.js";
import { childProcessEnv } from "../security/child-env.js";
import { signalGroup } from "../runtime/process-group.js";
import { currentCancellationSignal, mergeSignals } from "../runtime/cancellation.js";
import { createLogger } from "../observability/logger.js";
import { loadMcpConfig, type HttpServerSpec, type LoadedMcpConfig } from "../mcp/config.js";
import { resolveProviderTable } from "../providers/table.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { Gateway } from "./gateway.js";
import { DEFAULT_BACKOFF_MS, TunnelSupervisor, type ExposureState, type TunnelSpec } from "./tunnel.js";
import {
  DEFAULT_DENIED_PORTS,
  EXPOSURE_NAME_RE,
  NGROK_AGENT_API_PORTS,
  usesNgrokAgent,
  type PortsMode,
  type ResolvedPortsConfig,
  type ResolvedTunnelConfig,
} from "./config.js";

export type { ExposureState, PortsMode };

const logger = createLogger("edge.ports");

export const EXPOSURES_KV = "edge.exposures";
export const TUNNEL_PIDS_KV = "edge.tunnel_pids";
const PROBE_TIMEOUT_MS = 500;
const TUNNEL_STOP_GRACE_MS = 3_000;

export interface Exposure {
  port: number;
  /** proxy mode label */
  name?: string;
  /** null while restarting or failed */
  url: string | null;
  state: ExposureState;
  scope: "local" | "public";
  managedBy: "agent" | "runtime";
  sinceMs: number;
  /** Short, runtime-written reason for restarting or failed. Never tunnel output. */
  detail?: string;
  /** False when nothing listened on 127.0.0.1:<port> right after exposing. */
  listening?: boolean;
  /** Tunnel: URL known, ready line not seen within the start timeout. */
  readyPending?: boolean;
}

export type ExposeOptions = { name?: string; managedBy?: "agent" | "runtime"; signal?: AbortSignal };

export interface PortExposer {
  readonly mode: PortsMode;
  /** False when the mode cannot work here (gateway port in use, tunnel binary missing). */
  available(): { ok: true } | { ok: false; reason: string };
  expose(port: number, opts?: ExposeOptions): Promise<Exposure>;
  remove(port: number, opts?: { managedBy?: "agent" | "runtime" }): Promise<boolean>;
  list(): Exposure[];
  /** Agent exposures recorded by an earlier run and not public now. */
  previous(): { port: number; name?: string }[];
  onChange(cb: (e: Exposure, previousUrl: string | null) => void): () => void;
  start(): Promise<void>;
  close(ms: number): Promise<void>;
}

export type PortRefusalCode =
  | "PORT_NOT_ALLOWED"
  | "PORT_RESERVED"
  | "PORT_LIMIT"
  | "NAME_INVALID"
  | "NAME_TAKEN"
  | "MANAGED_BY_RUNTIME"
  | "NOT_EXPOSED"
  | "UNAVAILABLE";

export class PortRefusedError extends Error {
  constructor(
    readonly code: PortRefusalCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PortRefusedError";
  }
}

export function isPortRefusedError(err: unknown): err is PortRefusedError {
  return err instanceof PortRefusedError || (err as { name?: unknown } | null)?.name === "PortRefusedError";
}

interface KVLike {
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
}

/** Wider than the http-client rule on purpose: anything that may reach a local listener counts. */
function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0.0.0.0" || /^127\./.test(h)) return true;
  // IPv4-mapped; URL prints ::ffff:127.0.0.1 as ::ffff:7f00:1.
  const mapped = /^::ffff:(.+)$/.exec(h)?.[1];
  if (!mapped) return false;
  if (/^127\./.test(mapped) || mapped === "0.0.0.0") return true;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
  if (!hex) return false;
  const hi = parseInt(hex[1]!, 16);
  return hi >> 8 === 127 || (hi === 0 && parseInt(hex[2]!, 16) === 0);
}

/**
 * Ports of loopback services the runtime itself uses (a local model server,
 * an OpenAI-compatible server, a local relay). An unauthenticated local
 * model server must not become public by accident.
 */
export function loopbackServicePorts(config: Partial<AutomatonConfig>, env: NodeJS.ProcessEnv = process.env): number[] {
  const urls: unknown[] = [
    config.ollamaBaseUrl,
    env.OLLAMA_BASE_URL,
    // Conway mode sends planner and worker calls there.
    env.OPENAI_BASE_URL,
    config.providers?.openai?.baseUrl,
    config.providers?.ollama?.baseUrl,
    config.socialRelayUrl,
    config.conwayApiUrl,
    config.providers?.conway?.apiUrl,
  ];
  for (const c of config.providers?.compatible ?? []) urls.push(c?.baseUrl);
  // Every provider the runtime will call, as the provider table resolves it,
  // so an entry the raw fields above miss is still reserved.
  try {
    for (const e of resolveProviderTable(config as AutomatonConfig, env).entries) urls.push(e.baseUrl);
  } catch {
    // a partial config built in code: the raw fields above still count
  }
  return loopbackPortsOf(urls);
}

function loopbackPortsOf(urls: unknown[]): number[] {
  const out = new Set<number>();
  for (const u of urls) {
    if (typeof u !== "string" || !u.trim()) continue;
    let url: URL;
    try {
      url = new URL(u.trim());
    } catch {
      continue;
    }
    if (!isLoopbackHost(url.hostname)) continue;
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (Number.isInteger(port)) out.add(port);
  }
  return [...out];
}

/**
 * Loopback providers of inference-providers.json, which Conway mode's
 * planner and workers call. Disabled entries count too.
 */
export function inferenceProviderLoopbackPorts(
  file: string = path.join(process.env.HOME || process.cwd(), ".automaton", "inference-providers.json"),
): number[] {
  try {
    return loopbackPortsOf(ProviderRegistry.fromConfig(file).getProviders().map((p) => p.baseUrl));
  } catch {
    return [];
  }
}

/**
 * Ports of the operator's loopback MCP HTTP servers. They take tool calls
 * with the operator's credentials, so they must never become public.
 * Disabled entries count too: the operator may turn them on at any time.
 */
export function mcpLoopbackPorts(load: () => LoadedMcpConfig = () => loadMcpConfig()): number[] {
  let cfg: LoadedMcpConfig;
  try {
    cfg = load();
  } catch {
    return [];
  }
  return loopbackPortsOf(cfg.servers.filter((s) => s.transport === "http").map((s) => (s as HttpServerSpec).url));
}

/** Resolves true when something accepts a TCP connection on 127.0.0.1:port. */
export function probeListening(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean): void => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export interface ExposerDeps {
  /** Ports the agent may never expose besides the configured denials (loopback services). */
  reservedPorts?: () => number[];
  kv?: KVLike;
  probe?: (port: number) => Promise<boolean>;
  now?: () => number;
  /** Aborted when a runtime stop is requested: a start in progress is stopped at once. */
  shutdownSignal?: AbortSignal;
}

/** Today's behaviour: a localhost address only this machine can reach. */
export class LocalExposer implements PortExposer {
  readonly mode = "local" as const;
  private readonly exposures = new Map<number, Exposure>();
  available(): { ok: true } {
    return { ok: true };
  }
  async expose(port: number, opts: ExposeOptions = {}): Promise<Exposure> {
    const e: Exposure = {
      port,
      url: `http://localhost:${port}`,
      state: "up",
      scope: "local",
      managedBy: opts.managedBy ?? "agent",
      sinceMs: Date.now(),
    };
    this.exposures.set(port, e);
    return e;
  }
  async remove(port: number): Promise<boolean> {
    return this.exposures.delete(port);
  }
  list(): Exposure[] {
    return [...this.exposures.values()].map((e) => ({ ...e }));
  }
  previous(): { port: number; name?: string }[] {
    return [];
  }
  onChange(): () => void {
    return () => {};
  }
  async start(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Rules, bookkeeping and persistence shared by proxy and tunnel. */
abstract class PublicExposer implements PortExposer {
  abstract readonly mode: "proxy" | "tunnel";
  protected readonly exposures = new Map<number, Exposure>();
  /** Exposes in progress, by port; they hold their slot and name until they settle. */
  private readonly inflight = new Map<
    number,
    { run: Promise<Exposure>; managedBy: "agent" | "runtime"; name?: string; abort: AbortController }
  >();
  private readonly listeners = new Set<(e: Exposure, previousUrl: string | null) => void>();
  private readonly extraReserved = new Set<number>();
  private earlier: { port: number; name?: string }[] = [];
  /** Set by close(): nothing may start afterwards (a background restore included). */
  protected closed = false;
  protected readonly now: () => number;

  constructor(
    protected readonly cfg: ResolvedPortsConfig,
    protected readonly deps: ExposerDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
  }

  abstract available(): { ok: true } | { ok: false; reason: string };
  protected abstract open(port: number, name: string | undefined, managedBy: "agent" | "runtime", signal?: AbortSignal): Promise<Exposure>;
  protected abstract close1(e: Exposure): Promise<void>;
  protected abstract startMode(): Promise<void>;
  protected abstract closeMode(ms: number): Promise<void>;

  /** A runtime service port (the card server) the agent may not expose. */
  reservePort(port: number): void {
    this.extraReserved.add(port);
  }

  /** Ports the mode itself uses (the gateway's). */
  protected modeReserved(): number[] {
    return [];
  }

  protected reserved(): Set<number> {
    const set = new Set<number>(this.extraReserved);
    for (const p of this.modeReserved()) set.add(p);
    for (const p of this.deps.reservedPorts?.() ?? []) set.add(p);
    return set;
  }

  /** Refuse a port the agent may not expose; null when allowed. */
  checkPort(port: number): PortRefusedError | null {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return new PortRefusedError("PORT_NOT_ALLOWED", `port must be a whole number from 1 to 65535 (got ${String(port)})`);
    }
    const allowed = this.cfg.allowedPorts;
    const listed = Array.isArray(allowed);
    const inAllowed = listed ? allowed.includes(port) : port >= allowed.min && port <= allowed.max;
    if (!inAllowed) {
      const range = listed ? allowed.join(", ") : `${allowed.min}-${allowed.max}`;
      return new PortRefusedError("PORT_NOT_ALLOWED", `port ${port} is outside the ports your owner allows (${range})`);
    }
    if (this.cfg.deniedPorts.includes(port) || (!listed && DEFAULT_DENIED_PORTS.includes(port))) {
      return new PortRefusedError(
        "PORT_NOT_ALLOWED",
        `port ${port} is denied (a well-known service port or one your owner denied); it cannot be made public`,
      );
    }
    // Each ngrok agent serves an API that can open tunnels to any local port;
    // later agents take the next free port after 4040. Not overridable.
    if (this.cfg.tunnel && usesNgrokAgent(this.cfg.tunnel) && port >= NGROK_AGENT_API_PORTS.min && port <= NGROK_AGENT_API_PORTS.max) {
      return new PortRefusedError("PORT_RESERVED", `port ${port} may be an ngrok agent's API, which can open tunnels to any local port`);
    }
    if (this.reserved().has(port)) {
      return new PortRefusedError(
        "PORT_RESERVED",
        `port ${port} is used by a local service of this runtime and cannot be made public`,
      );
    }
    return null;
  }

  protected assertOpen(): void {
    if (this.closed || this.deps.shutdownSignal?.aborted) {
      throw new PortRefusedError("UNAVAILABLE", "public access is shutting down");
    }
  }

  assertAvailable(): void {
    this.assertOpen();
    const a = this.available();
    if (!a.ok) throw new PortRefusedError("UNAVAILABLE", a.reason);
  }

  async expose(port: number, opts: ExposeOptions = {}): Promise<Exposure> {
    const managedBy = opts.managedBy ?? "agent";
    if (managedBy === "agent") {
      const refused = this.checkPort(port);
      if (refused) throw refused;
    }
    const name = this.mode === "proxy" ? this.normaliseName(port, opts.name, managedBy) : undefined;
    const existing = this.exposures.get(port);
    if (existing && existing.state !== "failed") {
      if (existing.managedBy !== managedBy) {
        throw new PortRefusedError("MANAGED_BY_RUNTIME", `port ${port} is published by the runtime`);
      }
      if (this.mode === "proxy" && opts.name !== undefined && existing.name !== name) {
        throw new PortRefusedError("NAME_TAKEN", `port ${port} is already public as ${existing.name}; remove it first to rename it`);
      }
      return { ...existing };
    }
    const pending = this.inflight.get(port);
    if (pending) return pending.run.then((e) => ({ ...e }));
    if (managedBy === "agent") {
      const count =
        [...this.exposures.values()].filter((e) => e.managedBy === "agent" && e.port !== port).length +
        [...this.inflight.values()].filter((p) => p.managedBy === "agent").length;
      if (count >= this.cfg.maxExposed) {
        throw new PortRefusedError(
          "PORT_LIMIT",
          `at most ${this.cfg.maxExposed} port(s) can be public at once; remove one first`,
        );
      }
    }
    if (name !== undefined) {
      for (const e of this.exposures.values()) {
        if (e.name === name && e.port !== port) {
          throw new PortRefusedError("NAME_TAKEN", `the name ${name} is already used by port ${e.port}`);
        }
      }
      for (const [p, f] of this.inflight) {
        if (f.name === name) throw new PortRefusedError("NAME_TAKEN", `the name ${name} is being given to port ${p}`);
      }
    }
    this.assertAvailable();
    // remove() aborts a start in progress through this controller.
    const abort = new AbortController();
    // A tool call of the main loop has no ambient signal: without the
    // shutdown signal a stop would wait out the whole start timeout.
    const outer = mergeSignals(opts.signal ?? currentCancellationSignal(), this.deps.shutdownSignal);
    const signal = outer ? AbortSignal.any([abort.signal, outer]) : abort.signal;
    const run = (async () => {
      if (existing) await this.close1(existing).catch(() => {});
      this.assertOpen();
      if (abort.signal.aborted) throw abort.signal.reason;
      const e = await this.open(port, name, managedBy, signal).catch((err) => {
        this.assertOpen();
        throw err;
      });
      if (this.closed || abort.signal.aborted) {
        await this.close1(e).catch(() => {});
        this.assertOpen();
        throw abort.signal.reason;
      }
      this.exposures.set(port, e);
      this.earlier = this.earlier.filter((p) => p.port !== port);
      this.persist();
      this.emit(e, null);
      const probe = this.deps.probe ?? probeListening;
      e.listening = await probe(port).catch(() => false);
      return e;
    })();
    // Set before this call yields, so a concurrent expose sees the slot and name taken.
    this.inflight.set(port, { run, managedBy, abort, ...(name !== undefined ? { name } : {}) });
    try {
      return { ...(await run) };
    } finally {
      this.inflight.delete(port);
    }
  }

  private normaliseName(port: number, requested: string | undefined, managedBy: "agent" | "runtime"): string {
    const name = (requested ?? `p${port}`).trim().toLowerCase();
    if (!EXPOSURE_NAME_RE.test(name)) {
      throw new PortRefusedError(
        "NAME_INVALID",
        "name must be 1 to 40 lowercase letters, digits or hyphens, not starting or ending with a hyphen",
      );
    }
    if (managedBy === "agent" && this.reservedNames().has(name)) {
      throw new PortRefusedError("NAME_TAKEN", `the name ${name} is reserved by the runtime`);
    }
    return name;
  }

  /** Names the runtime keeps (the agent card's). */
  protected reservedNamesSet = new Set<string>();
  reserveName(name: string): void {
    this.reservedNamesSet.add(name);
  }
  private reservedNames(): Set<string> {
    return this.reservedNamesSet;
  }

  async remove(port: number, opts: { managedBy?: "agent" | "runtime" } = {}): Promise<boolean> {
    const managedBy = opts.managedBy ?? "agent";
    const pending = this.inflight.get(port);
    if (pending) {
      if (pending.managedBy === "runtime" && managedBy === "agent") {
        throw new PortRefusedError("MANAGED_BY_RUNTIME", `port ${port} is published by the runtime and cannot be removed by a tool`);
      }
      // A start in progress (a first expose or a retry of a failed one)
      // would go public after this call returned.
      pending.abort.abort(new PortRefusedError("NOT_EXPOSED", `port ${port} was removed while it was being exposed`));
      await pending.run.catch(() => {});
    }
    const e = this.exposures.get(port);
    if (!e) return pending !== undefined;
    if (e.managedBy === "runtime" && managedBy === "agent") {
      throw new PortRefusedError("MANAGED_BY_RUNTIME", `port ${port} is published by the runtime and cannot be removed by a tool`);
    }
    this.exposures.delete(port);
    await this.close1(e);
    this.persist();
    return true;
  }

  list(): Exposure[] {
    return [...this.exposures.values()].map((e) => ({ ...e }));
  }

  previous(): { port: number; name?: string }[] {
    return this.earlier.map((p) => ({ ...p }));
  }

  onChange(cb: (e: Exposure, previousUrl: string | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  protected emit(e: Exposure, previousUrl: string | null): void {
    for (const cb of this.listeners) {
      try {
        cb({ ...e }, previousUrl);
      } catch (err) {
        logger.warn(`Exposure listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Agent exposures in KV, so the next start can list or restore them. */
  protected persist(): void {
    const kv = this.deps.kv;
    if (!kv) return;
    const rows = [...this.exposures.values()]
      .filter((e) => e.managedBy === "agent")
      .map((e) => ({ port: e.port, ...(e.name ? { name: e.name } : {}), ...(e.url ? { url: e.url } : {}) }));
    try {
      kv.setKV(EXPOSURES_KV, JSON.stringify(rows));
    } catch (err) {
      logger.warn(`Could not record exposures: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readPersisted(): { port: number; name?: string }[] {
    const raw = this.deps.kv?.getKV(EXPOSURES_KV);
    if (!raw) return [];
    try {
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => r && Number.isInteger(r.port))
        .slice(0, 10)
        .map((r) => ({ port: r.port as number, ...(typeof r.name === "string" && EXPOSURE_NAME_RE.test(r.name) ? { name: r.name } : {}) }));
    } catch {
      return [];
    }
  }

  async start(): Promise<void> {
    await this.startMode();
    const earlier = this.readPersisted();
    if (earlier.length === 0) return;
    if (!this.cfg.restoreOnStart) {
      this.earlier = earlier;
      return;
    }
    // In the background: a slow tunnel must not delay startup.
    void (async () => {
      for (const p of earlier) {
        if (this.closed) return;
        try {
          await this.expose(p.port, { name: p.name });
        } catch (err) {
          if (this.closed) return;
          this.earlier.push(p);
          logger.warn(`Could not restore exposure of port ${p.port}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
  }

  async close(ms: number): Promise<void> {
    this.closed = true;
    // An aborted start still has to stop what it opened (a tunnel process):
    // wait for it within the same deadline.
    const starting = [...this.inflight.values()];
    for (const f of starting) f.abort.abort(new PortRefusedError("UNAVAILABLE", "public access is shutting down"));
    const all = [...this.exposures.values()];
    this.exposures.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...starting.map((f) => f.run), ...all.map((e) => this.close1(e)), this.closeMode(ms)]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

/** Proxy mode: names under the owner's wildcard, served by the gateway. */
export class ProxyExposer extends PublicExposer {
  readonly mode = "proxy" as const;
  readonly gateway: Gateway;

  constructor(cfg: ResolvedPortsConfig, deps: ExposerDeps = {}) {
    super(cfg, deps);
    if (!cfg.urlTemplate || !cfg.suffix) throw new Error("proxy mode needs urlTemplate");
    this.gateway = new Gateway({ host: cfg.gateway.host, port: cfg.gateway.port, suffix: cfg.suffix });
  }

  available(): { ok: true } | { ok: false; reason: string } {
    const why = this.gateway.failureReason();
    if (why) return { ok: false, reason: why };
    if (!this.gateway.address()) return { ok: false, reason: "the gateway is not running" };
    return { ok: true };
  }

  protected modeReserved(): number[] {
    const bound = this.gateway.address()?.port;
    return bound ? [this.cfg.gateway.port, bound] : [this.cfg.gateway.port];
  }

  urlFor(name: string): string {
    return this.cfg.urlTemplate!.replace("{name}", name).replace(/\/$/, "");
  }

  protected async open(port: number, name: string | undefined, managedBy: "agent" | "runtime"): Promise<Exposure> {
    const label = name ?? `p${port}`;
    this.gateway.setRoute(label, port);
    return {
      port,
      name: label,
      url: this.urlFor(label),
      state: "up",
      scope: "public",
      managedBy,
      sinceMs: this.now(),
    };
  }

  protected async close1(e: Exposure): Promise<void> {
    if (e.name) this.gateway.removeRoute(e.name);
  }

  protected async startMode(): Promise<void> {
    try {
      await this.gateway.start();
    } catch (err) {
      logger.warn(`Public ports are unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  protected async closeMode(ms: number): Promise<void> {
    await this.gateway.close(ms);
  }
}

export interface TunnelExposerDeps extends ExposerDeps {
  /** Host environment the tunnel's passEnv values come from. */
  env?: NodeJS.ProcessEnv;
  /** Restart backoff (tests shorten it). */
  backoffMs?: number[];
}

/** Tunnel mode: one supervised tunnel process per exposed port. */
export class TunnelExposer extends PublicExposer {
  readonly mode = "tunnel" as const;
  private readonly sups = new Map<number, TunnelSupervisor>();
  private commandProblem: string | null = null;
  private readonly tunnel: ResolvedTunnelConfig;

  constructor(
    cfg: ResolvedPortsConfig,
    private readonly tdeps: TunnelExposerDeps = {},
  ) {
    super(cfg, tdeps);
    if (!cfg.tunnel) throw new Error("tunnel mode needs a tunnel section");
    this.tunnel = cfg.tunnel;
  }

  /** The tunnel's environment: no credentials of the runtime, only what the owner named. */
  tunnelEnv(): NodeJS.ProcessEnv {
    const host = this.tdeps.env ?? process.env;
    const env = childProcessEnv(host);
    for (const name of this.tunnel.passEnv) {
      const v = host[name];
      if (typeof v === "string") env[name] = v;
    }
    Object.assign(env, this.tunnel.env);
    return env;
  }

  spec(): TunnelSpec {
    return {
      command: this.tunnel.command,
      args: this.tunnel.args,
      urlPattern: this.tunnel.urlPattern,
      readyPattern: this.tunnel.readyPattern,
      env: this.tunnelEnv(),
      startTimeoutMs: this.tunnel.startTimeoutMs,
      restart: { ...this.tunnel.restart, backoffMs: this.tdeps.backoffMs ?? [...DEFAULT_BACKOFF_MS] },
    };
  }

  /** Checks the binary: exists, is a file, is executable. */
  checkCommand(): string | null {
    const cmd = this.tunnel.command;
    try {
      const st = fs.statSync(cmd);
      if (!st.isFile()) return `the tunnel command ${cmd} is not a file`;
      fs.accessSync(cmd, fs.constants.X_OK);
    } catch {
      return `the tunnel command ${cmd} does not exist or is not executable`;
    }
    return null;
  }

  available(): { ok: true } | { ok: false; reason: string } {
    // Checked live: the owner may install the binary while the runtime runs.
    this.commandProblem = this.checkCommand();
    if (this.commandProblem) return { ok: false, reason: this.commandProblem };
    return { ok: true };
  }

  supervisor(port: number): TunnelSupervisor | undefined {
    return this.sups.get(port);
  }

  protected async open(port: number, _name: string | undefined, managedBy: "agent" | "runtime", signal?: AbortSignal): Promise<Exposure> {
    const sinceMs = this.now();
    // The address before a restart, so the one 'up' event after it can say what changed.
    let lastUpUrl: string | null = null;
    // Set once this start succeeded. Until then the port may still hold the
    // failed exposure of an earlier tunnel, which must not report this one.
    let created: Exposure | null = null;
    const sup = new TunnelSupervisor(port, this.spec(), {
      now: this.now,
      // Recorded at spawn, not when up: a hard kill during a start must not
      // leave a tunnel the next start cannot find.
      onSpawn: () => {
        if (this.sups.get(port) === sup) this.persistPids();
      },
      onStateChange: (state, url) => {
        const e = this.exposures.get(port);
        if (!e || e !== created || this.sups.get(port) !== sup) return;
        // A restart goes up -> restarting (url null) -> up: report the old
        // address on the 'up', in one event (a URL change is part of it).
        const previousUrl = state === "up" ? (e.url ?? lastUpUrl) : e.url;
        if (state === "up") lastUpUrl = url;
        e.state = state;
        e.url = url;
        e.detail = sup.detail;
        this.persistPids();
        this.persist();
        this.emit(e, previousUrl);
      },
    });
    this.sups.set(port, sup);
    try {
      const url = await sup.start(signal);
      if (this.closed) {
        // close() ran while this tunnel started; it must not outlive the edge.
        await sup.stop(500);
        this.assertOpen();
      }
      this.persistPids();
      lastUpUrl = url;
      created = {
        port,
        url,
        state: "up",
        scope: "public",
        managedBy,
        sinceMs,
        ...(sup.readyPending ? { readyPending: true } : {}),
      };
      return created;
    } catch (err) {
      if (this.sups.get(port) === sup) this.sups.delete(port);
      this.persistPids();
      throw err;
    }
  }

  protected async close1(e: Exposure): Promise<void> {
    const sup = this.sups.get(e.port);
    if (!sup) return;
    this.sups.delete(e.port);
    await sup.stop(TUNNEL_STOP_GRACE_MS);
    this.persistPids();
  }

  /** The tunnel's argv for a port, as /proc/<pid>/cmdline shows it. */
  private argvFor(port: number): string[] {
    return [this.tunnel.command, ...this.tunnel.args.map((a) => a.split("{port}").join(String(port)))];
  }

  /**
   * Tunnel process groups with their full argv and start time, so the next
   * start can stop ones a hard kill left running and nothing else.
   */
  private persistPids(): void {
    const kv = this.deps.kv;
    if (!kv) return;
    const rows: PersistedTunnel[] = [];
    for (const s of this.sups.values()) {
      const pid = s.pid;
      if (typeof pid !== "number") continue;
      rows.push({ pid, argv: this.argvFor(s.port), start: procStat(pid)?.start ?? null });
    }
    try {
      kv.setKV(TUNNEL_PIDS_KV, JSON.stringify(rows));
    } catch {
      // diagnostics only
    }
  }

  /**
   * A runtime killed with SIGKILL runs no exit hook, so its tunnels keep
   * running. Stop a recorded group only when its leader still has the same
   * argv and start time (a reused pid is left alone), and never this
   * process or its own group.
   */
  private reapOrphans(): void {
    const raw = this.deps.kv?.getKV(TUNNEL_PIDS_KV);
    if (!raw) return;
    let rows: unknown;
    try {
      rows = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    const self = procStat(process.pid);
    for (const row of rows as Partial<PersistedTunnel>[]) {
      const pid = row?.pid;
      if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid || pid === self?.pgrp) continue;
      if (typeof row.start !== "string" || !Array.isArray(row.argv)) continue;
      const stat = procStat(pid as number);
      if (!stat || stat.start !== row.start || stat.pgrp !== pid) continue;
      let argv: string[];
      try {
        argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      } catch {
        continue;
      }
      if (argv[argv.length - 1] === "") argv.pop();
      if (argv.length !== row.argv.length || argv.some((a, i) => a !== row.argv![i])) continue;
      if (signalGroup(pid as number, "SIGKILL")) logger.warn(`Stopped tunnel process group ${pid} left by an earlier run`);
    }
    try {
      this.deps.kv?.setKV(TUNNEL_PIDS_KV, "[]");
    } catch {
      // diagnostics only
    }
  }

  protected async startMode(): Promise<void> {
    this.reapOrphans();
    this.commandProblem = this.checkCommand();
    if (this.commandProblem) {
      logger.warn(`Public ports are unavailable: ${this.commandProblem}`);
      return;
    }
    try {
      fs.accessSync(this.tunnel.command, fs.constants.W_OK);
      logger.warn(`The tunnel command ${this.tunnel.command} is writable by this user; anything running as this user could replace it`);
    } catch {
      // not writable: as it should be
    }
  }

  protected async closeMode(): Promise<void> {
    const sups = [...this.sups.values()];
    this.sups.clear();
    await Promise.allSettled(sups.map((s) => s.stop(TUNNEL_STOP_GRACE_MS)));
    this.persistPids();
  }
}

interface PersistedTunnel {
  pid: number;
  argv: string[];
  /** /proc start time in clock ticks; null where /proc is missing (never reaped then). */
  start: string | null;
}

/** Process group and start time (fields 5 and 22 of /proc/<pid>/stat); null without /proc. */
function procStat(pid: number): { pgrp: number; start: string } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may hold spaces and parentheses; fields after it do not.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(rest[2]);
    const start = rest[19];
    if (!Number.isInteger(pgrp) || !start || !/^\d+$/.test(start)) return null;
    return { pgrp, start };
  } catch {
    return null;
  }
}

/** The exposer for a resolved ports section. */
export function createPortExposer(cfg: ResolvedPortsConfig, deps: TunnelExposerDeps = {}): PortExposer {
  if (cfg.mode === "proxy") return new ProxyExposer(cfg, deps);
  if (cfg.mode === "tunnel") return new TunnelExposer(cfg, deps);
  return new LocalExposer();
}
