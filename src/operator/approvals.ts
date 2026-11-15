/**
 * Owner transfer approvals (`automaton-cli approvals list|approve|reject`).
 *
 * The agent records a request in state.db when a transfer needs approval;
 * the owner's decision goes to the owner database, which the agent can only
 * read. The decision carries its own copy of the recipient and amount, and
 * the treasury executes only a transfer that matches that copy. These
 * commands never write state.db and do not take the instance lock, so the
 * owner can decide while the agent runs.
 */

import fs from "node:fs";
import Database from "better-sqlite3";
import type { AutomatonConfig, TreasuryPolicy } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { openOwnerDbForWrite, OwnerDbReader, type ApprovalDecision } from "../budget/owner-db.js";
import { resolveOwnerDbPath } from "../budget/config.js";
import { APPROVAL_ID_RE, approvalExecuteWindowMs, listApprovalViews, type ApprovalView } from "../treasury/approvals.js";
import { HELD_CENTS_SQL } from "../treasury/ledger.js";
import { resolvePath } from "../config.js";
import { loadOwnerConfig, parseOwnerArgs, type CliIo } from "./budget.js";
import { escapeForTerminal } from "../observability/terminal-safe.js";
import { formatUsd, parseUsdAmount } from "./fund.js";
import { canonicalAddress } from "../treasury/policy.js";
import type { ChainType } from "../identity/chain.js";

export const APPROVALS_USAGE = `Usage:
  automaton-cli approvals list [--all] [--json]          Pending transfer requests (--all: every state)
  automaton-cli approvals approve <id> [--note TEXT] [--yes --amount USD --to ADDRESS]
  automaton-cli approvals reject <id> [--note TEXT] [--yes]
An approved transfer runs once, through every normal spending cap, within
the execute window (2 hours by default); requests expire after 24 hours.
With --yes, approve also needs the amount and recipient you reviewed in
"approvals list" (it prints the exact command); any difference is refused.`;

export interface ApprovalsContext {
  dbPath: string;
  ownerDbPath: string;
  policy: Required<Pick<TreasuryPolicy, "maxSingleTransferCents" | "maxDailyTransferCents" | "requireConfirmationAboveCents">> & {
    approvalExecuteWindowMs: number;
  };
  /** The agent's chain, when the config names it: recipients on another chain are malformed. */
  chainType?: ChainType;
}

