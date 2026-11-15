/**
 * Shared fixtures for the budget tests: a temp HOME with a real state.db, a
 * fake clock, the owner database (written through the owner-side writer, as
 * the CLI would) and a meter over both. No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { createDatabase } from "../state/database.js";
import type { AutomatonDatabase } from "../types.js";
import { resolveBudget, type ResolvedBudget } from "../budget/config.js";
import { BudgetMeter } from "../budget/meter.js";
import { OwnerDbReader, openOwnerDbForWrite, type OwnerDbWriter } from "../budget/owner-db.js";
import { InferenceGate, type InferenceScope, type ReserveRequest } from "../inference/gate.js";
import { resolveInferencePolicy, type ResolvedInferencePolicy } from "../inference/policy.js";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
/** 2026-03-10T12:00:00Z: inside the March period of a monthly budget resetting on day 1. */
export const T0 = Date.UTC(2026, 2, 10, 12, 0, 0);
/** $2 / $8 per 1M tokens. 5000 input tokens = 1 cent. */
export const PRICE = { inputUsdPerM: 2, outputUsdPerM: 8, local: false };
export const MAIN: InferenceScope = { caller: "agent_turn" };
export const ORCH: InferenceScope = { caller: "orchestrator.plan" };
export const SURVIVAL: InferenceScope = { caller: "survival_turn" };

export interface BudgetEnv {
  tmp: string;
  db: AutomatonDatabase;
  raw: BetterSqlite3.Database;
  clock: { now(): number; set(ms: number): void; advance(ms: number): void };
  ownerPath: string;
  budget: ResolvedBudget;
  reader: OwnerDbReader;
  meter: BudgetMeter;
  /** Opens the owner database for writing (as the CLI does), runs fn, closes it. */
  owner<T>(fn: (w: OwnerDbWriter) => T): T;
  close(): void;
}

export function makeBudgetEnv(rawBudget: unknown = { allowanceCents: 2500, period: "monthly" }, start = T0): BudgetEnv {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  const db = createDatabase(path.join(tmp, "state.db"));
  let t = start;
  const clock = { now: () => t, set: (ms: number) => void (t = ms), advance: (ms: number) => void (t += ms) };
  const ownerPath = path.join(tmp, "owner", "owner.db");
  const budget = resolveBudget(rawBudget)!;
  const reader = new OwnerDbReader(ownerPath, { now: clock.now });
  const meter = new BudgetMeter({ db: db.raw, budget, owner: reader, now: clock.now });
  return {
    tmp,
    db,
    raw: db.raw,
    clock,
    ownerPath,
    budget,
    reader,
    meter,
    owner(fn) {
      const w = openOwnerDbForWrite(ownerPath);
      try {
        return fn(w);
      } finally {
        w.close();
      }
    },
    close() {
      reader.close();
      try {
        db.close();
      } catch {
        // already closed
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export function gatePolicy(daily = 100_000, opts: { ceiling?: number | null; room?: number | null; strategy?: Record<string, unknown> } = {}): ResolvedInferencePolicy {
  return resolveInferencePolicy(
    { modelStrategy: (opts.strategy ?? { survivalMinIntervalMs: 0 }) as any },
    { maxInferenceDailyCents: daily },
    { ceilingCents: opts.ceiling ?? null, survivalRoomCents: opts.room ?? null },
  );
}

export function newBudgetGate(env: BudgetEnv, p: ResolvedInferencePolicy = gatePolicy(), withBudget = true): InferenceGate {
  const g = new InferenceGate({
    db: env.raw,
    policy: p,
    now: env.clock.now,
    bootId: "boot-budget",
    budget: withBudget ? env.meter : undefined,
  });
  g.setSurvival({ tier: "high", creditsCents: 100_000 });
  return g;
}

/** A request whose worst case is exactly `cents` (input only). */
export function req(cents: number, scope: InferenceScope = MAIN, extra: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    callId: `call-${Math.random()}`,
    attempt: 1,
    provider: "openai",
    model: "gpt-4.1",
    price: PRICE,
    estInputTokens: cents * 5000,
    maxOutputTokens: 0,
    minOutputTokens: 0,
    scope,
    ...extra,
  };
}

/** Reserve and commit `cents` at the reserved amount. */
export function spendAi(g: InferenceGate, cents: number, scope: InferenceScope = MAIN): void {
  const r = g.reserve(req(cents, scope));
  g.commit(r.id, null, 1);
}
