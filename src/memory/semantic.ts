/**
 * Semantic Memory Manager
 *
 * Stores factual knowledge indexed by category and key.
 * Supports upsert semantics (category+key is unique), confidence scoring,
 * and LRU-based pruning.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { SemanticMemoryEntry, SemanticCategory } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { LIKE_ESCAPE, likeContains } from "../state/like-escape.js";
const logger = createLogger("memory.semantic");

type Database = BetterSqlite3.Database;

/**
 * A score in [0, 1]: numbers (or numeric strings) are clamped, anything
 * non-finite becomes the fallback. Keeps TEXT out of REAL score columns.
 */
export function clampScore(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export class SemanticMemoryManager {
  constructor(private db: Database) {}

  /**
   * Store a semantic memory entry. Upserts on (category, key).
   * Returns the id of the stored row; throws when the write fails.
   */
  store(entry: {
    category: SemanticCategory;
    key: string;
    value: string;
    confidence?: number;
    source: string;
    embeddingKey?: string | null;
  }): string {
    const id = ulid();
    try {
      this.db.prepare(
        `INSERT INTO semantic_memory (id, category, key, value, confidence, source, embedding_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(category, key) DO UPDATE SET
           value = excluded.value,
           confidence = excluded.confidence,
           source = excluded.source,
           embedding_key = excluded.embedding_key,
           updated_at = datetime('now')`,
      ).run(
        id,
        entry.category,
        entry.key,
        entry.value,
        clampScore(entry.confidence, 1.0),
        entry.source,
        entry.embeddingKey ?? null,
      );

      // On upsert conflict, the DB keeps the original row's id, not the new one.
      // Query for the actual id to return the correct value.
      const row = this.db.prepare(
        "SELECT id FROM semantic_memory WHERE category = ? AND key = ?",
      ).get(entry.category, entry.key) as { id: string } | undefined;
      if (!row) throw new Error("stored row not found");
      return row.id;
    } catch (error) {
      logger.error("Failed to store entry", error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get a specific semantic memory by category and key.
   */
  get(category: SemanticCategory, key: string): SemanticMemoryEntry | undefined {
    try {
      const row = this.db.prepare(
        "SELECT * FROM semantic_memory WHERE category = ? AND key = ?",
      ).get(category, key) as any | undefined;
      return row ? deserializeSemantic(row) : undefined;
    } catch (error) {
      logger.error("Failed to get entry", error instanceof Error ? error : undefined);
      return undefined;
    }
  }

  /**
   * Search semantic memory by key or value, optionally filtered by category.
   * A negative limit means no limit (SQLite LIMIT -1).
   */
  search(query: string, category?: SemanticCategory, limit: number = -1): SemanticMemoryEntry[] {
    try {
      const pattern = likeContains(query);
      if (category) {
        const rows = this.db.prepare(
          `SELECT * FROM semantic_memory
           WHERE category = ? AND (key LIKE ? ${LIKE_ESCAPE} OR value LIKE ? ${LIKE_ESCAPE})
           ORDER BY confidence DESC, updated_at DESC
           LIMIT ?`,
        ).all(category, pattern, pattern, limit) as any[];
        return rows.map(deserializeSemantic);
      }
      const rows = this.db.prepare(
        `SELECT * FROM semantic_memory
         WHERE key LIKE ? ${LIKE_ESCAPE} OR value LIKE ? ${LIKE_ESCAPE}
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`,
      ).all(pattern, pattern, limit) as any[];
      return rows.map(deserializeSemantic);
    } catch (error) {
      logger.error("Failed to search", error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Get all semantic memory entries in a category.
   */
  getByCategory(category: SemanticCategory): SemanticMemoryEntry[] {
    try {
      const rows = this.db.prepare(
        "SELECT * FROM semantic_memory WHERE category = ? ORDER BY confidence DESC, updated_at DESC",
      ).all(category) as any[];
      return rows.map(deserializeSemantic);
    } catch (error) {
      logger.error("Failed to get by category", error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Delete a semantic memory entry by id.
   */
  delete(id: string): void {
    try {
      this.db.prepare("DELETE FROM semantic_memory WHERE id = ?").run(id);
    } catch (error) {
      logger.error("Failed to delete entry", error instanceof Error ? error : undefined);
    }
  }

  /**
   * Prune entries when over maxEntries, removing lowest confidence + oldest first (LRU).
   * Returns number of entries removed.
   */
  prune(maxEntries: number = 500): number {
    try {
      const count = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM semantic_memory",
      ).get() as { cnt: number };

      if (count.cnt <= maxEntries) return 0;

      const toRemove = count.cnt - maxEntries;
      const result = this.db.prepare(
        `DELETE FROM semantic_memory WHERE id IN (
          SELECT id FROM semantic_memory
          ORDER BY confidence ASC, updated_at ASC
          LIMIT ?
        )`,
      ).run(toRemove);
      return result.changes;
    } catch (error) {
      logger.error("Failed to prune", error instanceof Error ? error : undefined);
      return 0;
    }
  }
}

function deserializeSemantic(row: any): SemanticMemoryEntry {
  return {
    id: row.id,
    category: row.category,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    source: row.source,
    embeddingKey: row.embedding_key ?? null,
    lastVerifiedAt: row.last_verified_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
