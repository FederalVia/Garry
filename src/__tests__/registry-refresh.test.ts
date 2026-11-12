/**
 * Model registry origins: the heartbeat's refresh (initialize, then
 * refreshFromApi) must not disable models discovered from the Conway API,
 * while baseline models removed from the baseline are still disabled.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { createDatabase, modelRegistryGetOrigin, modelRegistryUpsert } from "../state/database.js";
import { ModelRegistry } from "../inference/registry.js";
import { STATIC_MODEL_BASELINE } from "../inference/types.js";
import { SCHEMA_VERSION, MIGRATION_V6 } from "../state/schema.js";
import type { AutomatonDatabase, ModelRegistryRow } from "../types.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-refresh-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function row(modelId: string, provider: string, enabled: boolean): ModelRegistryRow {
  const now = new Date().toISOString();
  return {
    modelId,
    provider,
    displayName: modelId,
    tierMinimum: "normal",
    costPer1kInput: 1,
    costPer1kOutput: 2,
    maxTokens: 4096,
    contextWindow: 128000,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled,
    createdAt: now,
    updatedAt: now,
  };
}

describe("refresh_models sequence", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createDatabase(path.join(dir, "state.db"));
  });

  afterEach(() => {
    db.close();
  });

  it("keeps an API-discovered model enabled across initialize + refresh ticks and restarts", () => {
    const reg = new ModelRegistry(db.raw);
    const listing = [{ id: "claude-new-x", provider: "anthropic" }];

    reg.initialize();
    reg.refreshFromApi(listing);
    expect(reg.get("claude-new-x")?.enabled).toBe(true);
    expect(modelRegistryGetOrigin(db.raw, "claude-new-x")).toBe("api");

    for (let tick = 0; tick < 3; tick++) {
      reg.initialize();
      reg.refreshFromApi(listing);
    }
    expect(reg.get("claude-new-x")?.enabled).toBe(true);

    // A restart runs initialize() alone.
    new ModelRegistry(db.raw).initialize();
    expect(reg.get("claude-new-x")?.enabled).toBe(true);
  });

  it("keeps an operator's disable of an API model", () => {
    const reg = new ModelRegistry(db.raw);
    reg.initialize();
    reg.refreshFromApi([{ id: "claude-new-x", provider: "anthropic" }]);
    reg.setEnabled("claude-new-x", false);
    reg.initialize();
    reg.refreshFromApi([{ id: "claude-new-x", provider: "anthropic" }]);
    expect(reg.get("claude-new-x")?.enabled).toBe(false);
  });

  it("still disables a baseline model that left the baseline", () => {
    const reg = new ModelRegistry(db.raw);
    reg.initialize();
    // A model a previous release shipped in its baseline.
    modelRegistryUpsert(db.raw, row("gpt-retired", "openai", true), "baseline");
    reg.initialize();
    expect(reg.get("gpt-retired")?.enabled).toBe(false);
  });

  it("an API listing never downgrades a baseline model's origin", () => {
    const reg = new ModelRegistry(db.raw);
    reg.initialize();
    const baselineId = STATIC_MODEL_BASELINE[0]!.modelId;
    reg.refreshFromApi([{ id: baselineId, provider: "openai" }]);
    expect(modelRegistryGetOrigin(db.raw, baselineId)).toBe("baseline");
  });

  it("leaves Ollama and manual models alone", () => {
    const reg = new ModelRegistry(db.raw);
    reg.initialize();
    modelRegistryUpsert(db.raw, row("llama3:8b", "ollama", true), "ollama");
    reg.upsert({ ...row("my-model", "openai", true), lastSeen: null } as any);
    expect(modelRegistryGetOrigin(db.raw, "my-model")).toBe("manual");
    reg.initialize();
    expect(reg.get("llama3:8b")?.enabled).toBe(true);
    expect(reg.get("my-model")?.enabled).toBe(true);
  });

  it("an upsert without an origin keeps the stored one", () => {
    modelRegistryUpsert(db.raw, row("m1", "openai", true), "ollama");
    modelRegistryUpsert(db.raw, { ...row("m1", "openai", true), displayName: "changed" });
    expect(modelRegistryGetOrigin(db.raw, "m1")).toBe("ollama");
    modelRegistryUpsert(db.raw, row("m2", "openai", true));
    expect(modelRegistryGetOrigin(db.raw, "m2")).toBe("api");
  });
});

describe("schema version 15 migration", () => {
  /** A v14 database as the previous release left it after a refresh tick. */
  function makeV14(dbPath: string): void {
    const db = createDatabase(dbPath);
    db.close();
    const raw = new Database(dbPath);
    // Undo version 15: rebuild model_registry without origin and drop the version row.
    raw.exec(`DROP TABLE model_registry;`);
    raw.exec(MIGRATION_V6.slice(MIGRATION_V6.indexOf("CREATE TABLE IF NOT EXISTS model_registry")));
    raw.prepare("DELETE FROM schema_version WHERE version >= 15").run();
    const insert = raw.prepare(
      `INSERT INTO model_registry (model_id, provider, display_name, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    for (const m of STATIC_MODEL_BASELINE) insert.run(m.modelId, m.provider, m.displayName, 1);
    insert.run("claude-new-x", "anthropic", "API model, discovered since boot", 1);
    insert.run("claude-old-y", "anthropic", "API model the old boot disabled", 0);
    insert.run("claude-sonnet-4-6", "anthropic", "retired baseline model", 1);
    insert.run("llama3:8b", "ollama", "local", 1);
    insert.run("gpt-off", "openai", "disabled baseline", 0);
    raw.close();
  }

  it("adds origin, keeps every row's other fields, re-enables nothing, and spares API models from initialize", () => {
    const dbPath = path.join(dir, "v14.db");
    makeV14(dbPath);
    const before = new Database(dbPath);
    const rowsBefore = before
      .prepare("SELECT model_id, provider, display_name, enabled, created_at, updated_at FROM model_registry ORDER BY model_id")
      .all();
    before.close();

    const db = createDatabase(dbPath);
    try {
      const v = db.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(v.v).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);

      const rowsAfter = db.raw
        .prepare("SELECT model_id, provider, display_name, enabled, created_at, updated_at FROM model_registry ORDER BY model_id")
        .all();
      expect(rowsAfter).toEqual(rowsBefore);

      const origin = (id: string) => modelRegistryGetOrigin(db.raw, id);
      expect(origin(STATIC_MODEL_BASELINE[0]!.modelId)).toBe("baseline");
      expect(origin("claude-new-x")).toBe("api");
      expect(origin("claude-old-y")).toBe("baseline");
      expect(origin("claude-sonnet-4-6")).toBe("baseline");
      expect(origin("llama3:8b")).toBe("ollama");
      expect(origin("gpt-off")).toBe("baseline");

      // First boot after the upgrade.
      const reg = new ModelRegistry(db.raw);
      reg.initialize();
      expect(reg.get("claude-new-x")?.enabled).toBe(true);
      expect(reg.get("claude-sonnet-4-6")?.enabled).toBe(false);
      expect(reg.get("claude-old-y")?.enabled).toBe(false);
      expect(reg.get("llama3:8b")?.enabled).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is idempotent when the column already exists", () => {
    const dbPath = path.join(dir, "again.db");
    createDatabase(dbPath).close();
    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM schema_version WHERE version >= 15").run();
    raw.close();
    const db = createDatabase(dbPath);
    try {
      const cols = db.raw.prepare("PRAGMA table_info(model_registry)").all() as Array<{ name: string }>;
      expect(cols.filter((c) => c.name === "origin")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
