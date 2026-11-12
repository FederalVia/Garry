/**
 * Child status sets and timestamp parsing.
 *
 * One place that says which children rows hold a spawn slot, which ones
 * may have a live process, and how to read the timestamps SQLite writes.
 * Every consumer (spawn, health monitors, heartbeat tasks, cleanup and
 * lineage) uses these instead of ad-hoc status lists.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { ChildStatus } from "../types.js";

/** Lifecycle states between the spawn request and a verified wallet. */
export const SPAWNING: ReadonlySet<string> = new Set<ChildStatus>([
  "requested",
  "sandbox_created",
  "runtime_ready",
]);

/** Spawned, never started: no process is expected. */
export const PRE_START: ReadonlySet<string> = new Set<ChildStatus>(["wallet_verified", "funded"]);

/** Lifecycle states in which a process is (or may be) running. */
export const LIVE: ReadonlySet<string> = new Set<ChildStatus>(["starting", "healthy", "unhealthy"]);

/** Rows from before the lifecycle machine; nothing is known about them. */
export const LEGACY_LIVE: ReadonlySet<string> = new Set<ChildStatus>([
  "spawning",
  "running",
  "sleeping",
  "unknown",
]);

/** Ended or terminal: no process, and the row no longer holds a slot. */
export const ENDED: ReadonlySet<string> = new Set<ChildStatus>([
  "stopped",
  "failed",
  "dead",
  "cleaned_up",
]);

/** Nothing ever leaves these. */
export const TERMINAL: ReadonlySet<string> = new Set<ChildStatus>(["cleaned_up", "dead"]);

/** Statuses that count against maxChildren. */
export const SLOT_HOLDING: ReadonlySet<string> = new Set<string>([
  ...SPAWNING,
  ...PRE_START,
  ...LIVE,
  ...LEGACY_LIVE,
]);

/**
 * Whether a row in this status counts against maxChildren. An unrecognised
 * status counts, so a corrupt row can never let the parent overspend.
 */
export function holdsSlot(status: string | null | undefined): boolean {
  if (!status) return true;
  return !ENDED.has(status);
}

export function isEnded(status: string | null | undefined): boolean {
  return !!status && ENDED.has(status);
}

const ZONELESS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Parse a timestamp from the database. SQLite's datetime('now') writes UTC
 * without a zone ("YYYY-MM-DD HH:MM:SS"), which Date.parse would read as
 * local time; such values are read as UTC. Returns NaN when unparseable.
 */
export function parseDbTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const trimmed = value.trim();
  if (ZONELESS.test(trimmed)) {
    return Date.parse(`${trimmed.replace(" ", "T")}Z`);
  }
  return Date.parse(trimmed);
}

/** Number of children rows that currently hold a spawn slot. */
export function countSlotHoldingChildren(db: DatabaseType): number {
  const rows = db.prepare("SELECT status FROM children").all() as Array<{ status: string }>;
  return rows.filter((row) => holdsSlot(row.status)).length;
}

/** Whether this child has lifecycle events (the lifecycle owns its status). */
export function hasLifecycleEvents(db: DatabaseType, childId: string): boolean {
  try {
    return db.prepare("SELECT 1 FROM child_lifecycle_events WHERE child_id = ? LIMIT 1").get(childId) !== undefined;
  } catch {
    return false;
  }
}

/** Time of the latest lifecycle event of a child, in ms (NaN when none). */
export function latestLifecycleEventMs(db: DatabaseType, childId: string): number {
  try {
    const row = db
      .prepare(
        "SELECT created_at FROM child_lifecycle_events WHERE child_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(childId) as { created_at: string } | undefined;
    return parseDbTimestamp(row?.created_at);
  } catch {
    return Number.NaN;
  }
}
