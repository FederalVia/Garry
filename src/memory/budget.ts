/**
 * Memory Budget Manager
 *
 * Manages token budget allocation for memory retrieval.
 * Trims memory retrieval results to fit within configured budgets.
 */

import type { MemoryBudget, MemoryRetrievalResult } from "../types.js";
import { estimateTokens } from "../agent/context.js";

export class MemoryBudgetManager {
  constructor(private budget: MemoryBudget) {}

  /**
   * Allocate memories within budget, trimming each tier as needed.
   * Tiers are filled in priority order (working, episodic, semantic,
   * procedural, relationships); the budget a tier leaves unused rolls to the
   * next one, so the total never exceeds the sum of the configured budgets.
   */
  allocate(memories: MemoryRetrievalResult): MemoryRetrievalResult {
    let totalTokens = 0;
    let carry = 0;

    const fill = <T>(items: T[], budget: number, estimateFn: (item: T) => number): T[] => {
      const available = Math.max(0, budget) + carry;
      const { items: kept, tokens } = this.trimTier(items ?? [], available, estimateFn);
      carry = available - tokens;
      totalTokens += tokens;
      return kept;
    };

    const workingMemory = fill(
      memories.workingMemory,
      this.budget.workingMemoryTokens,
      (entry) => estimateTokens(entry.content),
    );

    const episodicMemory = fill(
      memories.episodicMemory,
      this.budget.episodicMemoryTokens,
      (entry) => estimateTokens(entry.summary + (entry.detail || "")),
    );

    const semanticMemory = fill(
      memories.semanticMemory,
      this.budget.semanticMemoryTokens,
      (entry) => estimateTokens(`${entry.category}/${entry.key}: ${entry.value}`),
    );

    const proceduralMemory = fill(
      memories.proceduralMemory,
      this.budget.proceduralMemoryTokens,
      (entry) => estimateTokens(
        `${entry.name}: ${entry.description} (${Array.isArray(entry.steps) ? entry.steps.length : 0} steps)`,
      ),
    );

    const relationships = fill(
      memories.relationships,
      this.budget.relationshipMemoryTokens,
      (entry) => estimateTokens(`${entry.entityAddress}: ${entry.relationshipType} trust=${entry.trustScore}`),
    );

    return {
      workingMemory,
      episodicMemory,
      semanticMemory,
      proceduralMemory,
      relationships,
      totalTokens,
    };
  }

  /**
   * Estimate token count for a text string.
   */
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  /**
   * Get total budget across all tiers.
   */
  getTotalBudget(): number {
    return (
      this.budget.workingMemoryTokens +
      this.budget.episodicMemoryTokens +
      this.budget.semanticMemoryTokens +
      this.budget.proceduralMemoryTokens +
      this.budget.relationshipMemoryTokens
    );
  }

  /**
   * Trim a tier's items to fit within a token budget. An item that does not
   * fit is skipped, so one oversized entry does not hide smaller ones.
   */
  private trimTier<T>(
    items: T[],
    budgetTokens: number,
    estimateFn: (item: T) => number,
  ): { items: T[]; tokens: number } {
    const result: T[] = [];
    let tokens = 0;

    for (const item of items) {
      const itemTokens = estimateFn(item);
      if (tokens + itemTokens > budgetTokens) continue;
      result.push(item);
      tokens += itemTokens;
    }

    return { items: result, tokens };
  }
}
