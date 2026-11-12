/**
 * Inference spend gate: caps, windows, settlement, crash recovery and the
 * error classification both inference paths share.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { getEncoding } from "js-tiktoken";
import { createDatabase } from "../../state/database.js";
import type { AutomatonDatabase } from "../../types.js";
import {
  GATE_SQL,
  InferenceGate,
  installInferenceGate,
  requireInferenceGate,
  resetInferenceGateForTests,
  runWithInferenceScope,
  currentInferenceScope,
  type InferenceScope,
  type ReserveRequest,
} from "../../inference/gate.js";
import { resolveInferencePolicy, type ResolvedInferencePolicy } from "../../inference/policy.js";
import {
  InferenceHttpError,
  InferenceRefusedError,
  InferenceResponseError,
  classifyInferenceError,
} from "../../inference/errors.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
/** gpt-4.1 prices, USD per 1M tokens. */
const PRICE = { inputUsdPerM: 2, outputUsdPerM: 8, local: false };
const MAIN: InferenceScope = { caller: "agent_turn" };
const ORCH: InferenceScope = { caller: "orchestrator.plan" };
const SURVIVAL: InferenceScope = { caller: "survival_turn" };

let tmp: string;
let db: AutomatonDatabase;
let raw: BetterSqlite3.Database;
let clock: number;

function policy(over: { daily?: number; strategy?: Record<string, unknown> } = {}): ResolvedInferencePolicy {
  return resolveInferencePolicy(
    { modelStrategy: (over.strategy ?? {}) as any },
    { maxInferenceDailyCents: over.daily ?? 500 },
  );
}

function newGate(p: ResolvedInferencePolicy = policy(), bootId = "boot-a"): InferenceGate {
  const g = new InferenceGate({ db: raw, policy: p, now: () => clock, bootId });
  g.setSurvival({ tier: "high", creditsCents: 100_000 });
  return g;
}

/** A request whose worst case is exactly `cents` (input only, no output). */
function req(cents: number, scope: InferenceScope = MAIN, extra: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    callId: `call-${Math.random()}`,
    attempt: 1,
    provider: "openai",
    model: "gpt-4.1",
    price: PRICE,
    // 1 input token at $2/M = 2 micro-USD; 1 cent = 10,000 micro-USD.
    estInputTokens: cents * 5000,
    maxOutputTokens: 0,
    minOutputTokens: 0,
    scope,
    ...extra,
  };
}

/** Commit a spend of `cents` at the current clock. */
function spend(g: InferenceGate, cents: number, scope: InferenceScope = MAIN): void {
  const r = g.reserve(req(cents, scope));
  g.commit(r.id, { inputTokens: cents * 5000, outputTokens: 0 }, 1);
}

function refusal(fn: () => unknown): InferenceRefusedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof InferenceRefusedError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inference-gate-"));
  db = createDatabase(path.join(tmp, "state.db"));
  raw = db.raw;
  clock = T0;
});

