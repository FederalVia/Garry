/**
 * State Versioning
 *
 * Version control the automaton's own state files (~/.automaton/).
 * SOUL.md, WORKLOG.md, heartbeat.yml and skills/ are committed after each
 * soul update and skill install, creation or removal (WORKLOG.md and
 * heartbeat.yml edits ride along with the next such commit). Keys, the
 * wallet, the database and automaton.json are never versioned.
 */

import { execFile, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { gitInit, gitCommit, gitLog } from "./tools.js";
import { readRegularFileNoFollow, writeFileSafe } from "../security/secure-fs.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("git.state");
const execFileAsync = promisify(execFile);

const AUTOMATON_DIR = "~/.automaton";

function resolveHome(p: string): string {
  const home = process.env.HOME || "/root";
  if (p.startsWith("~")) {
    return `${home}${p.slice(1)}`;
  }
  return p;
}

/**
 * Allowlist .gitignore for the state repo: only these files are versioned.
 * automaton.json (API keys), wallet.json, state.db and anything unknown stay
 * out of history even when `git add -A` runs.
 */
export const STATE_GITIGNORE = `# Allowlist: only these state files are versioned. Everything else stays out of git.
/*
!/.gitignore
!/SOUL.md
!/WORKLOG.md
!/heartbeat.yml
!/constitution.md
!/skills/
/skills/.*
/skills/*/.git
*.tmp-*
.env
.env.*
*.key
*.pem
*.p12
*.pfx
.netrc
.npmrc
.git-credentials
wallet.json
automaton.json
config.json
`;

const SECRET_HISTORY_PATHSPECS = [
  "automaton.json",
  "wallet.json",
  "config.json",
  "*.pem",
  "*.key",
  ".env",
];

let warnedAboutHistory = false;

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c", "core.hooksPath=/dev/null",
      "-c", "user.name=Automaton",
      "-c", "user.email=automaton@conway.tech",
      ...args,
    ],
    { cwd: dir, encoding: "utf-8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

function writeGitignore(dir: string): void {
  const target = path.join(dir, ".gitignore");
  try {
    // Replace, never write through, a link left at .gitignore.
    if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
  } catch {
    // missing
  }
  writeFileSafe(target, STATE_GITIGNORE, { trustedWriter: true, mode: 0o644 });
}

/**
 * Initialize git repo for the automaton's state directory.
 * Creates the allowlist .gitignore; an existing repo is migrated to it.
 */
export async function initStateRepo(
  conway: ConwayClient,
): Promise<void> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if already initialized
  const checkResult = await conway.exec(
    `test -d ${dir}/.git && echo "exists" || echo "nope"`,
    5000,
  );

  if (checkResult.stdout.trim() === "exists") {
    await migrateStateRepo(conway);
    return;
  }

  // Initialize
  await gitInit(conway, dir);

  writeGitignore(dir);

  // Configure git user
  await conway.exec(
    `cd ${dir} && git config user.name "Automaton" && git config user.email "automaton@conway.tech"`,
    5000,
  );

  // Initial commit
  await gitCommit(conway, dir, "genesis: automaton state repository initialized");
}

/**
 * Bring an existing state repo onto the allowlist: rewrite .gitignore, stop
 * tracking files it now excludes, and warn loudly if secrets are already in
 * history. History is not rewritten automatically: that is the operator's call.
 */
export async function migrateStateRepo(
  _conway: ConwayClient,
): Promise<{ untracked: string[]; historyHasSecrets: boolean }> {
  const dir = resolveHome(AUTOMATON_DIR);
  const gitignorePath = path.join(dir, ".gitignore");
  let changed = false;

  const current = readRegularFileNoFollow(gitignorePath, { root: dir, maxBytes: 64 * 1024 });
  if (current !== STATE_GITIGNORE) {
    writeGitignore(dir);
    await git(dir, ["add", "--", ".gitignore"]);
    changed = true;
  }

  const ignoredOut = await git(dir, ["ls-files", "-ci", "--exclude-standard", "-z"]);
  const untracked = ignoredOut.split("\0").filter(Boolean);
  if (untracked.length > 0) {
    await git(dir, ["rm", "--cached", "-q", "--", ...untracked]);
    changed = true;
  }

  if (changed) {
    const staged = await git(dir, ["diff", "--cached", "--name-only"]);
    if (staged.trim()) {
      await git(dir, ["commit", "-q", "-m", "security: stop tracking files excluded by the state allowlist"]);
    }
  }

  let historyHasSecrets = false;
  try {
    const hit = await git(dir, ["log", "--all", "--format=%H", "-n", "1", "--", ...SECRET_HISTORY_PATHSPECS]);
    historyHasSecrets = hit.trim().length > 0;
  } catch {
    // Empty repo or unreadable history: nothing to report.
  }
  if (historyHasSecrets && !warnedAboutHistory) {
    warnedAboutHistory = true;
    logger.error(
      "API keys were committed to ~/.automaton git history; rotate the Conway/OpenAI/Anthropic keys, " +
        "and rewrite or delete the history before adding any remote",
    );
  }

  return { untracked, historyHasSecrets };
}

