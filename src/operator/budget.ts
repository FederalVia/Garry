/**
 * Owner budget commands (`automaton-cli budget add|remove|show`).
 *
 * Grants go to the owner database, which only owner code writes; the agent
 * reads it read-only. These commands never write state.db: `show` opens it
 * with a read-only connection. They do not take the instance lock, so the
 * owner can top up (and so revive) a running agent.
 */

import fs from "node:fs";
import Database from "better-sqlite3";
import type { AgentState, AutomatonConfig } from "../types.js";
import { resolveBudget, resolveOwnerDbPath, describeBudget, type ResolvedBudget } from "../budget/config.js";
import { BudgetMeter, type BudgetSnapshot } from "../budget/meter.js";
import { currentPeriod } from "../budget/period.js";
import { openOwnerDbForWrite, OwnerDbReader, MAX_GRANT_CENTS, type OwnerGrant } from "../budget/owner-db.js";
import { INFERENCE_HELD_SQL } from "../inference/gate.js";
import { resolveRuntime } from "../providers/mode.js";
import { loadConfig, resolvePath } from "../config.js";
import { escapeForTerminal } from "../observability/terminal-safe.js";
import { formatUsd, parseUsdAmount } from "./fund.js";

export const BUDGET_USAGE = `Usage:
  automaton-cli budget add <usd> [--note TEXT] [--yes]     Add to this period's budget
  automaton-cli budget remove <usd> [--note TEXT] [--yes]  Take back (a negative grant)
  automaton-cli budget show [--json] [--init]              What is left, and what counts
  <usd>     Dollars, at most two decimals, no "$" sign (10, 2.50); at most $10,000 per grant
  --note    A note stored with the grant
  --yes     Skip the confirmation prompt
  --init    Only create the owner database (setup uses this)`;

export type GrantParse = { ok: true; cents: number } | { ok: false; error: string };

/** Positive dollars, at most two decimals, at most $10,000 (the owner database's limit). */
export function parseGrantAmount(raw: string): GrantParse {
  const parsed = parseUsdAmount(raw, { cents: false });
  if (!parsed.ok) return parsed;
  if (parsed.cents > MAX_GRANT_CENTS) {
    return { ok: false, error: `Invalid amount "${raw}": at most ${formatUsd(MAX_GRANT_CENTS)} per grant` };
  }
  return parsed;
}

export interface BudgetContext {
  config: AutomatonConfig;
  ownerDbPath: string;
  dbPath: string;
  budget: ResolvedBudget | null;
  mode: "conway" | "standalone";
  /** The runtime clamps the daily AI cap to this (standalone); null in Conway mode. */
  dailyCapCeilingCents: number | null;
}

/** automaton.json as the runtime loads it (validated, never written); throws when there is none. */
export function loadOwnerConfig(): AutomatonConfig {
  const config = loadConfig();
  if (!config) throw new Error("No automaton configuration found (automaton --setup).");
  return config;
}

/** Everything the budget commands need from automaton.json. Never writes it. */
export function budgetContext(config: AutomatonConfig = loadOwnerConfig()): BudgetContext {
  const runtime = resolveRuntime(config);
  return {
    config,
    ownerDbPath: resolveOwnerDbPath(config),
    dbPath: resolvePath(config.dbPath),
    // Validated by loadConfig; Conway mode ignores the block.
    budget: resolveBudget(config.budget),
    mode: runtime.mode,
    dailyCapCeilingCents: runtime.dailyCapCeilingCents,
  };
}

export interface GrantPlan {
  amountCents: number;
  note: string | null;
  ownerDbPath: string;
  description: string;
  warnings: string[];
}

