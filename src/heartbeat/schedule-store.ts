/**
 * Heartbeat schedule store
 *
 * heartbeat_schedule is what the scheduler runs. heartbeat.yml seeds it at
 * startup, and modify_heartbeat changes it at runtime. Seeding keeps run
 * state (last run, counts, pending retry) and runtime changes; a value from
 * heartbeat.yml replaces the row's value only when the operator changed it
 * in the file since the last seed (compared against a snapshot in KV).
 *
 * Entries whose task differs from their name keep the mapping in KV
 * (heartbeat.task.<name>), so no schema change is needed.
 *
 * Lease times are compared with julianday(), which understands both the
 * ISO strings written here and SQLite's datetime('now') format.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { HeartbeatEntry } from "../types.js";

type DatabaseType = BetterSqlite3.Database;

const SEED_PREFIX = "heartbeat.seed.";
const ALIAS_PREFIX = "heartbeat.task.";
/** A last run this far in the future means the clock stepped back. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

export const DEFAULT_TASK_TIMEOUT_MS = 30_000;
export const DEFAULT_TASK_MAX_RETRIES = 1;

interface SeedSnapshot {
  cron: string;
  enabled: boolean;
  task: string;
}

interface ScheduleRowRaw {
  task_name: string;
  cron_expression: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

function kvGet(db: DatabaseType, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function kvSet(db: DatabaseType, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
}

function kvDelete(db: DatabaseType, key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

function readSnapshot(db: DatabaseType, name: string): SeedSnapshot | null {
  const raw = kvGet(db, SEED_PREFIX + name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SeedSnapshot>;
    if (typeof parsed.cron !== "string" || typeof parsed.enabled !== "boolean") return null;
    return { cron: parsed.cron, enabled: parsed.enabled, task: typeof parsed.task === "string" ? parsed.task : name };
  } catch {
    return null;
  }
}

function isInFuture(iso: string | null, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > nowMs + CLOCK_SKEW_TOLERANCE_MS;
}

/**
 * Seed heartbeat_schedule from heartbeat.yml. Safe to run on every start:
 * - a missing row is inserted;
 * - an existing row keeps its run state and its runtime cron/enabled/task,
 *   unless heartbeat.yml changed that value since the last seed;
 * - a last_run_at in the future (clock stepped back) is cleared, so the
 *   task is not held back until the clock catches up;
 * - all leases are cleared (only one process runs the heartbeat).
 */
export function seedHeartbeatSchedule(db: DatabaseType, entries: HeartbeatEntry[]): void {
  const nowMs = Date.now();
  const tx = db.transaction(() => {
    db.prepare("UPDATE heartbeat_schedule SET lease_owner = NULL, lease_expires_at = NULL WHERE lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL").run();

    for (const entry of entries) {
      const yaml: SeedSnapshot = {
        cron: entry.schedule,
        enabled: entry.enabled !== false,
        task: entry.task || entry.name,
      };
      const existing = db
        .prepare("SELECT task_name, cron_expression, enabled, last_run_at, next_run_at FROM heartbeat_schedule WHERE task_name = ?")
        .get(entry.name) as ScheduleRowRaw | undefined;

      if (!existing) {
        db.prepare(
          `INSERT INTO heartbeat_schedule
           (task_name, cron_expression, interval_ms, enabled, priority, timeout_ms, max_retries, tier_minimum,
            last_run_at, next_run_at, run_count, fail_count, updated_at)
           VALUES (?, ?, NULL, ?, 0, ?, ?, 'dead', ?, ?, 0, 0, datetime('now'))`,
        ).run(
          entry.name,
          yaml.cron,
          yaml.enabled ? 1 : 0,
          DEFAULT_TASK_TIMEOUT_MS,
          DEFAULT_TASK_MAX_RETRIES,
          entry.lastRun ?? null,
          entry.nextRun ?? null,
        );
        applyAlias(db, entry.name, yaml.task);
      } else {
        const prev = readSnapshot(db, entry.name);
        // No snapshot yet (first start with this store): the file is the source.
        const cronChanged = !prev || prev.cron !== yaml.cron;
        const enabledChanged = !prev || prev.enabled !== yaml.enabled;
        const taskChanged = !prev || prev.task !== yaml.task;

        const sets: string[] = [];
        const params: unknown[] = [];
        if (cronChanged && existing.cron_expression !== yaml.cron) {
          sets.push("cron_expression = ?");
          params.push(yaml.cron);
        }
        if (enabledChanged && (existing.enabled === 1) !== yaml.enabled) {
          sets.push("enabled = ?");
          params.push(yaml.enabled ? 1 : 0);
        }
        if (isInFuture(existing.last_run_at, nowMs)) {
          sets.push("last_run_at = NULL");
        }
        if (sets.length > 0) {
          sets.push("updated_at = datetime('now')");
          db.prepare(`UPDATE heartbeat_schedule SET ${sets.join(", ")} WHERE task_name = ?`).run(...params, entry.name);
        }
        if (taskChanged) applyAlias(db, entry.name, yaml.task);
      }

      kvSet(db, SEED_PREFIX + entry.name, JSON.stringify(yaml));
    }

    // Runtime-added rows are not in the file; still undo a clock step for them.
    const rows = db.prepare("SELECT task_name, last_run_at FROM heartbeat_schedule").all() as Array<{
      task_name: string;
      last_run_at: string | null;
    }>;
    for (const row of rows) {
      if (isInFuture(row.last_run_at, nowMs)) {
        db.prepare("UPDATE heartbeat_schedule SET last_run_at = NULL, updated_at = datetime('now') WHERE task_name = ?").run(row.task_name);
      }
    }
  });
  tx();
}

