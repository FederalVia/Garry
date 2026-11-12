/**
 * Inbox isolation
 *
 * A social inbox batch is handled in one isolated turn. That turn may only
 * reply to the sender, and nothing it saw or produced is shown to a later
 * turn that is not itself an inbox turn. This module holds the shared
 * definitions: which sources are untrusted, which stored turns are isolated,
 * and which tool calls an inbox turn may make.
 */

import { detectChainType, isValidAddress, normalizeAddress } from "../identity/chain.js";

/** Label placed in front of every inbox message shown to the model. */
export const INBOX_LABEL = "UNTRUSTED EXTERNAL SENDER";

/** Turn sources set by the runtime itself. Anything else is untrusted. */
export const TRUSTED_TURN_SOURCES: readonly string[] = Object.freeze([
  "creator",
  "agent",
  "system",
  "wakeup",
  "heartbeat",
]);

const TRUSTED_SOURCE_SET = new Set(TRUSTED_TURN_SOURCES);

/** Inbox rows written before inbox turns were labelled "external". */
const LEGACY_INBOX_PREFIXES = ["[Message from ", "[INJECTION BLOCKED from "] as const;

/** The only tools an inbox turn may call. */
export const INBOX_ALLOWED_TOOLS: readonly string[] = Object.freeze(["send_message"]);

/** Most earlier turns from the same sender shown on an inbox turn. */
export const INBOX_HISTORY_LIMIT = 5;

/** True for a well-formed EVM or Solana address. */
export function isValidSenderAddress(value: unknown): value is string {
  return typeof value === "string" && isValidAddress(value);
}

/**
 * Canonical form of a sender address for comparisons: EVM addresses are
 * case-insensitive hex, Solana base58 addresses are case-sensitive. Returns
 * null for anything that is not a well-formed address.
 */
export function normalizeSenderAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const chain = detectChainType(value);
  return chain ? normalizeAddress(value, chain) : null;
}

/**
 * True for "external" and any other non-empty source the runtime does not set.
 * A missing or empty source is a source-less autonomous turn, not inbox input,
 * and keeps its existing rules.
 */
export function isInboxSource(source: string | null | undefined): boolean {
  return typeof source === "string" && source !== "" && !TRUSTED_SOURCE_SET.has(source);
}

/**
 * True when a stored turn handled inbox input. Such a turn is never shown to
 * a privileged turn. The check uses the stored source, not the label, so a
 * change to the label or a row written without it still counts.
 */
export function isIsolatedTurn(turn: {
  inputSource?: string | null;
  input?: string | null;
}): boolean {
  if (isInboxSource(turn.inputSource)) return true;
  if (turn.inputSource === "agent" && typeof turn.input === "string") {
    return LEGACY_INBOX_PREFIXES.some((prefix) => turn.input!.startsWith(prefix));
  }
  return false;
}

/**
 * SQL form of isIsolatedTurn for the turns table, optionally qualified with a
 * table alias. instr() is case-sensitive, matching startsWith above.
 */
export function isolatedTurnSql(alias?: string): string {
  // IFNULL keeps every comparison boolean: a NULL here would make NOT (...)
  // NULL and silently drop source-less turns from a filtered query.
  const src = `IFNULL(${alias ? `${alias}.` : ""}input_source, '')`;
  const input = `IFNULL(${alias ? `${alias}.` : ""}input, '')`;
  const trusted = TRUSTED_TURN_SOURCES.map((s) => `'${s}'`).join(", ");
  const legacy = LEGACY_INBOX_PREFIXES.map((p) => `instr(${input}, '${p}') = 1`).join(" OR ");
  return `((${src} <> '' AND ${src} NOT IN (${trusted}))` +
    ` OR (${src} = 'agent' AND (${legacy})))`;
}

export const ISOLATED_TURN_SQL = isolatedTurnSql();

/** Format one inbox message for the model. */
export function formatInboxMessage(sender: string, body: string): string {
  return `[${INBOX_LABEL} ${sender}]: ${body}`;
}

/** Prefix every stored inbox turn from this sender starts with. */
export function inboxTurnPrefix(sender: string): string {
  return `[${INBOX_LABEL} ${sender}]: `;
}

export interface InboxToolCallContext {
  /** Address of the sender whose batch this turn is handling. */
  sender?: string;
  /** Ids of the inbox messages in the batch. */
  messageIds?: string[];
  /** The agent's own address. */
  selfAddress?: string;
  /** send_message calls already allowed on this turn. */
  sendCount: number;
}

export interface InboxToolRefusal {
  code: string;
  message: string;
}

/**
 * Decide whether an inbox turn may make this call. Returns null to allow.
 * Messages never repeat the arguments, which are model output on a turn that
 * read untrusted text.
 */
export function checkInboxToolCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: InboxToolCallContext,
): InboxToolRefusal | null {
  if (!INBOX_ALLOWED_TOOLS.includes(toolName)) {
    return {
      code: "INBOX_TOOL_NOT_ALLOWED",
      message: "An inbox turn can only reply to the sender with send_message",
    };
  }

  // send_message: one reply, to the batch sender, never to ourselves.
  const to = normalizeSenderAddress(args.to_address);
  const sender = normalizeSenderAddress(ctx.sender);
  if (!sender || to !== sender) {
    return {
      code: "INBOX_REPLY_ONLY",
      message: "An inbox turn can only send a message to the sender of the batch",
    };
  }
  if (ctx.selfAddress && to === normalizeSenderAddress(ctx.selfAddress)) {
    return {
      code: "INBOX_REPLY_ONLY",
      message: "An inbox turn cannot send a message to the agent's own address",
    };
  }
  if (ctx.sendCount >= 1) {
    return {
      code: "INBOX_REPLY_LIMIT",
      message: "An inbox turn can send at most one reply",
    };
  }
  const replyTo = args.reply_to;
  if (replyTo !== undefined && replyTo !== null && replyTo !== "") {
    if (typeof replyTo !== "string" || !(ctx.messageIds ?? []).includes(replyTo)) {
      return {
        code: "INBOX_REPLY_ONLY",
        message: "reply_to must be the id of a message in this batch",
      };
    }
  }
  return null;
}
