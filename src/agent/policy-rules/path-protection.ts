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
  matchHomeStartupContainer,
  matchSensitive,
  resolveReal,
  type PathDecision,
} from "../../security/protected-paths.js";
import { isLocalSandboxId } from "../../conway/client.js";

/** The home of a remote Conway sandbox. It is not on this machine. */
const SANDBOX_HOME = "/root";

type SandboxMode = "local" | "remote" | "unknown";

/** Where the tool really acts: this machine, a remote sandbox, or unknown (no identity in context). */
function sandboxMode(request: PolicyRequest): SandboxMode {
  const identity = request.context?.identity;
  if (!identity) return "unknown";
  return isLocalSandboxId(identity.sandboxId) ? "local" : "remote";
}

interface Candidate {
  path: string;
  /** The path the tool acts on: it must be inspectable or the call is denied. */
  strict: boolean;
}

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

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** /root when it is not this process's home: a non-root user often cannot even list it. */
function isForeignSandboxHome(candidate: string): boolean {
  return isWithin(candidate, SANDBOX_HOME) && path.resolve(homeDir()) !== SANDBOX_HOME;
}

/**
 * Absolute paths a tool may act on for this argument, primary first. When the
 * tool and its fallbacks resolve the path against different bases, every
 * base is checked. Only the primary path is strict, and never under a /root
 * that is not this process's home (a remote sandbox's home, or one a
 * non-root user cannot list); the others are still checked by name and, when
 * they can be inspected, on disk.
 */
function candidatePaths(toolName: string, filePath: string, mode: SandboxMode): Candidate[] {
  const paths = candidatePathList(toolName, filePath, mode);
  return paths.map((p, index) => ({
    path: p,
    strict: index === 0 && !isForeignSandboxHome(p),
  }));
}

function candidatePathList(toolName: string, filePath: string, mode: SandboxMode): string[] {
  if (path.isAbsolute(filePath)) return [path.resolve(filePath)];
  const home = homeDir();
  if (!filePath.startsWith("~")) return relativeCandidates(toolName, filePath, home, mode);

  // The tools expand any leading "~" (join(HOME or /root, p.slice(1))), so
  // "~name/x" means HOME/name/x to them, while expandHome and the quoted
  // shell fallbacks read it literally. Check both readings.
  const rest = filePath.slice(1).replace(/^\/+/, "");
  let expanded: string[];
  switch (toolName) {
    case "write_file":
    case "git_clone":
      expanded = homeBases(home, mode).map((base) => path.resolve(base, rest));
      break;
    case "edit_own_file":
      expanded = [path.resolve(home, rest)];
      break;
    default:
      expanded = [path.resolve(home, rest), path.resolve(SANDBOX_HOME, rest)];
  }
  if (filePath === "~" || filePath.startsWith("~/")) return unique(expanded);
  return unique([...expanded, ...relativeCandidates(toolName, filePath, home, mode)]);
}

/**
 * Bases write_file and git_clone resolve against, the real one first: the
 * real HOME locally, /root in a remote sandbox. Locally they never touch
 * /root unless it is HOME.
 */
function homeBases(home: string, mode: SandboxMode): string[] {
  if (mode === "local") return [home];
  if (mode === "remote") return unique([SANDBOX_HOME, home]);
  return unique([home, SANDBOX_HOME]);
}

function relativeCandidates(toolName: string, filePath: string, home: string, mode: SandboxMode): string[] {
  switch (toolName) {
    case "write_file":
    case "git_clone":
      return unique(homeBases(home, mode).map((base) => path.resolve(base, filePath)));
    case "edit_own_file":
      return [path.resolve(process.cwd(), filePath)];
    case "read_file":
    default:
      // Local read_file resolves relative paths against HOME (as write_file
      // and exec do); remote reads and their `cat` fallback use /root. cwd is
      // kept because conway.readFile's local client still resolves there.
      return unique([
        path.resolve(home, filePath),
        path.resolve(process.cwd(), filePath),
        path.resolve(SANDBOX_HOME, filePath),
      ]);
  }
}

/** Only a strict candidate is denied for being uninspectable; the name checks already passed. */
function isForgivenUnresolvable(decision: PathDecision, candidate: Candidate): boolean {
  return !candidate.strict && decision.code === "UNRESOLVABLE";
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

/** A clone target that is a home or would create or fill a startup directory, by name or real path. */
function isHomeStartupCloneTarget(absPath: string): string | null {
  const resolved = resolveReal(absPath);
  for (const candidate of [absPath, resolved?.real]) {
    const rule = candidate ? matchHomeStartupContainer(candidate) : null;
    if (rule) return rule;
  }
  return null;
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

      for (const candidate of candidatePaths(toolName, filePath, sandboxMode(request))) {
        const decision = checkWrite(candidate.path, { allowDirectory: toolName === "git_clone" });
        if (!decision.ok && !isForgivenUnresolvable(decision, candidate)) {
          return deny(
            "path.protected_files",
            writeReasonCode(decision),
            `Cannot write to protected file: ${filePath} (${decision.code}: ${decision.reason})`,
          );
        }
        const startup = toolName === "git_clone" ? isHomeStartupCloneTarget(candidate.path) : null;
        if (startup) {
          return deny(
            "path.protected_files",
            "PROTECTED_FILE",
            `Cannot clone into a home startup directory: ${filePath} (${startup})`,
          );
        }
        if (toolName === "git_clone" && isSkillsDirTarget(candidate.path)) {
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

      for (const candidate of candidatePaths("read_file", filePath, sandboxMode(request))) {
        const decision = checkRead(candidate.path);
        if (!decision.ok && !isForgivenUnresolvable(decision, candidate)) {
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
