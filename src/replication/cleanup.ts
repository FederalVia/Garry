/**
 * Sandbox Cleanup
 *
 * Cleans up sandbox resources for stopped/failed children.
 * Transitions children to cleaned_up state after destruction.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { ConwayClient } from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import { createLogger } from "../observability/logger.js";
import { killChildProcess } from "./health.js";
import { isEnded } from "./child-status.js";
import { rethrowIfCancelled, throwIfCancelled } from "../runtime/cancellation.js";
const logger = createLogger("replication.cleanup");

export class SandboxCleanup {
  constructor(
    private conway: ConwayClient,
    private lifecycle: ChildLifecycle,
    private db: DatabaseType,
  ) {}

  /**
   * Clean up a single child's sandbox.
   * Only works for children in stopped or failed state. A child whose
   * process may still run (a forced stop, or a legacy row with no lifecycle
   * events) is cleaned up only once a kill in its sandbox is verified; until
   * then this throws and the row is kept, so the child is never untracked.
   */
  async cleanup(childId: string): Promise<void> {
    const childRow = this.db
      .prepare("SELECT sandbox_id, status FROM children WHERE id = ?")
      .get(childId) as { sandbox_id: string; status: string } | undefined;
    const state = this.lifecycle.getStateOrNull(childId);

    if (!state) {
      // Legacy row: the base runtime wrote these statuses with no proof the
      // process had ended (the pool optimizer's cull wrote 'stopped').
      if (!childRow || (childRow.status !== "stopped" && childRow.status !== "failed")) {
        throw new Error(`Cannot clean up child in state: ${childRow?.status ?? "unknown"}`);
      }
      await this.ensureProcessGone(childId, childRow.sandbox_id);
      this.db.prepare("UPDATE children SET status = 'dead', last_checked = datetime('now') WHERE id = ?").run(childId);
      return;
    }

    if (state !== "stopped" && state !== "failed") {
      throw new Error(`Cannot clean up child in state: ${state}`);
    }
    if (state === "failed" && processUnverified(this.lifecycle, childId)) {
      await this.ensureProcessGone(childId, childRow?.sandbox_id ?? "");
    }

    // Sandbox deletion is disabled by the Conway API (prepaid, non-refundable).
    // Transition to cleaned_up so the child slot is freed for reuse.
    const sandboxNote = childRow?.sandbox_id
      ? `sandbox ${childRow.sandbox_id} released (deletion disabled)`
      : "no sandbox to clean up";
    this.lifecycle.transition(childId, "cleaned_up", sandboxNote);
  }

  /** Throws unless no agent process of this child can still run. */
  private async ensureProcessGone(childId: string, sandboxId: string): Promise<void> {
    if (!sandboxId) return;
    // A newer child reuses the sandbox only after its old process was
    // verified gone; a process there now is the newer child's.
    const sharedWith = this.db
      .prepare("SELECT status FROM children WHERE sandbox_id = ? AND id <> ?")
      .all(sandboxId, childId) as Array<{ status: string }>;
    if (sharedWith.some((row) => !isEnded(row.status))) return;

    const kill = await killChildProcess(this.conway, sandboxId);
    if (kill.outcome !== "stopped") {
      throw new Error(`process of child ${childId} may still run: ${kill.detail}`);
    }
  }

  /**
   * Clean up all stopped and failed children.
   */
  async cleanupAll(): Promise<number> {
    const stopped = this.lifecycle.getChildrenInState("stopped");
    const failed = this.lifecycle.getChildrenInState("failed");
    let cleaned = 0;

    for (const child of [...stopped, ...failed]) {
      throwIfCancelled();
      try {
        await this.cleanup(child.id);
        cleaned++;
      } catch (error) {
        rethrowIfCancelled(error);
        logger.error(`Failed to clean up child ${child.id}`, error instanceof Error ? error : undefined);
      }
    }

    return cleaned;
  }

  /**
   * Clean up children that have been in stopped/failed state for too long.
   */
  async cleanupStale(maxAgeHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
    // julianday() reads both SQLite's "YYYY-MM-DD HH:MM:SS" and ISO strings
    // as UTC; a plain string comparison of the two formats is wrong.
    const stale = this.db.prepare(
      `SELECT id FROM children
       WHERE status IN ('failed', 'stopped')
         AND julianday(COALESCE(last_checked, created_at)) < julianday(?)`,
    ).all(cutoff) as Array<{ id: string }>;

    let cleaned = 0;
    for (const child of stale) {
      throwIfCancelled();
      try {
        await this.cleanup(child.id);
        cleaned++;
      } catch (error) {
        rethrowIfCancelled(error);
        logger.error(`Failed to clean up stale child ${child.id}`, error instanceof Error ? error : undefined);
      }
    }

    return cleaned;
  }
}

/** Metadata on a failed event whose process was never verified gone (a forced stop). */
export const PROCESS_UNVERIFIED = "processUnverified";

function processUnverified(lifecycle: ChildLifecycle, childId: string): boolean {
  const history = lifecycle.getHistory(childId);
  const latest = history[history.length - 1];
  if (!latest || latest.toState !== "failed") return false;
  try {
    return JSON.parse(latest.metadata || "{}")[PROCESS_UNVERIFIED] === true;
  } catch {
    return false;
  }
}
