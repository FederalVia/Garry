/**
 * The `publicAccess` block of automaton.json: port exposure (local, a
 * reverse proxy the owner runs, or a supervised tunnel), DNS on a zone the
 * owner owns, an optional registrar, and the agent card.
 *
 * Off by default: without the block nothing here changes behaviour. Parsing
 * is pure (no I/O beyond registering secrets for redaction) and memoised per
 * block, so the runtime summary can be derived on every use. Resolved
 * secrets live only in the parsed objects; the config keeps the owner's raw
 * block, so saving the config never writes an env-sourced token.
 */

import net from "node:net";
import path from "node:path";
import type { AutomatonConfig } from "../types.js";
import { isInternalHostname } from "../registry/safe-fetch.js";
import { registerSecret } from "../security/secret-redaction.js";
import { isSharedEnvName, withholdFromChildren } from "../security/child-env.js";
import { EdgeConfigError, type ResolvedDnsConfig, type ResolvedRegistrarConfig } from "./types.js";
import { DNS_ENV_NAMES, effectiveDefaultTtl, parseDnsSection } from "./dns/config.js";
import { REGISTRAR_ENV_NAMES, parseRegistrarSection } from "./registrar/config.js";

export type PortsMode = "local" | "conway" | "proxy" | "tunnel";
export type TunnelPreset = "cloudflared" | "ngrok" | "custom";

export interface ResolvedTunnelConfig {
  preset: TunnelPreset;
  command: string;
  args: string[];
  urlPattern: RegExp;
  readyPattern?: RegExp;
  /** Variables set for the tunnel only (its own token). */
  env: Record<string, string>;
  /** Names of host variables handed to the tunnel. */
  passEnv: string[];
  startTimeoutMs: number;
  restart: { maxRestarts: number; windowMs: number };
}

export interface ResolvedPortsConfig {
  mode: "local" | "proxy" | "tunnel";
  /** proxy: e.g. https://{name}.agents.example.com */
  urlTemplate?: string;
  /** proxy: the hostname after the agent's label, e.g. agents.example.com */
  suffix?: string;
  gateway: { host: string; port: number };
  maxExposed: number;
  allowedPorts: { min: number; max: number } | number[];
  deniedPorts: number[];
  restoreOnStart: boolean;
  tunnel?: ResolvedTunnelConfig;
}

export interface ResolvedAgentCardConfig {
  publish: boolean;
  name: string;
}

export interface ResolvedPublicAccess {
  ports?: ResolvedPortsConfig;
  dns?: ResolvedDnsConfig;
  /** Present only when the section is enabled. */
  registrar?: ResolvedRegistrarConfig;
  agentCard: ResolvedAgentCardConfig;
  /** Shape is valid but something deserves the owner's attention. */
  warnings: string[];
}

/** What the runtime offers, without secrets. */
export interface EdgeSummary {
  /** True when anything in publicAccess changes behaviour in this mode. */
  configured: boolean;
  ports: PortsMode;
  urlTemplate?: string;
  tunnelPreset?: TunnelPreset;
  /** Agent exposures allowed at once (public modes). */
  maxExposed?: number;
  dns?: { provider: string; zone: string; allowedTypes: string[]; subtree?: string; defaultTtl: number; allowApex: boolean };
  registrar?: { provider: string; allowedTlds: string[] };
  agentCard: boolean;
  /** Sections configured but not honoured in this mode, with why. */
  ignored: string[];
  /** The block could not be parsed (loadConfig refuses such a file; embedded use may not). */
  error?: string;
}

export const DEFAULT_GATEWAY = Object.freeze({ host: "127.0.0.1", port: 8480 });
export const DEFAULT_MAX_EXPOSED = 3;
export const DEFAULT_TUNNEL_START_TIMEOUT_MS = 30_000;
export const DEFAULT_TUNNEL_RESTART = Object.freeze({ maxRestarts: 5, windowMs: 600_000 });

/**
 * Well-known unauthenticated services that must not become public by one
 * tool call: Docker API, etcd, MySQL, the ngrok agent API (which can open new
 * tunnels), Postgres, CouchDB, Redis, Consul, Elasticsearch, the Node
 * inspector, memcached, MongoDB, cloudflared's metrics ports. An explicit
 * allowedPorts list overrides this default; deniedPorts adds to it.
 */
export const DEFAULT_DENIED_PORTS: readonly number[] = Object.freeze([
  2375, 2376, 2379, 2380, 3306, 4040, 5432, 5984, 6379, 8500, 9200, 9229, 9300, 11211, 20241, 20242, 20243, 20244,
  20245, 27017,
]);

