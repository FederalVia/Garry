/**
 * LIKE patterns built from caller text match literally: '\', '%' and '_'
 * are escaped everywhere memory and the KV prune use LIKE.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, pruneStaleKV } from "../../state/database.js";
import { escapeLike, likeContains, likePrefix } from "../../state/like-escape.js";
import { SemanticMemoryManager } from "../../memory/semantic.js";
import { EpisodicMemoryManager } from "../../memory/episodic.js";
import { ProceduralMemoryManager } from "../../memory/procedural.js";
import { KnowledgeStore } from "../../memory/knowledge-store.js";

let adb: ReturnType<typeof createDatabase>;

beforeEach(() => {
  adb = createDatabase(":memory:");
});

afterEach(() => {
  adb.close();
});

describe("escapeLike", () => {
  it("escapes the escape character too", () => {
    expect(escapeLike("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
    expect(likeContains("x%")).toBe("%x\\%%");
    expect(likePrefix("inbox_seen_")).toBe("inbox\\_seen\\_%");
  });
});

describe("memory manager search with a backslash", () => {
  const path = "C:\\Users\\bot";

  it("semantic, episodic and procedural search find a Windows path", () => {
    new SemanticMemoryManager(adb.raw).store({ category: "environment", key: "home", value: path, source: "t" });
    new EpisodicMemoryManager(adb.raw).record({ sessionId: "s", eventType: "note", summary: `saved to ${path}` });
    new ProceduralMemoryManager(adb.raw).save({
      name: "backup",
      description: `copy ${path}`,
      steps: [{ order: 1, description: "copy", tool: null, argsTemplate: null, expectedOutcome: null, onFailure: null }],
    });

    expect(new SemanticMemoryManager(adb.raw).search("C:\\Users")).toHaveLength(1);
    expect(new EpisodicMemoryManager(adb.raw).search("C:\\Users")).toHaveLength(1);
    expect(new ProceduralMemoryManager(adb.raw).search("C:\\Users")).toHaveLength(1);
    // '\%' in the query is a backslash and a percent sign, not a wildcard.
    expect(new SemanticMemoryManager(adb.raw).search("C:\\%")).toHaveLength(0);
  });
});

describe("knowledge store and KV prune", () => {
  function addKnowledge(key: string, content: string): void {
    new KnowledgeStore(adb.raw).add({
      category: "financial",
      key,
      content,
      source: "t",
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      tokenCount: 5,
      expiresAt: null,
    });
  }

  it("KnowledgeStore.search treats % and _ literally", () => {
    addKnowledge("fee", "fee is 1005 usdc");
    addKnowledge("pricing:gpt-4", "gpt-4 costs $30");
    const store = new KnowledgeStore(adb.raw);
    expect(store.search("100%")).toHaveLength(0);
    expect(store.search("pricing:gpt_4").map((e) => e.key)).not.toContain("pricing:gpt-4");
    expect(store.search("pricing:gpt-4").map((e) => e.key)).toEqual(["pricing:gpt-4"]);
  });

  it("pruneStaleKV removes only keys that really start with the prefix", () => {
    const old = "datetime('now', '-40 days')";
    adb.raw.exec(`INSERT INTO kv (key, value, updated_at) VALUES ('inbox_seen_1', '1', ${old})`);
    adb.raw.exec(`INSERT INTO kv (key, value, updated_at) VALUES ('inboxXseenY1', '1', ${old})`);
    adb.raw.exec("INSERT INTO kv (key, value, updated_at) VALUES ('inbox_seen_2', '1', datetime('now'))");
    expect(pruneStaleKV(adb.raw, "inbox_seen_", 30)).toBe(1);
    const keys = (adb.raw.prepare("SELECT key FROM kv WHERE key LIKE 'inbox%' ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toEqual(["inboxXseenY1", "inbox_seen_2"]);
  });
});
