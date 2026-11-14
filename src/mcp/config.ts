/**
 * MCP server configuration.
 *
 * Operator servers live in ~/.automaton/mcp-servers.json, which agent tools
 * can neither read nor write (secret and protected name, state dir). Servers
 * the agent installs are installed_tools rows and start only when the file
 * holds the operator's approval: the sha256 of the row's launch spec.
 *
 * Everything here is synchronous and never throws: a bad entry is skipped
 * with a warning and the rest still load.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expandHome, homeDir, stateDir } from "../security/protected-paths.js";
import { readRegularFileNoFollow } from "../security/secure-fs.js";
import { childProcessEnv } from "../security/child-env.js";
import { redactSecrets, registerSecret } from "../security/secret-redaction.js";

export const MCP_CONFIG_FILE = "mcp-servers.json";
const MAX_CONFIG_BYTES = 256 * 1024;

export const SERVER_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const REFUSED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "mcp-session-id"]);
const SHELL_METACHAR_RE = /[;|&$`\n(){}<>]/;

export const MCP_DEFAULTS = Object.freeze({
  callTimeoutMs: 60_000,
  maxCallTimeoutMs: 600_000,
  minCallTimeoutMs: 1_000,
  maxResultChars: 32_000,
  maxMaxResultChars: 50_000,
  maxToolsPerServer: 20,
  maxToolsGlobal: 40,
  callsPerHour: 120,
  maxCallsPerHour: 10_000,
});

export const AGENT_SERVER_LIMITS = Object.freeze({
  maxArgs: 16,
  maxArgLength: 256,
  maxEnv: 16,
  maxEnvValueBytes: 1024,
});

export interface McpToolFilter {
  allow?: string[];
  deny?: string[];
}

interface BaseSpec {
  name: string;
  origin: "operator" | "agent";
  enabled: boolean;
  callTimeoutMs: number;
  maxResultChars: number;
  maxTools: number;
  callsPerHour: number;
  tools: McpToolFilter;
  /** Hash of what decides the running process or session; a change restarts it. */
  specHash: string;
}

export interface StdioServerSpec extends BaseSpec {
  transport: "stdio";
  /** Absolute real path of the program to run. */
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** True when cwd is the runtime-owned default (created 0700 at spawn). */
  defaultCwd: boolean;
  /** Agent-installed rows: what the approval pinned. */
  agent?: { package: string; version: string; bin: string; contentHash: string };
}

export interface HttpServerSpec extends BaseSpec {
  transport: "http";
  url: string;
  headers: Record<string, string>;
  /** Operator-only: allows http:// and private or loopback addresses. */
  local: boolean;
}

export type McpServerSpec = StdioServerSpec | HttpServerSpec;

export interface LoadedMcpConfig {
  /** The file exists and was read. */
  present: boolean;
  enabled: boolean;
  maxTools: number;
  servers: McpServerSpec[];
  /** Operator approvals for agent-installed servers: name -> "sha256:<hex>". */
  agentApprovals: Map<string, string>;
  warnings: string[];
}

export function mcpConfigPath(): string {
  return path.join(stateDir(), MCP_CONFIG_FILE);
}

/** Default working directory of a stdio server: runtime-owned, not agent-writable. */
export function defaultServerCwd(name: string): string {
  return path.join(stateDir(), "mcp", name);
}

// ─── Canonical hashing ────────────────────────────────────────

/** JSON with object keys sorted at every level. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The value the operator puts in agentServers[name] to approve an agent row. */
export function agentServerApprovalHash(spec: {
  package: string;
  version: string;
  bin: string;
  contentHash: string;
  args: string[];
  env: Record<string, string>;
}): string {
  return sha256(
    canonicalJSON({
      package: spec.package,
      version: spec.version,
      bin: spec.bin,
      contentHash: spec.contentHash,
      args: spec.args,
      env: spec.env,
    }),
  );
}

export const PACKAGE_FINGERPRINT_LIMITS = Object.freeze({ maxEntries: 20_000, maxBytes: 256 * 1024 * 1024 });

/**
 * sha256 over every entry of an installed package tree (its node_modules
 * included): file contents, link targets (not followed) and directory names.
 * The approval pins this, so code swapped in after approval does not start.
 */