afterEach(() => {
  resetInferenceGateForTests();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("policy resolution", () => {
  it("takes the daily cap from the treasury policy and derives the hourly cap as daily / 6 (D1, D2)", () => {
    const p = resolveInferencePolicy({ modelStrategy: { hourlyBudgetCents: 0 } as any }, { maxInferenceDailyCents: 500 });
    expect(p.dailyCapCents).toBe(500);
    expect(p.hourlyCapCents).toBe(84);
    expect(p.orchestrationSharePct).toBe(50);
    expect(p.survivalAllowanceCents).toBe(25);
    expect(p.survivalMinIntervalMs).toBe(30 * 60_000);
    expect(p.sessionCooldownMs).toBe(30 * 60_000);
    expect(p.unknownPrice).toEqual({ inputUsdPerM: 2, outputUsdPerM: 14 });
  });

  it("clamps an explicit hourly cap to the daily cap and falls back on invalid values", () => {
    const warnings: string[] = [];
    const p = resolveInferencePolicy(
      { modelStrategy: { hourlyBudgetCents: 9999, sessionBudgetCents: -3, orchestrationSharePct: 150 } as any },
      { maxInferenceDailyCents: 300 },
      { onWarning: (m) => warnings.push(m) },
    );
    expect(p.hourlyCapCents).toBe(300);
    expect(p.sessionCapCents).toBe(0);
    expect(p.orchestrationSharePct).toBe(100);
    expect(warnings.length).toBe(2);
  });

  it("keeps the 50000c default daily cap when the treasury policy has none", () => {
    expect(resolveInferencePolicy({}, {}).dailyCapCents).toBe(50_000);
  });
});

describe("daily and hourly caps (F124)", () => {
  it("refuses once 24 h spend reaches the daily cap, and clears when the oldest spend ages out", () => {
    // Hourly cap explicit and high so only the daily cap applies.
    const g = newGate(policy({ daily: 500, strategy: { hourlyBudgetCents: 500 } }));
    spend(g, 300);
    clock += 2 * HOUR;
    spend(g, 195);
    clock += 1 * HOUR;
    const r = refusal(() => g.reserve(req(10)));
    expect(r.code).toBe("DAILY_CAP");
    // 495 + 10 > 500 needs the 300c row to age out: 24h after it, i.e. 21h from now.
    expect(r.retryAfterMs).toBeGreaterThan(21 * HOUR - 10);
    expect(r.retryAfterMs).toBeLessThanOrEqual(21 * HOUR + 10);
    clock += r.retryAfterMs!;
    expect(() => g.reserve(req(10))).not.toThrow();
  });

  it("refuses at the derived hourly cap and clears an hour later", () => {
    const g = newGate(policy({ daily: 600 })); // hourly = 100
    spend(g, 95);
    const r = refusal(() => g.reserve(req(10)));
    expect(r.code).toBe("HOURLY_CAP");
    expect(r.retryAfterMs).toBe(HOUR + 1);
    clock += HOUR + 1;
    expect(() => g.reserve(req(10))).not.toThrow();
  });

  it("a daily cap of 0 refuses paid inference with no time bound but lets free local models through", () => {
    const g = newGate(policy({ daily: 0 }));
    const r = refusal(() => g.reserve(req(1)));
    expect(r.code).toBe("HOURLY_CAP");
    expect(r.retryAfterMs).toBeNull();
    const local = g.reserve(req(1, MAIN, { provider: "ollama", price: { inputUsdPerM: 0, outputUsdPerM: 0, local: true } }));
    expect(local.reservedMicroUsd).toBe(0);
  });

  it("a single call larger than the cap gets retryAfterMs null, not a wait that never helps", () => {
    const g = newGate(policy({ daily: 600 })); // hourly 100
    const r = refusal(() => g.reserve(req(150)));
    expect(r.retryAfterMs).toBeNull();
  });

  it("counts reserved and unknown rows at the reserved amount and released rows not at all", () => {
    const g = newGate(policy({ daily: 600 })); // hourly 100
    const a = g.reserve(req(40));
    const b = g.reserve(req(40));
    g.markUnknown(a.id, "ambiguous");
    expect(refusal(() => g.reserve(req(40))).code).toBe("HOURLY_CAP");
    g.release(b.id, "server:503");
    expect(() => g.reserve(req(40))).not.toThrow();
  });
});

describe("orchestration share (D6)", () => {
  it("caps orchestration at 50% of the hourly cap while the main loop keeps the rest", () => {
    const g = newGate(policy({ daily: 600 })); // hourly 100, orchestration 50
    spend(g, 45, ORCH);
    const r = refusal(() => g.reserve(req(10, ORCH)));
    expect(r.code).toBe("ORCHESTRATION_SHARE");
    expect(() => g.reserve(req(50, MAIN))).not.toThrow();
  });

  it("treats unattributed calls as orchestration", () => {
    const g = newGate(policy({ daily: 600 }));
    spend(g, 45, ORCH);
    expect(refusal(() => g.reserve(req(10, { caller: "unattributed" }))).code).toBe("ORCHESTRATION_SHARE");
  });
});

describe("session budget (F128)", () => {
  it("is per session id, refuses with the cooldown, and a new session starts at zero", () => {
    const g = newGate(policy({ daily: 50_000, strategy: { sessionBudgetCents: 500 } }));
    const s1: InferenceScope = { caller: "agent_turn", sessionId: "cycle-1" };
    spend(g, 300, s1);
    spend(g, 199, s1);
    const r = refusal(() => g.reserve(req(5, s1)));
    expect(r.code).toBe("SESSION_CAP");
    expect(r.retryAfterMs).toBe(30 * 60_000);
    expect(() => g.reserve(req(5, { caller: "agent_turn", sessionId: "cycle-2" }))).not.toThrow();
  });
});

describe("per-task cap (F057 gate side, D5)", () => {
  it("is cumulative across attempts and retries of the same task id", () => {
    const g = newGate(policy({ daily: 50_000 }));
    const task: InferenceScope = { caller: "worker", taskId: "t1", taskCapCents: 5 };
    spend(g, 2, task);
    spend(g, 2, task);
    const r = refusal(() => g.reserve(req(2, task)));
    expect(r.code).toBe("TASK_CAP");
    expect(r.retryAfterMs).toBeNull();
    // A retry of the same task id gets no fresh budget.
    expect(refusal(() => g.reserve(req(2, { ...task, workerId: "retry" }))).code).toBe("TASK_CAP");
    expect(g.taskSpendCents("t1")).toBeCloseTo(4, 6);
  });
});

describe("per-call ceiling (F125, D4)", () => {
  it("clamps output tokens so the worst case fits, and refuses only when the minimum cannot fit", () => {
    const g = newGate(policy({ daily: 50_000, strategy: { perCallCeilingCents: 3 } }));
    // 10k input tokens at $2/M = 2c; 3c leaves 1c for output at $8/M = 1250 tokens.
    const r = g.reserve(req(0, MAIN, { estInputTokens: 10_000, maxOutputTokens: 4096, minOutputTokens: 1024 }));
    expect(r.maxOutputTokens).toBe(1250);
    expect(r.reservedMicroUsd).toBeLessThanOrEqual(30_000);
    const refused = refusal(() =>
      g.reserve(req(0, MAIN, { estInputTokens: 12_000, maxOutputTokens: 4096, minOutputTokens: 1024 })),
    );
    expect(refused.code).toBe("PER_CALL_CEILING");
    expect(refused.retryAfterMs).toBeNull();
  });

  it("applies an extra ceiling (routing matrix) too", () => {
    const g = newGate(policy({ daily: 50_000 }));
    const r = g.reserve(req(0, MAIN, { estInputTokens: 10_000, maxOutputTokens: 4096, minOutputTokens: 512, extraCeilingCents: 3 }));
    expect(r.maxOutputTokens).toBe(1250);
  });
});

describe("prices", () => {
  it("charges a remote model with a zero price at the conservative price (D10)", () => {
    const g = newGate(policy({ daily: 50_000 }));
    const r = g.reserve(req(0, MAIN, { price: { inputUsdPerM: 0, outputUsdPerM: 0, local: false }, estInputTokens: 1000, maxOutputTokens: 1000, minOutputTokens: 1000 }));
    expect(r.reservedMicroUsd).toBe(1000 * 2 + 1000 * 14);
  });

  it("commits at actual usage, and at the reserved amount when a paid response has no usage", () => {
    const g = newGate(policy({ daily: 50_000 }));
    const a = g.reserve(req(0, MAIN, { estInputTokens: 20_000, maxOutputTokens: 2000, minOutputTokens: 2000 }));
    expect(g.commit(a.id, { inputTokens: 20_000, outputTokens: 2000 }, 5).costMicroUsd).toBe(56_000);
    const b = g.reserve(req(0, MAIN, { estInputTokens: 1000, maxOutputTokens: 1000, minOutputTokens: 1000 }));
    expect(g.commit(b.id, null, 5).costMicroUsd).toBe(b.reservedMicroUsd);
    expect(g.isOpen(a.id)).toBe(false);
  });
});

describe("partial usage", () => {
  it("commits the reservation when only one usage field is reported", () => {
    const g = newGate(policy({ daily: 50_000 }));
    const onlyPrompt = g.reserve(req(0, MAIN, { estInputTokens: 1000, maxOutputTokens: 4000, minOutputTokens: 1000 }));
    expect(g.commit(onlyPrompt.id, { inputTokens: 50, outputTokens: 0 }, 5).costMicroUsd).toBe(onlyPrompt.reservedMicroUsd);
    const onlyCompletion = g.reserve(req(0, MAIN, { estInputTokens: 1000, maxOutputTokens: 4000, minOutputTokens: 1000 }));
    expect(g.commit(onlyCompletion.id, { inputTokens: 0, outputTokens: 10 }, 5).costMicroUsd).toBe(
      onlyCompletion.reservedMicroUsd,
    );
    const nan = g.reserve(req(0, MAIN, { estInputTokens: 1000, maxOutputTokens: 4000, minOutputTokens: 1000 }));
    expect(g.commit(nan.id, { inputTokens: 50, outputTokens: Number.NaN }, 5).costMicroUsd).toBe(nan.reservedMicroUsd);
  });

  it("does not let reported output fall far below the text actually returned, capped at the reserved output", () => {
    const g = newGate(policy({ daily: 50_000 }));
    const text = "the quick brown fox jumps over the lazy dog. ".repeat(200); // about 2000 tokens
    const a = g.reserve(req(0, MAIN, { estInputTokens: 1000, maxOutputTokens: 4000, minOutputTokens: 1000 }));
    const cost = g.commit(a.id, { inputTokens: 1000, outputTokens: 5 }, 5, { outputText: text }).costMicroUsd;
    // At least 75% of ~2000 output tokens at $8/M on top of the input.
    expect(cost).toBeGreaterThan(1000 * 2 + 1400 * 8);
    expect(cost).toBeLessThanOrEqual(a.reservedMicroUsd);
    // Honest usage at or above the text's size is taken as reported.
    const b = g.reserve(req(0, MAIN, { estInputTokens: 1000, maxOutputTokens: 4000, minOutputTokens: 1000 }));
    expect(g.commit(b.id, { inputTokens: 1000, outputTokens: 2100 }, 5, { outputText: text }).costMicroUsd).toBe(
      1000 * 2 + 2100 * 8,
    );
  });
});

describe("input estimate", () => {
  const WORDS =
    "the quick brown fox jumps over lazy dog while server returns status code with json payload error message retry later network latency".split(
      " ",
    );
  function prose(nChars: number, seed: number): string {
    let s = "";
    let i = seed;
    while (s.length < nChars) {
      i = (i * 1103515245 + 12345) % 2147483648;
      s += WORDS[i % WORDS.length] + (i % 7 === 0 ? ".\n" : " ");
    }
    return s;
  }

  it("stays within about 1.3x of the real token count for 100k-300k character payloads", () => {
    const g = newGate();
    const enc = getEncoding("cl100k_base");
    const tools = Array.from({ length: 77 }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: prose(250, i + 10),
        parameters: { type: "object", properties: { arg: { type: "string", description: prose(60, i) } } },
      },
    }));
    for (const extra of [100_000, 200_000, 300_000]) {
      const messages = [
        { role: "system" as const, content: prose(12_000, 1) },
        { role: "user" as const, content: prose(extra / 2, 2) },
        {
          role: "assistant" as const,
          content: "",
          tool_calls: [{ id: "c1", type: "function" as const, function: { name: "exec", arguments: JSON.stringify({ command: prose(2000, 3) }) } }],
        },
        { role: "tool" as const, content: prose(extra / 2, 4), tool_call_id: "c1" },
      ];
      const real = enc.encode(JSON.stringify({ messages, tools })).length;
      const est = g.estimateInputTokens(messages, tools);
      expect(est).toBeGreaterThanOrEqual(real);
      expect(est).toBeLessThanOrEqual(real * 1.35);
    }
  });

  it("bounds the time spent on dense text and never reserves less than it costs", () => {
    const g = newGate();
    // Ten inbox-sized messages of CJK with no punctuation, each distinct so the
    // token cache cannot help. Counting all of it exactly took about 9 s.
    const sentence = "数据库服务器返回错误信息请稍后重试网络延迟";
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `${i}:` + sentence.repeat(2_500).slice(0, 51_200),
    }));
    const started = performance.now();
    const est = g.estimateInputTokens(messages);
    expect(performance.now() - started).toBeLessThan(3_000);
    // cl100k spends at least about 0.8 tokens per CJK character.
    expect(est).toBeGreaterThanOrEqual(0.8 * 10 * 51_200);
  });
});

