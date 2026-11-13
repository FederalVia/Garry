/**
 * Memory Retriever
 *
 * Retrieves relevant memories across all tiers within a token budget.
 * Priority order: working > episodic > semantic > procedural > relationships.
 * Unused budget from one tier rolls to the next.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { MemoryBudget, MemoryRetrievalResult } from "../types.js";
import { DEFAULT_MEMORY_BUDGET } from "../types.js";
import { WorkingMemoryManager } from "./working.js";
import { EpisodicMemoryManager } from "./episodic.js";
import { SemanticMemoryManager } from "./semantic.js";
import { ProceduralMemoryManager } from "./procedural.js";
import { RelationshipMemoryManager } from "./relationship.js";
import { MemoryBudgetManager } from "./budget.js";
import { extractQueryTerms } from "./query-terms.js";
import type { ProceduralMemoryEntry, SemanticMemoryEntry } from "../types.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("memory.retrieval");

type Database = BetterSqlite3.Database;

const FACTS_PER_TERM = 20;
const PROCEDURES_PER_TERM = 10;

/**
 * Hits merged by id and ordered by how many terms matched, then by the
 * tier's own score.
 */
function rankByTermHits<T extends { id: string }>(
  hits: Map<string, { entry: T; terms: number }>,
  score: (entry: T) => number,
): T[] {
  return [...hits.values()]
    .sort((a, b) => b.terms - a.terms || score(b.entry) - score(a.entry))
    .map((h) => h.entry);
}

function addHits<T extends { id: string }>(hits: Map<string, { entry: T; terms: number }>, entries: T[]): void {
  for (const entry of entries) {
    const existing = hits.get(entry.id);
    if (existing) existing.terms += 1;
    else hits.set(entry.id, { entry, terms: 1 });
  }
}

export class MemoryRetriever {
  private working: WorkingMemoryManager;
  private episodic: EpisodicMemoryManager;
  private semantic: SemanticMemoryManager;
  private procedural: ProceduralMemoryManager;
  private relationships: RelationshipMemoryManager;
  private budgetManager: MemoryBudgetManager;

  constructor(db: Database, budget?: MemoryBudget) {
    this.working = new WorkingMemoryManager(db);
    this.episodic = new EpisodicMemoryManager(db);
    this.semantic = new SemanticMemoryManager(db);
    this.procedural = new ProceduralMemoryManager(db);
    this.relationships = new RelationshipMemoryManager(db);
    this.budgetManager = new MemoryBudgetManager(budget ?? DEFAULT_MEMORY_BUDGET);
  }

  /**
   * Retrieve relevant memories for a session, within token budget.
   * Priority: working > episodic > semantic > procedural > relationships.
   * Unused tokens from a tier roll to the next tier.
   */
  retrieve(sessionId: string, currentInput?: string): MemoryRetrievalResult {
    try {
      // Fetch raw memories from each tier
      const workingEntries = this.working.getBySession(sessionId);

      const episodicEntries = this.episodic.getRecent(sessionId, 20);

      // The input is a whole prompt, so it is searched word by word. Creator
      // and self facts are always included.
      const terms = extractQueryTerms(currentInput);
      const factHits = new Map<string, { entry: SemanticMemoryEntry; terms: number }>();
      const procedureHits = new Map<string, { entry: ProceduralMemoryEntry; terms: number }>();
      for (const term of terms) {
        addHits(factHits, this.semantic.search(term, undefined, FACTS_PER_TERM));
        addHits(procedureHits, this.procedural.search(term, PROCEDURES_PER_TERM));
      }
      const fixedFacts = [
        ...this.semantic.getByCategory("creator"),
        ...this.semantic.getByCategory("self"),
      ];
      const fixedIds = new Set(fixedFacts.map((f) => f.id));
      const semanticEntries = [
        ...fixedFacts,
        ...rankByTermHits(factHits, (f) => Number(f.confidence) || 0).filter((f) => !fixedIds.has(f.id)),
      ];
      const proceduralEntries = rankByTermHits(procedureHits, (p) => Number(p.successCount) || 0);

      const relationshipEntries = this.relationships.getTrusted(0.3);

      // Build raw result
      const raw: MemoryRetrievalResult = {
        workingMemory: workingEntries,
        episodicMemory: episodicEntries,
        semanticMemory: semanticEntries,
        proceduralMemory: proceduralEntries,
        relationships: relationshipEntries,
        totalTokens: 0,
      };

      // Apply budget allocation
      return this.budgetManager.allocate(raw);
    } catch (error) {
      logger.error("Retrieval failed", error instanceof Error ? error : undefined);
      return {
        workingMemory: [],
        episodicMemory: [],
        semanticMemory: [],
        proceduralMemory: [],
        relationships: [],
        totalTokens: 0,
      };
    }
  }
}
