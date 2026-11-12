/**
 * Main loop under inference caps: a refusal persists no turn, sleeps until it
 * clears, gives inbox messages back with their retry intact, and leaves a
 * small survival path; the session budget is per wake cycle, never lifetime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "./mocks.js";
import type { AgentTurn, AutomatonConfig, AutomatonDatabase, InferenceResponse } from "../types.js";
import {
  InferenceGate,
  getInstalledInferenceGate,
  installInferenceGate,
  resetInferenceGateForTests,
} from "../inference/gate.js";
import { resolveInferencePolicy } from "../inference/policy.js";

const HOUR = 3_600_000;

let db: AutomatonDatabase;
let conway: MockConwayClient;
let identity: ReturnType<typeof createTestIdentity>;

beforeEach(() => {
  resetInferenceGateForTests();
  db = createTestDb();
  conway = new MockConwayClient();
  identity = createTestIdentity();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetInferenceGateForTests();
  db.close();
});

/** A response that cost about `cents` on gpt-5.2 ($1.8 per M input). */
function costly(cents: number, base: InferenceResponse = toolCallResponse([{ name: "exec", arguments: { command: "echo hi" } }])): InferenceResponse {
  // One completion token: usage with a zero field counts as partial and is
  // committed at the reservation.
  const promptTokens = Math.ceil((cents * 10_000 - 14) / 1.8);
  return { ...base, usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 } };
}

async function cycle(config: AutomatonConfig, inference: MockInferenceClient, turns: AgentTurn[] = []): Promise<AgentTurn[]> {
  db.deleteKV("sleep_until");
  await runAgentLoop({ identity, config, db, conway, inference, onTurnComplete: (t) => turns.push(t) });
  return turns;
}

function sleepMsFromNow(): number {
  return new Date(db.getKV("sleep_until")!).getTime() - Date.now();
}

