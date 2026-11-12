/**
 * State Versioning
 *
 * Version control the automaton's own state files (~/.automaton/).
 * Every self-modification triggers a git commit with a descriptive message.
 * The automaton's entire identity history is version-controlled and replayable.
 */

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { gitInit, gitCommit, gitStatus, gitLog } from "./tools.js";
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

/**
 * Commit a state change with a descriptive message.
 * Called after any self-modification.
 */
export async function commitStateChange(
  conway: ConwayClient,
  description: string,
  category: string = "state",
): Promise<string> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Never throws: a missing or broken state repo must not fail the change itself.
  try {
    const status = await gitStatus(conway, dir);
    if (status.clean) {
      return "No changes to commit";
    }

    const message = `${category}: ${description}`;
    return await gitCommit(conway, dir, message);
  } catch (err: any) {
    const msg = err?.message || String(err);
    logger.warn(`State repo commit skipped: ${msg}`);
    return `State repo unavailable: ${msg}`;
  }
}

/**
 * Commit after a SOUL.md update.
 */
export async function commitSoulUpdate(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "soul");
}

/**
 * Commit after a skill installation or removal.
 */
export async function commitSkillChange(
  conway: ConwayClient,
  skillName: string,
  action: "install" | "remove" | "update",
): Promise<string> {
  return commitStateChange(
    conway,
    `${action} skill: ${skillName}`,
    "skill",
  );
}

/**
 * Commit after heartbeat config change.
 */
export async function commitHeartbeatChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "heartbeat");
}

/**
 * Commit after config change.
 */
export async function commitConfigChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "config");
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
