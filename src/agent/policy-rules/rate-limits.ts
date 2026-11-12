/**
 * Rate Limit Policy Rules
 *
 * Enforces rate limits on sensitive operations to prevent abuse.
 * The quota counts evidence that an operation took effect (or may have),
 * never policy 'allow' decisions: executeTool logs the decision before the
 * tool runs, so a call that failed would otherwise use up the quota.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
} from "../../types.js";

type RawDb = import("better-sqlite3").Database;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function rawDbOf(request: PolicyRequest): RawDb | undefined {
  return (request.context.db as any)?.raw ?? (request.context as any).rawDb;
}

/** modifications.timestamp is ISO 8601, so ISO strings compare in order. */
function countModifications(db: RawDb, type: string, windowMs: number): number {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM modifications WHERE type = ? AND timestamp >= ?")
    .get(type, cutoff) as { count: number };
  return row.count;
}

/**
 * Spawns that cost a sandbox, or may have, in the window:
 * - children rows created in the window, except in-process local workers
 *   and rows that failed before any sandbox id was recorded;
 * - plus sandbox creations the treasury sent whose outcome is still open or
 *   unknown (a timeout or 5xx after the POST left: a prepaid sandbox may
 *   exist although the child row records none).
 * Orchestrator-spawned Conway children count too: they cost the same.
 */
function countSpawns(db: RawDb, windowMs: number): number {
  const cutoffMs = Date.now() - windowMs;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const cutoffSql = cutoffIso.replace("T", " ").replace(/\.\d{3}Z$/, "");
  // children.created_at is SQLite datetime() text for insertChild rows and
  // ISO text for lifecycle rows; compare each form against its own cutoff.
  const children = db
    .prepare(
      `SELECT COUNT(*) AS count FROM children
        WHERE address NOT LIKE 'local://%'
          AND NOT (status = 'failed' AND sandbox_id = '')
          AND ((created_at LIKE '____-__-__T%' AND created_at >= ?)
            OR (created_at NOT LIKE '____-__-__T%' AND created_at >= ?))`,
    )
    .get(cutoffIso, cutoffSql) as { count: number };
  const unknownSandboxes = db
    .prepare(
      `SELECT COUNT(*) AS count FROM treasury_ledger
        WHERE kind = 'sandbox_create' AND status IN ('sent', 'unknown')
          AND COALESCE(sent_at_ms, created_at_ms) >= ?`,
    )
    .get(cutoffMs) as { count: number };
  return children.count + unknownSandboxes.count;
}

/**
 * Maximum 1 genesis prompt change per day: counts prompt_change rows, which
 * update_genesis_prompt writes only after the change is applied.
 */
function createGenesisPromptDailyRule(): PolicyRule {
  return {
    id: "rate.genesis_prompt_daily",
    description: "Maximum 1 genesis prompt change per day",
    priority: 600,
    appliesTo: { by: "name", names: ["update_genesis_prompt"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const db = rawDbOf(request);
      if (!db) return deny(this.id, "DB_UNAVAILABLE", "Rate limit check failed: database not accessible");

      const recentCount = countModifications(db, "prompt_change", DAY_MS);

      if (recentCount >= 1) {
        return deny(
          "rate.genesis_prompt_daily",
          "RATE_LIMIT_GENESIS",
          `Genesis prompt change rate exceeded: ${recentCount} changes in the last 24 hours (max 1/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Maximum 10 self-mod edits per hour: counts code_edit rows, which
 * editFile writes only after the file was written.
 */
function createSelfModHourlyRule(): PolicyRule {
  return {
    id: "rate.self_mod_hourly",
    description: "Maximum 10 own-code edits per hour",
    priority: 600,
    appliesTo: { by: "name", names: ["edit_own_file"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const db = rawDbOf(request);
      if (!db) return deny(this.id, "DB_UNAVAILABLE", "Rate limit check failed: database not accessible");

      const recentCount = countModifications(db, "code_edit", HOUR_MS);

      if (recentCount >= 10) {
        return deny(
          "rate.self_mod_hourly",
          "RATE_LIMIT_SELF_MOD",
          `Self-modification rate exceeded: ${recentCount} edits in the last hour (max 10/hour)`,
        );
      }

      return null;
    },
  };
}

/**
 * Maximum 3 child spawns per day, counted as sandboxes created or possibly
 * created (see countSpawns).
 */
function createSpawnDailyRule(): PolicyRule {
  return {
    id: "rate.spawn_daily",
    description: "Maximum 3 child spawns per day",
    priority: 600,
    appliesTo: { by: "name", names: ["spawn_child"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const db = rawDbOf(request);
      if (!db) return deny(this.id, "DB_UNAVAILABLE", "Rate limit check failed: database not accessible");

      const recentCount = countSpawns(db, DAY_MS);

      if (recentCount >= 3) {
        return deny(
          "rate.spawn_daily",
          "RATE_LIMIT_SPAWN",
          `Child spawn rate exceeded: ${recentCount} spawns in the last 24 hours (max 3/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Create all rate limit policy rules.
 */
export function createRateLimitRules(): PolicyRule[] {
  return [
    createGenesisPromptDailyRule(),
    createSelfModHourlyRule(),
    createSpawnDailyRule(),
  ];
}
