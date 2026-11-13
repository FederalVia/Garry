/**
 * Memory writes: failures are reported as failures, ids are the stored ids,
 * and bad values are refused or clamped before they reach the database.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { createDatabase } from "../../state/database.js";
import { SCHEMA_VERSION } from "../../state/schema.js";
import { SemanticMemoryManager } from "../../memory/semantic.js";
import { WorkingMemoryManager } from "../../memory/working.js";
import { ProceduralMemoryManager } from "../../memory/procedural.js";
import { RelationshipMemoryManager } from "../../memory/relationship.js";
import { MemoryRetriever } from "../../memory/retrieval.js";
import {
  rememberFact,
  setGoal,
  saveProcedure,
  recallProcedure,
  noteAboutAgent,
  forget,
} from "../../memory/tools.js";
import { formatMemoryBlock } from "../../agent/context.js";
import type { MemoryRetrievalResult } from "../../types.js";

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

let adb: ReturnType<typeof createDatabase>;
let db: Database.Database;

beforeEach(() => {
  adb = createDatabase(":memory:");
  db = adb.raw;
});

afterEach(() => {
  adb.close();
});

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("failed writes are reported", () => {
  it("remember_fact with an unknown category fails with no id and stores nothing", () => {
    const result = rememberFact(db, { category: "market", key: "k", value: "v" });
    expect(result.startsWith("Failed")).toBe(true);
    expect(result).not.toMatch(ULID);
    expect(count("semantic_memory")).toBe(0);
  });

  it("a manager write error throws instead of returning a made-up id", () => {
    const sm = new SemanticMemoryManager(db);
    expect(() => sm.store({ category: "market" as any, key: "k", value: "v", source: "t" })).toThrow();
    const wm = new WorkingMemoryManager(db);
    expect(() => wm.add({ sessionId: "s", content: "x", contentType: "bogus" as any })).toThrow();
    expect(count("working_memory")).toBe(0);
  });

  it("over-long fact values and goals are refused", () => {
    expect(rememberFact(db, { category: "self", key: "k", value: "v".repeat(4001) })).toMatch(/^Failed/);
    expect(rememberFact(db, { category: "self", key: "k".repeat(201), value: "v" })).toMatch(/^Failed/);
    expect(setGoal(db, { sessionId: "s", content: "g".repeat(2001) })).toMatch(/^Failed/);
    expect(count("semantic_memory") + count("working_memory")).toBe(0);
  });
});

describe("procedures", () => {
  const step = '[{"description":"push"}]';

  it("saving an existing name reports the stored id, which forget accepts", () => {
    const first = saveProcedure(db, { name: "p1", description: "d", steps: step });
    const second = saveProcedure(db, { name: "p1", description: "d2", steps: step });
    const id1 = first.match(ULID)?.[0];
    const id2 = second.match(ULID)?.[0];
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1);
    expect(forget(db, { id: id2!, memoryType: "procedural" })).toContain("forgotten");
    expect(count("procedural_memory")).toBe(0);
  });

  it("steps that are not an array of step objects are refused before any write", () => {
    expect(saveProcedure(db, { name: "a", description: "d", steps: "null" })).toMatch(/^Failed/);
    expect(saveProcedure(db, { name: "b", description: "d", steps: '{"description":"x"}' })).toMatch(/^Failed/);
    expect(saveProcedure(db, { name: "c", description: "d", steps: '["x"]' })).toMatch(/^Failed/);
    expect(saveProcedure(db, { name: "d", description: "d", steps: JSON.stringify(Array(51).fill({ description: "x" })) })).toMatch(/^Failed/);
    expect(count("procedural_memory")).toBe(0);
  });

  it("a stored non-array decodes as no steps and retrieval still works", () => {
    db.prepare("INSERT INTO procedural_memory (id, name, description, steps) VALUES ('x1', 'deploy', 'deploy the service', 'null')").run();
    db.prepare("INSERT INTO procedural_memory (id, name, description, steps) VALUES ('x2', 'deploy2', 'deploy the service', '{\"a\":1}')").run();
    expect(new ProceduralMemoryManager(db).get("deploy")?.steps).toEqual([]);
    expect(recallProcedure(db, { name: "deploy2" })).toContain("Procedure: deploy2");
    const result = new MemoryRetriever(db).retrieve("s", "deploy the service");
    expect(result.proceduralMemory.map((p) => p.name).sort()).toEqual(["deploy", "deploy2"]);
  });
});

describe("scores", () => {
  it("trust_score must be a number; out-of-range values are clamped", () => {
    expect(noteAboutAgent(db, { entityAddress: "0xabc", relationshipType: "peer", trustScore: "high" })).toMatch(/^Failed/);
    expect(count("relationship_memory")).toBe(0);
    expect(noteAboutAgent(db, { entityAddress: "0xabc", relationshipType: "peer", trustScore: 7 })).toContain("Relationship noted");
    expect(new RelationshipMemoryManager(db).get("0xabc")?.trustScore).toBe(1);
    expect(setGoal(db, { sessionId: "s", content: "g", priority: "urgent" })).toMatch(/^Failed/);
    expect(setGoal(db, { sessionId: "s", content: "g", priority: -3 })).toContain("priority: 0)");
  });

  it("a TEXT trust score is never trusted and does not break the memory block", () => {
    db.prepare(
      "INSERT INTO relationship_memory (id, entity_address, relationship_type, trust_score) VALUES ('r1', '0xbad', 'peer', 'high')",
    ).run();
    new RelationshipMemoryManager(db).record({ entityAddress: "0xgood", relationshipType: "peer", trustScore: 0.9 });
    expect(new RelationshipMemoryManager(db).getTrusted(0.3).map((r) => r.entityAddress)).toEqual(["0xgood"]);

    const memories: MemoryRetrievalResult = {
      workingMemory: [
        { id: "w1", sessionId: "s", content: "bad row", contentType: "goal", priority: "x" as any, tokenCount: 1, expiresAt: null, sourceTurn: null, createdAt: "" },
        { id: "w2", sessionId: "s", content: "good row", contentType: "goal", priority: 0.8, tokenCount: 1, expiresAt: null, sourceTurn: null, createdAt: "" },
      ],
      episodicMemory: [],
      semanticMemory: [],
      proceduralMemory: [
        { id: "p", name: "broken", description: "d", steps: null as any, successCount: 0, failureCount: 0, lastUsedAt: null, createdAt: "", updatedAt: "" },
      ],
      relationships: [
        { id: "r1", entityAddress: "0xbad", entityName: null, relationshipType: "peer", trustScore: "high" as any, interactionCount: 0, lastInteractionAt: null, notes: null, createdAt: "", updatedAt: "" },
      ],
      totalTokens: 10,
    };
    const block = formatMemoryBlock(memories);
    expect(block).toContain("good row");
    expect(block).toContain("broken: d (0 steps");
    expect(block).toContain("0xbad: peer (trust: ?)");
  });

  it("the version 17 migration repairs TEXT scores", () => {
    expect(SCHEMA_VERSION).toBe(17);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-v17-"));
    try {
      const file = path.join(dir, "state.db");
      const first = createDatabase(file);
      first.raw.prepare(
        "INSERT INTO relationship_memory (id, entity_address, relationship_type, trust_score) VALUES ('r1', '0xbad', 'peer', 'high')",
      ).run();
      first.raw.prepare(
        "INSERT INTO relationship_memory (id, entity_address, relationship_type, trust_score) VALUES ('r2', '0xbig', 'peer', 7)",
      ).run();
      first.raw.prepare(
        "INSERT INTO working_memory (id, session_id, content, content_type, priority) VALUES ('w1', 's', 'g', 'goal', 'urgent')",
      ).run();
      // Pretend the database is from before version 17.
      first.raw.prepare("DELETE FROM schema_version WHERE version >= 17").run();
      first.close();

      const second = createDatabase(file);
      const trust = second.raw.prepare("SELECT entity_address AS a, trust_score AS t FROM relationship_memory ORDER BY a").all();
      expect(trust).toEqual([{ a: "0xbad", t: 0.2 }, { a: "0xbig", t: 1 }]);
      expect(second.raw.prepare("SELECT priority FROM working_memory WHERE id = 'w1'").get()).toEqual({ priority: 0.5 });
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
