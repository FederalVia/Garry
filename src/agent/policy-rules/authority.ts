/**
 * Authority Policy Rules
 *
 * Controls what actions are allowed based on input authority level.
 * External/heartbeat-initiated turns cannot use dangerous tools
 * or modify protected files.
 */

import path from "node:path";
import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
} from "../../types.js";
import { checkInboxToolCall, isInboxSource } from "../inbox-isolation.js";

/** Files protected from external-source self-modification */
const PROTECTED_PATHS = [
  "constitution.md",
  "SOUL.md",
  "automaton.json",
  "heartbeat.yml",
  "wallet.json",
  "config.json",
  "mcp-servers.json",
  "policy-engine",
  "policy-rules",
  "injection-defense",
  "self-mod/code",
  "audit-log",
] as const;

const CODE_FILE_EXTENSION = /\.(?:d\.ts|ts|tsx|js|jsx|mjs|cjs)$/i;

/**
 * Match protected entries against whole path segments. An entry matches a run
 * of consecutive segments, where a segment matches by its full name or by its
 * name without a code extension ("policy-engine" matches "policy-engine.ts").
 * Substring matching would also catch "tsconfig.json" or "docs/audit-log.md".
 */
function matchProtectedPath(filePath: string): string | undefined {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/").toLowerCase());
  const segments = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
  const stems = segments.map((s) => s.replace(CODE_FILE_EXTENSION, ""));
  for (const entry of PROTECTED_PATHS) {
    const parts = entry.toLowerCase().split("/");
    for (let i = 0; i + parts.length <= segments.length; i++) {
      const matches = parts.every(
        (part, j) => segments[i + j] === part || stems[i + j] === part,
      );
      if (matches) return entry;
    }
  }
  return undefined;
}

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

/**
 * Tools that run a shell command or start a process.
 * On an inbox or unknown turn these can rewrite files or reach payment
 * endpoints even when the spend and edit tools are denied.
 */
const INBOX_SHELL_TOOLS = [
  "exec",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_push",
  "git_branch",
  "git_clone",
  "start_child",
  "stop_child",
  "install_skill",
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
          ...INBOX_SHELL_TOOLS,
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

      if (
        (INBOX_SHELL_TOOLS as readonly string[]).includes(toolName) &&
        isInboxOrUnknownSource(source)
      ) {
        return deny(
          "authority.external_tool_restriction",
          "EXTERNAL_DANGEROUS_TOOL",
          `Untrusted input (source: ${sourceLabel}) cannot run shell or process tool "${toolName}"`,
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

      const protectedPath = matchProtectedPath(filePath);
      if (protectedPath) {
        return deny(
          "authority.self_mod_from_external",
          "EXTERNAL_SELF_MOD",
          `External input cannot modify protected path: "${filePath}" (matches "${protectedPath}")`,
        );
      }

      return null;
    },
  };
}

/**
 * Default deny for inbox turns.
 *
 * Applies only when the source is "external" or another non-empty source the
 * runtime does not set. A missing or empty source and "heartbeat" are
 * source-less autonomous turns and keep the rules above. This is keyed on the
 * source string, not on PolicyEngine.deriveAuthorityLevel, which also maps a
 * missing source to "external".
 *
 * Only send_message passes, once per turn, addressed to the sender of the
 * batch. Every other tool, including tools added later, installed tools and
 * MCP tools, is denied. Runs before the other rules so the refusal does not
 * echo arguments chosen on an untrusted turn.
 */
function createInboxAllowListRule(): PolicyRule {
  return {
    id: "authority.inbox_allow_list",
    description: "Inbox and unknown-source turns may only reply to the sender",
    priority: 50,
    appliesTo: { by: "all" },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const turn = request.turnContext;
      if (!isInboxSource(turn.inputSource)) return null;
      const refusal = checkInboxToolCall(request.tool.name, request.args, {
        sender: turn.inboxSender,
        messageIds: turn.inboxMessageIds,
        selfAddress: request.context.identity?.address,
        sendCount: turn.inboxSendCount ?? 0,
      });
      if (!refusal) return null;
      return deny("authority.inbox_allow_list", refusal.code, refusal.message);
    },
  };
}

/**
 * Third-party tools (MCP) run code or services the runtime does not control
 * and return text someone else chose. Same treatment as the shell tools:
 * denied on inbox and unknown sources, allowed on source-less, heartbeat and
 * elevated turns. The inbox allow-list (priority 50) already denies them on
 * inbox turns; this also covers unknown source strings.
 */
function createThirdPartyToolRule(): PolicyRule {
  return {
    id: "authority.third_party_tools",
    description: "Deny third-party (MCP) tools on inbox and unknown-source turns",
    priority: 400,
    appliesTo: { by: "risk", levels: ["third_party"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const source = request.turnContext.inputSource;
      if (!isInboxOrUnknownSource(source)) return null;
      return deny(
        "authority.third_party_tools",
        "EXTERNAL_THIRD_PARTY_TOOL",
        `Untrusted input (source: ${source || "undefined"}) cannot use third-party tool "${request.tool.name}"`,
      );
    },
  };
}

/**
 * Create all authority policy rules.
 */
export function createAuthorityRules(): PolicyRule[] {
  return [
    createInboxAllowListRule(),
    createExternalToolRestrictionRule(),
    createSelfModFromExternalRule(),
    createThirdPartyToolRule(),
  ];
}
