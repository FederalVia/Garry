/**
 * Lineage Tracking
 *
 * Track parent-child relationships between automatons.
 * The parent records children in SQLite.
 * Children record their parent in config.
 * ERC-8004 registration includes parentAgent field.
 *
 * Phase 3.1: Actual pruning + concurrency-limited refresh.
 */

import type {
  AutomatonDatabase,
  ChildAutomaton,
  AutomatonConfig,
  ConwayClient,
} from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import type { ChildHealthMonitor } from "./health.js";
import type { SandboxCleanup } from "./cleanup.js";
import { deleteChild } from "../state/database.js";
import { LEGACY_LIVE, LIVE, isEnded, parseDbTimestamp } from "./child-status.js";
import { createLogger } from "../observability/logger.js";
import { rethrowIfCancelled, throwIfCancelled } from "../runtime/cancellation.js";
const logger = createLogger("replication.lineage");

/**
 * Get the full lineage tree (parent -> children).
 */
export function getLineage(db: AutomatonDatabase): {
  children: ChildAutomaton[];
  alive: number;
  dead: number;
  total: number;
} {
  const children = db.getChildren();
  const alive = children.filter((c) => LIVE.has(c.status) || LEGACY_LIVE.has(c.status)).length;
  const dead = children.filter((c) => isEnded(c.status)).length;

  return {
    children,
    alive,
    dead,
    total: children.length,
  };
}

/**
 * Check if this automaton has a parent (is itself a child).
 */
export function hasParent(config: AutomatonConfig): boolean {
  return !!config.parentAddress;
}

/**
 * Get a summary of the lineage for the system prompt.
 */
export function getLineageSummary(
  db: AutomatonDatabase,
  config: AutomatonConfig,
): string {
  const lineage = getLineage(db);
  const parts: string[] = [];

  if (hasParent(config)) {
    parts.push(`Parent: ${config.parentAddress}`);
  }

  if (lineage.total > 0) {
    parts.push(
      `Children: ${lineage.total} total (${lineage.alive} alive, ${lineage.dead} dead)`,
    );
    for (const child of lineage.children) {
      parts.push(
        `  - ${child.name} (id: ${child.id}) [${child.status}] sandbox:${child.sandboxId}`,
      );
    }
  }

  return parts.length > 0 ? parts.join("\n") : "No lineage (first generation)";
}

/**
 * Prune dead children: delete old ended rows from the DB.
 *
 * Only rows whose lifecycle state (or legacy status) is ended are
 * considered. With a cleanup, a row is deleted only after the cleanup
 * succeeds or when it is already cleaned_up/dead; a failed cleanup keeps the
 * row, so the record of a child that may still run is never lost.
 */
export async function pruneDeadChildren(
  db: AutomatonDatabase,
  cleanup?: SandboxCleanup,
  keepLast: number = 5,
): Promise<number> {
  const children = db.getChildren().map((child) => ({ child, state: effectiveState(db, child) }));
  const dead = children.filter((entry) => isEnded(entry.state));

  if (dead.length <= keepLast) return 0;

  // Sort by creation date, oldest first
  dead.sort((a, b) => createdMs(a.child) - createdMs(b.child));

  // Keep the most recent `keepLast` dead children
  const toRemove = dead.slice(0, dead.length - keepLast);
  let removed = 0;

  for (const { child, state } of toRemove) {
    throwIfCancelled();
    try {
      if (cleanup && state !== "cleaned_up" && state !== "dead") {
        try {
          await cleanup.cleanup(child.id);
        } catch (error) {
          // Cancelled: stop here; the child being cleaned keeps its row.
          rethrowIfCancelled(error);
          logger.warn(`Keeping child ${child.id}: cleanup failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      // Actually delete from DB
      deleteChild(db.raw, child.id);
      removed++;
    } catch (error) {
      rethrowIfCancelled(error);
      logger.error(`Failed to prune child ${child.id}`, error instanceof Error ? error : undefined);
    }
  }

  return removed;
}

/** Lifecycle state when the child has events, else the stored status. */
function effectiveState(db: AutomatonDatabase, child: ChildAutomaton): string {
  try {
    const row = db.raw
      .prepare(
        "SELECT to_state FROM child_lifecycle_events WHERE child_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(child.id) as { to_state: string } | undefined;
    return row?.to_state ?? child.status;
  } catch {
    return child.status;
  }
}

function createdMs(child: ChildAutomaton): number {
  const ms = parseDbTimestamp(child.createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Refresh status of all children using health monitor.
 * Concurrency limited to 3 simultaneous checks.
 */
export async function refreshChildrenStatus(
  conway: ConwayClient,
  db: AutomatonDatabase,
  healthMonitor?: ChildHealthMonitor,
): Promise<void> {
  if (healthMonitor) {
    // Use the health monitor with built-in concurrency limiting
    await healthMonitor.checkAllChildren();
    return;
  }

  // Without a monitor there is no probe that reaches the child's sandbox;
  // writing statuses from a probe of our own sandbox would be wrong, and
  // lifecycle rows are written only by ChildLifecycle.
  void conway;
  void db;
}
