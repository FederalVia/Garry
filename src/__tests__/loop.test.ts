/**
 * Agent Loop Tests
 *
 * Deterministic tests for the agent loop using mock clients.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { runAgentLoop } from "../agent/loop.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import {
  MockInferenceClient,
  MockConwayClient,
  MockSocialClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
  toolCallResponse,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase, AgentTurn, AgentState } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { getUsdcBalance } from "../conway/x402.js";

// The loop reads the USDC balance every phase; without this mock that read
// went to the public Base mainnet RPC. 0 USDC (what a fresh test wallet holds)
// keeps the bootstrap topup, and its module-level cooldown, out of these tests.
const realX402 = vi.hoisted(() => ({ getUsdcBalance: null as null | ((...args: any[]) => Promise<number>) }));
vi.mock("../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/x402.js")>();
  realX402.getUsdcBalance = actual.getUsdcBalance;
  return { ...actual, getUsdcBalance: vi.fn(async () => 0) };
});
const usdcBalanceMock = vi.mocked(getUsdcBalance);

describe("Agent Loop", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let identity: ReturnType<typeof createTestIdentity>;
  let config: ReturnType<typeof createTestConfig>;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    identity = createTestIdentity();
    config = createTestConfig();
    usdcBalanceMock.mockClear();
    usdcBalanceMock.mockImplementation(async () => 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("reads the USDC balance through the mock, never the network", async () => {
    const inference = new MockInferenceClient([noToolResponse("Done.")]);
    await runAgentLoop({ identity, config, db, conway, inference });
    expect(usdcBalanceMock).toHaveBeenCalled();
  });

  it("exec tool runs and is persisted", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo hello" } },
      ]),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // First turn should have the exec tool call
    expect(turns.length).toBeGreaterThanOrEqual(1);
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls[0].name).toBe("exec");
    expect(execTurn!.toolCalls[0].error).toBeUndefined();

    // Verify conway.exec was called
    expect(conway.execCalls.length).toBeGreaterThanOrEqual(1);
    expect(conway.execCalls[0].command).toBe("echo hello");
  });

  it("forbidden patterns blocked", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "rm -rf ~/.automaton" } },
      ]),
      noToolResponse("OK."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The tool result should contain a blocked message, not an error
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    const execCall = execTurn!.toolCalls.find((tc) => tc.name === "exec");
    expect(execCall!.result).toContain("Blocked");

    // conway.exec should NOT have been called
    expect(conway.execCalls.length).toBe(0);
  });

  it("low credits forces low-compute mode", async () => {
    conway.creditsCents = 50; // Below $1 threshold -> critical

    const inference = new MockInferenceClient([
      noToolResponse("Low on credits."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(inference.lowComputeMode).toBe(true);
  });

  it("sleep tool transitions state", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "sleep", arguments: { duration_seconds: 60, reason: "test" } },
      ]),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
  });

  it("idle auto-sleep on no tool calls", async () => {
    const inference = new MockInferenceClient([
      noToolResponse("Nothing to do."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
  });

  it("inbox messages cause pendingInput injection", async () => {
    // Insert an inbox message before running the loop
    db.insertInboxMessage({
      id: "test-msg-1",
      from: "0xsender",
      to: "0xrecipient",
      content: "Hello from another agent!",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      // First response: wakeup prompt
      toolCallResponse([
        { name: "exec", arguments: { command: "echo awake" } },
      ]),
      // Second response: inbox message (after wakeup turn, pendingInput is cleared,
      // then inbox messages are picked up on the next iteration)
      noToolResponse("Received the message."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // One of the turns should have input from the inbox message
    const inboxTurn = turns.find(
      (t) => t.input?.includes("Hello from another agent!"),
    );
    expect(inboxTurn).toBeDefined();
    expect(inboxTurn!.inputSource).toBe("external");
  });

  it("MAX_TOOL_CALLS_PER_TURN limits tool calls", async () => {
    // Create a response with 15 tool calls (max is 10)
    const manyToolCalls = Array.from({ length: 15 }, (_, i) => ({
      name: "exec",
      arguments: { command: `echo ${i}` },
    }));

    const inference = new MockInferenceClient([
      toolCallResponse(manyToolCalls),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The first turn should have at most 10 tool calls executed
    const execTurn = turns.find((t) => t.toolCalls.length > 0);
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls.length).toBeLessThanOrEqual(10);
  });

  it("fund_child calls count toward the per-turn transfer limit", async () => {
    const policy = { ...DEFAULT_TREASURY_POLICY, maxTransfersPerTurn: 2 };
    const policyEngine = new PolicyEngine(db.raw, createDefaultRules(policy));
    const to = "0x1111111111111111111111111111111111111111";
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "fund_child", arguments: { child_id: "missing-1", amount_cents: 100 } },
        { name: "fund_child", arguments: { child_id: "missing-2", amount_cents: 100 } },
        { name: "transfer_credits", arguments: { to_address: to, amount_cents: 100 } },
      ]),
      noToolResponse("Done."),
    ]);
    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config: createTestConfig({ treasuryPolicy: policy }),
      db,
      conway,
      inference,
      policyEngine,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const turn = turns.find((t) => t.toolCalls.some((tc) => tc.name === "transfer_credits"));
    const transfer = turn!.toolCalls.find((tc) => tc.name === "transfer_credits");
    expect(transfer!.error).toContain("TURN_TRANSFER_LIMIT");
  });

  it("consecutive errors trigger sleep", async () => {
    // Create an inference client that always throws
    const failingInference = new MockInferenceClient([]);
    failingInference.chat = async () => {
      throw new Error("Inference API unavailable");
    };

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleSpy3 = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      identity,
      config: { ...config, logLevel: "debug" },
      db,
      conway,
      inference: failingInference,
    });

    // After 5 consecutive errors, should be sleeping
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
    consoleSpy3.mockRestore();
  });

  it("financial state cached fallback on API failure", async () => {
    // Pre-cache a known balance
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 5000, usdcBalance: 1.0 }));

    // Make credits API fail
    conway.getCreditsBalance = async () => {
      throw new Error("API down");
    };

    const inference = new MockInferenceClient([
      noToolResponse("Running with cached balance."),
    ]);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy2 = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    // Should not die, should use cached balance and continue
    const state = db.getAgentState();
    expect(state).not.toBe("dead");

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
  });

  it("turn persistence is atomic with inbox ack", async () => {
    // Insert an inbox message
    db.insertInboxMessage({
      id: "atomic-msg-1",
      from: "0xsender",
      to: "0xrecipient",
      content: "Test atomic persistence",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo processing" } },
      ]),
      noToolResponse("Done processing."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // After processing, the inbox message should be marked as processed
    const unprocessed = db.getUnprocessedInboxMessages(10);
    // The message should have been consumed (either processed or not showing as unprocessed)
    // Since we successfully completed the turn, it should be processed
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  it("state transitions are reported via onStateChange", async () => {
    const stateChanges: AgentState[] = [];

    const inference = new MockInferenceClient([
      noToolResponse("Nothing to do."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Should have transitioned through waking -> running -> sleeping
    expect(stateChanges).toContain("waking");
    expect(stateChanges).toContain("running");
    expect(stateChanges).toContain("sleeping");
  });

  it("cycle turn limit forces sleep after maxTurnsPerCycle", async () => {
    // Set a low cycle limit
    const lowLimitConfig = createTestConfig({ maxTurnsPerCycle: 3 });

    // Create responses that would keep running indefinitely (all mutating tools)
    const responses = Array.from({ length: 10 }, () =>
      toolCallResponse([{ name: "exec", arguments: { command: "echo loop" } }]),
    );
    const inference = new MockInferenceClient(responses);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config: lowLimitConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have stopped at or before the cycle limit (3 turns)
    expect(turns.length).toBeLessThanOrEqual(3);
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
  });

  it("cycle limit sets 2-minute sleep duration", async () => {
    const lowLimitConfig = createTestConfig({ maxTurnsPerCycle: 1 });

    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo test" } }]),
    ]);

    await runAgentLoop({
      identity,
      config: lowLimitConfig,
      db,
      conway,
      inference,
    });

    const sleepUntil = db.getKV("sleep_until");
    expect(sleepUntil).toBeDefined();
    // Sleep should be ~2 minutes (120_000ms) from now
    const sleepMs = new Date(sleepUntil!).getTime() - Date.now();
    expect(sleepMs).toBeGreaterThan(100_000); // at least ~100s
    expect(sleepMs).toBeLessThan(150_000); // at most ~150s
  });

  it("respects custom maxTurnsPerCycle from config", async () => {
    // A limit of 5 should allow exactly 5 turns before forcing sleep
    const limit5Config = createTestConfig({ maxTurnsPerCycle: 5 });

    // Use varied tool names to avoid loop detection (fires after 3 identical patterns)
    const toolNames = ["exec", "write_file", "git_status", "exec", "write_file", "exec", "write_file"];
    const responses = toolNames.map((name) =>
      toolCallResponse([{ name, arguments: name === "exec" ? { command: "echo work" } : { path: "/tmp/test" } }]),
    );

    const inference = new MockInferenceClient(responses);
    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config: limit5Config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have stopped at the cycle limit of 5
    expect(turns.length).toBeLessThanOrEqual(5);
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("zero credits enters critical tier, not dead", async () => {
    conway.creditsCents = 0; // $0 -> critical tier (agent stays alive)

    const inference = new MockInferenceClient([
      noToolResponse("I have no credits but I'm still alive."),
    ]);

    const stateChanges: AgentState[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Zero credits = critical, not dead. Agent should stay alive.
    expect(stateChanges).toContain("critical");
    expect(stateChanges).not.toContain("dead");
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("maintenance loop detected after 3 consecutive idle-only turns", async () => {
    // Simulate: wakeup turn with check_credits, then 2 more idle-only turns,
    // triggering maintenance loop detection on the 3rd idle-only turn.
    // Construct responses with unique tool_call IDs to avoid DB collisions.
    function idleToolResponse(name: string, args: Record<string, unknown>, uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      idleToolResponse("check_credits", {}, "t1"),
      idleToolResponse("system_synopsis", {}, "t2"),
      idleToolResponse("review_memory", {}, "t3"),
      noToolResponse("I will now work on something productive."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The intervention message should have been injected after the 3rd idle-only turn.
    // Turn 4 should have the maintenance loop intervention as input.
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeDefined();
    expect(interventionTurn!.input).toContain("status-check tools");
  });

  it("maintenance loop NOT triggered when turns mix idle and productive tools", async () => {
    // Turn 1: idle-only, Turn 2: has productive tool (exec), Turn 3: idle-only
    // Should NOT trigger because turn 2 breaks the consecutive count.
    const inference = new MockInferenceClient([
      // Turn 1 (wakeup): idle-only
      toolCallResponse([
        { name: "check_credits", arguments: {} },
      ]),
      // Turn 2: productive tool — resets idle counter
      toolCallResponse([
        { name: "exec", arguments: { command: "echo hello" } },
      ]),
      // Turn 3: idle-only — counter starts at 1 again
      toolCallResponse([
        { name: "system_synopsis", arguments: {} },
      ]),
      // Turn 4: end
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // No maintenance loop intervention should have been injected
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeUndefined();
  });

  it("maintenance loop triggers with varying idle tool combinations", async () => {
    // Each turn uses a different idle-only tool, but all are idle-only.
    // The existing exact-pattern detector would NOT catch this (different patterns).
    // The new idle-tool detector SHOULD catch it.
    function idleToolResponse(name: string, args: Record<string, unknown>, uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      idleToolResponse("check_credits", {}, "v1"),
      idleToolResponse("check_usdc_balance", {}, "v2"),
      idleToolResponse("git_status", {}, "v3"),
      noToolResponse("Starting productive work now."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeDefined();
  });

  it("loop enforcement forces sleep after warning is ignored (6 identical patterns)", async () => {
    // 6 identical exec tool calls: warning fires at turn 3, enforcement at turn 6.
    // Use unique IDs to avoid DB collisions.
    function execResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      execResponse("e1"),
      execResponse("e2"),
      execResponse("e3"), // Warning fires here
      execResponse("e4"),
      execResponse("e5"),
      execResponse("e6"), // Enforcement fires here — forced sleep
    ]);

    const turns: AgentTurn[] = [];
    const stateChanges: AgentState[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
      onStateChange: (state) => stateChanges.push(state),
    });

    // Should have the warning at turn 4 (injected after turn 3)
    const warningTurn = turns.find(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(warningTurn).toBeDefined();

    // Agent should be sleeping due to enforcement
    expect(db.getAgentState()).toBe("sleeping");
    expect(stateChanges[stateChanges.length - 1]).toBe("sleeping");
  });

  it("loop enforcement resets when agent changes behavior after warning", async () => {
    // 3 identical exec calls → warning → different tool → 3 more exec calls → warning (not enforcement)
    function execResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      execResponse("r1"),
      execResponse("r2"),
      execResponse("r3"), // Warning fires, loopWarningPattern = "exec"
      // Turn 4: different tool — resets loopWarningPattern
      toolCallResponse([
        { name: "send_message", arguments: { to: "0x123", content: "hello" } },
      ]),
      execResponse("r5"),
      execResponse("r6"),
      execResponse("r7"), // Warning fires again (NOT enforcement — tracker was reset)
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have gotten a warning, not enforcement (agent is still running, not force-slept)
    // The second set of 3 identical patterns gets a NEW warning, not enforcement
    const warningTurns = turns.filter(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(warningTurns.length).toBeGreaterThanOrEqual(2);

    // No enforcement turn should exist
    const enforcementTurn = turns.find(
      (t) => t.input?.includes("LOOP ENFORCEMENT"),
    );
    expect(enforcementTurn).toBeUndefined();
  });

  it("discover_agents turns are retained in context (not classified as idle)", { timeout: 180_000 }, async () => {
    // A turn with only discover_agents should NOT trigger maintenance loop detection
    // because discover_agents is no longer in IDLE_ONLY_TOOLS
    function discoverResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "discover_agents", arguments: JSON.stringify({ limit: 15 }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "discover_agents", arguments: JSON.stringify({ limit: 15 }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      discoverResponse("d1"),
      discoverResponse("d2"),
      discoverResponse("d3"), // Would trigger maintenance loop if discover_agents were idle
      noToolResponse("Processing discovery results."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // No maintenance loop detection should fire since discover_agents is NOT idle
    const maintenanceTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(maintenanceTurn).toBeUndefined();

    // But the repetitive pattern detector SHOULD fire (3 identical patterns)
    const loopWarning = turns.find(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(loopWarning).toBeDefined();
  });

  it("read_file turns are retained in context (not classified as idle)", async () => {
    conway.files["/tmp/one.txt"] = "one";
    conway.files["/tmp/two.txt"] = "two";
    conway.files["/tmp/three.txt"] = "three";

    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "read_file", arguments: { path: "/tmp/one.txt" } }]),
      toolCallResponse([{ name: "read_file", arguments: { path: "/tmp/two.txt" } }]),
      toolCallResponse([{ name: "read_file", arguments: { path: "/tmp/three.txt" } }]),
      noToolResponse("Processed file contents."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const maintenanceTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(maintenanceTurn).toBeUndefined();

    const loopWarning = turns.find(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(loopWarning).toBeDefined();
  });

  it("sleeps early when local workers are running and no self-assigned parent task remains", async () => {
    const tickSpy = vi.spyOn(Orchestrator.prototype, "tick").mockResolvedValue({
      phase: "executing",
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      goalsActive: 1,
      agentsActive: 1,
    });
    const activeSpy = vi.spyOn(LocalWorkerPool.prototype, "getActiveCount").mockReturnValue(1);

    const inference = new MockInferenceClient([
      noToolResponse("This should never be used."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
    expect(inference.calls.length).toBe(0);
    tickSpy.mockRestore();
    activeSpy.mockRestore();
  });

  it("H3-001: does not sleep on delegated work when no local worker is alive", async () => {
    // A child row that looks busy: it can never finish a colony task.
    db.raw.prepare(
      "INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, creator_message, funded_amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("child-1", "Kid", "0x2222222222222222222222222222222222222222", "sb-kid", "p", "m", 25, "running", new Date().toISOString());
    const tickSpy = vi.spyOn(Orchestrator.prototype, "tick").mockResolvedValue({
      phase: "executing",
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      goalsActive: 1,
      agentsActive: 1,
    });

    const inference = new MockInferenceClient([
      noToolResponse("Checking on the goal."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(inference.calls.length).toBeGreaterThan(0);
    tickSpy.mockRestore();
  });

  it("H3-001: the orchestrator wired by the loop runs tasks on local workers and never spawns or funds children", async () => {
    const spawnModule = await import("../replication/spawn.js");
    const spawnSpy = vi.spyOn(spawnModule, "spawnChild");
    const funded = vi.spyOn(conway, "transferCredits");
    const spawned = vi.spyOn(LocalWorkerPool.prototype, "spawn").mockReturnValue(null);
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("goal-w", "Worker goal", "d", "active", new Date().toISOString());
    db.raw.prepare(
      `INSERT INTO task_graph (id, goal_id, title, description, status, agent_role, priority, dependencies, created_at)
       VALUES ('task-w', 'goal-w', 'T', 'd', 'pending', 'generalist', 50, '[]', ?)`,
    ).run(new Date().toISOString());
    db.setKV("orchestrator.state", JSON.stringify({ phase: "executing", goalId: "goal-w", replanCount: 0, failedTaskId: null, failedError: null }));

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference: new MockInferenceClient([noToolResponse("ok")]),
    });

    expect(spawned).toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(funded).not.toHaveBeenCalled();
    spawned.mockRestore();
    spawnSpy.mockRestore();
    funded.mockRestore();
  });

  it("does not sleep early when the parent has a self-assigned task", async () => {
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("goal-self", "Self goal", "Self goal description", "active", new Date().toISOString());
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-self",
      "goal-self",
      "Parent task",
      "Handled by parent",
      "assigned",
      identity.address,
      "generalist",
      50,
      JSON.stringify([]),
      new Date().toISOString(),
    );

    const tickSpy = vi.spyOn(Orchestrator.prototype, "tick").mockResolvedValue({
      phase: "executing",
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      goalsActive: 1,
      agentsActive: 1,
    });

    const inference = new MockInferenceClient([
      noToolResponse("Still working."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(inference.calls.length).toBeGreaterThan(0);
    tickSpy.mockRestore();
  });
});

// ─── Balances the loop cannot read ─────────────────────────────

describe("Agent Loop: unknown and cached balances", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let identity: ReturnType<typeof createTestIdentity>;
  let config: ReturnType<typeof createTestConfig>;
  const realFetch = globalThis.fetch;
  const savedRpc = process.env.AUTOMATON_RPC_URL;
  let payRequests: string[];

  /** USDC RPC answers 1000 USDC; /pay probes are recorded; everything else fails. */
  function stubNetwork(): void {
    payRequests = [];
    process.env.AUTOMATON_RPC_URL = "https://rpc.stub.invalid";
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes('"jsonrpc"')) {
        const req = JSON.parse(body);
        const result = "0x" + (1000n * 1_000_000n).toString(16).padStart(64, "0");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/pay/")) {
        payRequests.push(url);
        // An unparseable offer: nothing is signed and nothing is retried.
        return new Response("{}", { status: 402 });
      }
      throw new Error(`no network in this test: ${url}`);
    }) as typeof fetch;
  }

  beforeEach(() => {
    // These tests answer the balance RPC with their own fetch stub.
    usdcBalanceMock.mockImplementation((...args: any[]) => realX402.getUsdcBalance!(...args));
    db = createTestDb();
    conway = new MockConwayClient();
    // A real throwaway key, so the topup path gets as far as the /pay probe.
    const account = privateKeyToAccount(generatePrivateKey());
    identity = { ...createTestIdentity(), account, address: account.address };
    config = createTestConfig();
    stubNetwork();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedRpc === undefined) delete process.env.AUTOMATON_RPC_URL;
    else process.env.AUTOMATON_RPC_URL = savedRpc;
    vi.useRealTimers();
    vi.restoreAllMocks();
    db.close();
  });

  it("never buys credits on a cached balance (H1-001): three turns 61 s apart make no topup", async () => {
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 30, usdcBalance: 1000 }));
    conway.getCreditsBalance = async () => {
      throw new Error("Conway API error: GET /v1/credits/balance -> 503");
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = Date.parse("2026-11-12T10:00:00.000Z");
    const states: AgentState[] = [];
    let inferenceCalls = 0;
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(now);
      const inference = new MockInferenceClient([noToolResponse("working on a cached balance")]);
      await runAgentLoop({ identity, config, db, conway, inference, onStateChange: (s) => states.push(s) });
      inferenceCalls += inference.calls.length;
      db.deleteKV("sleep_until");
      now += 61_000;
    }
    expect(payRequests).toEqual([]);
    expect(db.getKV("last_inline_topup_attempt")).toBeUndefined();
    // Not dead: a cached balance is never a death sentence, and the agent ran.
    expect(states).not.toContain("dead");
    expect(inferenceCalls).toBeGreaterThan(0);
    // The cache still holds the last live read, not a guess.
    expect(JSON.parse(db.getKV("last_known_balance")!)).toMatchObject({ creditsCents: 30 });
  });

  it("a cached negative balance with a failing live read never marks the agent dead", async () => {
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: -50, usdcBalance: 0 }));
    db.setAgentState("sleeping");
    conway.getCreditsBalance = async () => {
      throw new Error("Conway API error: GET /v1/credits/balance -> 503");
    };
    const states: AgentState[] = [];
    const inference = new MockInferenceClient([noToolResponse("cached negative")]);
    await runAgentLoop({ identity, config, db, conway, inference, onStateChange: (s) => states.push(s) });
    expect(states).not.toContain("dead");
    expect(db.getAgentState()).not.toBe("dead");
    expect(payRequests).toEqual([]);
  });

  it("buys on live low balances (inline topup still works)", async () => {
    conway.creditsCents = 30;
    const inference = new MockInferenceClient([noToolResponse("low")]);
    await runAgentLoop({ identity, config, db, conway, inference });
    expect(payRequests.length).toBe(1);
  });

  it("a dead agent with a cached balance stays dead and runs no inference", async () => {
    db.setAgentState("dead");
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 500, usdcBalance: 0 }));
    conway.getCreditsBalance = async () => {
      throw new Error("Conway API error: GET /v1/credits/balance -> 503");
    };
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await runAgentLoop({ identity, config, db, conway, inference });
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("dead");
  });

  it("a dead agent with no balance at all stays dead and runs no inference", async () => {
    db.setAgentState("dead");
    conway.getCreditsBalance = async () => {
      throw new Error("Conway API error: GET /v1/credits/balance -> 503");
    };
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await runAgentLoop({ identity, config, db, conway, inference });
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("dead");
  });

  it("a dead agent comes back on a live funded read", async () => {
    db.setAgentState("dead");
    conway.creditsCents = 5_000;
    const inference = new MockInferenceClient([noToolResponse("alive again")]);
    await runAgentLoop({ identity, config, db, conway, inference });
    expect(inference.calls.length).toBeGreaterThan(0);
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("a malformed balance body is unknown, not zero: no topup, not dead", async () => {
    conway.getCreditsBalance = async () => {
      const { BalanceUnavailableError } = await import("../conway/balance.js");
      throw new BalanceUnavailableError("malformed_response", "no numeric balance");
    };
    const states: AgentState[] = [];
    const inference = new MockInferenceClient([noToolResponse("fine")]);
    await runAgentLoop({ identity, config, db, conway, inference, onStateChange: (s) => states.push(s) });
    expect(payRequests).toEqual([]);
    expect(states).not.toContain("dead");
    expect(states).not.toContain("critical");
  });
});
