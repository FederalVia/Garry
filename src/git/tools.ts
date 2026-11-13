/**
 * Git Tools
 *
 * Built-in git operations for the automaton.
 * Used for both state versioning and code development.
 */

import type { ConwayClient, GitStatus, GitLogEntry } from "../types.js";

/** The failing command's own words; stderr first, stdout when stderr is empty. */
function gitFailure(op: string, result: { stdout: string; stderr: string; exitCode: number }): Error {
  const detail = (result.stderr || result.stdout || "").trim() || `exit code ${result.exitCode}`;
  return new Error(`git ${op} failed: ${detail}`);
}

/**
 * Get git status for a repository.
 */
export async function gitStatus(
  conway: ConwayClient,
  repoPath: string,
): Promise<GitStatus> {
  const result = await conway.exec(
    `cd ${escapeShellArg(repoPath)} && git status --porcelain -b`,
    10000,
  );
  // A failed cd or a non-repo must not read as a clean tree.
  if (result.exitCode !== 0) throw gitFailure("status", result);

  const lines = result.stdout.split("\n").filter(Boolean);
  let branch = "unknown";
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0];
      continue;
    }

    const statusCode = line.slice(0, 2);
    const file = line.slice(3);

    if (statusCode[0] !== " " && statusCode[0] !== "?") {
      staged.push(file);
    }
    if (statusCode[1] === "M" || statusCode[1] === "D") {
      modified.push(file);
    }
    if (statusCode === "??") {
      untracked.push(file);
    }
  }

  return {
    branch,
    staged,
    modified,
    untracked,
    clean:
      staged.length === 0 && modified.length === 0 && untracked.length === 0,
  };
}

/**
 * Get git diff output.
 */
export async function gitDiff(
  conway: ConwayClient,
  repoPath: string,
  staged: boolean = false,
): Promise<string> {
  const flag = staged ? "--cached" : "";
  const result = await conway.exec(
    `cd ${escapeShellArg(repoPath)} && git diff ${flag}`,
    10000,
  );
  if (result.exitCode !== 0) throw gitFailure("diff", result);
  return result.stdout || "(no changes)";
}

/**
 * Create a git commit.
 */
export async function gitCommit(
  conway: ConwayClient,
  repoPath: string,
  message: string,
  addAll: boolean = true,
): Promise<string> {
  if (addAll) {
    await conway.exec(`cd ${escapeShellArg(repoPath)} && git add -A`, 10000);
  }

  const result = await conway.exec(
    `cd ${escapeShellArg(repoPath)} && git commit -m ${escapeShellArg(message)} --allow-empty 2>&1`,
    10000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git commit failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

/**
 * Commit only the given paths. Other staged, modified or untracked files in
 * the repo stay out of the commit. Returns null when the paths have no
 * changes (no empty commits).
 */
export async function gitCommitPaths(
  conway: ConwayClient,
  repoPath: string,
  message: string,
  paths: string[],
): Promise<string | null> {
  if (paths.length === 0) return null;
  const repo = escapeShellArg(repoPath);
  const pathspec = paths.map(escapeShellArg).join(" ");

  const add = await conway.exec(`cd ${repo} && git add -- ${pathspec} 2>&1`, 10000);
  if (add.exitCode !== 0) {
    throw new Error(`Git add failed: ${add.stderr || add.stdout}`);
  }

  const status = await conway.exec(`cd ${repo} && git status --porcelain -- ${pathspec}`, 10000);
  if (status.exitCode !== 0) {
    throw new Error(`Git status failed: ${status.stderr || status.stdout}`);
  }
  if (!status.stdout.trim()) return null;

  const identity = await fallbackIdentityFlags(conway, repo);
  const result = await conway.exec(
    `cd ${repo} && git ${identity}commit -m ${escapeShellArg(message)} -- ${pathspec} 2>&1`,
    10000,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Git commit failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * A fresh machine often has no git identity, and then every commit fails.
 * Supply one with -c only for the parts that are missing; no config is written.
 */
export async function fallbackIdentityFlags(conway: ConwayClient, repo: string): Promise<string> {
  const read = async (key: string): Promise<string> => {
    try {
      const res = await conway.exec(`cd ${repo} && git config ${key}`, 10000);
      return res.exitCode === 0 ? res.stdout.trim() : "";
    } catch {
      return "";
    }
  };
  const flags: string[] = [];
  if (!(await read("user.name"))) flags.push("-c user.name=Automaton");
  if (!(await read("user.email"))) flags.push("-c user.email=automaton@localhost");
  return flags.length ? `${flags.join(" ")} ` : "";
}

/**
 * Get git log.
 */
export async function gitLog(
  conway: ConwayClient,
  repoPath: string,
  limit: number = 10,
): Promise<GitLogEntry[]> {
  const safeLimit = Math.max(1, Math.floor(Number(limit))) || 10;
  const result = await conway.exec(
    `cd ${escapeShellArg(repoPath)} && git log --format="%H|%s|%an|%ai" -n ${safeLimit}`,
    10000,
  );

  if (result.exitCode !== 0) {
    // A repo without commits is not a failure.
    if (/does not have any commits yet/.test(result.stderr)) return [];
    throw gitFailure("log", result);
  }
  if (!result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, message, author, date] = line.split("|");
      return { hash, message, author, date };
    });
}

/**
 * Push to remote.
 */
export async function gitPush(
  conway: ConwayClient,
  repoPath: string,
  remote: string = "origin",
  branch?: string,
): Promise<string> {
  const branchArg = branch ? ` ${escapeShellArg(branch)}` : "";
  const result = await conway.exec(
    `cd ${escapeShellArg(repoPath)} && git push ${escapeShellArg(remote)}${branchArg} 2>&1`,
    30000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git push failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout || "Push successful";
}

/**
 * Manage branches.
 */
export async function gitBranch(
  conway: ConwayClient,
  repoPath: string,
  action: "list" | "create" | "checkout" | "delete",
  branchName?: string,
): Promise<string> {
  let cmd: string;

  switch (action) {
    case "list":
      cmd = `cd ${escapeShellArg(repoPath)} && git branch -a 2>/dev/null`;
      break;
    case "create":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${escapeShellArg(repoPath)} && git checkout -b ${escapeShellArg(branchName)} 2>&1`;
      break;
    case "checkout":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${escapeShellArg(repoPath)} && git checkout ${escapeShellArg(branchName)} 2>&1`;
      break;
    case "delete":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${escapeShellArg(repoPath)} && git branch -d ${escapeShellArg(branchName)} 2>&1`;
      break;
    default:
      throw new Error(`Unknown branch action: ${action}`);
  }

  const result = await conway.exec(cmd, 10000);
  return result.stdout || result.stderr || "Done";
}

/**
 * Clone a repository.
 */
export async function gitClone(
  conway: ConwayClient,
  url: string,
  targetPath: string,
  depth?: number,
): Promise<string> {
  const depthArg = depth
    ? ` --depth ${Math.max(1, Math.floor(Number(depth)))}`
    : "";
  const result = await conway.exec(
    `git clone${depthArg} ${escapeShellArg(url)} ${escapeShellArg(targetPath)} 2>&1`,
    120000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git clone failed: ${result.stderr || result.stdout}`);
  }

  return `Cloned ${url} to ${targetPath}`;
}

/**
 * Initialize a git repository.
 */
export async function gitInit(
  conway: ConwayClient,
  repoPath: string,
): Promise<string> {
  const result = await conway.exec(
    `cd ${escapeShellArg(repoPath)} && git init 2>&1`,
    10000,
  );
  return result.stdout || "Git initialized";
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