/**
 * Where ngrok agents serve their local API (4040, then the next free port
 * for each further agent). One agent runs per exposed port, at most 10.
 */
export const NGROK_AGENT_API_PORTS = Object.freeze({ min: 4040, max: 4050 });

/** True when the tunnel runs ngrok, as the preset or as a custom command named ngrok. */
export function usesNgrokAgent(t: Pick<ResolvedTunnelConfig, "preset" | "command">): boolean {
  return t.preset === "ngrok" || /^ngrok(?:\.exe)?$/i.test(path.basename(t.command));
}

export const TUNNEL_PRESETS: Readonly<
  Record<Exclude<TunnelPreset, "custom">, { args: string[]; urlPattern: RegExp; readyPattern?: RegExp; label: string }>
> = Object.freeze({
  cloudflared: {
    args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:{port}"],
    urlPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    readyPattern: /Registered tunnel connection/,
    label: "cloudflared",
  },
  ngrok: {
    args: ["http", "127.0.0.1:{port}", "--log", "stdout", "--log-format", "json"],
    urlPattern: /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|dev|io)/,
    label: "ngrok",
  },
});

/** Env names a tunnel may never be given: they change what runs. */
const DENIED_ENV_NAME = /^(?:PATH|HOME|NODE_OPTIONS|LD_.*|DYLD_.*)$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Names the agent may pick for a proxy exposure. */
export const EXPOSURE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** Tunnel tokens the runtime itself never uses but must never show. */
const TUNNEL_ENV_NAMES: readonly string[] = Object.freeze(["NGROK_AUTHTOKEN", "TUNNEL_TOKEN"]);

type Raw = Record<string, unknown>;

function isPlainObject(v: unknown): v is Raw {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function fail(p: string, message: string): never {
  throw new EdgeConfigError(p, message);
}

function intIn(p: string, v: unknown, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    fail(p, `must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)})`);
  }
  return v;
}

function bool(p: string, v: unknown, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") fail(p, `must be true or false (got ${JSON.stringify(v)})`);
  return v;
}

function portList(p: string, v: unknown): number[] {
  if (!Array.isArray(v)) fail(p, "must be a list of port numbers");
  if (v.length > 1000) fail(p, "has more than 1000 entries");
  return v.map((x, i) => intIn(`${p}[${i}]`, x, 1, 65535, 0));
}

