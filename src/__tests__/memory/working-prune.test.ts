/**
 * Working-memory pruning never lets other rows evict a goal, archives goals
 * it must remove, and auto-generated rows expire.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../state/database.js";
import { WorkingMemoryManager } from "../../memory/working.js";
import { MemoryIngestionPipeline } from "../../memory/ingestion.js";
import { setGoal } from "../../memory/tools.js";
import type { AgentTurn } from "../../types.js";

let adb: ReturnType<typeof createDatabase>;

beforeEach(() => {
  adb = createDatabase(":memory:");
});

afterEach(() => {
  adb.close();
});

describe("working memory pruning", () => {
  it("a new goal survives prune when 20 higher-priority decision rows exist", () => {
    const wm = new WorkingMemoryManager(adb.raw);
    for (let i = 0; i < 20; i++) {
      wm.add({ sessionId: "g", content: `Self-modification ${i}`, contentType: "decision", priority: 0.9 });
    }
    expect(setGoal(adb.raw, { sessionId: "g", content: "Earn 10 USDC by Friday" })).toContain("Goal set");

    expect(wm.prune("g", 20)).toBe(1);
    const goals = wm.getBySession("g").filter((e) => e.contentType === "goal");
    expect(goals.map((g) => g.content)).toEqual(["Earn 10 USDC by Friday"]);
  });

  it("goals over the limit are archived to episodic memory before removal", () => {
    const wm = new WorkingMemoryManager(adb.raw);
    for (let i = 0; i < 21; i++) {
      wm.add({ sessionId: "g", content: `goal ${i}`, contentType: "goal", priority: 0.5 + i / 100 });
    }
    expect(wm.prune("g", 20)).toBe(1);
    const left = wm.getBySession("g").map((e) => e.content);
    expect(left).toHaveLength(20);
    expect(left).not.toContain("goal 0");
    const archived = adb.raw
      .prepare("SELECT summary, importance FROM episodic_memory WHERE event_type = 'goal_archived'")
      .all() as Array<{ summary: string; importance: number }>;
    expect(archived).toHaveLength(1);
    expect(archived[0].summary).toContain("goal 0");
    expect(archived[0].importance).toBeCloseTo(0.5);
  });

  it("auto-generated decision rows from ingestion expire", () => {
    const turn: AgentTurn = {
      id: "t1",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "edit",
      toolCalls: [],
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costCents: 0,
    };
    new MemoryIngestionPipeline(adb.raw).ingest("g", turn, [
      { id: "c1", name: "edit_own_file", arguments: {}, result: "edited", durationMs: 1 },
    ]);
    const row = adb.raw
      .prepare("SELECT expires_at FROM working_memory WHERE content_type = 'decision'")
      .get() as { expires_at: string | null };
    expect(row.expires_at).not.toBeNull();
    const hours = (Date.parse(row.expires_at!) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
  });
});
