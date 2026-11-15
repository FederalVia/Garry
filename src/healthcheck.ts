/**
 * Container healthcheck: healthy while the heartbeat runs.
 *
 * Reads the newest heartbeat_history row from state.db through a read-only
 * connection. No network, no writes, no config changes. A dead agent is
 * healthy: its heartbeat keeps running while it waits for budget, and a
 * restart would not help it.
 *
 * Exit 0 healthy, 1 unhealthy. `node dist/healthcheck.js`
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

/**
 * health_check runs every 30 minutes in every mode, so a heartbeat older
 * than this means the scheduler stopped. AUTOMATON_HEALTH_MAX_AGE_MIN
 * overrides it.
 */
export const DEFAULT_MAX_AGE_MS = 45 * 60_000;

export interface HealthResult {
  ok: boolean;
  reason: string;
  lastBeatMs: number | null;
}

function expandHome(p: string, home: string): string {
  return p.startsWith("~") ? path.join(home, p.slice(1)) : p;
}

/** state.db's path from automaton.json, read as plain JSON (nothing is validated or written). */
export function stateDbPath(home: string): string {
  const fallback = path.join(home, ".automaton", "state.db");
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, ".automaton", "automaton.json"), "utf8"));
    if (raw && typeof raw.dbPath === "string" && raw.dbPath.trim()) return expandHome(raw.dbPath.trim(), home);
  } catch {
    // No or unreadable config: the default location.
  }
  return fallback;
}

export function checkHealth(opts: { home?: string; now?: number; maxAgeMs?: number } = {}): HealthResult {
  const home = opts.home ?? process.env.HOME ?? "";
  if (!home) return { ok: false, reason: "HOME is not set", lastBeatMs: null };
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const dbPath = stateDbPath(home);

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { ok: false, reason: `cannot open ${dbPath}: ${(err as Error).message}`, lastBeatMs: null };
  }
  try {
    db.pragma("busy_timeout = 2000");
    const row = db.prepare("SELECT MAX(started_at) AS last FROM heartbeat_history").get() as
      | { last: string | null }
      | undefined;
    const last = row?.last ? Date.parse(row.last) : NaN;
    if (!Number.isFinite(last)) return { ok: false, reason: "no heartbeat recorded yet", lastBeatMs: null };
    const age = now - last;
    if (age > maxAgeMs) {
      return { ok: false, reason: `last heartbeat ${Math.round(age / 60_000)} min ago`, lastBeatMs: last };
    }
    return { ok: true, reason: `last heartbeat ${Math.max(0, Math.round(age / 1000))} s ago`, lastBeatMs: last };
  } catch (err) {
    return { ok: false, reason: `cannot read heartbeat history: ${(err as Error).message}`, lastBeatMs: null };
  } finally {
    db.close();
  }
}

export function maxAgeFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const min = Number(env.AUTOMATON_HEALTH_MAX_AGE_MIN);
  return Number.isFinite(min) && min > 0 ? min * 60_000 : DEFAULT_MAX_AGE_MS;
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const result = checkHealth({ maxAgeMs: maxAgeFromEnv() });
  console.log(`${result.ok ? "healthy" : "unhealthy"}: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}