function applyAlias(db: DatabaseType, name: string, task: string): void {
  if (task && task !== name) kvSet(db, ALIAS_PREFIX + name, task);
  else kvDelete(db, ALIAS_PREFIX + name);
}

/** The task function an entry runs when its name is not itself a task. */
export function getTaskAlias(db: DatabaseType, name: string): string | undefined {
  return kvGet(db, ALIAS_PREFIX + name);
}

/** The task an entry runs: its alias, else its own name. */
export function resolveTaskName(db: DatabaseType, name: string): string {
  return getTaskAlias(db, name) ?? name;
}

export function setTaskAlias(db: DatabaseType, name: string, task: string): void {
  applyAlias(db, name, task);
}

export function scheduleEntryExists(db: DatabaseType, name: string): boolean {
  return db.prepare("SELECT 1 FROM heartbeat_schedule WHERE task_name = ?").get(name) !== undefined;
}

/** Returns false when there is no such entry. */
export function setScheduleEnabled(db: DatabaseType, name: string, enabled: boolean): boolean {
  const res = db
    .prepare("UPDATE heartbeat_schedule SET enabled = ?, updated_at = datetime('now') WHERE task_name = ?")
    .run(enabled ? 1 : 0, name);
  return res.changes > 0;
}

/** Returns false when there is no such entry. Clears a pending retry time. */
export function setScheduleCron(db: DatabaseType, name: string, cron: string): boolean {
  const res = db
    .prepare("UPDATE heartbeat_schedule SET cron_expression = ?, next_run_at = NULL, updated_at = datetime('now') WHERE task_name = ?")
    .run(cron, name);
  return res.changes > 0;
}

/** Insert a runtime entry. Throws when the name exists. */
export function addScheduleEntry(db: DatabaseType, name: string, cron: string, task: string, enabled = true): void {
  db.prepare(
    `INSERT INTO heartbeat_schedule
     (task_name, cron_expression, interval_ms, enabled, priority, timeout_ms, max_retries, tier_minimum, run_count, fail_count, updated_at)
     VALUES (?, ?, NULL, ?, 0, ?, ?, 'dead', 0, 0, datetime('now'))`,
  ).run(name, cron, enabled ? 1 : 0, DEFAULT_TASK_TIMEOUT_MS, DEFAULT_TASK_MAX_RETRIES);
  applyAlias(db, name, task);
}

// ─── Leases ─────────────────────────────────────────────────────

export function acquireScheduleLease(db: DatabaseType, name: string, owner: string, ttlMs: number): boolean {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const res = db
    .prepare(
      `UPDATE heartbeat_schedule
       SET lease_owner = ?, lease_expires_at = ?, updated_at = datetime('now')
       WHERE task_name = ?
         AND (lease_owner IS NULL OR lease_expires_at IS NULL
              OR julianday(lease_expires_at) < julianday('now'))`,
    )
    .run(owner, expiresAt, name);
  return res.changes > 0;
}

/** Push the expiry of a lease this owner holds. */
export function extendScheduleLease(db: DatabaseType, name: string, owner: string, ttlMs: number): void {
  db.prepare(
    "UPDATE heartbeat_schedule SET lease_expires_at = ? WHERE task_name = ? AND lease_owner = ?",
  ).run(new Date(Date.now() + ttlMs).toISOString(), name, owner);
}

export function releaseScheduleLease(db: DatabaseType, name: string, owner: string): void {
  db.prepare(
    `UPDATE heartbeat_schedule
     SET lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now')
     WHERE task_name = ? AND lease_owner = ?`,
  ).run(name, owner);
}

export function clearExpiredScheduleLeases(db: DatabaseType): number {
  return db
    .prepare(
      `UPDATE heartbeat_schedule
       SET lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now')
       WHERE lease_expires_at IS NOT NULL AND julianday(lease_expires_at) < julianday('now')`,
    )
    .run().changes;
}
