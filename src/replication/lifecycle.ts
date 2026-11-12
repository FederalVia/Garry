/**
 * Child Lifecycle State Machine
 *
 * Manages child automaton lifecycle transitions with validation.
 * Every transition is recorded in the child_lifecycle_events table.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ulid } from "ulid";
import type {
  AutomatonDatabase,
  ChildLifecycleState,
  ChildLifecycleEventRow,
  ConwayClient,
} from "../types.js";
import { VALID_TRANSITIONS } from "../types.js";
import {
  lifecycleInsertEvent,
  lifecycleGetEvents,
  lifecycleGetLatestState,
  getChildrenByStatus,
  updateChildStatus as dbUpdateChildStatus,
} from "../state/database.js";
import { ENDED, LIVE, PRE_START, SPAWNING, TERMINAL, latestLifecycleEventMs } from "./child-status.js";
import { PROCESS_UNVERIFIED } from "./cleanup.js";
import { killChildProcess } from "./health.js";

/** A spawn with no progress for this long may be abandoned by stop_child. */
export const STUCK_SPAWN_MS = 15 * 60 * 1000;

export class ChildLifecycle {
  constructor(private db: DatabaseType) {}

  /**
   * Initialize a child record and insert the first lifecycle event.
   */
  initChild(childId: string, name: string, sandboxId: string, genesisPrompt: string, chainType?: string): void {
    this.db.transaction(() => this.insertRequested(childId, name, sandboxId, genesisPrompt, chainType))();
  }