export function planGrant(ctx: BudgetContext, input: { amountCents: number; remove: boolean; note?: string | null }): GrantPlan {
  const amountCents = input.remove ? -input.amountCents : input.amountCents;
  const warnings: string[] = [];
  if (!ctx.budget) {
    warnings.push(
      "automaton.json has no budget block: the grant is stored but nothing uses it until you configure a budget (automaton --configure).",
    );
  } else if (ctx.mode === "conway") {
    warnings.push("This automaton runs in Conway mode, which ignores the budget: the grant is stored but unused.");
  }
  const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
  const what = input.remove ? `Remove ${formatUsd(input.amountCents)} from` : `Add ${formatUsd(input.amountCents)} to`;
  const scope = ctx.budget?.period === "one-off" ? "the budget" : "this period's budget";
  return {
    amountCents,
    note,
    ownerDbPath: ctx.ownerDbPath,
    description: `${what} ${scope}${note ? ` (note: ${note})` : ""}`,
    warnings,
  };
}

/** Write the grant to the owner database, creating it when missing. */
export function executeGrant(plan: GrantPlan, nowMs: number = Date.now()): OwnerGrant {
  const w = openOwnerDbForWrite(plan.ownerDbPath);
  try {
    return w.addGrant(plan.amountCents, plan.note, nowMs);
  } finally {
    w.close();
  }
}

/** Create the owner database (folder 0755, file 0644, rollback journal) if missing. */
export function initOwnerDb(ownerDbPath: string): { created: boolean } {
  const existed = fs.existsSync(ownerDbPath);
  openOwnerDbForWrite(ownerDbPath).close();
  return { created: !existed };
}

export interface BudgetReport {
  mode: "conway" | "standalone";
  /** automaton.json has a budget that Conway mode ignores. */
  budgetIgnored: boolean;
  budget: ResolvedBudget | null;
  budgetDescription: string | null;
  ownerDbPath: string;
  ownerDbExists: boolean;
  ownerDbStale: boolean;
  stateDbPath: string;
  stateDbExists: boolean;
  periodStartMs: number | null;
  periodEndMs: number | null;
  /** Grants that count in the current period (all of them with no budget). */
  grants: OwnerGrant[];
  snapshot: BudgetSnapshot | null;
  /** Of the AI spend, what open (reserved or unknown) calls hold. */
  aiInFlightMicroUsd: number;
  dailyCapCents: number | null;
  agentState: string | null;
  zeroSince: string | null;
}