function turnCount(): number {
  return (db.raw.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
}

/** Install a gate for this db and seed `cents` of main-loop spend `agoMs` ago. */
function gateWithSpend(config: AutomatonConfig, cents: number, agoMs: number): InferenceGate {
  const gate = new InferenceGate({
    db: db.raw,
    policy: resolveInferencePolicy(config, { maxInferenceDailyCents: config.treasuryPolicy?.maxInferenceDailyCents ?? 50_000 }),
  });
  installInferenceGate(gate);
  gate.setSurvival({ tier: "high", creditsCents: 10_000 });
  // Written directly: a seed this large would not pass the gate's own caps.
  db.raw
    .prepare(
      `INSERT INTO inference_ledger (id, call_id, attempt, status, budget_class, caller, provider, model,
        price_in_usd_per_m, price_out_usd_per_m, est_input_tokens, max_output_tokens, reserved_micro_usd,
        cost_micro_usd, boot_id, created_at_ms, settled_at_ms)
       VALUES ('seed', 'seed', 1, 'committed', 'main', 'agent_turn', 'openai', 'seed', 2, 8, 0, 0, ?, ?, 'seed', ?, ?)`,
    )
    .run(cents * 10_000, cents * 10_000, Date.now() - agoMs, Date.now() - agoMs);
  return gate;
}

describe("session budget is one wake cycle (F128)", () => {
  it("a refused cycle persists no junk turn and sleeps the cooldown; the next cycle starts at zero", async () => {
    const config = createTestConfig({
      modelStrategy: { sessionBudgetCents: 500, survivalAllowanceCents: 0 } as any,
    });
    // Cycle 1: the first turn spends ~600c, the second is refused.
    const first = new MockInferenceClient([costly(600), noToolResponse("never sent")]);
    const turns1 = await cycle(config, first);
    expect(first.calls).toHaveLength(1);
    expect(turns1).toHaveLength(1);
    expect(turnCount()).toBe(1);
    expect(db.getAgentState()).toBe("sleeping");
    const slept = sleepMsFromNow();
    expect(slept).toBeGreaterThan(29 * 60_000);
    expect(slept).toBeLessThanOrEqual(30 * 60_000);
    expect(JSON.parse(db.getKV("inference.last_refusal")!).code).toBe("SESSION_CAP");

    // Cycle 2: a new session; the agent thinks again and is told why it slept.
    const second = new MockInferenceClient([noToolResponse("Back.")]);
    const turns2 = await cycle(config, second);
    expect(second.calls).toHaveLength(1);
    expect(turns2).toHaveLength(1);
    expect(JSON.stringify(second.calls[0].messages)).toContain("inference budget was exhausted (SESSION_CAP)");
    expect(db.getKV("inference.last_refusal")).toBeUndefined();
  });
});

describe("liveness when the daily cap is spent", () => {
  it("runs one survival turn with 1024 max tokens, then sleeps until the cap clears", async () => {
    const config = createTestConfig({ treasuryPolicy: { maxInferenceDailyCents: 100 } as any });
    const gate = gateWithSpend(config, 100, 2 * HOUR);
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo survive" } }]),
      noToolResponse("never sent"),
    ]);
    const turns = await cycle(config, inference);

    expect(inference.calls).toHaveLength(1);
    expect(inference.calls[0].options?.model).toBe("gpt-5-mini");
    expect(inference.calls[0].options?.maxTokens).toBe(1024);
    expect(JSON.stringify(inference.calls[0].messages)).toContain("limited survival turn");
    expect(turns).toHaveLength(1);
    const survivalRow = db.raw
      .prepare("SELECT budget_class, caller, status FROM inference_ledger WHERE budget_class = 'survival'")
      .get();
    expect(survivalRow).toEqual({ budget_class: "survival", caller: "survival_turn", status: "committed" });

    // The second refusal within 30 min sleeps until the daily window frees
    // (22 h away, clamped to the 6 h maximum sleep).
    expect(db.getAgentState()).toBe("sleeping");
    expect(sleepMsFromNow()).toBeGreaterThan(6 * HOUR - 60_000);
    expect(JSON.parse(db.getKV("inference.last_refusal")!).code).toBe("DAILY_CAP");
    expect(gate.usage().last24h.survivalCents).toBeGreaterThan(0);
  });

  it("returns claimed inbox messages to the queue with their retry count unchanged", async () => {
    const config = createTestConfig({
      treasuryPolicy: { maxInferenceDailyCents: 600 } as any,
      modelStrategy: { survivalAllowanceCents: 0 } as any,
    });
    db.insertInboxMessage({
      id: "m1",
      from: "0x9999999999999999999999999999999999999999",
      to: identity.address,
      content: "hello",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    // The wakeup turn uses up the day's budget; the inbox turn is refused.
    const inference = new MockInferenceClient([costly(700), noToolResponse("never sent")]);
    await cycle(config, inference);
    expect(inference.calls).toHaveLength(1);
    expect(db.raw.prepare("SELECT status, retry_count FROM inbox_messages").get()).toEqual({
      status: "received",
      retry_count: 0,
    });
    expect(turnCount()).toBe(1);
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("a refusal that never clears on its own backs off and doubles", async () => {
    const config = createTestConfig({
      treasuryPolicy: { maxInferenceDailyCents: 0 } as any,
      modelStrategy: { survivalAllowanceCents: 0 } as any,
    });
    const inference = new MockInferenceClient([]);
    await cycle(config, inference);
    expect(inference.calls).toHaveLength(0);
    expect(turnCount()).toBe(0);
    expect(Math.round(sleepMsFromNow() / 60_000)).toBe(10);
    await cycle(config, inference);
    expect(Math.round(sleepMsFromNow() / 60_000)).toBe(20);
  });
});

describe("unknown balance (F026)", () => {
  it("routes as low_compute instead of dead, so the agent can still think", async () => {
    conway.getCreditsBalance = async () => {
      throw new Error("API down");
    };
    const config = createTestConfig();
    const inference = new MockInferenceClient([noToolResponse("Still here.")]);
    const turns = await cycle(config, inference);
    expect(inference.calls).toHaveLength(1);
    expect(inference.calls[0].options?.model).toBe("gpt-5-mini");
    expect(turns).toHaveLength(1);
    // Orchestration is paused while the balance is unknown.
    expect(getInstalledInferenceGate()!.survival().tier).toBe("unknown");
  });

  it("the loop installs a gate when none is installed and feeds it the survival tier", async () => {
    conway.creditsCents = 300; // normal tier
    const inference = new MockInferenceClient([noToolResponse("ok")]);
    await cycle(createTestConfig(), inference);
    const gate = getInstalledInferenceGate()!;
    expect(gate.usesDatabase(db.raw)).toBe(true);
    expect(gate.survival()).toEqual({ tier: "normal", creditsCents: 300 });
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM inference_ledger").get() as { n: number }).n).toBe(1);
  });
});
