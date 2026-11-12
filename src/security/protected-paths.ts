/**
 * Protected and sensitive paths: the single definition.
 *
 * "Sensitive" paths must not be read by the agent's tools. "Protected" paths
 * must not be written by them (a superset of sensitive). Every reader and
 * writer resolves the real path and asks this module, so a symlink, a parent
 * directory symlink or a hard link cannot carry a request past the rules.
 *
 * Everything here is synchronous (PolicyEngine.evaluate is synchronous) and
 * never throws: each check returns a decision, and any fs error is a denial.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Access = "read" | "write";
export type DenyCode =
  | "SENSITIVE_FILE"
  | "PROTECTED_FILE"
  | "SYMLINK"
  | "HARDLINK"
  | "NOT_REGULAR"
  | "OUTSIDE_ROOT"
  | "UNRESOLVABLE";

export interface PathDecision {
  ok: boolean;
  code?: DenyCode;
  /** Which rule matched, e.g. "state-dir:not-allowlisted". */
  rule?: string;
  /** Human message; never includes file contents. */
  reason?: string;
  /** Absolute lexical path. */
  requested: string;
  /** Real path (or resolved parent + basename for a file that does not exist yet). */
  real?: string;
  /** checkRead: identity of the file that was checked, when it existed. */
  dev?: number;
  ino?: number;
}

// ─── Locations ────────────────────────────────────────────────

/** Read on every call: tests swap HOME. */
export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

export function stateDir(): string {
  return path.join(homeDir(), ".automaton");
}

const RUNTIME_PACKAGE_NAME = "@conway/automaton";
let cachedRuntimeRoot: string | null = null;
let cachedRealRuntimeRoot: string | null = null;

function readPackageName(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

/** The checkout this code runs from: the nearest ancestor whose package.json is the runtime's. */
export function runtimeRoot(): string {
  if (cachedRuntimeRoot) return cachedRuntimeRoot;
  let found: string | null = null;
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 20; i++) {
      if (readPackageName(dir) === RUNTIME_PACKAGE_NAME) {
        found = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    found = null;
  }
  cachedRuntimeRoot = found ?? process.cwd();
  return cachedRuntimeRoot;
}

function realRuntimeRoot(): string {
  if (cachedRealRuntimeRoot) return cachedRealRuntimeRoot;
  try {
    cachedRealRuntimeRoot = fs.realpathSync(runtimeRoot());
  } catch {
    cachedRealRuntimeRoot = runtimeRoot();
  }
  return cachedRealRuntimeRoot;
}

/** Expands "~" and "~/x" only. */
export function expandHome(p: string, home: string = homeDir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

// ─── Lexical helpers ──────────────────────────────────────────

const CODE_EXT = /\.(?:d\.ts|ts|tsx|js|jsx|mjs|cjs)$/i;

function segmentsOf(absPath: string): string[] {
  const normalized = path.posix.normalize(absPath.replace(/\\/g, "/").toLowerCase());
  return normalized.split("/").filter((s) => s.length > 0 && s !== ".");
}

function stemOf(segment: string): string {
  return segment.replace(CODE_EXT, "");
}

function startsWithSegments(segs: string[], prefix: string[]): boolean {
  if (prefix.length > segs.length) return false;
  return prefix.every((p, i) => segs[i] === p);
}

/** Pattern "a/b" matches a run of whole segments (by name or code stem); "a/b/**" also matches below it. */
function matchesSegmentPattern(segs: string[], pattern: string): boolean {
  const parts = pattern.replace(/\/\*\*$/, "").split("/");
  const stems = segs.map(stemOf);
  for (let i = 0; i + parts.length <= segs.length; i++) {
    if (parts.every((part, j) => segs[i + j] === part || stems[i + j] === part)) return true;
  }
  return false;
}

// ─── Read-deny rules ──────────────────────────────────────────

const SECRET_NAMES = new Set([
  "wallet.json",
  "automaton.json",
  "config.json",
  ".env",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "state.db-journal",
]);

const ENV_EXAMPLE_NAMES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

const SECRET_NAME_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /^wallet\.json\..+/, label: "wallet-backup" },
  { re: /^automaton\.json\..+/, label: "config-backup" },
  { re: /^\.env\..+/, label: "env-file" },
  { re: /\.(?:key|pem|p12|pfx|jks|keystore)$/, label: "key-file" },
  { re: /^private-key/, label: "private-key" },
  { re: /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.(?!pub$).+)?$/, label: "ssh-key" },
  { re: /_history$/, label: "shell-history" },
];

