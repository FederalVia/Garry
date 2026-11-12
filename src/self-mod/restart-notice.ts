/**
 * Restart notice
 *
 * A rebuild replaces dist/ under the running process, but Node keeps
 * running the modules it already loaded. Tools that rebuild say so, and set
 * a KV flag the runtime shows in the system prompt and logs until the next
 * start (a new process deletes it).
 */

/** KV key; value is JSON {"reason": string, "at": ISO timestamp}. */
export const RESTART_REQUIRED_KEY = "restart_required";

export const RESTART_NOTICE =
  "The running process still uses the old code; the change takes effect after a restart.";

export interface RestartRequired {
  reason: string;
  at: string;
}

interface KVStore {
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
}

export function markRestartRequired(db: KVStore, reason: string): void {
  const value: RestartRequired = { reason, at: new Date().toISOString() };
  db.setKV(RESTART_REQUIRED_KEY, JSON.stringify(value));
}

export function getRestartRequired(db: KVStore): RestartRequired | null {
  const raw = db.getKV(RESTART_REQUIRED_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RestartRequired>;
    if (typeof parsed.reason !== "string" || typeof parsed.at !== "string") return null;
    return { reason: parsed.reason, at: parsed.at };
  } catch {
    return null;
  }
}