export function packageFingerprint(pkgDir: string): { error: string } | { hash: string } {
  const h = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  const walk = (rel: string): string | null => {
    const abs = rel ? path.join(pkgDir, rel) : pkgDir;
    let names: string[];
    try {
      names = fs.readdirSync(abs).sort();
    } catch (err) {
      return `cannot list ${rel || "."} (${(err as NodeJS.ErrnoException).code})`;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (++entries > PACKAGE_FINGERPRINT_LIMITS.maxEntries) return "has too many files to pin";
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(pkgDir, r));
      } catch (err) {
        return `cannot read ${r} (${(err as NodeJS.ErrnoException).code})`;
      }
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.readlinkSync(path.join(pkgDir, r));
        } catch (err) {
          return `cannot read ${r} (${(err as NodeJS.ErrnoException).code})`;
        }
        h.update(`l\0${r}\0${target}\0`);
      } else if (st.isDirectory()) {
        h.update(`d\0${r}\0`);
        const err = walk(r);
        if (err) return err;
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > PACKAGE_FINGERPRINT_LIMITS.maxBytes) return "is too large to pin";
        let fd: number;
        try {
          fd = fs.openSync(path.join(pkgDir, r), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        } catch (err) {
          return `cannot read ${r} (${(err as NodeJS.ErrnoException).code})`;
        }
        try {
          const content = fs.readFileSync(fd);
          // Mode matters: an executable bit can turn data into a program.
          h.update(`f\0${r}\0${st.mode & 0o777}\0${createHash("sha256").update(content).digest("hex")}\0`);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        return `${r} is not a file, directory or link`;
      }
    }
    return null;
  };
  const err = walk("");
  if (err) return { error: `the installed package ${err}` };
  return { hash: `sha256:${h.digest("hex")}` };
}

/** The installed package.json names this package at this exact version. */
export function readInstalledManifest(
  pkgDir: string,
  pkgName: string,
  root: string = pkgDir,
): { error: string } | { version: string; bin: unknown } {
  const raw = readRegularFileNoFollow(path.join(pkgDir, "package.json"), {
    root,
    maxBytes: 1024 * 1024,
    trusted: true,
  });
  if (raw === null) return { error: `${pkgName}/package.json could not be read safely` };
  let manifest: { version?: unknown; bin?: unknown; name?: unknown };
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { error: `${pkgName}/package.json is not valid JSON` };
  }
  if (!manifest || typeof manifest !== "object") return { error: `${pkgName}/package.json is not an object` };
  if (manifest.name !== pkgName) return { error: `${pkgName}/package.json names another package` };
  if (typeof manifest.version !== "string" || !EXACT_SEMVER_RE.test(manifest.version)) {
    return { error: `${pkgName} has no exact version` };
  }
  return { version: manifest.version, bin: manifest.bin };
}

/**
 * Before every spawn of an approved agent server: the package is still
 * where checkAgentPackageLocation wants it, at the approved version, with
 * the approved content. A tripwire: the same user can still race it.
 */
export function checkAgentPackageIntegrity(
  agent: { package: string; version: string; bin: string; contentHash: string },
  npmPrefix: string | null,
  opts: { content: boolean },
): { error: string } | { bin: string } {
  const loc = checkAgentPackageLocation(agent.package, agent.bin, npmPrefix);
  if ("error" in loc) return loc;
  if (loc.bin !== agent.bin) return { error: "its program moved since it was approved; reinstall it" };
  const manifest = readInstalledManifest(loc.pkgDir, agent.package);
  if ("error" in manifest) return manifest;
  if (manifest.version !== agent.version) {
    return {
      error: `the installed version is ${manifest.version}, not the approved ${agent.version}; reinstall it and approve again`,
    };
  }
  if (opts.content) {
    const fp = packageFingerprint(loc.pkgDir);
    if ("error" in fp) return fp;
    if (fp.hash !== agent.contentHash) {
      return { error: "its installed files changed since it was approved; reinstall it and approve again" };
    }
  }
  return { bin: loc.bin };
}

// ─── Agent-supplied values ────────────────────────────────────

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * An npm registry spec: `name` or `@scope/name`, optionally `@<exact semver>`.
 * Paths, URLs, git, file: and tarball specs are refused: npm would link or
 * unpack a directory the agent writes, and the approval would not pin it.
 */
export function parseRegistrySpec(spec: unknown): { name: string; version?: string } | null {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 260) return null;
  if (spec.startsWith(".") || spec.startsWith("/") || spec.includes("..") || spec.includes(":")) return null;
  const at = spec.lastIndexOf("@");
  let name = spec;
  let version: string | undefined;
  if (at > 0) {
    name = spec.slice(0, at);
    version = spec.slice(at + 1);
    if (!EXACT_SEMVER_RE.test(version)) return null;
  }
  if (name.length > 214 || !NPM_NAME_RE.test(name)) return null;
  return version ? { name, version } : { name };
}

const CREDENTIAL_NAME = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?)($|_)/i;
// Variables that make an interpreter or shell load code the agent wrote.
const LOADER_HIJACK_NAMES = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PATH",
  "HOME",
  "BASH_ENV",
  "ENV",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
]);
const LOADER_HIJACK_PREFIXES = ["LD_", "DYLD_", "GIT_", "NPM_CONFIG_"];