/** The only paths a state commit stages. */
const STATE_PATHS = ["SOUL.md", "WORKLOG.md", "heartbeat.yml", "skills"] as const;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 2000;

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Skill directories cloned from git: plain `git add` would record them as gitlinks. */
function nestedSkillRepos(dir: string): string[] {
  const skillsDir = path.join(dir, "skills");
  const st = lstatOrNull(skillsDir);
  if (!st || !st.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (lstatOrNull(path.join(skillsDir, entry.name, ".git"))) out.push(`skills/${entry.name}`);
  }
  return out;
}

/** Regular files under rel (no links, no .git), relative to dir. */
function listFiles(dir: string, rel: string, out: string[]): void {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (out.length >= MAX_SKILL_FILES) return;
    if (entry.name === ".git") continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) listFiles(dir, child, out);
    else if (entry.isFile() && (lstatOrNull(path.join(dir, child))?.size ?? Infinity) <= MAX_SKILL_FILE_BYTES) {
      out.push(child);
    }
  }
}

/**
 * Stage the files of a skill cloned from git as ordinary blobs, honouring the
 * state .gitignore, and drop index entries for files that are gone.
 */
async function stageNestedRepo(dir: string, rel: string): Promise<void> {
  const files: string[] = [];
  listFiles(dir, rel, files);
  let kept = files;
  if (files.length > 0) {
    let ignored = "";
    try {
      ignored = execFileSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "check-ignore", "--no-index", "--stdin", "-z"],
        { cwd: dir, encoding: "utf-8", input: files.join("\0") + "\0", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (err: any) {
      // Exit 1 means nothing is ignored.
      if (err?.status !== 1) throw err;
    }
    const ignoredSet = new Set(ignored.split("\0").filter(Boolean));
    kept = files.filter((f) => !ignoredSet.has(f));
  }
  const tracked = (await git(dir, ["ls-files", "-z", "--", rel])).split("\0").filter(Boolean);
  const keep = new Set(kept);
  const gone = tracked.filter((f) => !keep.has(f));
  if (gone.length > 0) await git(dir, ["update-index", "--force-remove", "--", ...gone]);
  for (const file of kept) {
    const sha = (await git(dir, ["hash-object", "-w", "--no-filters", "--", file])).trim();
    const mode = (lstatOrNull(path.join(dir, file))!.mode & 0o111) !== 0 ? "100755" : "100644";
    await git(dir, ["update-index", "--add", "--replace", "--cacheinfo", `${mode},${sha},${file}`]);
  }
}

function underStatePaths(file: string): boolean {
  return STATE_PATHS.some((p) => file === p || file.startsWith(`${p}/`));
}

/**
 * Commit the allowlisted state files (SOUL.md, WORKLOG.md, heartbeat.yml,
 * skills/) with a descriptive message. Nothing else is staged, and nothing
 * is committed when they are unchanged. Returns quietly when ~/.automaton has
 * no git repo, and never throws: a broken state repo must not fail the change.
 */
export async function commitStateChange(
  description: string,
  category: string = "state",
): Promise<string> {
  const dir = resolveHome(AUTOMATON_DIR);
  if (!lstatOrNull(path.join(dir, ".git"))) return "No state repo";

  try {
    const tracked = (await git(dir, ["ls-files", "-z", "--", ...STATE_PATHS])).split("\0").filter(Boolean);
    // A pathspec naming nothing on disk or in the index makes `git add` fail.
    const present = STATE_PATHS.filter(
      (p) => lstatOrNull(path.join(dir, p)) || tracked.some((t) => t === p || t.startsWith(`${p}/`)),
    );
    if (present.length === 0) return "No changes to commit";

    const nested = nestedSkillRepos(dir);
    await git(dir, ["add", "-A", "--", ...present, ...nested.map((n) => `:(exclude)${n}`)]);
    for (const rel of nested) await stageNestedRepo(dir, rel);

    // Commit only what this function staged: anything else is unstaged first.
    const staged = (await git(dir, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
    const stray = staged.filter((f) => !underStatePaths(f));
    if (stray.length > 0) await git(dir, ["reset", "-q", "--", ...stray]);
    if (staged.length === stray.length) return "No changes to commit";

    await git(dir, ["commit", "-q", "-m", `${category}: ${description}`]);
    return (await git(dir, ["rev-parse", "HEAD"])).trim();
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || err).trim();
    logger.warn(`State repo commit skipped: ${msg}`);
    return `State repo unavailable: ${msg}`;
  }
}

/**
 * Commit after a SOUL.md update.
 */
export async function commitSoulUpdate(description: string): Promise<string> {
  return commitStateChange(description, "soul");
}

/**
 * Commit after a skill installation or removal.
 */
export async function commitSkillChange(
  skillName: string,
  action: "install" | "remove" | "update" | "create",
): Promise<string> {
  return commitStateChange(`${action} skill: ${skillName}`, "skill");
}

/**
 * Commit after a heartbeat.yml change.
 */
export async function commitHeartbeatChange(description: string): Promise<string> {
  return commitStateChange(description, "heartbeat");
}

/**
 * Get the state repo history.
 */
export async function getStateHistory(
  conway: ConwayClient,
  limit: number = 20,
) {
  const dir = resolveHome(AUTOMATON_DIR);
  try {
    return await gitLog(conway, dir, limit);
  } catch (err: any) {
    logger.warn(`State repo history unavailable: ${err?.message || String(err)}`);
    return [];
  }
}
