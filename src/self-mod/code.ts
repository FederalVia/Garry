/**
 * Self-Modification Engine
 *
 * Allows the automaton to edit its own code and configuration.
 * All changes are audited, rate-limited, and some paths are protected.
 *
 * Safety model inspired by nanoclaw's trust boundary architecture:
 * - Hard-coded invariants that can NEVER be modified by the agent
 * - The safety enforcement code is immutable from the agent's perspective
 * - Pre-modification snapshots via git
 * - Rate limiting on modification frequency
 * - Symlink resolution before path validation
 * - Maximum diff size enforcement
 */

import fs from "fs";
import path from "path";
import type {
  ConwayClient,
  AutomatonDatabase,
} from "../types.js";
import { logModification } from "./audit-log.js";
import {
  checkWrite,
  expandHome,
  matchProtected,
  type PathDecision,
} from "../security/protected-paths.js";
import { readFileSafe, writeFileVerified } from "../security/secure-fs.js";
import { introducedNeutralisedMarker } from "../agent/injection-defense.js";
import { formatAuditDiff } from "./line-diff.js";
import { createHash } from "crypto";

// ─── IMMUTABLE SAFETY INVARIANTS ─────────────────────────────
// The protected and sensitive path rules live in security/protected-paths.ts,
// which is itself protected. This module only applies them.

/**
 * Maximum number of self-modifications per hour.
 * Prevents runaway modification loops.
 */
const MAX_MODIFICATIONS_PER_HOUR = 20;

/**
 * Maximum size of a single file modification (bytes).
 */
const MAX_MODIFICATION_SIZE = 100_000; // 100KB

/**
 * Maximum diff size stored in the audit log (characters).
 */
const MAX_DIFF_SIZE = 10_000;

export interface EditFileOptions {
  /** Repository the edit is confined to. Defaults to process.cwd(). */
  repoRoot?: string;
}

// ─── Path Validation ─────────────────────────────────────────

function resolveRepoRoot(opts?: EditFileOptions): string {
  return path.resolve(expandHome(opts?.repoRoot ?? process.cwd()));
}

/**
 * Decide whether filePath may be edited: resolved against the repo root,
 * checked on its real path, no symlink or hard link in the final component,
 * and confined to the repo.
 */
function checkEditPath(filePath: string, repoRoot: string): PathDecision {
  const abs = path.resolve(repoRoot, expandHome(filePath));
  return checkWrite(abs, { root: repoRoot });
}

/**
 * Check if a file path is protected from modification (lexical rules only;
 * editFile and the policy rules also check the real path).
 */
export function isProtectedFile(filePath: string): boolean {
  return matchProtected(path.resolve(expandHome(filePath))) !== null;
}

/**
 * Check if the modification rate limit has been exceeded. Only code edits
 * count: installs, reverts and resets do not use up the edit budget.
 */
function isRateLimited(db: AutomatonDatabase): boolean {
  const row = db.raw
    .prepare(
      "SELECT COUNT(*) AS n FROM modifications WHERE type = 'code_edit' AND julianday(timestamp) > julianday('now', '-1 hour')",
    )
    .get() as { n: number } | undefined;
  return (row?.n ?? 0) >= MAX_MODIFICATIONS_PER_HOUR;
}

// ─── Self-Modification API ───────────────────────────────────

/**
 * Edit a file in the automaton's own repository.
 * Records the change in the audit log and commits only that file.
 *
 * Safety checks:
 * 1. Protected and sensitive paths, on the lexical and the real path
 * 2. No symlink or hard link in the final component; confined to the repo
 * 3. Rate limiting
 * 4. File size limit
 * 5. Pre-modification git snapshot of the file (only when it is dirty)
 * 6. Write via temp file and rename (never follows a link)
 * 7. Audit log entry
 */