/** Why an env variable name may not be set by the agent, or null. */
export function agentEnvNameRefusal(name: string): string | null {
  if (!ENV_NAME_RE.test(name)) return `env name "${name}" is not a valid variable name`;
  const upper = name.toUpperCase();
  if (CREDENTIAL_NAME.test(name)) return `env name "${name}" looks like a credential`;
  if (LOADER_HIJACK_NAMES.has(upper) || LOADER_HIJACK_PREFIXES.some((p) => upper.startsWith(p))) {
    return `env name "${name}" changes how programs are loaded`;
  }
  return null;
}

/**
 * What an approval pins, for the operator to read before approving: the
 * program, its args and its env. Agent env values are never secrets (those
 * are refused at install).
 */
export function describeAgentLaunch(p: {
  bin: string;
  args: string[];
  env: Record<string, string>;
  contentHash?: string;
}): string {
  const files = p.contentHash ? `, package files ${p.contentHash}` : "";
  return `program ${p.bin}, args ${JSON.stringify(p.args)}, env ${JSON.stringify(p.env)}${files}`;
}

/** Validates agent args and env; returns an error or the clean values. */
export function validateAgentLaunchValues(
  args: unknown,
  env: unknown,
): { error: string } | { args: string[]; env: Record<string, string> } {
  const outArgs: string[] = [];
  if (args !== undefined) {
    if (!Array.isArray(args)) return { error: "args must be an array of strings" };
    if (args.length > AGENT_SERVER_LIMITS.maxArgs) return { error: `at most ${AGENT_SERVER_LIMITS.maxArgs} args` };
    for (const a of args) {
      if (typeof a !== "string") return { error: "args must be an array of strings" };
      if (a.length > AGENT_SERVER_LIMITS.maxArgLength) {
        return { error: `each arg is at most ${AGENT_SERVER_LIMITS.maxArgLength} characters` };
      }
      if (SHELL_METACHAR_RE.test(a)) return { error: `shell metacharacter in arg "${a.slice(0, 50)}"` };
      if (/[\x00-\x1f\x7f]/.test(a)) return { error: "control character in an arg" };
      outArgs.push(a);
    }
  }
  const outEnv: Record<string, string> = {};
  if (env !== undefined) {
    if (!env || typeof env !== "object" || Array.isArray(env)) return { error: "env must be an object of strings" };
    const entries = Object.entries(env as Record<string, unknown>);
    if (entries.length > AGENT_SERVER_LIMITS.maxEnv) return { error: `at most ${AGENT_SERVER_LIMITS.maxEnv} env entries` };
    for (const [k, v] of entries) {
      const why = agentEnvNameRefusal(k);
      if (why) return { error: why };
      if (typeof v !== "string") return { error: `env value of ${k} must be a string` };
      if (Buffer.byteLength(v) > AGENT_SERVER_LIMITS.maxEnvValueBytes) {
        return { error: `env value of ${k} is over ${AGENT_SERVER_LIMITS.maxEnvValueBytes} bytes` };
      }
      if (/[\x00]/.test(v)) return { error: `env value of ${k} contains a NUL character` };
      // A registered secret (wallet key, API keys, other servers' tokens) is
      // never handed to a server the agent chose.
      if (redactSecrets(v) !== v) return { error: `env value of ${k} contains a secret` };
      outEnv[k] = v;
    }
  }
  return { args: outArgs, env: outEnv };
}

// ─── Paths the agent can write ────────────────────────────────

let npmPrefixResolver: (() => Promise<string | null>) | null = null;
let npmPrefixCache: Promise<string | null> | null = null;

/** Test seam: replace how the npm global prefix is found (null restores npm). */
export function setNpmGlobalPrefixResolver(fn: (() => Promise<string | null>) | null): void {
  npmPrefixResolver = fn;
  npmPrefixCache = null;
}

/**
 * `npm prefix -g`, once per process, run from / with the scrubbed env so no
 * project .npmrc the agent wrote can move it. Null when npm is unavailable.
 */
