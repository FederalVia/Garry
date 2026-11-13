/**
 * Retrieval: tier budgets roll over, an oversized entry does not hide the
 * entries behind it, and a whole prompt is searched word by word.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../state/database.js";
import { MemoryRetriever } from "../../memory/retrieval.js";
import { MemoryBudgetManager } from "../../memory/budget.js";
import { WorkingMemoryManager } from "../../memory/working.js";
import { SemanticMemoryManager } from "../../memory/semantic.js";
import { ProceduralMemoryManager } from "../../memory/procedural.js";
import { extractQueryTerms } from "../../memory/query-terms.js";
import { estimateTokens } from "../../agent/context.js";
import { DEFAULT_MEMORY_BUDGET } from "../../types.js";
import type { MemoryRetrievalResult, SemanticMemoryEntry } from "../../types.js";

let adb: ReturnType<typeof createDatabase>;

beforeEach(() => {
  adb = createDatabase(":memory:");
});

afterEach(() => {
  adb.close();
});

function words(n: number, word = "plan"): string {
  return Array.from({ length: n }, (_, i) => `${word}${i % 10}`).join(" ");
}

describe("tier budgets", () => {
  it("an oversized top-priority goal does not hide the smaller goals behind it", () => {
    const wm = new WorkingMemoryManager(adb.raw);
    const big = words(4000);
    expect(estimateTokens(big)).toBeGreaterThan(DEFAULT_MEMORY_BUDGET.workingMemoryTokens);
    wm.add({ sessionId: "s", content: big, contentType: "goal", priority: 1.0 });
    wm.add({ sessionId: "s", content: "Reply to creator about invoice", contentType: "goal", priority: 0.9 });
    wm.add({ sessionId: "s", content: "Keep credits above $5", contentType: "goal", priority: 0.8 });

    const result = new MemoryRetriever(adb.raw).retrieve("s");
    const contents = result.workingMemory.map((e) => e.content);
    expect(contents).toContain("Reply to creator about invoice");
    expect(contents).toContain("Keep credits above $5");
  });

  it("budget an empty tier leaves unused rolls to the next tier, never past the total", () => {
    const facts: SemanticMemoryEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: `f${i}`,
      category: "environment",
      key: `k${i}`,
      value: words(1000, `w${i}x`),
      confidence: 1,
      source: "t",
      embeddingKey: null,
      lastVerifiedAt: null,
      createdAt: "",
      updatedAt: "",
    }));
    const perFact = estimateTokens(`${facts[0].category}/${facts[0].key}: ${facts[0].value}`);
    expect(perFact * 5).toBeGreaterThan(DEFAULT_MEMORY_BUDGET.semanticMemoryTokens);

    const manager = new MemoryBudgetManager(DEFAULT_MEMORY_BUDGET);
    const raw: MemoryRetrievalResult = {
      workingMemory: [],
      episodicMemory: [],
      semanticMemory: facts,
      proceduralMemory: [],
      relationships: [],
      totalTokens: 0,
    };
    const result = manager.allocate(raw);
    const used = result.semanticMemory.length * perFact;
    expect(used).toBeGreaterThan(DEFAULT_MEMORY_BUDGET.semanticMemoryTokens);
    expect(result.totalTokens).toBeLessThanOrEqual(manager.getTotalBudget());
  });
});

describe("retrieval with a pending input", () => {
  it("finds facts and procedures by word, and keeps the self and creator facts", () => {
    const sm = new SemanticMemoryManager(adb.raw);
    sm.store({ category: "self", key: "price", value: "fee is 5 USDC", source: "t" });
    sm.store({ category: "self", key: "name", value: "I am a bot", source: "t" });
    sm.store({ category: "creator", key: "timezone", value: "UTC", source: "creator" });
    sm.store({ category: "environment", key: "unrelated", value: "the sky is blue", source: "t" });
    new ProceduralMemoryManager(adb.raw).save({
      name: "deploy",
      description: "Deploy the service to production",
      steps: [{ order: 1, description: "push", tool: null, argsTemplate: null, expectedOutcome: null, onFailure: null }],
    });

    const result = new MemoryRetriever(adb.raw).retrieve(
      "s",
      "[Message from 0xabc]: what is the fee for the service?",
    );
    const keys = result.semanticMemory.map((e) => `${e.category}/${e.key}`);
    expect(keys).toContain("self/price");
    expect(keys).toContain("self/name");
    expect(keys).toContain("creator/timezone");
    expect(keys).not.toContain("environment/unrelated");
    expect(result.proceduralMemory.map((p) => p.name)).toEqual(["deploy"]);
  });

  it("extractQueryTerms drops boilerplate, addresses and short words", () => {
    expect(extractQueryTerms("[Message from 0xabc]: what is the fee for the service?")).toEqual(["fee", "service"]);
    expect(extractQueryTerms("部署 服务")).toEqual(["部署", "服务"]);
    expect(extractQueryTerms(words(50, "longword")).length).toBeLessThanOrEqual(8);
  });
});
