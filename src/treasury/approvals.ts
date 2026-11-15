/**
 * Large-transfer approvals.
 *
 * A credit transfer above requireConfirmationAboveCents (and not above
 * maxSingleTransferCents) is denied APPROVAL_REQUIRED by the treasury once
 * every other check passes. The tool path then records a request here, in
 * state.db. The owner decides with `automaton-cli approvals approve|reject`,
 * which writes approval_decisions in the owner database (never writable by
 * the runtime). The approved transfer runs through the treasury with every
 * normal cap, exactly once: the treasury binds it to the decision row and to
 * approval_id on the ledger row inside its immediate transaction.
 *
 * The state of a request is derived from the request, the owner's decision
 * and the ledger rows; it is never stored as a mutable column.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { ConwayClient, CreditTransferResult, ResolvedTreasuryPolicy } from "../types.js";
import type { ApprovalDecision } from "../budget/owner-db.js";
import { isInboxSource } from "../agent/inbox-isolation.js";
import { isValidAddress, type ChainType } from "../identity/chain.js";
import { createLogger } from "../observability/logger.js";
import { DAY_MS, canonicalAddress } from "./policy.js";
import { currentTreasuryOrigin, runWithTreasuryOrigin } from "./registry.js";
import { OutcomeUnknownError, TransferRejectedError, TreasuryDeniedError } from "./types.js";
import { rethrowIfCancelled, throwIfCancelled } from "../runtime/cancellation.js";

const logger = createLogger("treasury.approvals");

export type ApprovalState =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "outcome_unknown"
  | "executed";

export interface ApprovalRequest {
  id: string;
  kind: "credit_transfer";
  counterparty: string;
  amountCents: number;
  /** Written by the agent: unverified, show escaped. */
  reason: string | null;
  originName: string | null;
  /** fund_child: the child id, so an execution from the heartbeat records the funding. */
  originRef: string | null;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ApprovalView extends ApprovalRequest {
  state: ApprovalState;
  /**
   * The id or recipient is not one createApprovalRequest would write: the row
   * was put there by hand. It is shown flagged and can never be decided.
   */
  malformed: boolean;
  decision: ApprovalDecision | null;
  /** The ledger row that executed (or is executing) it. */
  ledgerId: string | null;
}

export interface DecisionSource {
  decision(requestId: string): ApprovalDecision | null;
}

export const APPROVAL_ID_RE = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;
export const MAX_OPEN_APPROVALS = 3;
export const MAX_APPROVALS_PER_DAY = 10;
/** An identical request is refused this long after the owner rejected one. */
export const REJECTED_BLOCK_MS = DAY_MS;
export const APPROVAL_REASON_MAX = 200;
/** Request rows are kept this long after they reach a final state. */
export const APPROVAL_PRUNE_AFTER_MS = 30 * DAY_MS;
/** The heartbeat origin of approved transfers (not an automatic child-funding origin). */
export const APPROVED_TRANSFER_ORIGIN = "heartbeat.approved_transfer";

const DEFAULT_TTL_MS = DAY_MS;
const DEFAULT_EXECUTE_WINDOW_MS = 2 * 3_600_000;

interface RequestRow {
  id: string;
  kind: "credit_transfer";
  counterparty: string;
  amount_cents: number;
  reason: string | null;
  origin_name: string | null;
  origin_ref?: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  decision_seen: string | null;
  decision_seen_at_ms: number | null;
  executor_note: string | null;
  executor_attempt_at_ms: number | null;
}

function toRequest(r: RequestRow): ApprovalRequest {
  return {
    id: r.id,
    kind: r.kind,
    counterparty: r.counterparty,
    amountCents: r.amount_cents,
    reason: r.reason,
    originName: r.origin_name,
    originRef: r.origin_ref ?? null,
    createdAtMs: r.created_at_ms,
    expiresAtMs: r.expires_at_ms,
  };
}

export function newApprovalId(): string {
  return `apr_${ulid()}`;
}