describe("survival allowance and tier (D7, D8)", () => {
  it("bypasses the regular caps, allows one survival turn per interval and caps 24 h spend", () => {
    const g = newGate(policy({ daily: 600 }));
    spend(g, 100); // hourly exhausted
    expect(refusal(() => g.reserve(req(1))).code).toBe("HOURLY_CAP");
    const first = g.reserve(req(10, SURVIVAL, { callId: "s1" }));
    // A fallback attempt of the same survival call is not a second turn.
    expect(() => g.reserve(req(1, SURVIVAL, { callId: "s1", attempt: 2 }))).not.toThrow();
    g.commit(first.id, { inputTokens: 50_000, outputTokens: 0 }, 1);
    const again = refusal(() => g.reserve(req(1, SURVIVAL, { callId: "s2" })));
    expect(again.code).toBe("SURVIVAL_ALLOWANCE");
    expect(again.retryAfterMs).toBe(30 * 60_000);
    clock += 30 * 60_000 + 1;
    expect(refusal(() => g.reserve(req(20, SURVIVAL, { callId: "s3" }))).code).toBe("SURVIVAL_ALLOWANCE");
    expect(() => g.reserve(req(10, SURVIVAL, { callId: "s4" }))).not.toThrow();
    expect(g.headroom("survival").allowed).toBe(false);
  });

  it("a survival allowance of 0 disables the survival class", () => {
    const g = newGate(policy({ strategy: { survivalAllowanceCents: 0 } }));
    expect(refusal(() => g.reserve(req(1, SURVIVAL))).code).toBe("SURVIVAL_ALLOWANCE");
  });

  it("pauses paid orchestration at low_compute, critical and unknown, and every paid class at dead", () => {
    const g = newGate(policy({ daily: 50_000 }));
    for (const tier of ["low_compute", "critical", "unknown"] as const) {
      g.setSurvival({ tier, creditsCents: null });
      expect(refusal(() => g.reserve(req(1, ORCH))).code).toBe("SURVIVAL_TIER");
      expect(() => g.reserve(req(1, MAIN))).not.toThrow();
    }
    g.setSurvival({ tier: "dead", creditsCents: 0 });
    expect(refusal(() => g.reserve(req(1, MAIN))).code).toBe("SURVIVAL_TIER");
    const local = { provider: "ollama", price: { inputUsdPerM: 0, outputUsdPerM: 0, local: true } };
    expect(() => g.reserve(req(1, ORCH, local))).not.toThrow();
    g.setSurvival({ tier: "normal", creditsCents: 200 });
    expect(() => g.reserve(req(1, ORCH))).not.toThrow();
  });
});