const SECRET_DIRS = new Set([
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  ".password-store",
]);

const SECRET_DIR_PAIRS = [".config/solana", ".config/gcloud", ".config/gh", ".local/share/keyrings"];

const SYSTEM_READ_PREFIXES = ["/proc", "/sys", "/dev", "/run/secrets", "/var/run/secrets", "/etc/sudoers.d"];
const SYSTEM_READ_FILES = new Set(["/etc/shadow", "/etc/gshadow", "/etc/sudoers"]);

const STATE_READ_FILES = new Set([
  "soul.md",
  "worklog.md",
  "heartbeat.yml",
  "constitution.md",
  "genesis.json",
  "agent-card.json",
]);
const STATE_READ_DIRS = new Set(["logs", "skills", "workspace", "runtime"]);
// The runtime checkout (installer default ~/.automaton/runtime) is governed by
// the checkout rules below, so the agent can still edit its non-guard source.
// skills/** stays writable because write_file of a SKILL.md is equivalent to
// create_skill; the loader accepts only plain regular files, and clones into
// the skills dir are denied by the git_clone rule.
const STATE_WRITE_FILES = new Set(["worklog.md"]);
const STATE_WRITE_DIRS = new Set(["workspace", "skills", "runtime"]);

function hasPrefix(normalized: string, prefix: string): boolean {
  return normalized === prefix || normalized.startsWith(prefix + "/");
}

function normalizedAbs(absPath: string): string {
  return "/" + segmentsOf(absPath).join("/");
}

// Files this process holds POSIX locks on (the instance lock, the state
// database). Closing any descriptor on such a file in this process drops
// those locks, so they are denied wherever they live and whatever their name.
const runtimeFiles = new Set<string>(); // normalized, for matching
const runtimeFilePaths = new Set<string>(); // as given, for the inode check

/** Deny reads and writes of absPath (and its realpath) for the rest of this process. */
export function protectRuntimeFile(absPath: string): void {
  const lexical = path.resolve(expandHome(absPath));
  const parent = tryRealpath(path.dirname(lexical));
  const real = tryRealpath(lexical) ?? (parent ? path.join(parent, path.basename(lexical)) : null);
  for (const p of real ? [lexical, real] : [lexical]) {
    runtimeFiles.add(normalizedAbs(p));
    runtimeFilePaths.add(p);
  }
}

/** Secret file names, secret directories and system paths. No state-dir rule. */
export function matchSecret(absPath: string): string | null {
  if (runtimeFiles.size > 0 && runtimeFiles.has(normalizedAbs(absPath))) return "runtime-lock";
  const segs = segmentsOf(absPath);
  const base = segs[segs.length - 1] ?? "";
  if (SECRET_NAMES.has(base)) return `secret-name:${base}`;
  for (const { re, label } of SECRET_NAME_PATTERNS) {
    if (label === "env-file" && ENV_EXAMPLE_NAMES.has(base)) continue;
    if (re.test(base)) return `secret-name:${label}`;
  }
  for (const seg of segs) {
    if (SECRET_DIRS.has(seg)) return `secret-dir:${seg}`;
  }
  for (const pair of SECRET_DIR_PAIRS) {
    if (matchesSegmentPattern(segs, pair)) return `secret-dir:${pair}`;
  }
  const norm = normalizedAbs(absPath);
  if (norm !== "/dev/null") {
    for (const prefix of SYSTEM_READ_PREFIXES) {
      if (hasPrefix(norm, prefix)) return `system:${prefix}`;
    }
  }
  if (SYSTEM_READ_FILES.has(norm)) return `system:${norm}`;
  return null;
}

