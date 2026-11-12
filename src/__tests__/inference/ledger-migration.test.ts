/**
 * Migration 13: the inference ledger, and the one-time copy of the last 24 h
 * of inference_costs so an upgrade does not reset today's daily spend.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, inferenceInsertCost } from "../../state/database.js";
import { SCHEMA_VERSION } from "../../state/schema.js";
import { InferenceGate, resetInferenceGateForTests } from "../../inference/gate.js";
import { resolveInferencePolicy } from "../../inference/policy.js";
import { InferenceRefusedError } from "../../inference/errors.js";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inference-ledger-mig-"));
  dbPath = path.join(tmp, "state.db");
});

afterEach(() => {
  resetInferenceGateForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A schema-12 database holding today's 2100c and an older 1000c of legacy inference spend. */
function makeV12(): void {
  const before = createDatabase(dbPath);
  before.raw.exec("DROP TABLE inference_ledger");
  before.raw.prepare("DELETE FROM schema_version WHERE version >= 13").run();
  for (let i = 0; i < 3; i++) {
    inferenceInsertCost(before.raw, {
      sessionId: "default",
      turnId: null,
      model: "gpt-5.2",
      provider: "openai",
      inputTokens: 1000,
      outputTokens: 500,
      costCents: 700,
      latencyMs: 10,
      tier: "normal",
      taskType: "agent_turn",
      cacheHit: false,
    });
  }
  before.raw
    .prepare(
      `INSERT INTO inference_costs (id, session_id, model, provider, cost_cents, tier, task_type, created_at)
       VALUES ('old', 'default', 'gpt-5.2', 'openai', 1000, 'normal', 'agent_turn', datetime('now', '-3 days'))`,
    )
    .run();
  before.close();
}

describe("migration 13", () => {
  it("creates the ledger, copies the last 24 h of inference_costs, and the daily cap then refuses", () => {
    makeV12();
    const upgraded = createDatabase(dbPath);
    try {
      const v = upgraded.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(v.v).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(13);
      const rows = upgraded.raw
        .prepare("SELECT status, budget_class, caller, cost_micro_usd, boot_id FROM inference_ledger")
        .all();
      expect(rows).toEqual(
        Array.from({ length: 3 }, () => ({
          status: "committed",
          budget_class: "main",
          caller: "legacy:agent_turn",
          cost_micro_usd: 7_000_000,
          boot_id: "legacy",
        })),
      );

      const gate = new InferenceGate({
        db: upgraded.raw,
        policy: resolveInferencePolicy({ modelStrategy: { hourlyBudgetCents: 500 } as any }, { maxInferenceDailyCents: 500 }),
      });
      gate.setSurvival({ tier: "high", creditsCents: 100_000 });
      expect(gate.usage().last24h.mainCents).toBe(2100);
      let err: unknown;
      try {
        gate.reserve({
          callId: "c",
          attempt: 1,
          provider: "openai",
          model: "gpt-5-mini",
          price: { inputUsdPerM: 0.8, outputUsdPerM: 3.2, local: false },
          estInputTokens: 1000,
          maxOutputTokens: 1000,
          minOutputTokens: 1000,
          scope: { caller: "agent_turn" },
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InferenceRefusedError);
      expect(["HOURLY_CAP", "DAILY_CAP"]).toContain((err as InferenceRefusedError).code);
    } finally {
      upgraded.close();
    }

    // Opening again neither re-runs the migration nor duplicates the copy.
    const reopened = createDatabase(dbPath);
    try {
      expect((reopened.raw.prepare("SELECT COUNT(*) AS n FROM inference_ledger").get() as { n: number }).n).toBe(3);
      // inference_costs is left in place for history.
      expect((reopened.raw.prepare("SELECT COUNT(*) AS n FROM inference_costs").get() as { n: number }).n).toBe(4);
    } finally {
      reopened.close();
    }
  });

  it("a fresh database gets an empty ledger at the current schema version", () => {
    const db = createDatabase(dbPath);
    try {
      expect((db.raw.prepare("SELECT COUNT(*) AS n FROM inference_ledger").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
});