export function npmGlobalPrefix(): Promise<string | null> {
  if (npmPrefixResolver) return npmPrefixResolver();
  if (!npmPrefixCache) {
    npmPrefixCache = new Promise((resolve) => {
      try {
        execFile(
          "npm",
          ["prefix", "-g"],
          { cwd: "/", env: childProcessEnv(), timeout: 10_000, maxBuffer: 64 * 1024 },
          (err, stdout) => {
            const out = String(stdout ?? "").trim();
            resolve(!err && path.isAbsolute(out) ? out : null);
          },
        );
      } catch {
        resolve(null);
      }
    });
  }
  return npmPrefixCache;
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function writableByUs(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories the agent can fill with programs: the state dir (workspace,
 * skills, runtime checkout), the npm global prefix's bin and module dirs when
 * this user can write them (install_npm_package runs npm install -g), and
 * the npx cache. exec can still write anywhere this user can; these are the
 * places the agent's own install tools put programs.
 */
export function agentWritableRoots(npmPrefix: string | null): string[] {
  const roots = [stateDir(), path.join(homeDir(), ".npm", "_npx")];
  if (npmPrefix) {
    for (const dir of [path.join(npmPrefix, "bin"), path.join(npmPrefix, "lib", "node_modules"), npmPrefix]) {
      if (writableByUs(dir)) roots.push(dir);
    }
  }
  const out = new Set<string>();
  for (const r of roots) {
    out.add(path.resolve(r));
    const real = tryRealpath(r);
    if (real) out.add(real);
  }
  return [...out];
}

/** The agent-writable root that contains realPath, or null. */
export function insideAgentWritableRoot(realPath: string, roots: string[]): string | null {
  return roots.find((r) => isWithin(realPath, r)) ?? null;
}

/**
 * An arg that names an existing regular file inside an agent-writable root
 * (a script given to an interpreter, a config the program loads): its real
 * path and the root, or null. Covers "--flag=<path>" and paths relative to cwd.
 */
export function argFileInAgentWritableRoot(
  args: string[],
  cwd: string,
  roots: string[],
): { arg: string; real: string; root: string } | null {
  for (const arg of args) {
    const values = [arg];
    const eq = arg.indexOf("=");
    if (arg.startsWith("-") && eq > 0) values.push(arg.slice(eq + 1));
    for (const v of values) {
      if (!v || v.startsWith("-") || v.includes("\0")) continue;
      const expanded = expandHome(v);
      const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
      let real: string;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        real = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      const root = insideAgentWritableRoot(real, roots);
      if (root) return { arg: v, real, root };
    }
  }
  return null;
}

/**
 * The interpreter programs a "#!" script runs through, as real paths: the
 * shebang program and, for "#!/usr/bin/env name", name looked up on envPath
 * (the PATH the server gets). Empty for a binary or an unresolvable name.
 */
export function shebangPrograms(command: string, envPath: string | undefined): string[] {
  let head: string;
  try {
    const fd = fs.openSync(command, fs.constants.O_RDONLY);
    try {
      const buf = Buffer.alloc(256);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("latin1");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  if (!head.startsWith("#!")) return [];
  const tokens = head.slice(2).split("\n")[0].trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const out: string[] = [];
  const interp = resolveCommand(tokens[0], envPath);
  if (interp) out.push(interp);
  if (path.basename(tokens[0]) === "env") {
    // env [-S] [-i] [NAME=value ...] program: the program comes from PATH.
    const name = tokens.slice(1).find((t) => !t.startsWith("-") && !t.includes("="));
    const real = name ? resolveCommand(name, envPath) : null;
    if (real) out.push(real);
  }
  return out;
}

/** Absolute real path of an executable: an absolute path, or a bare name looked up on PATH. */
export function resolveCommand(command: string, envPath: string | undefined = process.env.PATH): string | null {
  if (!command || /[\x00-\x1f]/.test(command)) return null;
  const candidates: string[] = [];
  if (command.includes("/")) {
    const expanded = expandHome(command);
    if (!path.isAbsolute(expanded)) return null;
    candidates.push(expanded);
  } else {
    for (const dir of (envPath ?? "").split(path.delimiter)) {
      if (dir && path.isAbsolute(dir)) candidates.push(path.join(dir, command));
    }
  }
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (!st.isFile()) continue;
      fs.accessSync(c, fs.constants.X_OK);
      return fs.realpathSync(c);
    } catch {
      // next candidate
    }
  }
  return null;
}

/**
 * The installed package dir must be a real directory at
 * <npm prefix>/lib/node_modules/<pkg> (not a link to a dir the agent writes)
 * and bin must resolve inside it, outside the agent-writable state dirs.
 * Checked at install and again before every spawn.
 */
export function checkAgentPackageLocation(
  pkgName: string,
  binPath: string,
  npmPrefix: string | null,
): { error: string } | { pkgDir: string; bin: string } {
  if (!npmPrefix) return { error: "the npm global prefix is unknown" };
  const nm = tryRealpath(path.join(npmPrefix, "lib", "node_modules"));
  if (!nm) return { error: "the npm global module directory does not exist" };
  const expected = path.join(nm, ...pkgName.split("/"));
  const realPkg = tryRealpath(expected);
  if (!realPkg || realPkg !== expected) {
    return { error: `${pkgName} is not a directory inside ${nm} (linked or missing)` };
  }
  const realBin = tryRealpath(binPath);
  if (!realBin || !isWithin(realBin, realPkg) || realBin === realPkg) {
    return { error: `the server program of ${pkgName} is not inside its package directory` };
  }
  const state = [stateDir(), tryRealpath(stateDir())].filter((x): x is string => !!x);
  for (const p of [realPkg, realBin]) {
    if (state.some((s) => isWithin(p, s))) return { error: `${pkgName} resolves into the state directory` };
  }
  return { pkgDir: realPkg, bin: realBin };
}

// ─── Operator file ────────────────────────────────────────────

const TOP_KEYS = new Set(["version", "enabled", "maxTools", "servers", "agentServers"]);
const COMMON_KEYS = ["enabled", "transport", "callTimeoutMs", "maxResultChars", "maxTools", "callsPerHour", "tools"];
const STDIO_KEYS = new Set([...COMMON_KEYS, "command", "args", "env", "cwd"]);
const HTTP_KEYS = new Set([...COMMON_KEYS, "url", "headers", "local"]);
const LAUNCHERS = new Set(["npx", "uvx", "pnpx", "bunx", "pipx"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function intIn(v: unknown, def: number, min: number, max: number): number | null {
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function stringList(v: unknown, max: number, maxLen: number): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || x.length > maxLen || x.includes("\0")) return null;
    out.push(x);
  }
  return out;
}

function stringMap(v: unknown, keyRe: RegExp, maxEntries: number): Record<string, string> | null {
  if (v === undefined) return {};
  if (!isPlainObject(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > maxEntries) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of entries) {
    if (!keyRe.test(k) || typeof val !== "string" || val.length > 32 * 1024 || val.includes("\0")) return null;
    out[k] = val;
  }
  return out;
}

function parseToolFilter(v: unknown): McpToolFilter | null {
  if (v === undefined) return {};
  if (!isPlainObject(v)) return null;
  for (const k of Object.keys(v)) if (k !== "allow" && k !== "deny") return null;
  const allow = v.allow === undefined ? undefined : stringList(v.allow, 200, 128);
  const deny = v.deny === undefined ? undefined : stringList(v.deny, 200, 128);
  if (allow === null || deny === null) return null;
  return { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
}

function registerServerSecret(value: string, server: string, key: string, warnings: string[]): void {
  if (value.trim().length < 16) {
    warnings.push(
      `MCP server "${server}": ${key} is shorter than 16 characters, so it cannot be redacted from logs and results.`,
    );
    return;
  }
  registerSecret(value, `mcp:${server}`);
}

const AUTH_SCHEME_RE = /^\s*(?:bearer|basic|token|apikey|api-key|key)\s+(\S+)\s*$/i;

/**
 * A header value like "Bearer <token>": the bare credential is what a server
 * echoes or the model copies, so it is registered on its own as well.
 */
function registerHeaderSecret(value: string, server: string, key: string, warnings: string[]): void {
  registerServerSecret(value, server, key, warnings);
  const scheme = AUTH_SCHEME_RE.exec(value);
  const parts = value.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? "";
  const credential = scheme?.[1] ?? (parts.length > 1 && last.length >= 16 ? last : undefined);
  if (credential && credential !== value) registerServerSecret(credential, server, `${key} credential`, warnings);
}

export interface LoadMcpConfigOptions {
  path?: string;
  /** npm global prefix, for the agent-writable check of secret-bearing commands. */
  npmPrefix?: string | null;
  /** PATH used to resolve bare command names (default process.env.PATH). */
  envPath?: string;
}

function emptyConfig(warnings: string[] = []): LoadedMcpConfig {
  return { present: false, enabled: false, maxTools: MCP_DEFAULTS.maxToolsGlobal, servers: [], agentApprovals: new Map(), warnings };
}

/** Read and validate the operator file. A missing file is an empty, disabled config. */
export function loadMcpConfig(opts: LoadMcpConfigOptions = {}): LoadedMcpConfig {
  const file = opts.path ?? mcpConfigPath();
  const warnings: string[] = [];
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return emptyConfig();
  }
  // Anyone else who can write it can make this runtime run their program
  // with the operator's tokens.
  if ((st.mode & 0o022) !== 0) {
    warnings.push(`${file} is group- or world-writable; MCP servers are not loaded (chmod 600 it).`);
    return emptyConfig(warnings);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    warnings.push(`${file} is not owned by the runtime user; MCP servers are not loaded.`);
    return emptyConfig(warnings);
  }
  const raw = readRegularFileNoFollow(file, { root: path.dirname(file), maxBytes: MAX_CONFIG_BYTES, trusted: true });
  if (raw === null) {
    warnings.push(`${file} could not be read safely (link, size or type); MCP servers are not loaded.`);
    return emptyConfig(warnings);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    warnings.push(`${file} is not valid JSON (${(err as Error).message}); MCP servers are not loaded.`);
    return emptyConfig(warnings);
  }
  if (!isPlainObject(doc)) {
    warnings.push(`${file} must hold a JSON object; MCP servers are not loaded.`);
    return emptyConfig(warnings);
  }
  if (doc.version !== 1) {
    warnings.push(`${file}: "version" must be 1; MCP servers are not loaded.`);
    return emptyConfig(warnings);
  }
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) warnings.push(`${file}: unknown key "${k}" ignored.`);
  }
  const enabled = doc.enabled === undefined ? true : doc.enabled === true;
  if (doc.enabled !== undefined && typeof doc.enabled !== "boolean") {
    warnings.push(`${file}: "enabled" must be true or false; MCP is off.`);
  }
  const maxTools = intIn(doc.maxTools, MCP_DEFAULTS.maxToolsGlobal, 0, 128);
  const out: LoadedMcpConfig = {
    present: true,
    enabled,
    maxTools: maxTools ?? MCP_DEFAULTS.maxToolsGlobal,
    servers: [],
    agentApprovals: new Map(),
    warnings,
  };
  if (maxTools === null) warnings.push(`${file}: "maxTools" must be an integer; using ${MCP_DEFAULTS.maxToolsGlobal}.`);

  if (doc.agentServers !== undefined) {
    if (!isPlainObject(doc.agentServers)) {
      warnings.push(`${file}: "agentServers" must be an object; no agent server is approved.`);
    } else {
      for (const [name, hash] of Object.entries(doc.agentServers)) {
        if (!SERVER_NAME_RE.test(name) || typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
          warnings.push(`${file}: agentServers entry "${name.slice(0, 40)}" is not a valid approval; ignored.`);
          continue;
        }
        out.agentApprovals.set(name, hash);
      }
    }
  }

  if (doc.servers !== undefined && !isPlainObject(doc.servers)) {
    warnings.push(`${file}: "servers" must be an object; no operator server is loaded.`);
    return out;
  }
  const roots = agentWritableRoots(opts.npmPrefix ?? null);
  for (const [name, entry] of Object.entries((doc.servers as Record<string, unknown>) ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const spec = parseOperatorServer(name, entry, { roots, envPath: opts.envPath, warnings });
    if (spec) out.servers.push(spec);
  }
  return out;
}

function parseOperatorServer(
  name: string,
  entry: unknown,
  ctx: { roots: string[]; envPath?: string; warnings: string[] },
): McpServerSpec | null {
  const skip = (why: string): null => {
    ctx.warnings.push(`MCP server "${name.slice(0, 40)}" skipped: ${why}.`);
    return null;
  };
  if (!SERVER_NAME_RE.test(name)) return skip(`its name must match ${SERVER_NAME_RE.source}`);
  if (!isPlainObject(entry)) return skip("its entry must be an object");
  const transport = entry.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "http") return skip(`unknown transport "${String(transport).slice(0, 20)}"`);
  const allowed = transport === "stdio" ? STDIO_KEYS : HTTP_KEYS;
  const unknown = Object.keys(entry).filter((k) => !allowed.has(k));
  if (unknown.length > 0) return skip(`unknown key(s) ${unknown.map((k) => `"${k.slice(0, 30)}"`).join(", ")}`);
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") return skip(`"enabled" must be true or false`);

  const callTimeoutMs = intIn(entry.callTimeoutMs, MCP_DEFAULTS.callTimeoutMs, MCP_DEFAULTS.minCallTimeoutMs, MCP_DEFAULTS.maxCallTimeoutMs);
  const maxResultChars = intIn(entry.maxResultChars, MCP_DEFAULTS.maxResultChars, 1_000, MCP_DEFAULTS.maxMaxResultChars);
  const maxTools = intIn(entry.maxTools, MCP_DEFAULTS.maxToolsPerServer, 0, 128);
  const callsPerHour = intIn(entry.callsPerHour, MCP_DEFAULTS.callsPerHour, 0, MCP_DEFAULTS.maxCallsPerHour);
  if (callTimeoutMs === null || maxResultChars === null || maxTools === null || callsPerHour === null) {
    return skip("callTimeoutMs, maxResultChars, maxTools and callsPerHour must be integers");
  }
  const tools = parseToolFilter(entry.tools);
  if (!tools) return skip(`"tools" must be {allow?: string[], deny?: string[]}`);
  const base = {
    name,
    origin: "operator" as const,
    enabled: entry.enabled !== false,
    callTimeoutMs,
    maxResultChars,
    maxTools,
    callsPerHour,
    tools,
  };

  if (transport === "stdio") {
    if (typeof entry.command !== "string" || !entry.command) return skip(`"command" is required`);
    const args = stringList(entry.args, 64, 4096);
    if (!args) return skip(`"args" must be an array of strings`);
    const env = stringMap(entry.env, ENV_NAME_RE, 64);
    if (!env) return skip(`"env" must map variable names to strings`);
    let cwd = defaultServerCwd(name);
    let defaultCwd = true;
    if (entry.cwd !== undefined) {
      if (typeof entry.cwd !== "string" || !path.isAbsolute(expandHome(entry.cwd))) return skip(`"cwd" must be an absolute path`);
      cwd = path.resolve(expandHome(entry.cwd));
      defaultCwd = cwd === defaultServerCwd(name);
    }
    const command = resolveCommand(entry.command, ctx.envPath);
    if (!command) return skip(`command "${entry.command.slice(0, 80)}" was not found or is not executable`);
    const base0 = path.basename(command);
    if (LAUNCHERS.has(path.basename(entry.command)) || LAUNCHERS.has(base0)) {
      ctx.warnings.push(
        `MCP server "${name}" runs through ${path.basename(entry.command)}, which fetches code when it starts; ` +
          "pin an exact version or install the server and give its path.",
      );
    }
    // A server that holds the operator's tokens must not run a program the
    // agent can replace or shadow on PATH.
    if (Object.keys(env).length > 0) {
      const root = insideAgentWritableRoot(command, ctx.roots);
      if (root) {
        return skip(
          `its command resolves to ${command}, inside ${root}, which the agent can write, and the server gets env secrets; ` +
            "install it outside that directory and give the absolute path",
        );
      }
      // A "#!/usr/bin/env node" script runs whatever node its PATH finds first.
      for (const prog of shebangPrograms(command, env.PATH ?? ctx.envPath ?? process.env.PATH)) {
        const r = insideAgentWritableRoot(prog, ctx.roots);
        if (r) {
          return skip(
            `its command runs through ${prog}, inside ${r}, which the agent can write, and the server gets env secrets; ` +
              "give an interpreter outside that directory as the command and the script as its argument",
          );
        }
      }
      // "node /path/to/index.js": the script is the program as much as node is.
      const file = argFileInAgentWritableRoot(args, cwd, ctx.roots);
      if (file) {
        return skip(
          `its argument ${file.arg.slice(0, 120)} resolves to ${file.real}, inside ${file.root}, which the agent can write, ` +
            "and the server gets env secrets; install it outside that directory and give the absolute path",
        );
      }
    }
    for (const [k, v] of Object.entries(env)) registerServerSecret(v, name, `env ${k}`, ctx.warnings);
    const specHash = sha256(canonicalJSON({ transport, command, args, env, cwd }));
    return { ...base, transport: "stdio", command, args, env, cwd, defaultCwd, specHash };
  }

  if (typeof entry.url !== "string") return skip(`"url" is required`);
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return skip(`"url" is not a valid URL`);
  }
  if (entry.local !== undefined && typeof entry.local !== "boolean") return skip(`"local" must be true or false`);
  const local = entry.local === true;
  if (url.username || url.password) return skip("the URL carries credentials; use headers");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return skip(`scheme ${url.protocol} is allowed only with "local": true`);
  }
  if (url.hash) return skip("the URL has a fragment");
  const headers = stringMap(entry.headers, HEADER_NAME_RE, 32);
  if (!headers) return skip(`"headers" must map header names to strings`);
  for (const [k, v] of Object.entries(headers)) {
    if (REFUSED_HEADERS.has(k.toLowerCase())) return skip(`header "${k}" is set by the runtime`);
    if (/[\r\n]/.test(v)) return skip(`header "${k}" contains a line break`);
  }
  for (const [k, v] of Object.entries(headers)) registerHeaderSecret(v, name, `header ${k}`, ctx.warnings);
  for (const [k, v] of url.searchParams) registerServerSecret(v, name, `URL parameter ${k}`, ctx.warnings);
  const specHash = sha256(canonicalJSON({ transport, url: url.toString(), headers, local }));
  return { ...base, transport: "http", url: url.toString(), headers, local, specHash };
}