  private insertRequested(childId: string, name: string, sandboxId: string, genesisPrompt: string, chainType?: string): void {
    // Insert child row into children table
    this.db.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status, created_at, chain_type)
       VALUES (?, ?, '', ?, ?, 'requested', datetime('now'), ?)`,
    ).run(childId, name, sandboxId, genesisPrompt, chainType ?? "evm");

    // Record initial event
    const event: ChildLifecycleEventRow = {
      id: ulid(),
      childId,
      fromState: "none",
      toState: "requested",
      reason: "child created",
      metadata: "{}",
      createdAt: new Date().toISOString(),
    };
    lifecycleInsertEvent(this.db, event);
    dbUpdateChildStatus(this.db, childId, "requested");
  }

  /**
   * Transition a child to a new state with validation.
   * Throws on invalid transitions.
   */
  transition(childId: string, toState: ChildLifecycleState, reason?: string, metadata?: Record<string, unknown>): void {
    const current = this.getCurrentState(childId);
    const allowed = VALID_TRANSITIONS[current];

    if (!allowed || !allowed.includes(toState)) {
      throw new Error(`Invalid lifecycle transition: ${current} → ${toState}`);
    }

    // Record transition event
    const event: ChildLifecycleEventRow = {
      id: ulid(),
      childId,
      fromState: current,
      toState,
      reason: reason ?? null,
      metadata: JSON.stringify(metadata ?? {}),
      createdAt: new Date().toISOString(),
    };
    // The event and children.status change together, so they never disagree.
    this.db.transaction(() => {
      lifecycleInsertEvent(this.db, event);
      dbUpdateChildStatus(this.db, childId, toState);
    })();
  }

  /**
   * Get the current lifecycle state of a child.
   */
  /** The current lifecycle state, or null for a row with no events (legacy). */
  getStateOrNull(childId: string): ChildLifecycleState | null {
    return lifecycleGetLatestState(this.db, childId);
  }

  getCurrentState(childId: string): ChildLifecycleState {
    const state = lifecycleGetLatestState(this.db, childId);
    if (!state) {
      throw new Error(`Child ${childId} not found in lifecycle events`);
    }
    return state;
  }

  /**
   * Get the full lifecycle event history for a child.
   */
  getHistory(childId: string): ChildLifecycleEventRow[] {
    return lifecycleGetEvents(this.db, childId);
  }

  /**
   * Get all children in a given lifecycle state.
   */
  getChildrenInState(state: ChildLifecycleState): Array<{ id: string; name: string; sandboxId: string; status: string; createdAt: string; lastChecked: string | null }> {
    const rows = getChildrenByStatus(this.db, state);
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      sandboxId: row.sandbox_id,
      status: row.status,
      createdAt: row.created_at,
      lastChecked: row.last_checked ?? null,
    }));
  }
}

/**
 * Stop a child and free its slot (the stop_child tool).
 *
 * - starting/healthy/unhealthy: kill the agent process in the child's
 *   sandbox; only a verified stop moves the child to stopped (starting goes
 *   to failed, the only exit the machine allows). An unverified stop
 *   changes nothing.
 * - wallet_verified/funded: no process; abandoned -> failed.
 * - requested/sandbox_created/runtime_ready: abandoned -> failed once the
 *   spawn has made no progress for STUCK_SPAWN_MS.
 * - failed/stopped: the row stays as it is, but a process that may still run in its
 *   sandbox (start could not be confirmed, forced stop) is killed and
 *   verified gone, unless a newer child reuses the sandbox.
 * - force: a live child whose stop cannot be verified (sandbox unreachable)
 *   moves to failed anyway, with the forced stop in its lifecycle event.
 * - Legacy rows without lifecycle events (also 'stopped'/'failed' ones): same
 *   kill and verify, then 'dead'.
 */
export async function stopChild(
  db: AutomatonDatabase,
  conway: ConwayClient,
  childId: string,
  reason: string,
  nowMs: number = Date.now(),
  options: { force?: boolean } = {},
): Promise<string> {
  const child = db.getChildById(childId);
  if (!child) return `Child ${childId} not found.`;
  const lifecycle = new ChildLifecycle(db.raw);
  const state = lifecycle.getStateOrNull(child.id);

  if (!state) {
    if (TERMINAL.has(child.status)) return `Child ${child.name} has already ended (${child.status}).`;
    // Legacy 'stopped'/'failed' carry no proof the process ended (the old
    // pool optimizer culled rows to 'stopped' without touching the sandbox).
    const sandboxReused = !!child.sandboxId && (db.raw
      .prepare("SELECT status FROM children WHERE sandbox_id = ? AND id <> ?")
      .all(child.sandboxId, child.id) as Array<{ status: string }>).some((row) => !ENDED.has(row.status));
    if (child.sandboxId && !(ENDED.has(child.status) && sandboxReused)) {
      const kill = await killChildProcess(conway, child.sandboxId);
      if (kill.outcome !== "stopped") {
        return `Could not stop child ${child.name}: ${kill.detail}. Status left at '${child.status}'.`;
      }
    }
    db.raw.prepare("UPDATE children SET status = 'dead', last_checked = datetime('now') WHERE id = ?").run(child.id);
    return `Child ${child.name} stopped (legacy record marked dead). Reason: ${reason}`;
  }

  if ((state === "failed" || state === "stopped") && child.sandboxId) {
    const sharedWith = db.raw
      .prepare("SELECT id, status FROM children WHERE sandbox_id = ? AND id <> ?")
      .all(child.sandboxId, child.id) as Array<{ id: string; status: string }>;
    if (sharedWith.some((row) => !ENDED.has(row.status))) {
      return `Child ${child.name} has already ended (${state}); its sandbox is now used by another child, so nothing was killed.`;
    }
    const kill = await killChildProcess(conway, child.sandboxId);
    if (kill.outcome !== "stopped") {
      return `Child ${child.name} has ended (${state}), but its process could not be verified gone: ${kill.detail}.`;
    }
    return `Child ${child.name} has ended (${state}); no agent process runs in its sandbox (${kill.detail}).`;
  }

  if (ENDED.has(state)) return `Child ${child.name} has already ended (${state}).`;

  if (PRE_START.has(state)) {
    lifecycle.transition(child.id, "failed", `abandoned before start: ${reason}`);
    return `Child ${child.name} abandoned (was ${state}, now failed); its slot is free. Reason: ${reason}`;
  }

  if (SPAWNING.has(state)) {
    const sinceMs = nowMs - latestLifecycleEventMs(db.raw, child.id);
    if (!(sinceMs >= STUCK_SPAWN_MS)) {
      return `Child ${child.name} is still being spawned (${state}); try again if it makes no progress for ${STUCK_SPAWN_MS / 60_000} minutes.`;
    }
    lifecycle.transition(child.id, "failed", `spawn abandoned: ${reason}`);
    return `Child ${child.name} spawn abandoned (was ${state}, now failed); its slot is free.`;
  }

  if (LIVE.has(state)) {
    if (!child.sandboxId) {
      return `Could not stop child ${child.name}: it has no sandbox id. Status left at '${state}'.`;
    }
    const kill = await killChildProcess(conway, child.sandboxId);
    if (kill.outcome === "unknown" && options.force) {
      // healthy may only reach failed through unhealthy.
      db.raw.transaction(() => {
        if (state === "healthy") lifecycle.transition(child.id, "unhealthy", `forced stop requested: ${reason}`);
        // Cleanup keeps the row until a later kill is verified.
        lifecycle.transition(child.id, "failed", `forced stop, process not verified (${kill.detail}): ${reason}`, {
          [PROCESS_UNVERIFIED]: true,
        });
      })();
      return `Child ${child.name} marked failed by a forced stop; its process could not be verified gone (${kill.detail}). ` +
        `Its slot is free. Run stop_child again later to kill a process that may still run.`;
    }
    if (kill.outcome !== "stopped") {
      const hint = kill.outcome === "unknown" ? " Use force to mark it failed anyway." : "";
      return `Could not stop child ${child.name}: ${kill.detail}. Status left at '${state}'.${hint}`;
    }
    const target: ChildLifecycleState = state === "starting" ? "failed" : "stopped";
    lifecycle.transition(child.id, target, `${reason} (${kill.detail})`);
    return `Child ${child.name} stopped (${kill.detail}); status ${target}, slot freed. Reason: ${reason}`;
  }

  return `Child ${child.name} is in state '${state}' and cannot be stopped.`;
}