function isLoopbackName(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The template's hostname suffix after `{name}.`, validated. */
function parseUrlTemplate(p: string, v: unknown): { template: string; suffix: string } {
  if (typeof v !== "string" || v.trim() === "") fail(p, "is required in proxy mode");
  const template = v.trim();
  const placeholders = template.match(/\{[^}]*\}/g) ?? [];
  if (placeholders.length !== 1 || placeholders[0] !== "{name}") {
    fail(p, "must contain {name} exactly once and no other placeholder");
  }
  const m = /^https:\/\/\{name\}\.([^/:?#@]+)(:\d{1,5})?\/?$/.exec(template);
  if (!m) {
    if (!template.startsWith("https://")) fail(p, "must start with https://");
    fail(p, "must be https://{name}.<domain> with {name} as the whole leftmost label, no path, query or user");
  }
  if (net.isIP(m[1]) || /^[\d.]+$/.test(m[1])) fail(p, "must name a domain, not an IP address");
  let url: URL;
  try {
    url = new URL(template.replace("{name}", "x"));
  } catch {
    fail(p, "is not a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail(p, "must be a plain https URL");
  }
  if (url.pathname !== "/" && url.pathname !== "") fail(p, "must not have a path");
  const suffix = m[1].toLowerCase();
  const labels = suffix.split(".");
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) {
    fail(p, "needs a domain of at least two valid labels after {name}.");
  }
  if (net.isIP(suffix) || net.isIP(url.hostname)) fail(p, "must name a domain, not an IP address");
  if (isInternalHostname(`x.${suffix}`)) fail(p, "must name a public domain");
  return { template, suffix };
}

function parseEnvNames(p: string, v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 32) fail(p, "must be a list of at most 32 variable names");
  return v.map((n, i) => {
    if (typeof n !== "string" || !ENV_NAME.test(n)) fail(`${p}[${i}]`, "must be an upper-case variable name");
    if (DENIED_ENV_NAME.test(n)) fail(`${p}[${i}]`, `${n} cannot be passed to a tunnel`);
    return n;
  });
}

function parseTunnel(p: string, v: unknown, env: NodeJS.ProcessEnv, warnings: string[]): ResolvedTunnelConfig {
  if (!isPlainObject(v)) fail(p, "is required in tunnel mode (an object with preset and command)");
  const preset = v.preset;
  if (preset !== "cloudflared" && preset !== "ngrok" && preset !== "custom") {
    fail(`${p}.preset`, `must be "cloudflared", "ngrok" or "custom" (got ${JSON.stringify(preset)})`);
  }
  const command = v.command;
  if (typeof command !== "string" || !path.isAbsolute(command) || command.includes("\0")) {
    fail(`${p}.command`, "must be an absolute path (no PATH lookup)");
  }
  let args: string[];
  let urlPattern: RegExp;
  let readyPattern: RegExp | undefined;
  if (preset === "custom") {
    if (!Array.isArray(v.args) || v.args.length === 0 || v.args.length > 32) {
      fail(`${p}.args`, "must be a list of 1 to 32 strings");
    }
    args = v.args.map((a, i) => {
      if (typeof a !== "string" || a.length > 256 || a.includes("\0")) {
        fail(`${p}.args[${i}]`, "must be a string of at most 256 characters");
      }
      return a;
    });
    if (!args.some((a) => a.includes("{port}"))) fail(`${p}.args`, "must contain {port} in at least one argument");
    urlPattern = compilePattern(`${p}.urlPattern`, v.urlPattern, true)!;
    readyPattern = compilePattern(`${p}.readyPattern`, v.readyPattern, false);
  } else {
    if (v.args !== undefined || v.urlPattern !== undefined || v.readyPattern !== undefined) {
      warnings.push(`publicAccess.ports.tunnel: args and patterns are fixed by the ${preset} preset and were ignored; use preset "custom" to set them`);
    }
    const ps = TUNNEL_PRESETS[preset];
    args = [...ps.args];
    urlPattern = ps.urlPattern;
    readyPattern = ps.readyPattern;
  }
  const tunnelEnv: Record<string, string> = {};
  if (v.env !== undefined) {
    if (!isPlainObject(v.env)) fail(`${p}.env`, "must be an object of NAME: value");
    const entries = Object.entries(v.env);
    if (entries.length > 32) fail(`${p}.env`, "has more than 32 variables");
    for (const [name, value] of entries) {
      if (!ENV_NAME.test(name)) fail(`${p}.env.${name}`, "must be an upper-case variable name");
      if (DENIED_ENV_NAME.test(name)) fail(`${p}.env.${name}`, `${name} cannot be set for a tunnel`);
      if (typeof value !== "string") fail(`${p}.env.${name}`, "must be a string");
      tunnelEnv[name] = value;
      registerSecret(value, "edge-tunnel");
    }
  }
  const passEnv = parseEnvNames(`${p}.passEnv`, v.passEnv);
  // Proxy, certificate and locale settings are shared with every child anyway:
  // they are neither masked nor held back.
  for (const name of passEnv) if (!isSharedEnvName(name)) registerSecret(env[name], "edge-tunnel");
  // For the tunnel only: tool children must not inherit the rest, whatever the name.
  withholdFromChildren(passEnv);
  const restartRaw = v.restart;
  if (restartRaw !== undefined && !isPlainObject(restartRaw)) fail(`${p}.restart`, "must be an object");
  const restart = {
    maxRestarts: intIn(`${p}.restart.maxRestarts`, (restartRaw as Raw | undefined)?.maxRestarts, 0, 20, DEFAULT_TUNNEL_RESTART.maxRestarts),
    windowMs: intIn(`${p}.restart.windowMs`, (restartRaw as Raw | undefined)?.windowMs, 60_000, 86_400_000, DEFAULT_TUNNEL_RESTART.windowMs),
  };
  return {
    preset,
    command,
    args,
    urlPattern,
    readyPattern,
    env: tunnelEnv,
    passEnv,
    startTimeoutMs: intIn(`${p}.startTimeoutMs`, v.startTimeoutMs, 5_000, 120_000, DEFAULT_TUNNEL_START_TIMEOUT_MS),
    restart,
  };
}

function compilePattern(p: string, v: unknown, required: boolean): RegExp | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > 512) fail(p, "must be a regular expression string");
  try {
    return new RegExp(v);
  } catch (err) {
    fail(p, `is not a valid regular expression (${err instanceof Error ? err.message : String(err)})`);
  }
}