// ─── Agent rows ───────────────────────────────────────────────

export interface AgentRowLike {
  id: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  enabled: boolean;
}

export interface AgentRowResolution {
  spec?: StdioServerSpec;
  /** Why the row does not start (logged once). */
  skip?: string;
}

/**
 * Turn an agent-installed row into a launch spec, or say why it does not
 * start. Starts only when the operator's approval equals the row's hash.
 */
export function resolveAgentRow(
  row: AgentRowLike,
  ctx: { approvals: Map<string, string>; operatorNames: Set<string>; localExec: boolean; npmPrefix: string | null },
): AgentRowResolution {
  const name = row.name;
  const cfg = row.config ?? {};
  if (!SERVER_NAME_RE.test(name)) return { skip: `its name must match ${SERVER_NAME_RE.source}; reinstall it` };
  if (ctx.operatorNames.has(name)) return { skip: "an operator server has the same name" };
  if (cfg.installedBy !== "agent" || cfg.transport !== "stdio" || typeof cfg.bin !== "string") {
    return { skip: "it was installed before MCP execution existed; reinstall it with install_mcp_server" };
  }
  const parsed = parseRegistrySpec(cfg.package);
  if (!parsed || parsed.version || typeof cfg.version !== "string" || !EXACT_SEMVER_RE.test(cfg.version)) {
    return { skip: "its package or version is not a registry name and exact version; reinstall it" };
  }
  if (typeof cfg.contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(cfg.contentHash)) {
    return { skip: "it has no pinned content hash; reinstall it with install_mcp_server" };
  }
  const launch = validateAgentLaunchValues(cfg.args ?? [], cfg.env ?? {});
  if ("error" in launch) return { skip: `${launch.error}; reinstall it` };
  const agent = { package: parsed.name, version: cfg.version, bin: cfg.bin, contentHash: cfg.contentHash };
  const hash = agentServerApprovalHash({ ...agent, args: launch.args, env: launch.env });
  if (ctx.approvals.get(name) !== hash) {
    return {
      skip:
        `it is not approved. It runs ${parsed.name}@${cfg.version} (${describeAgentLaunch({ bin: cfg.bin, contentHash: cfg.contentHash, ...launch })}) ` +
        "with the runtime user's file and network access. " +
        `To approve it, add to "agentServers" in ${mcpConfigPath()}: "${name}": "${hash}"`,
    };
  }
  // exec and npm install -g happen in the remote sandbox there; a local
  // process would escape it.
  if (!ctx.localExec) return { skip: "agent-installed servers run only where exec runs (local sandbox)" };
  // The content hash is checked before each spawn (manager), not on every refresh.
  const loc = checkAgentPackageIntegrity(agent, ctx.npmPrefix, { content: false });
  if ("error" in loc) return { skip: loc.error };
  return {
    spec: {
      name,
      origin: "agent",
      enabled: row.enabled !== false,
      callTimeoutMs: MCP_DEFAULTS.callTimeoutMs,
      maxResultChars: MCP_DEFAULTS.maxResultChars,
      maxTools: MCP_DEFAULTS.maxToolsPerServer,
      callsPerHour: MCP_DEFAULTS.callsPerHour,
      tools: {},
      transport: "stdio",
      // npm servers are node programs; running them with this node avoids a
      // `#!/usr/bin/env node` lookup on a PATH the agent can extend.
      command: process.execPath,
      args: [loc.bin, ...launch.args],
      env: launch.env,
      cwd: defaultServerCwd(name),
      defaultCwd: true,
      agent,
      specHash: hash,
    },
  };
}