function readGrants(ownerDbPath: string, startMs: number, endMs: number | null): { grants: OwnerGrant[]; stale: boolean } {
  if (!fs.existsSync(ownerDbPath)) return { grants: [], stale: false };
  let db: Database.Database | null = null;
  try {
    db = new Database(ownerDbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    const rows = db
      .prepare(
        `SELECT id, amount_cents, note, created_at_ms FROM budget_grants
          WHERE created_at_ms >= ? AND (? IS NULL OR created_at_ms < ?) ORDER BY created_at_ms, id`,
      )
      .all(startMs, endMs, endMs) as Array<{ id: number; amount_cents: number; note: string | null; created_at_ms: number }>;
    return {
      grants: rows.map((r) => ({ id: r.id, amountCents: r.amount_cents, note: r.note, createdAtMs: r.created_at_ms })),
      stale: false,
    };
  } catch {
    return { grants: [], stale: true };
  } finally {
    db?.close();
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * What the agent's budget looks like now, computed by the runtime's own
 * meter over a read-only state.db connection.
 */
export function budgetReport(ctx: BudgetContext, nowMs: number = Date.now()): BudgetReport {
  const budget = ctx.mode === "standalone" ? ctx.budget : null;
  const period = budget ? currentPeriod(budget, nowMs) : null;
  const ownerDbExists = fs.existsSync(ctx.ownerDbPath);
  const stateDbExists = fs.existsSync(ctx.dbPath);
  const { grants, stale } = readGrants(
    ctx.ownerDbPath,
    period?.startMs ?? 0,
    budget?.period === "monthly" ? (period?.endMs ?? null) : null,
  );

  let snapshot: BudgetSnapshot | null = null;
  let aiInFlightMicroUsd = 0;
  let agentState: string | null = null;
  let zeroSince: string | null = null;
  let db: Database.Database | null = null;
  const owner = new OwnerDbReader(ctx.ownerDbPath);
  try {
    // An empty in-memory database stands in before the agent first ran.
    db = stateDbExists ? new Database(ctx.dbPath, { readonly: true, fileMustExist: true }) : new Database(":memory:");
    db.pragma("busy_timeout = 2000");
    if (budget) {
      snapshot = new BudgetMeter({ db, budget, owner, now: () => nowMs }).snapshot(nowMs);
      if (tableExists(db, "inference_ledger")) {
        aiInFlightMicroUsd = Number(
          db
            .prepare(
              `SELECT COALESCE(SUM(${INFERENCE_HELD_SQL}), 0) FROM inference_ledger
                WHERE status IN ('reserved','unknown') AND created_at_ms >= ?`,
            )
            .pluck()
            .get(snapshot.periodStartMs) ?? 0,
        );
      }
    }
    if (tableExists(db, "kv")) {
      const kv = db.prepare("SELECT value FROM kv WHERE key = ?").pluck();
      const raw = kv.get("agent_state");
      // The agent writes kv: anything but a known state is reported as unknown.
      agentState = typeof raw === "string" ? (KNOWN_AGENT_STATES.includes(raw as AgentState) ? raw : "unknown") : null;
      zeroSince = (kv.get("zero_credits_since") as string | undefined) ?? null;
    }
  } finally {
    db?.close();
    owner.close();
  }

  // The cap as the runtime applies it: the configured one, clamped to the ceiling.
  const configuredCap = ctx.config.treasuryPolicy?.maxInferenceDailyCents;
  const ceiling = ctx.dailyCapCeilingCents;
  const dailyCapCents =
    typeof configuredCap === "number"
      ? ceiling === null ? configuredCap : Math.min(configuredCap, ceiling)
      : ceiling;
  return {
    mode: ctx.mode,
    budgetIgnored: ctx.mode === "conway" && ctx.budget !== null,
    budget,
    budgetDescription: budget ? describeBudget(budget) : null,
    ownerDbPath: ctx.ownerDbPath,
    ownerDbExists,
    ownerDbStale: stale || !!snapshot?.ownerDbStale,
    stateDbPath: ctx.dbPath,
    stateDbExists,
    periodStartMs: period?.startMs ?? null,
    periodEndMs: period?.endMs ?? null,
    grants,
    snapshot,
    aiInFlightMicroUsd,
    dailyCapCents,
    agentState,
    zeroSince,
  };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const microToUsd = (micro: number) => formatUsd(Math.round(micro / 10_000));
const safe = (s: string) => escapeForTerminal(s, { keepNewlines: false });
const KNOWN_AGENT_STATES: readonly AgentState[] = ["setup", "waking", "running", "sleeping", "low_compute", "critical", "dead"];

export function formatBudgetReport(r: BudgetReport): string {
  const lines: string[] = [];
  const row = (k: string, v: string) => lines.push(`${(k + ":").padEnd(14)}${v}`);
  if (r.mode === "conway") {
    lines.push(
      r.budgetIgnored
        ? "Conway mode ignores the budget in automaton.json (the Conway credit balance is the limit)."
        : "Conway mode: no budget applies (the Conway credit balance is the limit).",
    );
  }
  if (!r.budget) {
    if (r.mode === "standalone") lines.push("No budget configured in automaton.json (automaton --configure, section Budget).");
    row("Owner db", `${r.ownerDbPath}${r.ownerDbExists ? "" : " (not created yet)"}`);
    if (r.grants.length) row("Grants", `${r.grants.length} stored, ${formatUsd(r.grants.reduce((s, g) => s + g.amountCents, 0))} in all (unused)`);
    return lines.join("\n");
  }
  const s = r.snapshot!;
  row("Budget", r.budgetDescription!);
  row(
    "Period",
    r.periodEndMs === null ? `since ${day(s.periodStartMs)} UTC` : `${day(s.periodStartMs)} to ${day(r.periodEndMs)} UTC (resets then)`,
  );
  row("Allowance", formatUsd(s.allowanceCents));
  row("Grants", `${formatUsd(s.grantsCents)} (${s.grantCount})`);
  for (const g of r.grants) {
    lines.push(`  ${new Date(g.createdAtMs).toISOString().replace("T", " ").slice(0, 16)}  ${formatUsd(g.amountCents).padStart(10)}${g.note ? `  ${safe(g.note)}` : ""}`);
  }
  row("AI spend", `${microToUsd(s.aiSpentMicroUsd)}${r.aiInFlightMicroUsd > 0 ? ` (of which ${microToUsd(r.aiInFlightMicroUsd)} in flight)` : ""}`);
  row("Payments", r.budget.countTreasury ? formatUsd(s.treasurySpentCents) : "not counted (countTreasury: false)");
  row("Remaining", `${formatUsd(s.remainingCents)} of ${formatUsd(s.totalCents)}`);
  const t = s.thresholds;
  row("Tier", `${s.tier} (high > ${formatUsd(t.high)}, normal > ${formatUsd(t.normal)}, low_compute > ${formatUsd(t.low_compute)})`);
  if (r.dailyCapCents !== null) row("Daily AI cap", formatUsd(r.dailyCapCents));
  row("Agent state", r.agentState ?? (r.stateDbExists ? "unknown" : "not started yet"));
  if (r.zeroSince) {
    row("At zero since", `${safe(r.zeroSince)}${r.budget.dead ? " (dead after an hour)" : " (dead is off: idles at critical)"}`);
  }
  if (r.agentState === "dead") lines.push("The agent is dead: add budget (automaton-cli budget add <usd>) and it revives within 5 minutes.");
  row("Owner db", `${r.ownerDbPath}${r.ownerDbExists ? "" : " (not created yet)"}${r.ownerDbStale ? " (could not be read: values may be stale)" : ""}`);
  return lines.join("\n");
}

export function budgetReportJson(r: BudgetReport): Record<string, unknown> {
  const s = r.snapshot;
  return {
    mode: r.mode,
    budgetIgnored: r.budgetIgnored,
    budget: r.budget,
    ownerDbPath: r.ownerDbPath,
    ownerDbExists: r.ownerDbExists,
    ownerDbStale: r.ownerDbStale,
    periodStartMs: r.periodStartMs,
    periodEndMs: r.periodEndMs,
    grants: r.grants,
    allowanceCents: s?.allowanceCents ?? null,
    grantsCents: s?.grantsCents ?? null,
    totalCents: s?.totalCents ?? null,
    aiSpentMicroUsd: s?.aiSpentMicroUsd ?? null,
    aiInFlightMicroUsd: r.aiInFlightMicroUsd,
    treasurySpentCents: s?.treasurySpentCents ?? null,
    remainingMicroUsd: s?.remainingMicroUsd ?? null,
    remainingCents: s?.remainingCents ?? null,
    tier: s?.tier ?? null,
    thresholds: s?.thresholds ?? null,
    dailyCapCents: r.dailyCapCents,
    agentState: r.agentState,
    zeroSince: r.zeroSince,
  };
}

/**
 * `automaton-cli fund` moves Conway credits; standalone has none. Returns
 * the refusal text in standalone mode, null in Conway mode.
 */
export function standaloneFundRefusal(config: AutomatonConfig = loadOwnerConfig()): string | null {
  if (resolveRuntime(config).mode !== "standalone") return null;
  return "Standalone mode has no Conway credits; use automaton-cli budget add <usd> to give the agent more budget.";
}

/** One line for `automaton-cli status`. */
export function budgetStatusLine(r: BudgetReport): string {
  if (r.mode === "conway") return r.budgetIgnored ? "ignored in Conway mode" : "Conway credits";
  if (!r.budget || !r.snapshot) return "none (fixed survival tier)";
  const s = r.snapshot;
  const end = r.periodEndMs === null ? "" : `, resets ${day(r.periodEndMs)} UTC`;
  return `${formatUsd(s.remainingCents)} of ${formatUsd(s.totalCents)} left (${s.tier}${end})`;
}

export interface CliIo {
  log(line: string): void;
  /** Yes/no on a terminal; null without one (then --yes is required). */
  confirm(question: string): Promise<boolean | null>;
  now?: () => number;
}

/** Shared flag parsing for the owner commands: --note, --yes, and the given boolean flags. */
export function parseOwnerArgs(
  args: string[],
  flags: readonly string[],
  valueFlags: readonly string[] = [],
): { positional: string[]; note?: string; yes: boolean; set: Set<string>; values: Map<string, string>; error?: string } {
  const positional: string[] = [];
  const set = new Set<string>();
  const values = new Map<string, string>();
  let note: string | undefined;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (a === "--note") {
      if (i + 1 >= args.length) return { positional, yes, set, values, error: "--note needs a value" };
      note = args[++i];
    } else if (a.startsWith("--note=")) {
      note = a.slice("--note=".length);
    } else if (valueFlags.includes(name)) {
      if (eq > 0) values.set(name, a.slice(eq + 1));
      else if (i + 1 >= args.length) return { positional, yes, set, values, error: `${name} needs a value` };
      else values.set(name, args[++i]!);
    } else if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (flags.includes(a)) {
      set.add(a);
    } else if (a.startsWith("-") && !/^-\d/.test(a)) {
      return { positional, yes, set, values, error: `Unknown option: ${a}` };
    } else {
      positional.push(a);
    }
  }
  return { positional, note, yes, set, values };
}

/**
 * `automaton-cli budget ...` (args after "budget"). Returns the exit code.
 * Grants need --yes or an interactive y.
 */
export async function runBudgetCli(args: string[], io: CliIo, ctxIn?: BudgetContext): Promise<number> {
  const now = io.now ?? Date.now;
  const [sub, ...rest] = args;
  const usage = (msg?: string) => {
    if (msg) io.log(msg);
    io.log(BUDGET_USAGE);
    return 1;
  };
  if (sub !== "add" && sub !== "remove" && sub !== "show") return usage(sub ? `Unknown budget command: ${sub}` : undefined);
  const parsed = parseOwnerArgs(rest, ["--json", "--init"]);
  if (parsed.error) return usage(parsed.error);
  const ctx = ctxIn ?? budgetContext();

  if (sub === "show") {
    if (parsed.positional.length) return usage(`Unexpected argument: ${parsed.positional[0]}`);
    if (parsed.set.has("--init")) {
      const { created } = initOwnerDb(ctx.ownerDbPath);
      io.log(`${created ? "Created" : "Owner database already exists:"} ${ctx.ownerDbPath}`);
      return 0;
    }
    const report = budgetReport(ctx, now());
    io.log(parsed.set.has("--json") ? JSON.stringify(budgetReportJson(report), null, 2) : formatBudgetReport(report));
    return 0;
  }

  if (parsed.set.size) return usage("--json and --init apply to budget show only.");
  if (parsed.positional.length !== 1) return usage(parsed.positional.length ? `Unexpected argument: ${parsed.positional[1]}` : "Amount is required.");
  const amount = parseGrantAmount(parsed.positional[0]!);
  if (!amount.ok) return usage(amount.error);

  const plan = planGrant(ctx, { amountCents: amount.cents, remove: sub === "remove", note: parsed.note });
  for (const w of plan.warnings) io.log(`Warning: ${w}`);
  io.log(plan.description);
  if (!parsed.yes) {
    const answer = await io.confirm(`${sub === "add" ? "Add" : "Remove"} ${formatUsd(amount.cents)}? [y/N] `);
    if (answer === null) {
      io.log("Refusing without confirmation: re-run with --yes, or run it in an interactive terminal.");
      return 1;
    }
    if (!answer) {
      io.log("Cancelled. Nothing was changed.");
      return 1;
    }
  }
  const grant = executeGrant(plan, now());
  io.log(`Grant ${grant.id} recorded: ${formatUsd(grant.amountCents)} (${plan.ownerDbPath}).`);
  const report = budgetReport(ctx, now());
  if (report.snapshot) io.log(`Remaining now: ${formatUsd(report.snapshot.remainingCents)} of ${formatUsd(report.snapshot.totalCents)}.`);
  return 0;
}
