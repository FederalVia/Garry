/**
 * Authority Policy Rules
 *
 * Controls what actions are allowed based on input authority level.
 * External/heartbeat-initiated turns cannot use dangerous tools
 * or modify protected files.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
} from "../../types.js";

/** Files protected from external-source self-modification */
const PROTECTED_PATHS = [
  "constitution.md",
  "SOUL.md",
  "automaton.json",
  "heartbeat.yml",
  "wallet.json",
  "config.json",
  "policy-engine",
  "policy-rules",
  "injection-defense",
  "self-mod/code",
  "audit-log",
] as const;

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Sources that keep elevated authority when a caller sets them explicitly.
 * Inbox delivery never sets one of these. A missing source is not elevated.
 */
const ELEVATED_SOURCES = new Set(["creator", "agent", "system", "wakeup"]);

/**
 * Check if an input source represents external (non-agent) authority.
 * Unknown values are external. Heartbeat and source-less turns stay external,
 * which is their existing classification.
 */
function isExternalSource(inputSource: string | undefined): boolean {
  if (inputSource === undefined || inputSource === "" || inputSource === "heartbeat") {
    return true;
  }
  return !ELEVATED_SOURCES.has(inputSource);
}

/**
 * Inbox messages and unrecognized sources.
 *
 * Heartbeat tasks and source-less autonomous turns are not inbox input.
 * They keep the original external-tool list and are not newly blocked
 * from transfer_credits or ordinary file writes.
 */
function isInboxOrUnknownSource(inputSource: string | undefined): boolean {
  if (inputSource === undefined || inputSource === "heartbeat") {
    return false;
  }
  return !ELEVATED_SOURCES.has(inputSource);
}

/** True for creator, agent, system, and wakeup. Missing sources are not elevated. */
export function isElevatedInputSource(inputSource: string | undefined): boolean {
  return inputSource !== undefined && inputSource !== "" && ELEVATED_SOURCES.has(inputSource);
}

/**
 * True for inbox input and any source the runtime does not explicitly trust.
 * Heartbeat and missing sources are handled by the older external rules.
 */
export function isUntrustedInputSource(inputSource: string | undefined): boolean {
  return isInboxOrUnknownSource(inputSource);
}

/**
 * Tools that must be blocked from external/heartbeat input sources.
 *
 * These are genuinely destructive or high-autonomy operations that should
 * only be initiated by an elevated source — never from heartbeat tasks
 * or untrusted external input.
 */
const EXTERNAL_BLOCKED_TOOLS = [
  "delete_sandbox",
  "spawn_child",
  "fund_child",
  "update_genesis_prompt",
] as const;

/** Money movement. Inbox and unknown sources cannot use these. */
const INBOX_SPEND_TOOLS = [
  "transfer_credits",
  "x402_fetch",
  "topup_credits",
  "fund_child",
] as const;

/** Tools that change the agent's own code or installed runtime. */
const INBOX_CODE_TOOLS = [
  "edit_own_file",
  "pull_upstream",
  "reset_to_upstream",
  "install_npm_package",
  "install_mcp_server",
  "revert_last_edit",
] as const;

const CODE_PATH = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|sol)$/i;

function isAgentCodePath(filePath: string): boolean {
  const pathOnly = filePath.split(/[?#]/, 1)[0] ?? filePath;
  return CODE_PATH.test(pathOnly);
}

/**
 * Deny specific high-risk tools when input comes from external sources.
 * Only agent-initiated or creator turns can use these tools.
 */
function createExternalToolRestrictionRule(): PolicyRule {
  return {
    id: "authority.external_tool_restriction",
    description: "Deny destructive/high-autonomy tools from external/heartbeat input sources",
    priority: 400,
    appliesTo: {
      by: "name",
      names: [
        ...new Set<string>([
          ...EXTERNAL_BLOCKED_TOOLS,
          ...INBOX_SPEND_TOOLS,
          ...INBOX_CODE_TOOLS,
        ]),
      ],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const source = request.turnContext.inputSource;
      const toolName = request.tool.name;
      const sourceLabel = source || "undefined";

      if (
        (EXTERNAL_BLOCKED_TOOLS as readonly string[]).includes(toolName) &&
        isExternalSource(source)
      ) {
        return deny(
          "authority.external_tool_restriction",
          "EXTERNAL_DANGEROUS_TOOL",
          `External input (source: ${sourceLabel}) cannot use dangerous tool "${toolName}"`,
        );
      }

      if (
        (INBOX_SPEND_TOOLS as readonly string[]).includes(toolName) &&
        isInboxOrUnknownSource(source)
      ) {
        return deny(
          "authority.external_tool_restriction",
          "EXTERNAL_DANGEROUS_TOOL",
          `Untrusted input (source: ${sourceLabel}) cannot spend via "${toolName}"`,
        );
      }

      if (
        (INBOX_CODE_TOOLS as readonly string[]).includes(toolName) &&
        isInboxOrUnknownSource(source)
      ) {
        return deny(
          "authority.external_tool_restriction",
          "EXTERNAL_SELF_MOD",
          `Untrusted input (source: ${sourceLabel}) cannot modify agent code via "${toolName}"`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny self-modification from external sources targeting protected paths.
 */
function createSelfModFromExternalRule(): PolicyRule {
  return {
    id: "authority.self_mod_from_external",
    description: "Deny edit_own_file/write_file targeting protected paths from external input",
    priority: 400,
    appliesTo: { by: "name", names: ["edit_own_file", "write_file"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const source = request.turnContext.inputSource;
      const filePath = request.args.path as string | undefined;

      if (
        isInboxOrUnknownSource(source) &&
        request.tool.name === "write_file" &&
        filePath &&
        isAgentCodePath(filePath)
      ) {
        return deny(
          "authority.self_mod_from_external",
          "EXTERNAL_SELF_MOD",
          `Untrusted input cannot modify code path: "${filePath}"`,
        );
      }

      if (!isExternalSource(source)) {
        return null;
      }

      if (!filePath) return null;

      const normalizedPath = filePath.toLowerCase();
      for (const protectedPath of PROTECTED_PATHS) {
        if (
          normalizedPath.includes(protectedPath.toLowerCase())
        ) {
          return deny(
            "authority.self_mod_from_external",
            "EXTERNAL_SELF_MOD",
            `External input cannot modify protected path: "${filePath}" (matches "${protectedPath}")`,
          );
        }
      }

      return null;
    },
  };
}

/**
 * Create all authority policy rules.
 */
export function createAuthorityRules(): PolicyRule[] {
  return [
    createExternalToolRestrictionRule(),
    createSelfModFromExternalRule(),
  ];
}