export function approvalsContext(config: AutomatonConfig = loadOwnerConfig()): ApprovalsContext {
  const p = { ...DEFAULT_TREASURY_POLICY, ...(config.treasuryPolicy ?? {}) };
  return {
    dbPath: resolvePath(config.dbPath),
    ownerDbPath: resolveOwnerDbPath(config),
    policy: {
      maxSingleTransferCents: p.maxSingleTransferCents,
      maxDailyTransferCents: p.maxDailyTransferCents,
      requireConfirmationAboveCents: p.requireConfirmationAboveCents,
      approvalExecuteWindowMs: approvalExecuteWindowMs(p),
    },
    chainType: config.chainType,
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** state.db through a read-only connection, or null before the agent created it. */
function openStateReadOnly(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 2000");
  return db;
}

function withViews<T>(ctx: ApprovalsContext, nowMs: number, all: boolean, fn: (views: ApprovalView[], db: Database.Database | null) => T): T {
  const db = openStateReadOnly(ctx.dbPath);
  const owner = new OwnerDbReader(ctx.ownerDbPath);
  try {
    const views = db && tableExists(db, "transfer_approval_requests") ? listApprovalViews(db, owner, nowMs, { all, chainType: ctx.chainType }) : [];
    return fn(views, db);
  } finally {
    owner.close();
    db?.close();
  }
}

export function listApprovals(ctx: ApprovalsContext, opts: { all?: boolean; nowMs?: number } = {}): ApprovalView[] {
  return withViews(ctx, opts.nowMs ?? Date.now(), !!opts.all, (views) => views);
}

/** Pending requests, for `automaton-cli status`. */
export function pendingApprovalCount(ctx: ApprovalsContext, nowMs: number = Date.now()): number {
  return listApprovals(ctx, { nowMs }).filter((v) => v.state === "pending").length;
}

const safe = (s: string | null | undefined) => escapeForTerminal(String(s ?? ""), { keepNewlines: false });
const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** Every agent-written field (id, recipient, reason) is escaped for the terminal. */
export function formatApprovalList(views: ApprovalView[], nowMs: number = Date.now()): string {
  if (views.length === 0) return "No transfer approval requests.";
  const out: string[] = [];
  for (const v of views) {
    if (v.malformed) {
      out.push(`${safe(v.id)}  MALFORMED  ${formatUsd(v.amountCents)} to ${safe(v.counterparty)}`);
      out.push("  not written by the agent's transfer tools (bad id or recipient): it cannot be approved");
      continue;
    }
    out.push(`${safe(v.id)}  ${v.state.toUpperCase()}  ${formatUsd(v.amountCents)} to ${safe(v.counterparty)}`);
    out.push(`  created ${when(v.createdAtMs)}, ${v.expiresAtMs > nowMs ? "expires" : "expired"} ${when(v.expiresAtMs)}`);
    if (v.decision) {
      out.push(
        `  ${v.decision.decision} ${when(v.decision.decidedAtMs)}` +
          (v.decision.executeByMs ? `, must run by ${when(v.decision.executeByMs)}` : "") +
          (v.decision.note ? ` (note: ${safe(v.decision.note)})` : ""),
      );
    }
    if (v.ledgerId) out.push(`  ledger ${safe(v.ledgerId)}`);
    if (v.reason) out.push(`  agent's reason (unverified): ${safe(v.reason)}`);
    if (v.state === "pending") out.push(`  approve: ${approveCommand(v)}`);
  }
  return out.join("\n");
}

/** POSIX single-quoting: the owner may paste the command into a shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The non-interactive approve command, bound to the amount and recipient
 * shown. Only well-formed requests get one; every value is quoted anyway.
 */
export function approveCommand(v: Pick<ApprovalView, "id" | "amountCents" | "counterparty">): string {
  const q = (s: string) => shellQuote(safe(s));
  return `automaton-cli approvals approve ${q(v.id)} --amount ${(v.amountCents / 100).toFixed(2)} --to ${q(v.counterparty)} --yes`;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return canonicalAddress(a) === canonicalAddress(b);
  } catch {
    return a.trim() === b.trim();
  }
}

/**
 * --yes skips the prompt, so the owner states what they reviewed: the
 * request row lives in the agent's state.db and can change after `list`.
 */
export function checkExpected(
  v: Pick<ApprovalView, "id" | "amountCents" | "counterparty">,
  expected: { amount?: string; to?: string },
): string | null {
  if (expected.amount === undefined || expected.to === undefined) {
    return `With --yes, approve needs --amount and --to as reviewed in "approvals list": ${approveCommand(v)}`;
  }
  const amount = parseUsdAmount(expected.amount, { cents: false });
  if (!amount.ok) return amount.error;
  if (amount.cents !== v.amountCents || !sameAddress(expected.to, v.counterparty)) {
    return (
      `Request ${v.id} is now ${formatUsd(v.amountCents)} to ${safe(v.counterparty)}, not ${formatUsd(amount.cents)} to ${safe(expected.to)}. ` +
      "Nothing was decided. Review it again with automaton-cli approvals list."
    );
  }
  return null;
}

/** The agent's stated reason, escaped, for a confirmation prompt. */
export function formatReason(v: Pick<ApprovalView, "reason">): string | null {
  return v.reason ? `Agent's reason (unverified): ${safe(v.reason)}` : null;
}

export function approvalsJson(views: ApprovalView[]): Record<string, unknown>[] {
  return views.map((v) => ({ ...v }));
}

export interface DecisionPlan {
  view: ApprovalView;
  decision: "approved" | "rejected";
  note: string | null;
  /** The approved transfer must run by then; null for a rejection. */
  executeByMs: number | null;
  warnings: string[];
  description: string;
}

export type PlanDecisionResult = { ok: true; plan: DecisionPlan } | { ok: false; error: string };

/** Credit transfers committed or in flight in the last 24 hours, as the treasury counts them. */
function transferredLastDay(db: Database.Database | null, nowMs: number): number {
  if (!db || !tableExists(db, "treasury_ledger")) return 0;
  return Number(
    db
      .prepare(
        `SELECT COALESCE(SUM(${HELD_CENTS_SQL}), 0) FROM treasury_ledger
          WHERE budget = 'transfer' AND status IN ('reserved','sent','unknown','committed') AND created_at_ms >= ?`,
      )
      .pluck()
      .get(nowMs - 86_400_000) ?? 0,
  );
}

export function planDecision(
  ctx: ApprovalsContext,
  input: { id: string; decision: "approved" | "rejected"; note?: string | null; nowMs?: number },
): PlanDecisionResult {
  const nowMs = input.nowMs ?? Date.now();
  const id = input.id.trim();
  if (!APPROVAL_ID_RE.test(id)) return { ok: false, error: `Invalid request id "${safe(id)}" (expected apr_...)` };
  return withViews(ctx, nowMs, true, (views, db): PlanDecisionResult => {
    const view = views.find((v) => v.id === id);
    if (!view) return { ok: false, error: `No transfer approval request ${id}.` };
    if (view.malformed) {
      return { ok: false, error: `Request ${id} has a recipient that is not a valid address; it cannot be decided.` };
    }
    if (view.decision) {
      return { ok: false, error: `Request ${id} was already ${view.decision.decision} (${view.state}); a decision cannot be changed.` };
    }
    if (view.state !== "pending") return { ok: false, error: `Request ${id} is ${view.state}; only a pending request can be decided.` };

    const warnings: string[] = [];
    const executeByMs = input.decision === "approved" ? nowMs + ctx.policy.approvalExecuteWindowMs : null;
    if (input.decision === "approved") {
      if (view.amountCents > ctx.policy.maxSingleTransferCents) {
        warnings.push(
          `${formatUsd(view.amountCents)} is above treasuryPolicy.maxSingleTransferCents (${formatUsd(ctx.policy.maxSingleTransferCents)}): the treasury will refuse it even when approved.`,
        );
      }
      // An identical request that already ran: approving this one pays again.
      const twin = views.find(
        (o) =>
          o.id !== view.id &&
          (o.state === "executed" || o.state === "executing" || o.state === "outcome_unknown") &&
          o.amountCents === view.amountCents &&
          sameAddress(o.counterparty, view.counterparty),
      );
      if (twin) {
        warnings.push(
          `Request ${twin.id} for the same amount and recipient (created ${when(twin.createdAtMs)}) is already ${twin.state.replace("_", " ")}: approving this one pays again.`,
        );
      }
      const left = ctx.policy.maxDailyTransferCents - transferredLastDay(db, nowMs);
      if (view.amountCents > left) {
        warnings.push(
          `Only ${formatUsd(Math.max(0, left))} of the daily transfer cap (${formatUsd(ctx.policy.maxDailyTransferCents)}) is left right now: the transfer is refused unless room frees up before ${when(executeByMs!)}.`,
        );
      }
    }
    const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
    const verb = input.decision === "approved" ? "Approve" : "Reject";
    return {
      ok: true,
      plan: {
        view,
        decision: input.decision,
        note,
        executeByMs,
        warnings,
        description:
          `${verb} ${view.id}: ${formatUsd(view.amountCents)} to ${safe(view.counterparty)}` +
          (executeByMs ? ` (runs once, by ${when(executeByMs)})` : ""),
      },
    };
  });
}

/**
 * Write the decision. Recipient and amount are copied from the request the
 * owner saw; the treasury compares the transfer with this copy only.
 */
export function executeDecision(ctx: ApprovalsContext, plan: DecisionPlan, nowMs: number = Date.now()): ApprovalDecision {
  // Checked again: the request may have expired or changed while the owner read it.
  const fresh = planDecision(ctx, { id: plan.view.id, decision: plan.decision, note: plan.note, nowMs });
  if (!fresh.ok) throw new Error(fresh.error);
  const v = fresh.plan.view;
  if (v.counterparty !== plan.view.counterparty || v.amountCents !== plan.view.amountCents || v.kind !== plan.view.kind) {
    throw new Error(`Request ${plan.view.id} changed since it was shown; nothing was decided. Run the command again.`);
  }
  const w = openOwnerDbForWrite(ctx.ownerDbPath);
  try {
    return w.decide({
      requestId: plan.view.id,
      decision: plan.decision,
      kind: plan.view.kind,
      counterparty: plan.view.counterparty,
      amountCents: plan.view.amountCents,
      executeByMs: fresh.plan.executeByMs,
      note: plan.note,
      nowMs,
    });
  } finally {
    w.close();
  }
}

/**
 * `automaton-cli approvals ...` (args after "approvals"). Returns the exit
 * code. Decisions need --yes or an interactive y.
 */
export async function runApprovalsCli(args: string[], io: CliIo, ctxIn?: ApprovalsContext): Promise<number> {
  const now = io.now ?? Date.now;
  const [sub, ...rest] = args;
  const usage = (msg?: string) => {
    if (msg) io.log(msg);
    io.log(APPROVALS_USAGE);
    return 1;
  };
  if (sub !== "list" && sub !== "approve" && sub !== "reject") return usage(sub ? `Unknown approvals command: ${sub}` : undefined);
  const parsed = parseOwnerArgs(rest, ["--json", "--all"], ["--amount", "--to"]);
  if (parsed.error) return usage(parsed.error);
  const ctx = ctxIn ?? approvalsContext();

  if (sub === "list") {
    if (parsed.positional.length) return usage(`Unexpected argument: ${parsed.positional[0]}`);
    const views = listApprovals(ctx, { all: parsed.set.has("--all"), nowMs: now() });
    io.log(parsed.set.has("--json") ? JSON.stringify(approvalsJson(views), null, 2) : formatApprovalList(views, now()));
    return 0;
  }

  if (parsed.set.size) return usage("--json and --all apply to approvals list only.");
  if (parsed.values.size && sub !== "approve") return usage("--amount and --to apply to approvals approve only.");
  if (parsed.positional.length !== 1) {
    return usage(parsed.positional.length ? `Unexpected argument: ${parsed.positional[1]}` : "A request id is required (automaton-cli approvals list).");
  }
  const decision = sub === "approve" ? "approved" : "rejected";
  const planned = planDecision(ctx, { id: parsed.positional[0]!, decision, note: parsed.note, nowMs: now() });
  if (!planned.ok) {
    io.log(planned.error);
    return 1;
  }
  const plan = planned.plan;
  io.log(plan.description);
  const reason = formatReason(plan.view);
  if (reason) io.log(reason);
  for (const w of plan.warnings) io.log(`Warning: ${w}`);
  if (parsed.yes && sub === "approve") {
    const mismatch = checkExpected(plan.view, { amount: parsed.values.get("--amount"), to: parsed.values.get("--to") });
    if (mismatch) {
      io.log(mismatch);
      return 1;
    }
  }
  if (!parsed.yes) {
    const answer = await io.confirm(`${sub === "approve" ? "Approve" : "Reject"} ${plan.view.id}? [y/N] `);
    if (answer === null) {
      io.log("Refusing without confirmation: re-run with --yes, or run it in an interactive terminal.");
      return 1;
    }
    if (!answer) {
      io.log("Cancelled. Nothing was decided.");
      return 1;
    }
  }
  let written: ApprovalDecision;
  try {
    written = executeDecision(ctx, plan, now());
  } catch (err) {
    io.log(safe(err instanceof Error ? err.message : String(err)));
    return 1;
  }
  io.log(
    written.decision === "approved"
      ? `Approved. It runs once, on the agent's next retry or within 5 minutes, and must run by ${when(written.executeByMs!)}.`
      : "Rejected. The agent is told not to retry it.",
  );
  return 0;
}
