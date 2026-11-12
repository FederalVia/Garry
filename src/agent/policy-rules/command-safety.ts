/**
 * Command Safety Policy Rules
 *
 * Detects shell injection attempts and forbidden command patterns.
 *
 * The forbidden-command check is a TRIPWIRE, not a security boundary. It
 * stops accidental damage and copy-pasted injection one-liners: it denies a
 * command that names a secret (whatever the verb), globs hidden home paths,
 * dumps the environment, kills the runtime, or writes to guard files. exec
 * runs as the same OS user that owns the wallet, so interpreters, variable
 * indirection or scripts written to disk get past any pattern list. Only
 * privilege separation closes that.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import {
  GUARD_COMMAND_FRAGMENTS,
  SENSITIVE_COMMAND_FRAGMENTS,
  homeDir,
} from "../../security/protected-paths.js";

// Shell metacharacters that could enable injection when interpolated
const SHELL_METACHAR_RE = /[;|&$`\n(){}<>]/;

// Tools whose arguments may be interpolated into shell commands
const SHELL_INTERPOLATED_TOOLS = new Set([
  "exec",
  "pull_upstream",
  "install_npm_package",
  "install_mcp_server",
  "install_skill",
  "create_skill",
  "remove_skill",
]);

// Fields per tool that get interpolated into shell commands
const SHELL_FIELDS: Record<string, string[]> = {
  exec: [], // exec is the shell itself, handled by forbidden_patterns
  pull_upstream: ["commit"],
  install_npm_package: ["package"],
  install_mcp_server: ["package", "name"],
  install_skill: ["name", "url"],
  create_skill: ["name"],
  remove_skill: ["name"],
};

// Forbidden command patterns (migrated from tools.ts isForbiddenCommand)
const FORBIDDEN_COMMAND_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Self-destruction
  { pattern: /rm\s+(-rf?\s+)?.*\.automaton/, description: "Delete .automaton directory" },
  { pattern: /rm\s+(-rf?\s+)?.*state\.db/, description: "Delete state database" },
  { pattern: /rm\s+(-rf?\s+)?.*wallet\.json/, description: "Delete wallet" },
  { pattern: /rm\s+(-rf?\s+)?.*automaton\.json/, description: "Delete config" },
  { pattern: /rm\s+(-rf?\s+)?.*heartbeat\.yml/, description: "Delete heartbeat config" },
  { pattern: /rm\s+(-rf?\s+)?.*SOUL\.md/, description: "Delete SOUL.md" },
  // Process killing
  { pattern: /kill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /pkill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /systemctl\s+(stop|disable)\s+automaton/, description: "Stop automaton service" },
  // Database destruction
  { pattern: /DROP\s+TABLE/i, description: "Drop database table" },
  { pattern: /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i, description: "Delete from critical table" },
  { pattern: /TRUNCATE/i, description: "Truncate table" },
  // Safety infrastructure modification via shell
  { pattern: /sed\s+.*injection-defense/, description: "Modify injection defense via sed" },
  { pattern: /sed\s+.*self-mod\/code/, description: "Modify self-mod code via sed" },
  { pattern: /sed\s+.*audit-log/, description: "Modify audit log via sed" },
  { pattern: />\s*.*injection-defense/, description: "Overwrite injection defense" },
  { pattern: />\s*.*self-mod\/code/, description: "Overwrite self-mod code" },
  { pattern: />\s*.*audit-log/, description: "Overwrite audit log" },
  // Credential harvesting
  { pattern: /cat\s+.*\.ssh/, description: "Read SSH keys" },
  { pattern: /cat\s+.*\.gnupg/, description: "Read GPG keys" },
  { pattern: /cat\s+.*\.env/, description: "Read environment file" },
  { pattern: /cat\s+.*wallet\.json/, description: "Read wallet file" },
  // Policy engine modification via shell
  { pattern: /sed\s+.*policy-engine/, description: "Modify policy engine via sed" },
  { pattern: /sed\s+.*policy-rules/, description: "Modify policy rules via sed" },
  { pattern: />\s*.*policy-engine/, description: "Overwrite policy engine" },
  { pattern: />\s*.*policy-rules/, description: "Overwrite policy rules" },
];

/**
 * Normalised copy of a command for the tripwire: lower-cased, quotes and
 * backslashes removed, and the home directory spelled "~".
 */