/** Each ".automaton" segment anchors a state directory; returns the segments below each anchor. */
function stateDirRemainders(segs: string[]): string[][] {
  const out: string[][] = [];
  segs.forEach((seg, i) => {
    if (seg === ".automaton") out.push(segs.slice(i + 1));
  });
  return out;
}

function stateReadAllowed(rest: string[]): boolean {
  if (rest.length === 0) return true; // the directory itself (listing names only)
  const first = rest[0];
  if (STATE_READ_DIRS.has(first)) return true;
  if (rest.length === 1 && (STATE_READ_FILES.has(first) || first.endsWith(".log"))) return true;
  return false;
}

function stateWriteAllowed(rest: string[]): boolean {
  if (rest.length === 0) return false;
  const first = rest[0];
  if (STATE_WRITE_DIRS.has(first) && rest.length > 1) return true;
  if (rest.length === 1 && STATE_WRITE_FILES.has(first)) return true;
  return false;
}

/** Read-deny. Lexical, no fs. Returns the matching rule id or null. */
export function matchSensitive(absPath: string): string | null {
  const secret = matchSecret(absPath);
  if (secret) return secret;
  for (const rest of stateDirRemainders(segmentsOf(absPath))) {
    if (!stateReadAllowed(rest)) return "state-dir:not-allowlisted";
  }
  return null;
}

// ─── Write-deny rules ─────────────────────────────────────────

const PROTECTED_NAMES = new Set([
  "wallet.json",
  "config.json",
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "state.db-journal",
  "constitution.md",
  "automaton.json",
  "package.json",
  "soul.md",
  "injection-defense.ts",
  "injection-defense.js",
  "injection-defense.d.ts",
  "heartbeat.yml",
  "inference-providers.json",
]);

const HOME_STARTUP_FILES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".npmrc",
  ".gitconfig",
]);
const HOME_STARTUP_DIRS = [[".config", "git"], [".local", "bin"], ["bin"]];

const SYSTEM_WRITE_PREFIXES = [
  "/etc",
  "/usr",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/bin",
  "/sbin",
  "/boot",
  "/var/spool/cron",
];

/**
 * Guard code, matched on whole segments anywhere in a path. Only names
 * distinctive to this runtime, so a copy of the tree is protected too while
 * ordinary projects are not.
 */
export const GUARD_SURFACE: readonly string[] = Object.freeze([
  "agent/policy-engine",
  "agent/policy-rules/**",
  "agent/spend-tracker",
  "agent/injection-defense",
  "agent/inbox-isolation",
  "agent/tools",
  "agent/harness-types",
  "agent/harness-registry",
  "self-mod/**",
  "skills/loader",
  "skills/registry",
  "security/protected-paths",
  "security/secure-fs",
  "security/child-env",
  "security/secret-redaction",
]);

/**
 * Guard code with names common in other projects (agent/loop, soul/model,
 * heartbeat/config ...). Matched only inside an automaton checkout, so a
 * worker project in the workspace can use the same layout.
 */
const CHECKOUT_GUARD_SURFACE: readonly string[] = Object.freeze([
  "agent/loop",
  "agent/system-prompt",
  "agent/harnesses/**",
  "skills/format",
  "orchestration/local-worker",
  // Labels orchestrator child funding for the treasury's automatic-funding limits.
  "orchestration/simple-tracker",
  "inference/provider-registry",
  "inference/inference-client",
  "inference/budget",
  // The inference spend gate and the paths that must pass through it.
  "inference/gate",
  "inference/policy",
  "inference/errors",
  "inference/router",
  // Model prices the inference gate charges.
  "inference/registry",
  "observability/logger",
  "soul/validator",
  "soul/tools",
  "soul/model",
  "heartbeat/config",
  "heartbeat/tasks",
  // Balance snapshot the heartbeat's topup and survival decisions read.
  "heartbeat/tick-context",
  // The operator CLI signs and moves the operator's money.
  "packages/cli/src/commands/fund",
  "packages/cli/src/commands/send",
  "audit-log",
  // Signs ERC-8004 transactions with the wallet key (gas paid in ETH).
  "registry/erc8004",
  // Helpers guard code decides with: injection-defense folds text with
  // text-normalize; the logger and the operator CLI escape with terminal-safe.
  "agent/text-normalize",
  "observability/terminal-safe",
]);

