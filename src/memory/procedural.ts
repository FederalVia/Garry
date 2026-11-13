/**
 * Procedural Memory Manager
 *
 * Stores learned procedures (step-by-step instructions) with success/failure tracking.
 * Upserts on procedure name.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { ProceduralMemoryEntry, ProceduralStep } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { LIKE_ESCAPE, likeContains } from "../state/like-escape.js";
const logger = createLogger("memory.procedural");

type Database = BetterSqlite3.Database;

export class ProceduralMemoryManager {
  constructor(private db: Database) {}

  /**
   * Save a procedure. Upserts on name.
   * Returns the id of the stored row (the original id when the name already
   * existed); throws when the write fails.
   */
  save(entry: {
    name: string;
    description: string;
    steps: ProceduralStep[];
  }): string {
    const id = ulid();
    try {
      this.db.prepare(
        `INSERT INTO procedural_memory (id, name, description, steps)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           steps = excluded.steps,
           updated_at = datetime('now')`,
      ).run(
        id,
        entry.name,
        entry.description,
        JSON.stringify(Array.isArray(entry.steps) ? entry.steps : []),
      );
      const row = this.db.prepare(
        "SELECT id FROM procedural_memory WHERE name = ?",
      ).get(entry.name) as { id: string } | undefined;
      if (!row) throw new Error("stored row not found");
      return row.id;
    } catch (error) {
      logger.error("Failed to save", error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get a procedure by name.
   */
  get(name: string): ProceduralMemoryEntry | undefined {
    try {
      const row = this.db.prepare(
        "SELECT * FROM procedural_memory WHERE name = ?",
      ).get(name) as any | undefined;
      return row ? deserializeProcedural(row) : undefined;
    } catch (error) {
      logger.error("Failed to get", error instanceof Error ? error : undefined);
      return undefined;
    }
  }

  /**
   * Record a success or failure outcome for a named procedure.
   */
  recordOutcome(name: string, success: boolean): void {
    try {
      const column = success ? "success_count" : "failure_count";
      this.db.prepare(
        `UPDATE procedural_memory SET ${column} = ${column} + 1, last_used_at = datetime('now'), updated_at = datetime('now') WHERE name = ?`,
      ).run(name);
    } catch (error) {
      logger.error("Failed to record outcome", error instanceof Error ? error : undefined);
    }
  }

  /**
   * Search procedures by name or description. A negative limit means no limit.
   */
  search(query: string, limit: number = -1): ProceduralMemoryEntry[] {
    try {
      const pattern = likeContains(query);
      const rows = this.db.prepare(
        `SELECT * FROM procedural_memory
         WHERE name LIKE ? ${LIKE_ESCAPE} OR description LIKE ? ${LIKE_ESCAPE}
         ORDER BY success_count DESC, updated_at DESC
         LIMIT ?`,
      ).all(pattern, pattern, limit) as any[];
      return rows.map(deserializeProcedural);
    } catch (error) {
      logger.error("Failed to search", error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Delete a procedure by name.
   */
  delete(name: string): void {
    try {
      this.db.prepare("DELETE FROM procedural_memory WHERE name = ?").run(name);
    } catch (error) {
      logger.error("Failed to delete", error instanceof Error ? error : undefined);
    }
  }
}

function deserializeProcedural(row: any): ProceduralMemoryEntry {
  let steps: ProceduralStep[] = [];
  try {
    const parsed = JSON.parse(row.steps || "[]");
    // A stored non-array (from before steps were validated) reads as no steps.
    steps = Array.isArray(parsed) ? parsed.filter((s) => s && typeof s === "object") : [];
  } catch {
    logger.error("Failed to parse steps for: " + row.name);
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    steps,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
