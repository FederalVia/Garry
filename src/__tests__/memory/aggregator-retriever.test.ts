/**
 * AgentContextAggregator keeps to its token budget and matches status words
 * whole; EnhancedRetriever does not hide entries behind a category guess.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { MIGRATION_V5, MIGRATION_V10 } from "../../state/schema.js";
import { AgentContextAggregator, type AgentStatusUpdate } from "../../memory/agent-context-aggregator.js";
import { EnhancedRetriever } from "../../memory/enhanced-retriever.js";
import { KnowledgeStore } from "../../memory/knowledge-store.js";

function failedUpdates(n: number): AgentStatusUpdate[] {
  return Array.from({ length: n }, (_, i) => ({
    agentAddress: `0x${String(i).padStart(40, "0")}`,
    status: "failed",
    message: `Task ${i} failed because the upstream API returned an unexpected error`,
  }));
}

describe("aggregator token budget", () => {
  it("a tiny budget returns almost nothing", () => {
    const result = new AgentContextAggregator().aggregateChildUpdates(failedUpdates(30), 5);
    expect(result.summary.length).toBeLessThanOrEqual(18);
    expect(result.estimatedTokens).toBeLessThanOrEqual(5);
  });

  it("a normal budget is respected by the estimate", () => {
    const result = new AgentContextAggregator().aggregateChildUpdates(failedUpdates(30), 50);
    expect(result.estimatedTokens).toBeLessThanOrEqual(50);
    expect(result.summary).toContain("[TRUNCATED FOR TOKEN BUDGET]");
  });
});

describe("aggregator triage words", () => {
  it("'sleeping' is not a heartbeat and keeps its message", () => {
    const aggregator = new AgentContextAggregator();
    const update = { agentAddress: "0x1", status: "sleeping", message: "Out of credits, sleeping until funded" };
    expect(aggregator.triageUpdate(update)).toBe("summary");
    const result = aggregator.aggregateChildUpdates([update], 1000);
    expect(result.heartbeatCount).toBe(0);
    expect(result.summary).toContain("Out of credits");
  });

  it("'abandoned' is not completed, 'ping' still counts as a heartbeat", () => {
    const aggregator = new AgentContextAggregator();
    const result = aggregator.aggregateChildUpdates([{ agentAddress: "0x1", status: "abandoned" }], 1000);
    expect(result.summaryEntries[0].completed).toBe(0);
    expect(aggregator.triageUpdate({ agentAddress: "0x2", status: "ping" })).toBe("count");
    expect(aggregator.triageUpdate({ agentAddress: "0x3", status: "in_progress" })).toBe("summary");
  });
});

describe("aggregator plural and inflected statuses", () => {
  it("'3 errors occurred' and 'build failure' are errors", () => {
    const aggregator = new AgentContextAggregator();
    expect(aggregator.triageUpdate({ agentAddress: "0x1", status: "3 errors occurred" })).toBe("full");
    expect(aggregator.triageUpdate({ agentAddress: "0x2", status: "build failure" })).toBe("full");
    expect(aggregator.triageUpdate({ agentAddress: "0x3", status: "sleeping" })).toBe("summary");
  });
});

describe("aggregator snake_case event kinds", () => {
  it("task_failed is an error and task_completed counts as completed", () => {
    const aggregator = new AgentContextAggregator();
    expect(aggregator.triageUpdate({ agentAddress: "0x1", kind: "task_failed", status: "task_failed" })).toBe("full");
    const result = aggregator.aggregateChildUpdates(
      [
        { agentAddress: "0x1", kind: "task_failed", status: "task_failed", message: "build step" },
        { agentAddress: "0x2", kind: "task_completed", status: "task_completed", message: "ok" },
      ],
      1000,
    );
    expect(result.fullUpdates).toHaveLength(1);
    expect(result.summaryEntries.reduce((n, e) => n + e.completed, 0)).toBe(1);
    // A multi-word pattern still needs its words in sequence.
    expect(aggregator.triageUpdate({ agentAddress: "0x3", status: "waiting_on_dependency" })).toBe("full");
    expect(aggregator.triageUpdate({ agentAddress: "0x4", status: "waiting", message: "on a dependency" })).not.toBe("full");
  });
});

describe("enhanced retriever categories", () => {
  it("'translation endpoint' finds a technical entry ('sla' inside a word is no category)", () => {
    const db = new Database(":memory:");
    try {
      db.exec(MIGRATION_V5);
      db.exec(MIGRATION_V10);
      db.exec("CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, thinking TEXT NOT NULL)");
      new KnowledgeStore(db).add({
        category: "technical",
        key: "translation-service",
        content: "Use deepl endpoint for translation requests",
        source: "a",
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        tokenCount: 20,
        expiresAt: null,
      });
      const result = new EnhancedRetriever(db).retrieveScored({
        sessionId: "s",
        currentInput: "translation endpoint",
        budgetTokens: 1000,
      });
      expect(result.entries.map((e) => e.entry.key)).toContain("translation-service");
    } finally {
      db.close();
    }
  });
});