/**
 * Guard code whose names are generic (src/index.ts, src/config.ts, src/git/...).
 * Matched only inside an automaton checkout, so ordinary projects are not blocked.
 */
const CHECKOUT_GUARD_DIRS = new Set([
  "security",
  "treasury",
  "conway",
  "identity",
  "git",
  "state",
  "replication",
  "survival",
  "operator",
]);
const CHECKOUT_GUARD_FILES = new Set(["index", "types", "config"]);
// packages/ holds the workspace packages the root build compiles after the
// runtime (`tsc && pnpm -r build`): the operator CLI's built commands, their
// tsconfig (whose outDir can point at the protected dist/) and node_modules/.bin
// shims the build runs. All of it is a build input or operator code.
const CHECKOUT_ROOT_DIRS = new Set(["dist", "node_modules", ".git", "scripts", "packages"]);
const CHECKOUT_ROOT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  // Workspace layout and install hooks: both decide what the build runs.
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  ".gitignore",
  "constitution.md",
]);

/** Rules for a path relative to the root of an automaton checkout. */
function matchCheckoutRelative(rel: string[]): string | null {
  if (rel.length === 0) return null;
  for (const pattern of CHECKOUT_GUARD_SURFACE) {
    if (matchesSegmentPattern(rel, pattern)) return `guard:${pattern}`;
  }
  if (CHECKOUT_ROOT_DIRS.has(rel[0])) return `runtime:${rel[0]}`;
  if (rel.length === 1 && (CHECKOUT_ROOT_FILES.has(rel[0]) || /^tsconfig.*\.json$/.test(rel[0]))) {
    return `runtime:${rel[0]}`;
  }
  for (let i = 0; i + 1 < rel.length; i++) {
    if (rel[i] !== "src" && rel[i] !== "dist") continue;
    const next = rel[i + 1];
    if (CHECKOUT_GUARD_DIRS.has(next) && rel.length > i + 2) return `guard:${rel[i]}/${next}`;
    if (rel.length === i + 2 && CHECKOUT_GUARD_FILES.has(stemOf(next))) return `guard:${rel[i]}/${stemOf(next)}`;
  }
  return null;
}

/** Checkout roots known without touching the fs: this runtime and ~/.automaton/runtime. */
function lexicalCheckoutRemainders(segs: string[]): string[][] {
  const out: string[][] = [];
  for (const root of new Set([runtimeRoot(), realRuntimeRoot()])) {
    const rootSegs = segmentsOf(root);
    if (startsWithSegments(segs, rootSegs)) out.push(segs.slice(rootSegs.length));
  }
  segs.forEach((seg, i) => {
    if (seg === ".automaton" && segs[i + 1] === "runtime") out.push(segs.slice(i + 2));
  });
  return out;
}

function matchHomeStartup(segs: string[]): string | null {
  for (const home of new Set([homeDir(), "/root"])) {
    const homeSegs = segmentsOf(home);
    if (!startsWithSegments(segs, homeSegs)) continue;
    const rel = segs.slice(homeSegs.length);
    if (rel.length === 1 && HOME_STARTUP_FILES.has(rel[0])) return `home-startup:${rel[0]}`;
    for (const dir of HOME_STARTUP_DIRS) {
      if (rel.length > dir.length && startsWithSegments(rel, dir)) return `home-startup:${dir.join("/")}`;
    }
  }
  return null;
}

/**
 * A directory target (git clone) that is a home, or a home startup directory
 * or one of its parents: the clone would create it and fill it with the
 * repository's files (git's global config, executables on PATH).
 */
