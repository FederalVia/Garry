/**
 * Upstream Awareness
 *
 * Helpers for the automaton to know its own git origin,
 * detect new upstream commits, and review diffs.
 * All git commands use execFile with argument arrays to prevent injection,
 * and run in the directory this process runs from.
 */

import { execFile, execFileSync } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Large enough for any real diff; the default 1 MB made big diffs fail.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// Full diffs: every file as text (binary and -diff attributes included), no
// rename folding (numstat would print "a => b" paths), no external drivers.
const SHOW_DIFF_ARGS = [
  "--text",
  "--no-renames",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--diff-merges=first-parent",
];

/**
 * Run a git command using execFileSync with argument array (no shell interpolation).
 */
function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: GIT_MAX_BUFFER,
  }).trim();
}

/** Async git in the repo this process runs from; output is not trimmed. */
async function gitAsync(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

/** Strip embedded credentials (https://user:token@host/... -> https://host/...). */
function stripCredentials(url: string): string {
  return url.replace(/\/\/[^@/]+@/, "//");
}

/**
 * Return origin URL (credentials stripped), current branch, and HEAD info.
 */
export function getRepoInfo(): {
  originUrl: string;
  branch: string;
  headHash: string;
  headMessage: string;
} {
  const originUrl = stripCredentials(git(["config", "--get", "remote.origin.url"]));
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headLine = git(["log", "-1", "--format=%h %s"]);
  const [headHash, ...rest] = headLine.split(" ");
  return { originUrl, branch, headHash, headMessage: rest.join(" ") };
}

/**
 * Fetch origin and report how many commits we're behind.
 */
export function checkUpstream(): {
  behind: number;
  commits: { hash: string; message: string }[];
} {
  git(["fetch", "origin", "main", "--quiet"]);
  const log = git(["log", "HEAD..origin/main", "--oneline"]);
  if (!log) return { behind: 0, commits: [] };
  const commits = log.split("\n").map((line) => {
    const [hash, ...rest] = line.split(" ");
    return { hash, message: rest.join(" ") };
  });
  return { behind: commits.length, commits };
}

/** Origin URL with credentials stripped, or "(no origin)". */
export async function getOriginUrl(): Promise<string> {
  try {
    return stripCredentials((await gitAsync(["config", "--get", "remote.origin.url"])).trim());
  } catch {
    return "(no origin)";
  }
}

/** Fetch origin main and return the full SHA origin/main now points to. */
export async function resolveUpstreamTarget(): Promise<string> {
  await gitAsync(["fetch", "origin", "main", "--quiet"], 60_000);
  return (await gitAsync(["rev-parse", "--verify", "origin/main^{commit}"])).trim();
}

/** Full SHA of a commit-ish, or null when it does not name a commit. */
export async function resolveCommit(ref: string): Promise<string | null> {
  try {
    return (await gitAsync(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

export interface UpstreamCommit {
  hash: string;
  author: string;
  message: string;
  parents: number;
}

/** Commits in HEAD..target, oldest first (the order they apply in). */
export async function listCommitsBetween(target: string): Promise<UpstreamCommit[]> {
  // rev-list is the authoritative list; log only supplies display text.
  const revs = (await gitAsync(["rev-list", "--reverse", "--parents", `HEAD..${target}`]))
    .split("\n")
    .map((l) => l.trim().split(" "))
    .filter((parts) => /^[0-9a-f]{40,64}$/.test(parts[0]));
  const meta = new Map<string, { author: string; message: string }>();
  for (const line of (await gitAsync(["log", "--format=%H%x09%an%x09%s", `HEAD..${target}`])).split("\n")) {
    const [hash, author, ...subject] = line.split("\t");
    if (hash && !meta.has(hash)) meta.set(hash, { author: author ?? "", message: subject.join("\t") });
  }
  return revs.map(([hash, ...parents]) => ({
    hash,
    author: meta.get(hash)?.author ?? "",
    message: meta.get(hash)?.message ?? "",
    parents: parents.length,
  }));
}

/**
 * True when HEAD is on target's first-parent chain. Only then do the
 * first-parent diffs of the commits in HEAD..target add up to the change a
 * fast-forward applies; a merge whose first parent is a side branch can drop
 * HEAD's own changes without any reviewed diff showing it.
 */
export async function headOnFirstParentChain(target: string): Promise<boolean> {
  const head = (await gitAsync(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const lines = (await gitAsync(["rev-list", "--first-parent", "--parents", `HEAD..${target}`]))
    .trim()
    .split("\n")
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines[lines.length - 1].trim().split(" ")[1] === head;
}

/**
 * The full patch of one commit (root commits and merges included; merges
 * against their first parent). Errors are thrown, never returned as a diff.
 */
export async function getCommitDiff(hash: string): Promise<string> {
  return gitAsync(["show", "--format=", "--patch", ...SHOW_DIFF_ARGS, hash], 120_000);
}

/** Files a commit changes, with added/deleted line counts. */
export async function getCommitFiles(hash: string): Promise<{ path: string; added: number; deleted: number }[]> {
  const out = await gitAsync(["show", "--format=", "--numstat", "-z", ...SHOW_DIFF_ARGS, hash], 120_000);
  return parseNumstatZ(out);
}

/** Files that differ between two commits, with line counts. */
export async function getFilesBetween(from: string, to: string): Promise<{ path: string; added: number; deleted: number }[]> {
  const out = await gitAsync(["diff", "--numstat", "-z", "--text", "--no-renames", "--no-ext-diff", "--no-textconv", from, to], 120_000);
  return parseNumstatZ(out);
}

function parseNumstatZ(out: string): { path: string; added: number; deleted: number }[] {
  const files: { path: string; added: number; deleted: number }[] = [];
  for (const entry of out.split("\0")) {
    const record = entry.replace(/^\n+/, "");
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!m) continue;
    files.push({ path: m[3], added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return files;
}

/** Commits on HEAD that are not in target (lost by a reset). */
export async function getLocalOnlyCommits(target: string): Promise<string> {
  return (await gitAsync(["log", "--oneline", `${target}..HEAD`])).trim();
}

/** Number of uncommitted changes (lost by a hard reset). */
export async function countUncommittedChanges(): Promise<number> {
  const out = await gitAsync(["status", "--porcelain", "-z", "--untracked-files=no"]);
  return out.split("\0").filter(Boolean).length;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