function parsePorts(v: unknown, env: NodeJS.ProcessEnv, warnings: string[]): ResolvedPortsConfig | undefined {
  if (v === undefined) return undefined;
  const p = "publicAccess.ports";
  if (!isPlainObject(v)) fail(p, "must be an object");
  const mode = v.mode ?? "local";
  if (mode !== "local" && mode !== "proxy" && mode !== "tunnel") {
    fail(`${p}.mode`, `must be "local", "proxy" or "tunnel" (got ${JSON.stringify(mode)})`);
  }
  let gatewayHost: string = DEFAULT_GATEWAY.host;
  let gatewayPort: number = DEFAULT_GATEWAY.port;
  if (v.gateway !== undefined) {
    if (!isPlainObject(v.gateway)) fail(`${p}.gateway`, "must be an object with host and port");
    const h = v.gateway.host;
    if (h !== undefined) {
      if (typeof h !== "string" || (h !== "localhost" && net.isIP(h) === 0)) {
        fail(`${p}.gateway.host`, "must be an IP address or localhost");
      }
      gatewayHost = h;
    }
    gatewayPort = intIn(`${p}.gateway.port`, v.gateway.port, 1024, 65535, DEFAULT_GATEWAY.port);
  }
  let urlTemplate: string | undefined;
  let suffix: string | undefined;
  let tunnel: ResolvedTunnelConfig | undefined;
  if (mode === "proxy") {
    ({ template: urlTemplate, suffix } = parseUrlTemplate(`${p}.urlTemplate`, v.urlTemplate));
    if (!isLoopbackName(gatewayHost)) {
      warnings.push(
        `publicAccess.ports.gateway.host ${gatewayHost} is not a loopback address: anything that can reach it can use the gateway (fine inside a container whose port is published only to the host's loopback)`,
      );
    }
  }
  if (mode === "tunnel") tunnel = parseTunnel(`${p}.tunnel`, v.tunnel, env, warnings);

  let allowedPorts: ResolvedPortsConfig["allowedPorts"] = { min: 1024, max: 65535 };
  if (v.allowedPorts !== undefined) {
    if (Array.isArray(v.allowedPorts)) {
      allowedPorts = portList(`${p}.allowedPorts`, v.allowedPorts);
    } else if (isPlainObject(v.allowedPorts)) {
      const min = intIn(`${p}.allowedPorts.min`, v.allowedPorts.min, 1, 65535, 1024);
      const max = intIn(`${p}.allowedPorts.max`, v.allowedPorts.max, 1, 65535, 65535);
      if (min > max) fail(`${p}.allowedPorts`, "min must not be greater than max");
      allowedPorts = { min, max };
    } else {
      fail(`${p}.allowedPorts`, "must be {min, max} or a list of ports");
    }
  }
  const deniedPorts = v.deniedPorts === undefined ? [] : portList(`${p}.deniedPorts`, v.deniedPorts);
  return {
    mode,
    urlTemplate,
    suffix,
    gateway: { host: gatewayHost, port: gatewayPort },
    maxExposed: intIn(`${p}.maxExposed`, v.maxExposed, 1, 10, DEFAULT_MAX_EXPOSED),
    allowedPorts,
    deniedPorts,
    restoreOnStart: bool(`${p}.restoreOnStart`, v.restoreOnStart, false),
    tunnel,
  };
}

function parseAgentCard(v: unknown): ResolvedAgentCardConfig {
  if (v === undefined) return { publish: false, name: "agent" };
  if (!isPlainObject(v)) fail("publicAccess.agentCard", "must be an object");
  const name = v.name ?? "agent";
  if (typeof name !== "string" || !EXPOSURE_NAME_RE.test(name)) {
    fail("publicAccess.agentCard.name", "must be a DNS label (lowercase letters, digits, hyphens)");
  }
  return { publish: bool("publicAccess.agentCard.publish", v.publish, false), name };
}

const memo = new WeakMap<object, { env: NodeJS.ProcessEnv; result: ResolvedPublicAccess }>();

/**
 * Parse the publicAccess block. Throws EdgeConfigError (with the config
 * path of the bad value) on a shape error. Registers every secret it reads.
 */
export function parsePublicAccess(raw: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedPublicAccess | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) fail("publicAccess", "must be an object");
  const hit = memo.get(raw);
  if (hit && hit.env === env) return hit.result;
  const warnings: string[] = [];
  const ports = parsePorts(raw.ports, env, warnings);
  const dns = parseDnsSection(raw.dns, env) ?? undefined;
  const registrar = raw.registrar === undefined ? undefined : (parseRegistrarSection(raw.registrar, env) ?? undefined);
  const agentCard = parseAgentCard(raw.agentCard);
  const result: ResolvedPublicAccess = { ports, dns, registrar, agentCard, warnings };
  memo.set(raw, { env, result });
  return result;
}