export function matchHomeStartupContainer(absPath: string): string | null {
  const segs = segmentsOf(absPath);
  for (const home of new Set([homeDir(), "/root"])) {
    const homeSegs = segmentsOf(home);
    if (!startsWithSegments(segs, homeSegs)) continue;
    const rel = segs.slice(homeSegs.length);
    if (rel.length === 0) return "home-startup:home";
    for (const dir of HOME_STARTUP_DIRS) {
      if (startsWithSegments(dir, rel)) return `home-startup:${dir.join("/")}`;
    }
  }
  return null;
}

/** Write-deny. Lexical, no fs. A superset of matchSensitive. */
export function matchProtected(absPath: string): string | null {
  const secret = matchSecret(absPath);
  if (secret) return secret;
  const segs = segmentsOf(absPath);
  for (const rest of stateDirRemainders(segs)) {
    if (!stateWriteAllowed(rest)) return "state-dir:not-writable";
  }
  const base = segs[segs.length - 1] ?? "";
  if (PROTECTED_NAMES.has(base)) return `protected-name:${base}`;
  const startup = matchHomeStartup(segs);
  if (startup) return startup;
  const norm = "/" + segs.join("/");
  for (const prefix of SYSTEM_WRITE_PREFIXES) {
    if (hasPrefix(norm, prefix)) return `system:${prefix}`;
  }
  for (const pattern of GUARD_SURFACE) {
    if (matchesSegmentPattern(segs, pattern)) return `guard:${pattern}`;
  }
  for (const rel of lexicalCheckoutRemainders(segs)) {
    const rule = matchCheckoutRelative(rel);
    if (rule) return rule;
  }
  return null;
}

// ─── Exec tripwire fragments ──────────────────────────────────

/**
 * Fragments that name secrets, matched against a normalised command
 * (lower-cased, quotes and backslashes removed, home spelled "~").
 */