export async function editFile(
  conway: ConwayClient,
  db: AutomatonDatabase,
  filePath: string,
  newContent: string,
  reason: string,
  opts?: EditFileOptions,
): Promise<{ success: boolean; error?: string; commitError?: string }> {
  const repoRoot = resolveRepoRoot(opts);

  // 1-2. Path decision on the real path
  const decision = checkEditPath(filePath, repoRoot);
  if (!decision.ok || !decision.real) {
    return {
      success: false,
      error: `BLOCKED: Cannot modify ${filePath}: ${decision.code}: ${decision.reason}. This is a hard-coded safety invariant.`,
    };
  }
  const target = decision.real;

  // 3. Rate limiting
  if (isRateLimited(db)) {
    return {
      success: false,
      error: `RATE LIMITED: Too many modifications in the past hour (max ${MAX_MODIFICATIONS_PER_HOUR}). Wait before making more changes.`,
    };
  }

  // 4. File size limit
  if (newContent.length > MAX_MODIFICATION_SIZE) {
    return {
      success: false,
      error: `BLOCKED: File content too large (${newContent.length} bytes, max ${MAX_MODIFICATION_SIZE}). Break into smaller changes.`,
    };
  }

  // 5. Read current content for diff
  let existing: string | null = null;
  try {
    existing = readFileSafe(target, { root: repoRoot });
  } catch {
    existing = null;
  }
  // Text copied from a neutralised read would replace the original markers.
  const marker = introducedNeutralisedMarker(newContent, existing);
  if (marker) {
    return {
      success: false,
      error: `BLOCKED: the content contains ${marker}, a placeholder from a neutralised tool result, and ${filePath} does not. Writing it would replace the original text.`,
    };
  }

  // Path of the file inside the repo, for pathspec-limited commits.
  let realRepoRoot = repoRoot;
  try {
    realRepoRoot = fs.realpathSync(repoRoot);
  } catch {
    // keep the lexical root
  }
  const relPath = path.relative(realRepoRoot, target);

  // 6. Pre-modification snapshot of this file only, when it is tracked and dirty
  const { gitCommitPaths } = await import("../git/tools.js");
  try {
    const tracked = await conway.exec(
      `cd ${shellQuote(repoRoot)} && git ls-files -- ${shellQuote(relPath)}`,
      10_000,
    );
    if (tracked.exitCode === 0 && tracked.stdout.trim()) {
      await gitCommitPaths(conway, repoRoot, `pre-modify: ${reason}`, [relPath]);
    }
  } catch {
    // Git not available -- proceed without snapshot
  }

  // 7. Write new content (own code is local by definition)
  try {
    writeFileVerified(target, newContent, { root: repoRoot });
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to write file: ${err.message}`,
    };
  }

  // 8. Generate diff and log
  const newSha = createHash("sha256").update(newContent).digest("hex");
  const diff = formatAuditDiff(existing ?? "", newContent, newSha, MAX_DIFF_SIZE);

  logModification(db, "code_edit", reason, {
    filePath: relPath,
    diff,
    reversible: true,
  });

  // 9. Post-modification commit of this file only; a failure is reported.
  let commitError: string | undefined;
  try {
    await gitCommitPaths(conway, repoRoot, `self-mod: ${reason}`, [relPath]);
  } catch (err: any) {
    commitError = String(err?.message ?? err).replace(/\s+/g, " ").trim().slice(0, 500);
  }
  const withCommit = commitError ? { commitError } : {};

  // 10. Rebuild in the repo, and report a failed build
  if (/\.(ts|js|tsx|jsx)$/.test(target)) {
    try {
      const build = await conway.exec(`cd ${shellQuote(repoRoot)} && npm run build`, 60_000);
      if (build.exitCode !== 0) {
        const output = (build.stderr || build.stdout || "").slice(0, 500);
        return { success: true, error: `rebuild failed: ${output}`, ...withCommit };
      }
    } catch (err: any) {
      return { success: true, error: `rebuild failed: ${String(err?.message ?? err).slice(0, 500)}`, ...withCommit };
    }
  }

  return { success: true, ...withCommit };
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate a proposed modification without executing it.
 * Uses the same path decision as editFile.
 */
export function validateModification(
  db: AutomatonDatabase,
  filePath: string,
  contentSize: number,
  opts?: EditFileOptions,
): {
  allowed: boolean;
  reason: string;
  checks: { name: string; passed: boolean; detail: string }[];
} {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const decision = checkEditPath(filePath, resolveRepoRoot(opts));
  const isProtected = decision.code === "PROTECTED_FILE" || decision.code === "SENSITIVE_FILE";

  // Protected file check
  checks.push({
    name: "protected_file",
    passed: !isProtected,
    detail: isProtected
      ? `File matches protected pattern (${decision.rule ?? decision.code})`
      : "File is not protected",
  });

  // Path validation
  const pathOk = decision.ok || isProtected;
  checks.push({
    name: "path_valid",
    passed: pathOk,
    detail: decision.ok
      ? `Resolved to: ${decision.real}`
      : isProtected
        ? "See protected_file"
        : `Path is invalid or unsafe (${decision.code}: ${decision.reason})`,
  });

  // Rate limit
  const rateLimited = isRateLimited(db);
  checks.push({
    name: "rate_limit",
    passed: !rateLimited,
    detail: rateLimited
      ? `Exceeded ${MAX_MODIFICATIONS_PER_HOUR}/hour limit`
      : "Within rate limit",
  });

  // Size limit
  const sizeOk = contentSize <= MAX_MODIFICATION_SIZE;
  checks.push({
    name: "size_limit",
    passed: sizeOk,
    detail: sizeOk
      ? `${contentSize} bytes (max ${MAX_MODIFICATION_SIZE})`
      : `${contentSize} bytes exceeds ${MAX_MODIFICATION_SIZE} limit`,
  });

  const allPassed = checks.every((c) => c.passed);
  const failedChecks = checks.filter((c) => !c.passed);

  return {
    allowed: allPassed,
    reason: allPassed
      ? "All safety checks passed"
      : `Blocked: ${failedChecks.map((c) => c.detail).join("; ")}`,
    checks,
  };
}