describe("concurrency", () => {
  it("5 concurrent worst-case reservations against 10c of headroom: exactly 3 succeed", async () => {
    const g = newGate(policy({ daily: 60 })); // hourly 10
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i));
        const r = g.reserve(req(3, MAIN));
        await new Promise((res) => setTimeout(res, 20));
        g.commit(r.id, { inputTokens: 15_000, outputTokens: 0 }, 20);
        return r;
      }),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(refused.map((r) => r.reason.code)).toEqual(["HOURLY_CAP", "HOURLY_CAP"]);
    expect(g.usage().lastHour.cappedCents).toBeLessThanOrEqual(10);
  });
});

describe("crash recovery and clock hygiene", () => {
  it("holds another boot's reserved rows as unknown for 24 h, then frees them", () => {
    const g1 = newGate(policy({ daily: 600, strategy: { hourlyBudgetCents: 600 } }), "boot-a");
    g1.reserve(req(590));
    clock += 2 * HOUR;
    const g2 = newGate(policy({ daily: 600, strategy: { hourlyBudgetCents: 600 } }), "boot-b");
    const row = raw.prepare("SELECT status FROM inference_ledger").get() as { status: string };
    expect(row.status).toBe("unknown");
    expect(refusal(() => g2.reserve(req(20))).code).toBe("DAILY_CAP");
    clock += DAY + 1;
    expect(() => g2.reserve(req(20))).not.toThrow();
  });

  it("clamps rows stamped in the future, at startup and while running, so a clock step back cannot hold spend for long", () => {
    const g = newGate(policy({ daily: 600, strategy: { hourlyBudgetCents: 600 } }));
    spend(g, 590);
    // The clock steps back a year while the process runs.
    clock -= 365 * DAY;
    const r = refusal(() => g.reserve(req(20)));
    expect(["HOURLY_CAP", "DAILY_CAP"]).toContain(r.code);
    expect(r.retryAfterMs).toBeLessThanOrEqual(DAY + 1);
    clock += DAY + 1;
    expect(() => g.reserve(req(20))).not.toThrow();
  });

  it("prunes rows older than 30 days at startup", () => {
    const g = newGate();
    spend(g, 1);
    clock += 31 * DAY;
    newGate();
    expect((raw.prepare("SELECT COUNT(*) AS n FROM inference_ledger").get() as { n: number }).n).toBe(0);
  });

  it("every SUM in the gate's SQL is bounded by time, session or task (no lifetime sums)", () => {
    const sums = Object.entries(GATE_SQL).filter(([, sql]) => /SUM\(/i.test(sql));
    expect(sums.length).toBeGreaterThan(5);
    for (const [name, sql] of sums) {
      expect(/created_at_ms > @since|session_id = @sessionId|task_id = @taskId/.test(sql), name).toBe(true);
    }
  });
});

describe("gate availability (D9)", () => {
  it("refuses paid inference with GATE_UNAVAILABLE when none is installed", () => {
    resetInferenceGateForTests();
    expect(() => requireInferenceGate()).toThrow(InferenceRefusedError);
    const g = newGate();
    installInferenceGate(g);
    expect(requireInferenceGate()).toBe(g);
  });

  it("on a ledger error refuses paid models and still allows free local ones", () => {
    const g = newGate();
    raw.exec("DROP TABLE inference_ledger");
    expect(refusal(() => g.reserve(req(1))).code).toBe("GATE_UNAVAILABLE");
    const local = g.reserve(req(1, MAIN, { provider: "ollama", price: { inputUsdPerM: 0, outputUsdPerM: 0, local: true } }));
    expect(g.isOpen(local.id)).toBe(true);
    g.commit(local.id, { inputTokens: 1, outputTokens: 1 }, 1);
    expect(g.isOpen(local.id)).toBe(false);
  });
});

describe("scope", () => {
  it("merges with the outer scope, and an explicit undefined clears a key", async () => {
    expect(currentInferenceScope().caller).toBe("unattributed");
    await runWithInferenceScope({ caller: "unattributed", sessionId: "s1" }, async () => {
      await runWithInferenceScope({ caller: "worker", taskId: "t", sessionId: undefined }, async () => {
        expect(currentInferenceScope()).toEqual({ caller: "worker", taskId: "t" });
      });
      expect(currentInferenceScope()).toEqual({ caller: "unattributed", sessionId: "s1" });
    });
  });
});

describe("classifyInferenceError", () => {
  const status = (s: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${s}`), { status: s, ...extra });

  it("follows the settlement table", () => {
    expect(classifyInferenceError(status(400))).toMatchObject({ kind: "caller", settle: "release", failover: false, countsForBreaker: false });
    expect(classifyInferenceError(status(404))).toMatchObject({ kind: "model", settle: "release", failover: true, countsForBreaker: false });
    expect(classifyInferenceError(new InferenceHttpError("conway", 400, '{"error":{"code":"model_not_found"}}'))).toMatchObject({ kind: "model", failover: true });
    expect(classifyInferenceError(status(401))).toMatchObject({ kind: "auth", failover: true, disableProviderMs: 30 * 60_000 });
    expect(classifyInferenceError(status(402))).toMatchObject({ settle: "release", failover: true, countsForBreaker: false });
    expect(classifyInferenceError(status(429, { headers: new Headers({ "retry-after": "2" }) }))).toMatchObject({
      kind: "rate_limit", settle: "release", retrySameProvider: true, failover: true, countsForBreaker: true, retryAfterMs: 2000,
    });
    expect(classifyInferenceError(new InferenceHttpError("conway", 503, "busy", 1500))).toMatchObject({ retrySameProvider: true, retryAfterMs: 1500 });
    expect(classifyInferenceError(status(502))).toMatchObject({ kind: "server", retrySameProvider: false, failover: true, countsForBreaker: true });
    expect(classifyInferenceError(status(504))).toMatchObject({ kind: "server", retrySameProvider: false, failover: true });
  });

  it("separates never-sent from ambiguous connection failures", () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(classifyInferenceError(refused)).toMatchObject({ kind: "not_sent", settle: "release", failover: true });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(classifyInferenceError(reset)).toMatchObject({ kind: "ambiguous", settle: "unknown", failover: true });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(classifyInferenceError(timeout)).toMatchObject({ kind: "ambiguous", settle: "unknown" });
    expect(classifyInferenceError(timeout, { callerAborted: true })).toMatchObject({ kind: "aborted", settle: "unknown", failover: false });
    expect(classifyInferenceError(new InferenceResponseError("No completion choice"))).toMatchObject({ settle: "unknown", failover: true });
    expect(classifyInferenceError(new Error("something odd"))).toMatchObject({ kind: "ambiguous", settle: "unknown" });
    expect(classifyInferenceError(new InferenceRefusedError("DAILY_CAP", "x"))).toMatchObject({ kind: "refused", settle: "none", failover: true });
  });
});