export const SENSITIVE_COMMAND_FRAGMENTS: readonly { re: RegExp; label: string }[] = Object.freeze([
  { re: /wallet\.(?!(?:d\.ts|ts|tsx|js|jsx|mjs|cjs|py|rs|go|sol|md)\b)/, label: "wallet file" },
  { re: /wallet[*?[]/, label: "wallet glob" },
  { re: /automaton\.json/, label: "automaton.json" },
  { re: /state\.db/, label: "state database" },
  { re: /inference-providers/, label: "provider config" },
  { re: /(?:^|[^a-z0-9_])\.ssh(?:$|[^a-z0-9_])/, label: "SSH directory" },
  { re: /id_(?:rsa|ed25519|ecdsa|dsa)/, label: "SSH key" },
  { re: /\.gnupg/, label: "GPG keys" },
  { re: /\.config\/solana/, label: "Solana keypair" },
  { re: /\/proc\/self\//, label: "process memory or environment" },
  { re: /\/proc\/thread-self\//, label: "process memory or environment" },
  { re: /\/proc\/[^\s/]+\/(?:environ|mem|cmdline|maps)/, label: "process memory or environment" },
]);

/**
 * Guard-file fragments for the write-verb tripwire. Only names distinctive to
 * this runtime: generic ones such as src/index would block ordinary projects.
 */
export const GUARD_COMMAND_FRAGMENTS: readonly string[] = Object.freeze([
  "policy-engine",
  "policy-rules",
  "injection-defense",
  "spend-tracker",
  "inbox-isolation",
  "self-mod/",
  "agent/harnesses",
  "agent/tools.ts",
  "agent/tools.js",
  "agent/loop.ts",
  "agent/loop.js",
  "orchestration/local-worker",
  "inference/provider-registry",
  "inference/inference-client",
  "inference/budget",
  "inference/gate",
  "inference/policy",
  "inference/errors",
  "inference/router",
  // Model prices the inference gate charges.
  "inference/registry",
  "conway/inference",
  "conway/http-client",
  "security/protected-paths",
  "security/secure-fs",
  "security/child-env",
  "security/secret-redaction",
  // The spending gate and the payment primitives it wraps.
  "treasury/treasury",
  "treasury/guarded-conway",
  "treasury/ledger",
  "treasury/policy",
  "treasury/registry",
  "conway/client",
  "conway/x402",
  "conway/topup",
  "conway/balance",
  "conway/transfer-status",
  "registry/erc8004",
  "heartbeat/tick-context",
  "operator/fund",
  "operator/send",
  "orchestration/simple-tracker",
  "heartbeat.yml",
  "constitution.md",
  "soul.md",
]);

// ─── fs-aware checks ──────────────────────────────────────────

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isWithin(child: string, root: string): boolean {
  if (child === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(prefix);
}

/**
 * Realpath of absPath, or for a path that does not exist yet, the realpath of
 * its nearest existing ancestor plus the missing segments. Null on ELOOP,
 * EACCES and other errors.
 */
export function resolveReal(absPath: string): { real: string; exists: boolean } | null {
  const abs = path.resolve(absPath);
  try {
    return { real: fs.realpathSync(abs), exists: true };
  } catch (err) {
    if (!isMissing(err)) return null;
  }
  const missing: string[] = [];
  let current = abs;
  for (let i = 0; i < 256; i++) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    missing.unshift(path.basename(current));
    try {
      return { real: path.join(fs.realpathSync(parent), ...missing), exists: false };
    } catch (err) {
      if (!isMissing(err)) return null;
      current = parent;
    }
  }
  return null;
}

/** Nearest ancestor (or the dir itself) that is an automaton checkout, by its package.json. */
export function findCheckoutRoot(absDir: string): string | null {
  let dir = path.resolve(absDir);
  for (let i = 0; i < 64; i++) {
    if (readPackageName(dir) === RUNTIME_PACKAGE_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function matchCheckoutOnDisk(realPath: string): string | null {
  const root = findCheckoutRoot(path.dirname(realPath));
  if (!root) return null;
  return matchCheckoutRelative(segmentsOf(path.relative(root, realPath)));
}

function sensitiveInodeCandidates(): string[] {
  const state = stateDir();
  const home = homeDir();
  const out = [
    path.join(state, "wallet.json"),
    path.join(state, "automaton.json"),
    path.join(state, "config.json"),
    path.join(state, "state.db"),
    path.join(state, "inference-providers.json"),
    path.join(home, ".config", "solana", "id.json"),
    ...runtimeFilePaths,
  ];
  try {
    const sshDir = path.join(home, ".ssh");
    for (const name of fs.readdirSync(sshDir)) out.push(path.join(sshDir, name));
  } catch {
    // no ~/.ssh
  }
  return out;
}

/** True when st is the same inode as a known secret file. Stats at call time, no cache. */
export function sameInodeAsSensitive(st: fs.Stats): boolean {
  for (const candidate of sensitiveInodeCandidates()) {
    try {
      const other = fs.statSync(candidate);
      if (other.dev === st.dev && other.ino === st.ino) return true;
    } catch {
      // missing candidate
    }
  }
  return false;
}

function deny(
  requested: string,
  code: DenyCode,
  reason: string,
  rule?: string,
  real?: string,
): PathDecision {
  return { ok: false, code, reason, rule, requested, real };
}

function checkRoot(real: string, root: string | undefined, requested: string): PathDecision | null {
  if (!root) return null;
  const realRoot = tryRealpath(path.resolve(expandHome(root)));
  if (!realRoot) return deny(requested, "UNRESOLVABLE", `root ${root} cannot be resolved`, "root", real);
  if (!isWithin(real, realRoot)) {
    return deny(requested, "OUTSIDE_ROOT", `${requested} resolves outside ${root}`, "root", real);
  }
  return null;
}

/** May absPath be read? Checks the lexical path and its realpath, root containment and the file type. */
export function checkRead(absPath: string, opts: { root?: string } = {}): PathDecision {
  const lexical = path.resolve(expandHome(absPath));
  let rule = matchSensitive(lexical);
  if (rule) return deny(lexical, "SENSITIVE_FILE", `${lexical} is a sensitive path (${rule})`, rule);

  const resolved = resolveReal(lexical);
  if (!resolved) return deny(lexical, "UNRESOLVABLE", `${lexical} cannot be resolved`);
  rule = matchSensitive(resolved.real);
  if (rule) {
    return deny(lexical, "SENSITIVE_FILE", `${lexical} resolves to a sensitive path (${rule})`, rule, resolved.real);
  }
  const rootDenial = checkRoot(resolved.real, opts.root, lexical);
  if (rootDenial) return rootDenial;

  if (resolved.exists) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(resolved.real);
    } catch {
      return deny(lexical, "UNRESOLVABLE", `${lexical} cannot be inspected`, undefined, resolved.real);
    }
    if (!st.isDirectory()) {
      if (!st.isFile()) return deny(lexical, "NOT_REGULAR", `${lexical} is not a regular file`, undefined, resolved.real);
      if (st.nlink > 1 && sameInodeAsSensitive(st)) {
        return deny(lexical, "HARDLINK", `${lexical} is a hard link to a sensitive file`, undefined, resolved.real);
      }
    }
    return { ok: true, requested: lexical, real: resolved.real, dev: st.dev, ino: st.ino };
  }
  return { ok: true, requested: lexical, real: resolved.real };
}

export interface CheckWriteOptions {
  /** Confinement root (worker edit root, skill dir, repo root). */
  root?: string;
  /** Internal code that owns a protected file: skips the protected-name rules, keeps link and root checks. */
  trustedWriter?: boolean;
  /**
   * Allow a symlink or hard link in the final component. The write then
   * replaces the directory entry by rename and never follows it. Off by
   * default, also for trusted writers: a link at a fixed state path is a sign
   * of tampering and should fail loudly.
   */
  replaceLinks?: boolean;
  /** Accept an existing directory as the final component (clone targets). */
  allowDirectory?: boolean;
}

/** May absPath be written? */
export function checkWrite(absPath: string, opts: CheckWriteOptions = {}): PathDecision {
  const lexical = path.resolve(expandHome(absPath));
  const trusted = opts.trustedWriter === true;
  const replaceLinks = opts.replaceLinks === true;

  if (!trusted) {
    const rule = matchProtected(lexical);
    if (rule) return deny(lexical, "PROTECTED_FILE", `${lexical} is a protected path (${rule})`, rule);
  }

  const parent = resolveReal(path.dirname(lexical));
  if (!parent) return deny(lexical, "UNRESOLVABLE", `parent of ${lexical} cannot be resolved`);
  const final = path.join(parent.real, path.basename(lexical));

  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(final);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return deny(lexical, "UNRESOLVABLE", `${lexical} cannot be inspected`, undefined, final);
    }
  }
  if (st) {
    if (st.isSymbolicLink()) {
      if (!replaceLinks) return deny(lexical, "SYMLINK", `${lexical} is a symbolic link`, undefined, final);
    } else if (st.isDirectory()) {
      if (!opts.allowDirectory) return deny(lexical, "NOT_REGULAR", `${lexical} is a directory`, undefined, final);
    } else if (!st.isFile()) {
      return deny(lexical, "NOT_REGULAR", `${lexical} is not a regular file`, undefined, final);
    } else if (st.nlink > 1 && !replaceLinks) {
      return deny(lexical, "HARDLINK", `${lexical} has other hard links`, undefined, final);
    }
  }

  if (!trusted) {
    const rule = matchProtected(final) ?? matchCheckoutOnDisk(final);
    if (rule) {
      return deny(lexical, "PROTECTED_FILE", `${lexical} resolves to a protected path (${rule})`, rule, final);
    }
  }

  const rootDenial = checkRoot(final, opts.root, lexical);
  if (rootDenial) return rootDenial;

  return { ok: true, requested: lexical, real: final };
}
