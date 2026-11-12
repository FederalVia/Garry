/**
 * File Path Protection Policy Rules
 *
 * Prevents writes to protected files, reads of sensitive files,
 * and path traversal attacks. Every rule resolves the path the way the tool
 * will, then decides on the real path with security/protected-paths.ts, so a
 * symlink or hard link cannot carry a request past the rules.
 */

import path from "path";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import {
  checkRead,
  checkWrite,
  expandHome,
  homeDir,
  matchSensitive,
  resolveReal,
  type PathDecision,
} from "../../security/protected-paths.js";

/** write_file confines to the sandbox home, which is /root locally and remotely. */
const SANDBOX_HOME = "/root";

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Check if a file path matches a sensitive read pattern (lexical).
 */
export function isSensitiveFile(filePath: string): boolean {
  return matchSensitive(path.resolve(expandHome(filePath))) !== null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Absolute paths a tool may act on for this argument, primary first. When the
 * tool and its fallbacks resolve the path against different bases, every
 * base is checked.
 */
function candidatePaths(toolName: string, filePath: string): string[] {
  if (path.isAbsolute(filePath)) return [path.resolve(filePath)];
  const home = homeDir();
  if (!filePath.startsWith("~")) return relativeCandidates(toolName, filePath, home);

  // The tools expand any leading "~" (join(HOME or /root, p.slice(1))), so
  // "~name/x" means HOME/name/x to them, while expandHome and the quoted
  // shell fallbacks read it literally. Check both readings.
  const rest = filePath.slice(1).replace(/^\/+/, "");
  let expanded: string[];
  switch (toolName) {
    case "write_file":
      expanded = [path.resolve(SANDBOX_HOME, rest), path.resolve(home, rest)];
      break;
    case "edit_own_file":
      expanded = [path.resolve(home, rest)];
      break;
    default:
      expanded = [path.resolve(home, rest), path.resolve(SANDBOX_HOME, rest)];
  }
  if (filePath === "~" || filePath.startsWith("~/")) return unique(expanded);
  return unique([...expanded, ...relativeCandidates(toolName, filePath, home)]);
}

function relativeCandidates(toolName: string, filePath: string, home: string): string[] {
  switch (toolName) {
    case "write_file":
      // tools.ts confinePathToSandbox resolves relative paths against /root.
      return [path.resolve(SANDBOX_HOME, filePath)];
    case "edit_own_file":
      return [path.resolve(process.cwd(), filePath)];
    case "git_clone":
      // gitClone runs in HOME (local exec) or /root (remote exec).
      return unique([path.resolve(home, filePath), path.resolve(SANDBOX_HOME, filePath)]);
    case "read_file":
    default:
      // conway.readFile resolves relative paths against cwd; its `cat`
      // fallback runs in HOME (local) or /root (remote).
      return unique([
        path.resolve(process.cwd(), filePath),
        path.resolve(home, filePath),
        path.resolve(SANDBOX_HOME, filePath),
      ]);
  }
}

/** A fallback base this process cannot even resolve (e.g. /root for a non-root user) is not a denial. */
function isUnreachableFallback(decision: PathDecision, index: number): boolean {
  return index > 0 && decision.code === "UNRESOLVABLE";
}

function writeReasonCode(decision: PathDecision): string {
  if (decision.code === "SYMLINK") return "PROTECTED_SYMLINK";
  if (decision.code === "HARDLINK") return "PROTECTED_HARDLINK";
  return "PROTECTED_FILE";
}

/**
 * Clone targets inside a skills directory would bypass install_skill's
 * checks (symlink-free checkout, SKILL.md validation).
 */
function isSkillsDirTarget(absPath: string): boolean {
  const resolved = resolveReal(absPath);
  for (const candidate of [absPath, resolved?.real]) {
    if (!candidate) continue;
    const segs = candidate.toLowerCase().split(path.sep);
    const i = segs.indexOf(".automaton");
    if (i >= 0 && segs[i + 1] === "skills") return true;
  }
  return false;
}

/**
 * Deny writes to protected files.
 * Applies to: write_file, edit_own_file, git_clone
 */
function createProtectedFilesRule(): PolicyRule {
  return {
    id: "path.protected_files",
    description: "Deny writes to protected files",
    priority: 200,
    appliesTo: {
      by: "name",
      names: ["write_file", "edit_own_file", "git_clone"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const filePath = (request.args.path as string | undefined);
      if (!filePath) return null;
      const toolName = request.tool.name;

      const candidates = candidatePaths(toolName, filePath);
      for (const [index, candidate] of candidates.entries()) {
        const decision = checkWrite(candidate, { allowDirectory: toolName === "git_clone" });
        if (!decision.ok && !isUnreachableFallback(decision, index)) {
          return deny(
            "path.protected_files",
            writeReasonCode(decision),
            `Cannot write to protected file: ${filePath} (${decision.code}: ${decision.reason})`,
          );
        }
        if (toolName === "git_clone" && isSkillsDirTarget(candidate)) {
          return deny(
            "path.protected_files",
            "PROTECTED_FILE",
            `Cannot clone into the skills directory: ${filePath} (use install_skill)`,
          );
        }
      }
      return null;
    },
  };
}

/**
 * Deny reads of sensitive files (wallet, env, config secrets, keys, state).
 * Applies to: read_file
 */
function createReadSensitiveRule(): PolicyRule {
  return {
    id: "path.read_sensitive",
    description: "Deny reads of sensitive files (wallet, env, config, keys)",
    priority: 200,
    appliesTo: {
      by: "name",
      names: ["read_file"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const filePath = (request.args.path as string | undefined);
      if (!filePath) return null;

      const candidates = candidatePaths("read_file", filePath);
      for (const [index, candidate] of candidates.entries()) {
        const decision = checkRead(candidate);
        if (!decision.ok && !isUnreachableFallback(decision, index)) {
          return deny(
            "path.read_sensitive",
            "SENSITIVE_FILE_READ",
            `Cannot read sensitive file: ${filePath} (${decision.code})`,
          );
        }
      }
      return null;
    },
  };
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Deny paths that resolve outside the working directory.
 *
 * Only applies to edit_own_file, which modifies local agent source code.
 * write_file and read_file operate on the remote Conway sandbox via API,
 * so local cwd-based traversal checks are not meaningful for them and
 * will false-positive on every absolute sandbox path (e.g. /home/conway/app.py).
 */
function createTraversalDetectionRule(): PolicyRule {
  return {
    id: "path.traversal_detection",
    description: "Deny paths containing traversal sequences after resolution",
    priority: 200,
    appliesTo: {
      by: "name",
      names: ["edit_own_file"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const filePath = (request.args.path as string | undefined);
      if (!filePath) return null;

      // Check for double-slash tricks
      if (filePath.includes("//")) {
        return deny(
          "path.traversal_detection",
          "PATH_TRAVERSAL",
          `Suspicious path pattern detected: "${filePath}"`,
        );
      }

      // Containment on real paths: a symlinked parent cannot point outside.
      const cwd = process.cwd();
      const realCwd = resolveReal(cwd)?.real ?? cwd;
      const resolved = path.resolve(cwd, expandHome(filePath));
      const real = resolveReal(resolved);
      if (!isWithin(resolved, cwd) || !real || !isWithin(real.real, realCwd)) {
        return deny(
          "path.traversal_detection",
          "PATH_TRAVERSAL",
          `Path resolves outside working directory: "${filePath}"`,
        );
      }

      return null;
    },
  };
}

export function createPathProtectionRules(): PolicyRule[] {
  return [
    createProtectedFilesRule(),
    createReadSensitiveRule(),
    createTraversalDetectionRule(),
  ];
}
