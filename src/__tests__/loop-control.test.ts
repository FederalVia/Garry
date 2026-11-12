/**
 * Loop control: cooperative stop, dead state, loop detection by arguments,
 * create_goal outcomes, wake reasons and the survival tier in prompts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentLoop, SHUTDOWN_SKIP_ERROR } from "../agent/loop.js";
import { buildSystemPrompt, buildWakeupPrompt, INBOX_WAKE_NOTICE } from "../agent/system-prompt.js";
import { insertWakeEvent } from "../state/database.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import {
  MockConwayClient,
  MockInferenceClient,
  MockSocialClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "./mocks.js";
import type { AgentState, AgentTurn, AutomatonDatabase, ChatMessage, FinancialState, InferenceOptions } from "../types.js";

const identity = createTestIdentity();

describe("loop control", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let home: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    home = fs.mkdtempSync(path.join(os.tmpdir(), "loop-control-"));
    process.env.HOME = home;
    db = createTestDb();
    conway = new MockConwayClient();
    // No planning or worker inference in these tests.
    vi.spyOn(Orchestrator.prototype, "tick").mockResolvedValue({
      phase: "idle",
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      goalsActive: 0,
      agentsActive: 0,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    process.env = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function requestText(inference: MockInferenceClient, i: number): string {
    return JSON.stringify(inference.calls[i]?.messages ?? []);
  }

  describe("cooperative stop", () => {
    it("a stop during a tool call saves the turn with the rest skipped and runs no more inference", async () => {
      let stop = false;
      conway.exec = async (command: string, timeout?: number) => {
        conway.execCalls.push({ command, timeout });
        if (command === "echo t1") stop = true;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      };
      const inference = new MockInferenceClient([
        toolCallResponse([
          { name: "exec", arguments: { command: "echo t1" } },
          { name: "exec", arguments: { command: "echo t2" } },
        ]),
        noToolResponse("must not be reached"),
      ]);
      const states: AgentState[] = [];
      const turns: AgentTurn[] = [];
      await runAgentLoop({
        identity,
        config: createTestConfig(),
        db,
        conway,
        inference,
        shouldStop: () => stop,
        onStateChange: (s) => states.push(s),
        onTurnComplete: (t) => turns.push(t),
      });

      expect(inference.calls).toHaveLength(1);
      expect(conway.execCalls.map((c) => c.command)).toEqual(["echo t1"]);
      expect(turns).toHaveLength(1);
      const stored = db.getRecentTurns(5);
      expect(stored).toHaveLength(1);
      expect(stored[0].toolCalls.map((tc) => [tc.arguments.command, tc.error ?? null])).toEqual([
        ["echo t1", null],
        ["echo t2", SHUTDOWN_SKIP_ERROR],
      ]);
      // The loop leaves the state to the runtime's shutdown.
      expect(states).not.toContain("sleeping");
    });

    it("a stop requested before the loop starts does nothing", async () => {
      const inference = new MockInferenceClient([noToolResponse("x")]);
      db.setAgentState("sleeping");
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference, shouldStop: () => true });
      expect(inference.calls).toHaveLength(0);
      expect(db.getAgentState()).toBe("sleeping");
    });
  });

  describe("dead state", () => {
    it("dead with zero credits: no inference and the state stays dead", async () => {
      conway.creditsCents = 0;
      db.setAgentState("dead");
      const states: AgentState[] = [];
      const inference = new MockInferenceClient([noToolResponse("should not run")]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference, onStateChange: (s) => states.push(s) });
      expect(inference.calls).toHaveLength(0);
      expect(db.getAgentState()).toBe("dead");
      expect(states).not.toContain("running");
      expect(states).not.toContain("waking");
    });

    it("dead but funded again: runs normally and leaves dead", async () => {
      conway.creditsCents = 5000;
      db.setAgentState("dead");
      const inference = new MockInferenceClient([noToolResponse("back")]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference });
      expect(inference.calls).toHaveLength(1);
      expect(db.getAgentState()).not.toBe("dead");
    });

    it("a negative balance is dead: no inference", async () => {
      conway.creditsCents = -20;
      const states: AgentState[] = [];
      const inference = new MockInferenceClient([noToolResponse("should not run")]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference, onStateChange: (s) => states.push(s) });
      expect(inference.calls).toHaveLength(0);
      expect(db.getAgentState()).toBe("dead");
      expect(states).toContain("dead");
    });

    it("the heartbeat marking dead mid-cycle stops the loop before the tier branch overwrites it", async () => {
      conway.creditsCents = 0;
      conway.exec = async (command: string, timeout?: number) => {
        conway.execCalls.push({ command, timeout });
        db.setAgentState("dead"); // what check_credits does after an hour at zero
        return { stdout: "ok", stderr: "", exitCode: 0 };
      };
      const inference = new MockInferenceClient([
        toolCallResponse([{ name: "exec", arguments: { command: "echo work" } }]),
        noToolResponse("should not run"),
      ]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference });
      expect(inference.calls).toHaveLength(1);
      expect(db.getAgentState()).toBe("dead");
    });
  });

  describe("loop detection", () => {
    it("exec turns with different commands are progress, not a loop", async () => {
      const inference = new MockInferenceClient([
        ...["git pull", "npm ci", "npm run build", "npm test", "vim fix", "npm test -- again"].map((command) =>
          toolCallResponse([{ name: "exec", arguments: { command } }]),
        ),
        noToolResponse("done"),
      ]);
      const turns: AgentTurn[] = [];
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference, onTurnComplete: (t) => turns.push(t) });
      expect(turns.some((t) => t.input?.includes("LOOP"))).toBe(false);
      expect(db.getKV("loop.enforcement_note")).toBeUndefined();
      for (let i = 0; i < inference.calls.length; i++) {
        expect(requestText(inference, i)).not.toContain("You have been calling");
      }
      expect(inference.calls).toHaveLength(7);
    });

    it("enforcement sets sleep_until and tells the next cycle why it slept", async () => {
      const same = () => toolCallResponse([{ name: "exec", arguments: { command: "echo loop" } }]);
      const first = new MockInferenceClient([same(), same(), same(), same(), same(), same()]);
      const before = Date.now();
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference: first });
      const until = Date.parse(db.getKV("sleep_until") ?? "");
      expect(until - before).toBeGreaterThanOrEqual(4 * 60_000);
      expect(until - before).toBeLessThanOrEqual(6 * 60_000);
      expect(db.getKV("loop.enforcement_note")).toContain("LOOP ENFORCEMENT");

      const next = new MockInferenceClient([noToolResponse("ok, something else")]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference: next });
      expect(requestText(next, 0)).toContain("LOOP ENFORCEMENT");
      expect(db.getKV("loop.enforcement_note")).toBeUndefined();
    });
  });

  describe("create_goal outcomes", () => {
    function insertGoal(title: string): void {
      db.raw
        .prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)")
        .run(`g-${title}`, title, "d", new Date().toISOString());
    }

    it("a duplicate-goal rejection sleeps with backoff that doubles", async () => {
      insertGoal("Build weather API");
      const dup = () =>
        toolCallResponse([{ name: "create_goal", arguments: { title: "Build weather API", description: "again" } }]);

      const first = new MockInferenceClient([dup(), noToolResponse("not reached")]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference: first });
      expect(first.calls).toHaveLength(1);
      expect(db.getKV("blocked_goal_backoff")).toBe("120000");
      expect(db.getAgentState()).toBe("sleeping");

      const second = new MockInferenceClient([dup(), noToolResponse("not reached")]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference: second });
      expect(db.getKV("blocked_goal_backoff")).toBe("240000");
    });

    it("a created goal with BLOCKED in its title does not sleep and resets the backoff", async () => {
      db.setKV("blocked_goal_backoff", "240000");
      const inference = new MockInferenceClient([
        toolCallResponse([{ name: "create_goal", arguments: { title: "Fix BLOCKED queue", description: "d" } }]),
        noToolResponse("done"),
      ]);
      const turns: AgentTurn[] = [];
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference, onTurnComplete: (t) => turns.push(t) });
      expect(turns[0].toolCalls[0].result).toMatch(/^Goal created:/);
      expect(inference.calls).toHaveLength(2);
      expect(db.getKV("blocked_goal_backoff")).toBeUndefined();
    });
  });

  describe("wake reasons", () => {
    it("a heartbeat wake reason reaches the first prompt", async () => {
      insertWakeEvent(db.raw, "heartbeat", "auto-topup failed: XYZZY. Use topup_credits to retry.", {
        taskName: "check_usdc_balance",
      });
      const inference = new MockInferenceClient([noToolResponse("ok")]);
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference });
      expect(requestText(inference, 0)).toContain("XYZZY");
    });

    it("an event consumed by the runtime while sleeping is passed in and shown", async () => {
      const inference = new MockInferenceClient([noToolResponse("ok")]);
      await runAgentLoop({
        identity,
        config: createTestConfig(),
        db,
        conway,
        inference,
        wakeEvents: [
          { id: 1, source: "heartbeat", reason: "check_for_updates: 2 new commit(s) PLUGH", payload: "{}", consumedAt: null, createdAt: "" },
        ],
      });
      expect(requestText(inference, 0)).toContain("PLUGH");
    });

    it("a social inbox wake shows a generic notice and no sender text in privileged requests", async () => {
      const marker = "0x5eeded5eeded5eeded5eeded5eeded5eeded5eed";
      insertWakeEvent(db.raw, "heartbeat", `1 new message(s) from: ${marker.slice(0, 10)} QQSENDERTEXT`, {
        taskName: "check_social_inbox",
      });
      db.insertInboxMessage({
        id: "w1",
        from: marker,
        to: identity.address,
        content: "QQSENDERTEXT please",
        signedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      const inference = new MockInferenceClient([]);
      inference.chat = async (messages: ChatMessage[], options?: InferenceOptions) => {
        inference.calls.push({ messages, options });
        return noToolResponse("ok");
      };
      await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference, social: new MockSocialClient() });

      expect(requestText(inference, 0)).toContain(INBOX_WAKE_NOTICE);
      const privileged = inference.calls.filter(
        (c) => !c.messages.some((m) => typeof m.content === "string" && m.content.includes("external sender")),
      );
      expect(privileged.length).toBeGreaterThan(0);
      for (const c of privileged) {
        const text = JSON.stringify(c.messages);
        expect(text).not.toContain("QQSENDERTEXT");
        expect(text).not.toContain(marker.slice(0, 10));
      }
    });
  });

  describe("survival tier in prompts", () => {
    function tierFor(creditsCents: number | null, usdc: number | null = 0, extra: Partial<FinancialState> = {}): string {
      return buildSystemPrompt({
        identity,
        config: createTestConfig(),
        financial: { creditsCents, usdcBalance: usdc, lastChecked: "", ...extra },
        state: "running",
        db,
        tools: [],
        isFirstRun: false,
      });
    }

    it("uses the runtime's thresholds and shows an unknown balance as unknown", () => {
      expect(tierFor(0)).toContain("Survival tier: critical");
      expect(tierFor(60_000)).toContain("Survival tier: high");
      const unknown = tierFor(null, null);
      expect(unknown).toContain("Survival tier: unknown");
      expect(unknown).toContain("Credits: unknown (balance API unreachable)");
      expect(unknown).not.toContain("$0.00");
      // -1 is a real (debt) balance now, not a sentinel.
      expect(tierFor(-1)).toContain("Credits: $-0.01");
    });

    it("marks a cached balance with its time", () => {
      const text = tierFor(3000, 1, { credits: "cached", creditsAsOf: "2026-11-12T08:00:00.000Z" });
      expect(text).toContain("Credits: $30.00 (cached, as of 2026-11-12T08:00:00.000Z)");
      expect(text).toContain("Survival tier: high (from cached balance)");
    });

    it("never shows a cached debt as dead, matching the loop's routing", () => {
      const cached = tierFor(-20, 1, { credits: "cached" });
      expect(cached).toContain("Survival tier: critical (from cached balance)");
      expect(cached).not.toContain("Survival tier: dead");
      expect(tierFor(-20, 1, { credits: "live" })).toContain("Survival tier: dead");
    });

    it("the wakeup prompt shows unknown balances as unknown", () => {
      db.insertTurn({
        id: "t0",
        timestamp: new Date().toISOString(),
        state: "running",
        thinking: "earlier",
        toolCalls: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costCents: 0,
      });
      const text = buildWakeupPrompt({
        identity,
        config: createTestConfig(),
        financial: { creditsCents: null, usdcBalance: null, credits: "unknown", usdc: "unknown", lastChecked: "" },
        db,
      });
      expect(text).toContain("Your credits: unknown (balance API unreachable) | USDC: unknown");
      expect(text).not.toContain("$0.00");
    });

    it("shows a pending restart after a rebuild", () => {
      db.setKV("restart_required", JSON.stringify({ reason: "rebuild", at: "2026-11-12T08:00:00.000Z" }));
      expect(tierFor(5000)).toContain(
        "A rebuild finished at 2026-11-12T08:00:00.000Z; your changes take effect only after a restart.",
      );
    });
  });
});