export function normalizeCommand(command: string): string {
  let out = command.replace(/["'\\`]/g, "");
  const home = homeDir();
  if (home && home !== "/") out = out.split(home).join("~");
  out = out.toLowerCase();
  out = out.replace(/\$\{home\}|\$home\b/g, "~");
  out = out.replace(/(^|[^a-z0-9_.\-/])\/root(?=\/|$|[^a-z0-9_.\-])/g, "$1~");
  return out;
}

/** State-dir entries a command may name. Anything else under .automaton trips. */
const STATE_DIR_COMMAND_ALLOWED = /^\/(?:workspace|worklog\.md|skills|agent\.log|logs|runtime|soul\.md|heartbeat\.yml|constitution\.md)(?:\/|$)/;

function automatonTokenMatch(normalized: string): string | null {
  for (const token of normalized.split(/[\s;|&<>()=,]+/)) {
    let index = token.indexOf(".automaton");
    while (index >= 0) {
      const rest = token.slice(index + ".automaton".length);
      if (!STATE_DIR_COMMAND_ALLOWED.test(rest) || rest.includes("/..")) {
        return token;
      }
      index = token.indexOf(".automaton", index + 1);
    }
  }
  return null;
}

const WRITE_VERB = /(?:^|[\s;|&(])(?:cp|mv|tee|dd|install|ln|rsync|truncate|chmod|chown|rm|unlink|shred|touch)(?=\s)|(?:^|[\s;|&(])sed\s+(?:-[a-z]*i|--in-place)|(?:^|[\s;|&(])perl\s+-[a-z]*i|>(?!&|\s*\/dev\/null)/;

const ENV_DUMP_PATTERNS: RegExp[] = [
  /(?:^|[;&|(]|\s)env\s*(?:$|[|;&>])/,
  /(?:^|[;&|(\s])printenv(?:\s|$|[|;&>])/,
  /(?:^|[;&|(\s])export\s+-p\b/,
  /(?:^|[;&|(\s])declare\s+-[a-z]*[xp]/,
  /(?:^|[;&|(\s])compgen\s+-[a-z]*e/,
  /(?:^|[;&|(])\s*set\s*(?:$|[|;&>])/,
];

const SELF_KILL_PATTERNS: RegExp[] = [
  /(?:^|[;&|(\s])(?:pkill|killall)\b[^;&|]*\b(?:node|tsx|automaton)\b/,
  /(?:^|[;&|(\s])kill\b[^;&|]*\$\((?:\s*)(?:pgrep|pidof)\b/,
  /(?:^|[;&|(\s])kill\b[^;&|]*(?:\$\$|\$ppid\b|\s-1\b|\s1(?:\s|$))/,
];

function tripwireMatch(command: string): { description: string; pattern: string } | null {
  const normalized = normalizeCommand(command);

  for (const { re, label } of SENSITIVE_COMMAND_FRAGMENTS) {
    if (re.test(normalized)) return { description: `References ${label}`, pattern: re.source };
  }
  const stateToken = automatonTokenMatch(normalized);
  if (stateToken) {
    return { description: "References the state directory outside its allowed entries", pattern: stateToken.slice(0, 80) };
  }
  if (/~\/\.[^\s/]*[*?[]/.test(normalized) || /(?:^|[\s/=])\.a(?:u(?:t(?:o(?:m(?:a(?:t(?:o(?:n)?)?)?)?)?)?)?)?[*?[]/.test(normalized)) {
    return { description: "Glob over hidden home paths", pattern: "hidden-home-glob" };
  }
  for (const re of ENV_DUMP_PATTERNS) {
    if (re.test(normalized)) return { description: "Dumps the process environment", pattern: re.source };
  }
  for (const re of SELF_KILL_PATTERNS) {
    if (re.test(normalized)) return { description: "Kills the runtime process", pattern: re.source };
  }
  if (WRITE_VERB.test(normalized)) {
    const fragment = GUARD_COMMAND_FRAGMENTS.find((f) => normalized.includes(f));
    if (fragment) return { description: `Writes to guard file (${fragment})`, pattern: fragment };
  }
  return null;
}

export function getForbiddenCommandMatch(command: string): { description: string; pattern: string } | null {
  for (const { pattern, description } of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { description, pattern: pattern.source };
    }
  }
  return tripwireMatch(command);
}

export function isForbiddenCommand(command: string): boolean {
  return getForbiddenCommandMatch(command) !== null;
}

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Detect shell metacharacters in tool arguments that will be
 * interpolated into shell commands.
 */
function createShellInjectionRule(): PolicyRule {
  return {
    id: "command.shell_injection",
    description: "Detect shell metacharacters in arguments interpolated into shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: Array.from(SHELL_INTERPOLATED_TOOLS),
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const fields = SHELL_FIELDS[request.tool.name];
      if (!fields || fields.length === 0) return null;

      for (const field of fields) {
        const value = request.args[field];
        if (typeof value !== "string") continue;

        if (SHELL_METACHAR_RE.test(value)) {
          return deny(
            "command.shell_injection",
            "SHELL_INJECTION_DETECTED",
            `Shell metacharacter detected in ${request.tool.name}.${field}: "${value.slice(0, 50)}"`,
          );
        }
      }

      return null;
    },
  };
}

/**
 * Check exec commands against forbidden patterns.
 * Replaces the isForbiddenCommand() function with a proper policy rule.
 */
function createForbiddenPatternsRule(): PolicyRule {
  return {
    id: "command.forbidden_patterns",
    description: "Block self-destructive and credential-harvesting shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: ["exec"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const command = request.args.command as string | undefined;
      if (!command) return null;

      const match = getForbiddenCommandMatch(command);
      if (match) {
        return deny(
          "command.forbidden_patterns",
          "FORBIDDEN_COMMAND",
          `Blocked: ${match.description} (pattern: ${match.pattern})`,
        );
      }

      return null;
    },
  };
}

export function createCommandSafetyRules(): PolicyRule[] {
  return [
    createShellInjectionRule(),
    createForbiddenPatternsRule(),
  ];
}