export function approvalTtlMs(policy: Partial<Pick<ResolvedTreasuryPolicy, "approvalTtlMs">> | undefined): number {
  const v = policy?.approvalTtlMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

export function approvalExecuteWindowMs(
  policy: Partial<Pick<ResolvedTreasuryPolicy, "approvalExecuteWindowMs">> | undefined,
): number {
  const v = policy?.approvalExecuteWindowMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_EXECUTE_WINDOW_MS;
}

export function getApprovalRequest(db: BetterSqlite3.Database, id: string): ApprovalRequest | null {
  const row = db.prepare("SELECT * FROM transfer_approval_requests WHERE id = ?").get(id) as RequestRow | undefined;
  return row ? toRequest(row) : null;
}

/** Ledger rows that executed (or tried to) under this approval; denied rows excluded. */
export function approvalLedgerRows(
  db: BetterSqlite3.Database,
  id: string,
): Array<{ id: string; status: string }> {
  return db
    .prepare("SELECT id, status FROM treasury_ledger WHERE approval_id = ? AND status != 'denied' ORDER BY created_at_ms, id")
    .all(id) as Array<{ id: string; status: string }>;
}

export function approvalStatus(
  r: Pick<ApprovalRequest, "expiresAtMs">,
  d: ApprovalDecision | null,
  rows: Array<{ status: string }>,
  nowMs: number,
): ApprovalState {
  if (d?.decision === "rejected") return "rejected";
  if (rows.some((x) => x.status === "committed")) return "executed";
  if (rows.some((x) => x.status === "reserved" || x.status === "sent")) return "executing";
  if (rows.some((x) => x.status === "unknown")) return "outcome_unknown";
  if (d?.decision === "approved") {
    return d.executeByMs !== null && nowMs <= d.executeByMs ? "approved" : "expired";
  }
  return nowMs > r.expiresAtMs ? "expired" : "pending";
}

/**
 * The rows live in the agent's state.db, and their id and recipient end up in
 * a command the owner may paste into a shell: only these exact shapes pass.
 */
export function isWellFormedRequest(r: Pick<ApprovalRequest, "id" | "counterparty">, chainType?: ChainType): boolean {
  return (
    typeof r.id === "string" &&
    APPROVAL_ID_RE.test(r.id) &&
    typeof r.counterparty === "string" &&
    isValidAddress(r.counterparty, chainType)
  );
}

function viewOf(
  db: BetterSqlite3.Database,
  owner: DecisionSource,
  r: ApprovalRequest,
  nowMs: number,
  chainType?: ChainType,
): ApprovalView {
  const decision = safeDecision(owner, r.id);
  const rows = approvalLedgerRows(db, r.id);
  const state = approvalStatus(r, decision, rows, nowMs);
  const live = rows.find((x) => x.status !== "released");
  return { ...r, state, malformed: !isWellFormedRequest(r, chainType), decision, ledgerId: live?.id ?? null };
}

const OPEN_STATES: readonly ApprovalState[] = ["pending", "approved", "executing", "outcome_unknown"];

/** Newest first. Without `all`, only requests still open (pending, approved, executing, outcome unknown). */
export function listApprovalViews(
  db: BetterSqlite3.Database,
  owner: DecisionSource,
  nowMs: number,
  opts: { all?: boolean; chainType?: ChainType } = {},
): ApprovalView[] {
  const rows = db
    .prepare("SELECT * FROM transfer_approval_requests ORDER BY created_at_ms DESC, id DESC LIMIT 500")
    .all() as RequestRow[];
  const views = rows.map((r) => viewOf(db, owner, toRequest(r), nowMs, opts.chainType));
  return opts.all ? views : views.filter((v) => OPEN_STATES.includes(v.state));
}

function safeDecision(owner: DecisionSource, id: string): ApprovalDecision | null {
  try {
    return owner.decision(id);
  } catch (err) {
    logger.warn(`Approval decision read failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function sameRecipient(a: string, b: string): boolean {
  try {
    return canonicalAddress(a) === canonicalAddress(b);
  } catch {
    return a.trim() === b.trim();
  }
}

/** Control characters out, length capped: the reason is shown to the owner. */
function cleanReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = reason.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return text ? text.slice(0, APPROVAL_REASON_MAX) : null;
}

export type CreateApprovalResult =
  | { ok: true; request: ApprovalRequest; reused: boolean }
  | { ok: false; message: string };

/**
 * Record a pending request, or reuse a pending one for the same recipient
 * and amount. Refused when 3 are open, 10 were made in the last 24 h, or an
 * identical request was rejected in the last 24 h.
 */
export function createApprovalRequest(
  db: BetterSqlite3.Database,
  owner: DecisionSource,
  input: { counterparty: string; amountCents: number; reason?: string | null; originName?: string | null; originRef?: string | null },
  policy: Partial<Pick<ResolvedTreasuryPolicy, "approvalTtlMs">> | undefined,
  nowMs: number,
): CreateApprovalResult {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, message: "amount must be a positive whole number of cents" };
  }
  const counterparty = typeof input.counterparty === "string" ? input.counterparty.trim() : "";
  if (!counterparty) return { ok: false, message: "a recipient is required" };
  if (!isValidAddress(counterparty)) return { ok: false, message: "the recipient is not a valid wallet address" };

  const recent = db
    .prepare("SELECT * FROM transfer_approval_requests WHERE created_at_ms > ? ORDER BY created_at_ms DESC, id DESC")
    .all(nowMs - Math.max(approvalTtlMs(policy), DAY_MS) - DAY_MS) as RequestRow[];
  const views = recent.map((r) => viewOf(db, owner, toRequest(r), nowMs));
  const same = (v: ApprovalView) => v.amountCents === input.amountCents && sameRecipient(v.counterparty, counterparty);

  const reusable = views.find((v) => v.state === "pending" && same(v));
  if (reusable) return { ok: true, request: reusable, reused: true };

  const rejected = views.find(
    (v) => v.state === "rejected" && same(v) && v.decision !== null && nowMs - v.decision.decidedAtMs < REJECTED_BLOCK_MS,
  );
  if (rejected) {
    return {
      ok: false,
      message: `Your owner rejected an identical transfer (${rejected.id}) less than 24 hours ago; do not ask again yet.`,
    };
  }
  const open = views.filter((v) => v.state === "pending").length;
  if (open >= MAX_OPEN_APPROVALS) {
    return { ok: false, message: `${open} approval requests are already waiting for your owner; wait for a decision.` };
  }
  const lastDay = views.filter((v) => v.createdAtMs > nowMs - DAY_MS).length;
  if (lastDay >= MAX_APPROVALS_PER_DAY) {
    return { ok: false, message: `${lastDay} approval requests were made in the last 24 hours; that is the limit.` };
  }

  const request: ApprovalRequest = {
    id: newApprovalId(),
    kind: "credit_transfer",
    counterparty,
    amountCents: input.amountCents,
    reason: cleanReason(input.reason),
    originName: typeof input.originName === "string" ? input.originName.slice(0, 100) : null,
    originRef: typeof input.originRef === "string" ? input.originRef.slice(0, 100) : null,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + approvalTtlMs(policy),
  };
  db.prepare(
    `INSERT INTO transfer_approval_requests (id, kind, counterparty, amount_cents, reason, origin_name, origin_ref, created_at_ms, expires_at_ms)
     VALUES (?, 'credit_transfer', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.id,
    request.counterparty,
    request.amountCents,
    request.reason,
    request.originName,
    request.originRef,
    request.createdAtMs,
    request.expiresAtMs,
  );
  return { ok: true, request, reused: false };
}

/**
 * The newest request for this recipient and amount that the owner approved
 * and that may run now: 'approved', or 'outcome_unknown' (only as a replay
 * with the original idempotency key; the treasury decides).
 */
export function findUsableApproval(
  db: BetterSqlite3.Database,
  owner: DecisionSource,
  counterparty: string,
  amountCents: number,
  nowMs: number,
): ApprovalView | null {
  const rows = db
    .prepare(
      "SELECT * FROM transfer_approval_requests WHERE amount_cents = ? AND created_at_ms > ? ORDER BY created_at_ms DESC, id DESC",
    )
    .all(amountCents, nowMs - APPROVAL_PRUNE_AFTER_MS) as RequestRow[];
  for (const r of rows) {
    if (!sameRecipient(r.counterparty, counterparty)) continue;
    const v = viewOf(db, owner, toRequest(r), nowMs);
    if (v.state === "approved" || v.state === "outcome_unknown") return v;
  }
  return null;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export type ApprovalTransferOutcome =
  | { status: "sent"; transfer: CreditTransferResult; approvalId?: string }
  | { status: "approval_pending"; message: string; requestId: string }
  | { status: "approval_refused"; message: string };

/**
 * The transfer tools' path: execute a matching approved request, else
 * transfer normally; on APPROVAL_REQUIRED from a tool call, record (or
 * reuse) a pending request. Automatic origins get the denial and no
 * request. Every other treasury outcome propagates.
 */
export async function transferWithApproval(opts: {
  conway: Pick<ConwayClient, "transferCredits">;
  db: BetterSqlite3.Database;
  owner: DecisionSource;
  policy: Partial<Pick<ResolvedTreasuryPolicy, "approvalTtlMs">> | undefined;
  to: string;
  amountCents: number;
  note?: string;
  reason?: string;
  /** fund_child: the child id. */
  originRef?: string;
  now?: () => number;
}): Promise<ApprovalTransferOutcome> {
  const now = opts.now ?? Date.now;
  const usable = findUsableApproval(opts.db, opts.owner, opts.to, opts.amountCents, now());
  if (usable) {
    // The transfer as asked; the treasury checks it against the owner's
    // decision row (APPROVAL_INVALID on any difference).
    const transfer = await opts.conway.transferCredits(opts.to, opts.amountCents, opts.note, { approvalId: usable.id });
    return { status: "sent", transfer, approvalId: usable.id };
  }
  try {
    const transfer = await opts.conway.transferCredits(opts.to, opts.amountCents, opts.note);
    return { status: "sent", transfer };
  } catch (err) {
    if (!(err instanceof TreasuryDeniedError) || err.code !== "APPROVAL_REQUIRED") throw err;
    const origin = currentTreasuryOrigin();
    if (origin.type !== "tool" || isInboxSource(origin.inputSource)) throw err;
    const created = createApprovalRequest(
      opts.db,
      opts.owner,
      {
        counterparty: opts.to,
        amountCents: opts.amountCents,
        reason: opts.reason ?? opts.note ?? null,
        originName: origin.name ?? null,
        originRef: opts.originRef ?? null,
      },
      opts.policy,
      now(),
    );
    if (!created.ok) {
      return {
        status: "approval_refused",
        message: `Transfer of ${usd(opts.amountCents)} to ${opts.to} needs your owner's approval, but no request was made: ${created.message}`,
      };
    }
    const r = created.request;
    return {
      status: "approval_pending",
      requestId: r.id,
      message:
        `Transfer of ${usd(r.amountCents)} to ${r.counterparty} needs your owner's approval. ` +
        `Request ${r.id} is ${created.reused ? "already " : ""}pending until ${new Date(r.expiresAtMs).toISOString()} UTC. ` +
        `Your owner approves it with \`automaton-cli approvals approve ${r.id}\`. ` +
        "Retrying before then does nothing; once approved, it runs on your next retry or within 5 minutes.",
    };
  }
}

/**
 * fund_child's bookkeeping for a transfer the heartbeat executed (the tool
 * does it itself when its retry executes). Returns wake text that tells the
 * agent not to ask again.
 */
async function afterHeartbeatExecution(db: BetterSqlite3.Database, r: ApprovalRequest): Promise<string> {
  if (r.originName !== "fund_child") return " Do not retry it: it has already run.";
  let recorded = false;
  if (r.originRef) {
    try {
      const { recordChildFunded } = await import("../replication/funding.js");
      recorded = recordChildFunded(db, r.originRef, r.amountCents);
    } catch (err) {
      logger.warn(`Recording child funding for ${r.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return recorded
    ? ` Child ${r.originRef} is recorded as funded; do not call fund_child again for this amount.`
    : " Do not call fund_child again for this amount: the child has been paid.";
}

function markSeen(db: BetterSqlite3.Database, id: string, value: string, nowMs: number): void {
  db.prepare(
    "UPDATE transfer_approval_requests SET decision_seen = ?, decision_seen_at_ms = ? WHERE id = ? AND decision_seen IS NULL",
  ).run(value, nowMs, id);
}

function noteAttempt(db: BetterSqlite3.Database, id: string, note: string, nowMs: number): boolean {
  const prev = db.prepare("SELECT executor_note FROM transfer_approval_requests WHERE id = ?").pluck().get(id);
  db.prepare("UPDATE transfer_approval_requests SET executor_note = ?, executor_attempt_at_ms = ? WHERE id = ?").run(
    note,
    nowMs,
    id,
  );
  return prev !== note;
}

/**
 * The heartbeat step. For each request the agent has not been told about:
 * a rejection is reported; an approval is executed once through the
 * treasury (the quote is built from the owner's decision row), and its
 * outcome reported. A cap or cooldown refusal is retried on later ticks
 * until the execute-by time (reported once per distinct reason); an
 * outcome-unknown transfer is reported and never replayed here (the agent's
 * retry replays it with the same idempotency key). Final request rows are
 * pruned after 30 days. Returns the wake messages.
 */
export async function executeApprovedTransfers(deps: {
  db: BetterSqlite3.Database;
  owner: DecisionSource;
  conway: Pick<ConwayClient, "transferCredits">;
  now?: () => number;
}): Promise<string[]> {
  const now = deps.now ?? Date.now;
  const db = deps.db;
  const messages: string[] = [];
  const rows = db
    .prepare(
      "SELECT * FROM transfer_approval_requests WHERE decision_seen IS NULL AND created_at_ms > ? ORDER BY created_at_ms, id",
    )
    .all(now() - APPROVAL_PRUNE_AFTER_MS) as RequestRow[];

  for (const row of rows) {
    const r = toRequest(row);
    const view = viewOf(db, deps.owner, r, now());
    const d = view.decision;
    const what = `transfer ${r.id} (${usd(r.amountCents)} to ${r.counterparty})`;
    switch (view.state) {
      case "pending":
      case "executing":
        continue;
      case "rejected":
        markSeen(db, r.id, "rejected", now());
        messages.push(`Your owner rejected ${what}; do not retry it.`);
        continue;
      case "executed":
        markSeen(db, r.id, "approved", now());
        messages.push(`Approved ${what} executed.`);
        continue;
      case "outcome_unknown":
        markSeen(db, r.id, "approved", now());
        messages.push(
          `Approved ${what} was sent but its outcome is unknown. Retrying the identical transfer replays it with the same idempotency key.`,
        );
        continue;
      case "expired":
        markSeen(db, r.id, d?.decision === "approved" ? "approved" : "expired", now());
        messages.push(
          d?.decision === "approved"
            ? `Approved ${what} expired before it could run.`
            : `Approval request ${r.id} expired without a decision from your owner.`,
        );
        continue;
      case "approved":
        break;
    }
    if (!d || d.decision !== "approved") continue;
    // A cancelled task starts no further transfer.
    throwIfCancelled();
    try {
      await runWithTreasuryOrigin({ type: "auto", name: APPROVED_TRANSFER_ORIGIN }, () =>
        deps.conway.transferCredits(d.counterparty, d.amountCents, `approved transfer ${r.id}`, { approvalId: r.id }),
      );
      const tail = await afterHeartbeatExecution(db, r);
      // Cancelled after it ran: this run's wake is dropped, so the next tick
      // reports it (the ledger row makes it 'executed').
      throwIfCancelled();
      markSeen(db, r.id, "approved", now());
      messages.push(`Approved ${what} executed.${tail}`);
    } catch (err) {
      // The server's refusal is an answer, not an abort: recorded even when
      // cancelled, so the heartbeat does not send it again.
      if (err instanceof TransferRejectedError || (err as { name?: string })?.name === "TransferRejectedError") {
        markSeen(db, r.id, "approved", now());
        messages.push(`Approved ${what} was rejected by the server; nothing moved. You may retry it until the approval expires.`);
        rethrowIfCancelled(err);
        continue;
      }
      // Cancelled: record nothing here. The ledger already holds the truth
      // (released before the send, unknown after it, which only a replay
      // with the same idempotency key can follow), and the next tick
      // reports it.
      rethrowIfCancelled(err);
      if (err instanceof OutcomeUnknownError || (err as { name?: string })?.name === "OutcomeUnknownError") {
        markSeen(db, r.id, "approved", now());
        messages.push(
          `Approved ${what} was sent but its outcome is unknown. Retrying the identical transfer replays it with the same idempotency key.`,
        );
      } else if (err instanceof TreasuryDeniedError) {
        // The agent's own retry got there first: re-derived next tick.
        if (err.code === "APPROVAL_USED") continue;
        if (err.code === "APPROVAL_INVALID") {
          markSeen(db, r.id, "invalid", now());
          messages.push(`Approved ${what} cannot run: ${err.message}`);
          continue;
        }
        // A cap, cooldown or balance refusal can clear: retry until execute-by.
        if (noteAttempt(db, r.id, err.code, now())) {
          messages.push(`Approved ${what} was refused for now (${err.code}: ${err.message}); retrying until the approval expires.`);
        }
      } else {
        noteAttempt(db, r.id, "error", now());
        logger.warn(`Approved transfer ${r.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  pruneApprovalRequests(db, deps.owner, now());
  return messages;
}

/** Delete request rows 30 days after they reached a final state (the ledger keeps the execution record). */
export function pruneApprovalRequests(db: BetterSqlite3.Database, owner: DecisionSource, nowMs: number): number {
  const old = db
    .prepare("SELECT * FROM transfer_approval_requests WHERE created_at_ms < ?")
    .all(nowMs - APPROVAL_PRUNE_AFTER_MS) as RequestRow[];
  let deleted = 0;
  for (const row of old) {
    const v = viewOf(db, owner, toRequest(row), nowMs);
    if (v.state !== "rejected" && v.state !== "executed" && v.state !== "expired") continue;
    const finalAt = Math.max(row.expires_at_ms, row.decision_seen_at_ms ?? 0, v.decision?.executeByMs ?? 0);
    if (nowMs - finalAt < APPROVAL_PRUNE_AFTER_MS) continue;
    deleted += db.prepare("DELETE FROM transfer_approval_requests WHERE id = ?").run(row.id).changes;
  }
  return deleted;
}