/**
 * loadConfig's check: a shape error becomes ConfigError-ready text with the
 * config path. Returns the parsed block (secrets registered).
 */
export function validatePublicAccess(
  raw: unknown,
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  makeError: (message: string) => Error = (m) => new Error(m),
): ResolvedPublicAccess | null {
  try {
    return parsePublicAccess(raw, env);
  } catch (err) {
    if (err instanceof EdgeConfigError) throw makeError(`${configPath}: ${err.message}`);
    throw err;
  }
}

/** Register the values of every edge credential variable, even when its section is absent. */
export function registerEdgeEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of DNS_ENV_NAMES) registerSecret(env[name], "edge-dns");
  for (const name of REGISTRAR_ENV_NAMES) registerSecret(env[name], "edge-registrar");
  for (const name of TUNNEL_ENV_NAMES) registerSecret(env[name], "edge-tunnel");
}

/** Same rule as conway/client's isLocalSandboxId; kept here so the mode module does not import the client. */
function isLocalSandboxId(value: string | null | undefined): boolean {
  const t = (value || "").trim();
  return t === "" || t === "undefined" || t === "null";
}

/** True when ports may be handled by the runtime in this mode (commands run where the runtime runs). */
export function portsHonoured(config: Pick<AutomatonConfig, "sandboxId">, mode: "conway" | "standalone"): boolean {
  return mode === "standalone" || isLocalSandboxId(config.sandboxId);
}

/** The runtime summary: what is honoured in this mode, without secrets. Never throws. */
export function summarizeEdge(config: AutomatonConfig, mode: "conway" | "standalone", env: NodeJS.ProcessEnv = process.env): EdgeSummary {
  const base: EdgeSummary = { configured: false, ports: mode === "conway" ? "conway" : "local", agentCard: false, ignored: [] };
  const raw = (config as { publicAccess?: unknown }).publicAccess;
  if (raw === undefined || raw === null) return base;
  let parsed: ResolvedPublicAccess | null;
  try {
    parsed = parsePublicAccess(raw, env);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed) return base;
  return summarizeParsed(parsed, config, mode);
}

export function summarizeParsed(
  parsed: ResolvedPublicAccess,
  config: Pick<AutomatonConfig, "sandboxId">,
  mode: "conway" | "standalone",
): EdgeSummary {
  const s: EdgeSummary = { configured: false, ports: mode === "conway" ? "conway" : "local", agentCard: false, ignored: [] };
  const localCommands = portsHonoured(config, mode);
  if (parsed.ports) {
    if (!localCommands) {
      if (parsed.ports.mode !== "local") {
        s.ignored.push("ports: Conway sandbox mode exposes ports through Conway (the runtime may not run where your commands run)");
      }
    } else if (parsed.ports.mode !== "local") {
      s.ports = parsed.ports.mode;
      s.maxExposed = parsed.ports.maxExposed;
      if (parsed.ports.mode === "proxy") s.urlTemplate = parsed.ports.urlTemplate;
      if (parsed.ports.mode === "tunnel") s.tunnelPreset = parsed.ports.tunnel?.preset;
    } else if (mode === "standalone") {
      s.ports = "local";
    }
  }
  if (parsed.dns) {
    s.dns = {
      provider: parsed.dns.provider,
      zone: parsed.dns.zone,
      allowedTypes: [...parsed.dns.allowedTypes],
      ...(parsed.dns.allowedSubtree ? { subtree: parsed.dns.allowedSubtree } : {}),
      defaultTtl: effectiveDefaultTtl(parsed.dns),
      allowApex: parsed.dns.allowApex,
    };
  }
  if (parsed.registrar) {
    if (mode === "conway") s.ignored.push("registrar: Conway mode buys domains through Conway");
    else s.registrar = { provider: parsed.registrar.provider, allowedTlds: [...parsed.registrar.allowedTlds] };
  }
  if (parsed.agentCard.publish) {
    if (s.ports === "proxy" || s.ports === "tunnel") s.agentCard = true;
    else if (!localCommands) s.ignored.push("agentCard: not supported in a Conway sandbox");
    else s.ignored.push("agentCard: needs ports in proxy or tunnel mode (a localhost card is useless)");
  }
  s.configured = s.ports === "proxy" || s.ports === "tunnel" || !!s.dns || !!s.registrar || s.agentCard;
  return s;
}
