/**
 * A turn's tools and its saved history agree: a policy exception, duplicate
 * provider ids or a failing write never lose a call that ran, and an inbox
 * batch whose tools ran is never replayed. Also: no API keys are copied
 * into process.env, and the last turn stays in context.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTERRUPTED_TOOL_ERROR, runAgentLoop } from "../agent/loop.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { resetInboxToReceived } from "../state/database.js";
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
import type { AgentTurn, AutomatonDatabase, ChatMessage, InferenceOptions } from "../types.js";

const SENDER = "0x9999999999999999999999999999999999999999";
const identity = createTestIdentity();

describe("turn persistence", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let home: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    home = fs.mkdtempSync(path.join(os.tmpdir(), "loop-persist-"));
    process.env.HOME = home;
    db = createTestDb();
    conway = new MockConwayClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    process.env = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function insertInbox(id: string, content = "hello"): void {
    db.insertInboxMessage({
      id,
      from: SENDER,
      to: identity.address,
      content,
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
  }

  function inboxRow(id: string): { status: string; retry_count: number } {
    return db.raw.prepare("SELECT status, retry_count FROM inbox_messages WHERE id = ?").get(id) as any;
  }

  it("a policy rule that throws on a later call does not lose the earlier call's side effect", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo side-effect" } },
        { name: "modify_heartbeat", arguments: { action: "add", name: "ping", schedule: 5 } },
      ]),
      noToolResponse("done"),
    ]);
    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: createTestConfig(),
      db,
      conway,
      inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()),
      onTurnComplete: (t) => turns.push(t),
    });

    expect(conway.execCalls).toHaveLength(1);
    const rows = db.raw.prepare("SELECT name, error FROM tool_calls ORDER BY created_at, rowid").all() as {
      name: string;
      error: string | null;
    }[];
    expect(rows.map((r) => r.name)).toEqual(["exec", "modify_heartbeat"]);
    expect(rows[1].error).toMatch(/^Policy denied:/);
    // The next request shows the model what already ran.
    expect(JSON.stringify(inference.calls[1].messages)).toContain("side-effect");
  });

  it("stores internal ids, so tool calls that share a provider id are all saved", async () => {
    const response = toolCallResponse([
      { name: "exec", arguments: { command: "echo one" } },
      { name: "exec", arguments: { command: "echo two" } },
    ]);
    response.toolCalls![1].id = response.toolCalls![0].id;
    const inference = new MockInferenceClient([response, noToolResponse("done")]);
    await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference });

    const rows = db.raw.prepare("SELECT id FROM tool_calls").all() as { id: string }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    for (const r of rows) expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("an inbox turn whose two calls share a provider id replies once and is processed once", async () => {
    insertInbox("m1");
    const social = new MockSocialClient();
    const dup = toolCallResponse([
      { name: "send_message", arguments: { to_address: SENDER, content: "hi back" } },
      { name: "send_message", arguments: { to_address: SENDER, content: "again" } },
    ]);
    dup.toolCalls![1].id = dup.toolCalls![0].id;
    const inference = new MockInferenceClient([]);
    inference.chat = async (messages: ChatMessage[], options?: InferenceOptions) => {
      inference.calls.push({ messages, options });
      const text = messages.map((m) => m.content).join("\n");
      if (text.includes("external sender")) return structuredClone(dup);
      return toolCallResponse([{ name: "check_credits", arguments: {} }]);
    };

    await runAgentLoop({ identity, config: createTestConfig({ maxTurnsPerCycle: 8 }), db, conway, inference, social });

    expect(social.sentMessages).toHaveLength(1);
    expect(inboxRow("m1").status).toBe("processed");
    const external = db.raw
      .prepare("SELECT id, tool_calls FROM turns WHERE input_source = 'external'")
      .all() as { id: string; tool_calls: string }[];
    expect(external).toHaveLength(1);
    expect(JSON.parse(external[0].tool_calls)).toHaveLength(2);
    const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE turn_id = ?").get(external[0].id) as {
      n: number;
    };
    expect(rows.n).toBe(2);
  });

  it("a failed tool-call write during an inbox turn still marks the batch processed, with no replay", async () => {
    insertInbox("m2");
    const social = new MockSocialClient();
    const original = db.insertToolCall.bind(db);
    let thrown = false;
    db.insertToolCall = (turnId, call) => {
      if (!thrown && call.name === "send_message") {
        thrown = true;
        throw new Error("SQLITE_FULL: database or disk is full");
      }
      return original(turnId, call);
    };
    let inboxTurns = 0;
    const inference = new MockInferenceClient([]);
    inference.chat = async (messages: ChatMessage[], options?: InferenceOptions) => {
      inference.calls.push({ messages, options });
      const text = messages.map((m) => m.content).join("\n");
      if (text.includes("external sender")) {
        inboxTurns++;
        return toolCallResponse([{ name: "send_message", arguments: { to_address: SENDER, content: "reply" } }]);
      }
      return toolCallResponse([{ name: "check_credits", arguments: {} }]);
    };

    await runAgentLoop({ identity, config: createTestConfig({ maxTurnsPerCycle: 8 }), db, conway, inference, social });

    expect(thrown).toBe(true);
    expect(inboxTurns).toBe(1);
    expect(social.sentMessages).toHaveLength(1);
    expect(inboxRow("m2").status).toBe("processed");
    // The call that ran is still on record.
    const saved = db.raw.prepare("SELECT name FROM tool_calls WHERE name = 'send_message'").all();
    expect(saved).toHaveLength(1);
  });

  it("saves the turn and each call while the turn runs, so a crash keeps what ran and what was running", async () => {
    type Seen = { turns: number; calls: [string, string | null][]; listed: [string, string | null][] };
    let seenDuringSecond: Seen | undefined;
    conway.exec = async (command: string, timeout?: number) => {
      conway.execCalls.push({ command, timeout });
      if (command === "echo second") {
        const turns = (db.raw.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
        const calls = (
          db.raw.prepare("SELECT arguments, error FROM tool_calls ORDER BY rowid").all() as {
            arguments: string;
            error: string | null;
          }[]
        ).map((r): [string, string | null] => [JSON.parse(r.arguments).command, r.error]);
        const row = db.raw.prepare("SELECT tool_calls FROM turns").get() as { tool_calls: string };
        const listed = (JSON.parse(row.tool_calls) as { arguments: { command: string }; error?: string }[]).map(
          (c): [string, string | null] => [c.arguments.command, c.error ?? null],
        );
        seenDuringSecond = { turns, calls, listed };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo first" } },
        { name: "exec", arguments: { command: "echo second" } },
      ]),
      noToolResponse("done"),
    ]);
    await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference });

    // A forced exit during the second call leaves it saved as interrupted.
    const during: [string, string | null][] = [
      ["echo first", null],
      ["echo second", INTERRUPTED_TOOL_ERROR],
    ];
    expect(seenDuringSecond).toEqual({ turns: 1, calls: during, listed: during });
    // Once it returned, its result replaced the placeholder: one row per call.
    const after = db.raw.prepare("SELECT arguments, error, result FROM tool_calls ORDER BY rowid").all() as {
      arguments: string;
      error: string | null;
      result: string;
    }[];
    expect(after.map((r) => [JSON.parse(r.arguments).command, r.error])).toEqual([
      ["echo first", null],
      ["echo second", null],
    ]);
    const turn = db.getRecentTurns(5).find((t) => t.toolCalls.length > 0)!;
    expect(turn.toolCalls.map((c) => c.error ?? null)).toEqual([null, null]);
    const rowIds = (db.raw.prepare("SELECT id FROM tool_calls ORDER BY rowid").all() as { id: string }[]).map((r) => r.id);
    expect(turn.toolCalls.map((c) => c.id)).toEqual(rowIds);
  });

  it("an inbox batch whose reply went out before a crash is marked processed by startup recovery", async () => {
    // Simulated by the marker the turn writes before its tools run.
    insertInbox("m3");
    const social = new MockSocialClient();
    let markerDuringSend: string | undefined;
    social.send = async (to: string, content: string) => {
      markerDuringSend = db.getKV("inbox.tools_started");
      social.sentMessages.push({ to, content });
      return { id: "x" };
    };
    const inference = new MockInferenceClient([]);
    inference.chat = async (messages: ChatMessage[], options?: InferenceOptions) => {
      inference.calls.push({ messages, options });
      const text = messages.map((m) => m.content).join("\n");
      if (text.includes("external sender")) {
        return toolCallResponse([{ name: "send_message", arguments: { to_address: SENDER, content: "reply" } }]);
      }
      return toolCallResponse([{ name: "check_credits", arguments: {} }]);
    };
    await runAgentLoop({ identity, config: createTestConfig({ maxTurnsPerCycle: 4 }), db, conway, inference, social });

    expect(markerDuringSend).toBeDefined();
    expect(JSON.parse(markerDuringSend!).ids).toEqual(["m3"]);
    // Cleared once the turn was saved.
    expect(db.getKV("inbox.tools_started")).toBeUndefined();
  });

  it("an onTurnComplete callback that throws does not fail a saved turn or replay it", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo once" } }]),
      noToolResponse("done"),
    ]);
    await runAgentLoop({
      identity,
      config: createTestConfig(),
      db,
      conway,
      inference,
      onTurnComplete: () => {
        throw new Error("callback broke");
      },
    });
    expect(conway.execCalls.map((c) => c.command)).toEqual(["echo once"]);
  });

  it("resetInboxToReceived leaves a processed row alone", () => {
    insertInbox("m4");
    db.raw.prepare("UPDATE inbox_messages SET status = 'processed' WHERE id = 'm4'").run();
    resetInboxToReceived(db.raw, ["m4"]);
    expect(inboxRow("m4").status).toBe("processed");
  });

  it("does not copy API keys or a base URL into process.env", async () => {
    for (const k of ["OPENAI_API_KEY", "CONWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL"]) {
      delete process.env[k];
    }
    await runAgentLoop({
      identity,
      config: createTestConfig({ conwayApiKey: "cnwy_k_leak", anthropicApiKey: "sk-ant-leak", openaiApiKey: undefined }),
      db,
      conway,
      inference: new MockInferenceClient([noToolResponse("x")]),
    });
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.CONWAY_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("keeps the most recent turn in context, even when it only checked status", async () => {
    conway.creditsCents = 424_200;
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo build" } }]),
      toolCallResponse([{ name: "check_credits", arguments: {} }]),
      noToolResponse("done"),
    ]);
    await runAgentLoop({ identity, config: createTestConfig(), db, conway, inference });
    expect(JSON.stringify(inference.calls[2].messages)).toContain("424200 cents");
  });
});
