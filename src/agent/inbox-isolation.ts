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

/** What the label says about the sender address. */
export const VERIFIED_SENDER_NOTE = "signature verified";
export const UNVERIFIED_SENDER_NOTE = "NOT VERIFIED: address reported by relay";

/** Marker in front of every line of a message body. */
export const INBOX_QUOTE = "> ";

function labelAddress(sender: string): string {
  // Addresses are alphanumeric; anything else could break out of the label.
  return sender.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 128) || "unknown";
}

/**
 * Prefix every stored inbox turn from this sender starts with. It says
 * whether the address was proven by a signature or only reported by the
 * relay.
 */
export function inboxTurnPrefix(sender: string, verified: boolean): string {
  const note = verified ? VERIFIED_SENDER_NOTE : UNVERIFIED_SENDER_NOTE;
  return `[${INBOX_LABEL} ${labelAddress(sender)} | ${note}]:\n`;
}

/**
 * Format one inbox message for the model: the label on its own line, then
 * every line of the body quoted. A label typed inside a body therefore never
 * starts a line, so a sender cannot forge another message's label (say, a
 * "signature verified" one for the creator's address).
 */
export function formatInboxMessage(sender: string, body: string, verified: boolean): string {
  const quoted = body
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .map((line) => INBOX_QUOTE + line)
    .join("\n");
  return inboxTurnPrefix(sender, verified) + quoted;
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