/**
 * The program an installed npm package runs as its server: the single bin,
 * or the one named after the package. Read from the global module dir with
 * no link following; the result must pass checkAgentPackageLocation.
 */
export async function resolveInstalledMcpBin(
  pkgName: string,
): Promise<{ error: string } | { bin: string; version: string; contentHash: string }> {
  const prefix = await npmGlobalPrefix();
  if (!prefix) return { error: "the npm global prefix is unknown" };
  const nm = tryRealpath(path.join(prefix, "lib", "node_modules"));
  if (!nm) return { error: "the npm global module directory does not exist" };
  const pkgDir = path.join(nm, ...pkgName.split("/"));
  const manifest = readInstalledManifest(pkgDir, pkgName, nm);
  if ("error" in manifest) return manifest;
  let rel: string | null = null;
  if (typeof manifest.bin === "string") rel = manifest.bin;
  else if (isPlainObject(manifest.bin)) {
    const entries = Object.entries(manifest.bin).filter(([, v]) => typeof v === "string") as [string, string][];
    const unscoped = pkgName.split("/").pop()!;
    if (entries.length === 1) rel = entries[0][1];
    else rel = entries.find(([k]) => k === unscoped || k === pkgName)?.[1] ?? null;
  }
  if (!rel) return { error: `${pkgName} has no single program (bin) to run` };
  const loc = checkAgentPackageLocation(pkgName, path.resolve(pkgDir, rel), prefix);
  if ("error" in loc) return loc;
  const fp = packageFingerprint(loc.pkgDir);
  if ("error" in fp) return fp;
  return { bin: loc.bin, version: manifest.version, contentHash: fp.hash };
}
