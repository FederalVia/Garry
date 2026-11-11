/**
 * Inbox turns are default-deny.
 *
 * Every builtin tool is evaluated through the real PolicyEngine with the
 * default rules. On an inbox or unknown source only send_message to the
 * batch sender passes. Source-less, wakeup, system and heartbeat turns keep
 * their existing rules.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { createBuiltinTools } from "../agent/tools.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { checkInboxToolCall } from "../agent/inbox-isolation.js";
import { isValidSolanaAddress } from "../identity/chain.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
} from "./mocks.js";
import type {
  AutomatonDatabase,
  AutomatonTool,
  InputSource,
  PolicyRequest,
  ToolContext,
} from "../types.js";

const SENDER = "0x" + "5a".repeat(20);
const OTHER = "0x" + "6b".repeat(20);
const BATCH_IDS = ["msg-1", "msg-2"];

describe("inbox allow list", () => {
  let db: AutomatonDatabase;
  let engine: PolicyEngine;
  let ctx: ToolContext;
  let spend: SpendTracker;
  const tools = createBuiltinTools("test-sandbox-id");

  beforeEach(() => {
    db = createTestDb();
    engine = new PolicyEngine(db.raw, createDefaultRules());
    spend = new SpendTracker(db.raw);
    ctx = {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    };
  });

  afterEach(() => {
    db.close();
  });

  function evaluate(
    tool: AutomatonTool,
    args: Record<string, unknown>,
    inputSource: InputSource | undefined,
    extra: Partial<PolicyRequest["turnContext"]> = {},
  ) {
    return engine.evaluate({
      tool,
      args,
      context: ctx,
      turnContext: {
        inputSource,
        turnToolCallCount: 0,
        sessionSpend: spend,
        inboxSender: SENDER,
        inboxMessageIds: BATCH_IDS,
        inboxSendCount: 0,
        ...extra,
      },
    });
  }

  function toolNamed(name: string): AutomatonTool {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no builtin tool ${name}`);
    return tool;
  }

  function argsFor(name: string): Record<string, unknown> {
    if (name === "send_message") return { to_address: SENDER, content: "thanks" };
    return {};
  }

  for (const source of ["external", "peer"] as InputSource[]) {
    it(`source "${source}": only send_message is allowed, for every builtin tool`, () => {
      expect(tools.length).toBeGreaterThan(50);
      const allowed: string[] = [];
      for (const tool of tools) {
        const decision = evaluate(tool, argsFor(tool.name), source);
        if (decision.action === "allow") {
          allowed.push(tool.name);
        } else {
          expect(decision.reasonCode, tool.name).toBe("INBOX_TOOL_NOT_ALLOWED");
        }
      }
      expect(allowed).toEqual(["send_message"]);
    });

    it(`source "${source}": an unknown tool name is denied the same way`, () => {
      const unknown: AutomatonTool = {
        name: "mcp_newly_installed_tool",
        description: "installed later",
        parameters: { type: "object", properties: {} },
        execute: async () => "ran",
        riskLevel: "safe",
        category: "vm",
      };
      const decision = evaluate(unknown, {}, source);
      expect(decision.action).toBe("deny");
      expect(decision.reasonCode).toBe("INBOX_TOOL_NOT_ALLOWED");
    });
  }

  it("send_message is allowed only once, only to the batch sender, and never to the agent itself", () => {
    const send = toolNamed("send_message");
    expect(evaluate(send, { to_address: SENDER.toUpperCase().replace("0X", "0x"), content: "hi" }, "external").action).toBe("allow");

    const other = evaluate(send, { to_address: OTHER, content: "hi" }, "external");
    expect(other.action).toBe("deny");
    expect(other.reasonCode).toBe("INBOX_REPLY_ONLY");

    const self = createTestIdentity().address;
    const toSelf = evaluate(send, { to_address: self, content: "hi" }, "external", { inboxSender: self });
    expect(toSelf.action).toBe("deny");
    expect(toSelf.reasonCode).toBe("INBOX_REPLY_ONLY");

    const second = evaluate(send, { to_address: SENDER, content: "hi" }, "external", { inboxSendCount: 1 });
    expect(second.action).toBe("deny");
    expect(second.reasonCode).toBe("INBOX_REPLY_LIMIT");

    const noSender = evaluate(send, { to_address: SENDER, content: "hi" }, "external", { inboxSender: undefined });
    expect(noSender.action).toBe("deny");
  });

  it("a Solana sender can be replied to, with its address matched case-sensitively", () => {
    const sol = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    const ctx = { sender: sol, messageIds: BATCH_IDS, sendCount: 0, selfAddress: SENDER };
    expect(checkInboxToolCall("send_message", { to_address: sol, content: "hi" }, ctx)).toBeNull();
    // The same address with one letter's case flipped (N -> n). Both are valid
    // Solana addresses, so the refusal can only come from comparing case.
    // Lowercasing the whole address would not test this: it turns "L" into
    // "l", which is not base58, and validation refuses it first.
    const caseVariant = "4nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    expect(isValidSolanaAddress(caseVariant)).toBe(true);
    expect(checkInboxToolCall("send_message", { to_address: caseVariant, content: "hi" }, ctx)?.code)
      .toBe("INBOX_REPLY_ONLY");
    expect(checkInboxToolCall("send_message", { to_address: SENDER, content: "hi" }, ctx)?.code)
      .toBe("INBOX_REPLY_ONLY");
    expect(
      checkInboxToolCall("send_message", { to_address: sol, content: "hi" }, { ...ctx, selfAddress: sol })?.code,
    ).toBe("INBOX_REPLY_ONLY");
    expect(checkInboxToolCall("send_message", { to_address: sol, content: "hi" }, { ...ctx, sendCount: 1 })?.code)
      .toBe("INBOX_REPLY_LIMIT");
    // Not an address on either chain.
    expect(
      checkInboxToolCall("send_message", { to_address: "not-an-address", content: "hi" }, { ...ctx, sender: "not-an-address" })?.code,
    ).toBe("INBOX_REPLY_ONLY");
  });

  it("reply_to must name a message in the batch", () => {
    const send = toolNamed("send_message");
    expect(
      evaluate(send, { to_address: SENDER, content: "hi", reply_to: "msg-2" }, "external").action,
    ).toBe("allow");
    const foreign = evaluate(send, { to_address: SENDER, content: "hi", reply_to: "someone-else" }, "external");
    expect(foreign.action).toBe("deny");
    expect(foreign.reasonCode).toBe("INBOX_REPLY_ONLY");
  });

  it("refusals do not repeat the arguments", () => {
    const decision = evaluate(
      toolNamed("write_file"),
      { path: "/tmp/ZQX_SECRET_PATH", content: "ZQX_SECRET_CONTENT" },
      "external",
    );
    expect(decision.action).toBe("deny");
    expect(decision.humanMessage).not.toContain("ZQX");
  });

  for (const source of [undefined, "wakeup", "system", "heartbeat", "agent", "creator"] as (InputSource | undefined)[]) {
    it(`source ${String(source)} keeps its rules: exec and write_file to an ordinary path are allowed`, () => {
      const exec = evaluate(toolNamed("exec"), { command: "echo ok" }, source);
      expect(exec.action).toBe("allow");
      expect(exec.rulesTriggered).not.toContain("authority.inbox_allow_list");
      const write = evaluate(
        toolNamed("write_file"),
        { path: "/root/work/notes.txt", content: "x" },
        source,
      );
      expect(write.action).toBe("allow");
      // send_message is not limited to replies outside inbox turns.
      const send = evaluate(toolNamed("send_message"), { to_address: OTHER, content: "hi" }, source);
      expect(send.action).toBe("allow");
    });
  }

  it("an empty source string is not treated as inbox input", () => {
    const write = evaluate(
      toolNamed("write_file"),
      { path: "/root/work/notes.txt", content: "x" },
      "" as InputSource,
    );
    expect(write.action).toBe("allow");
    expect(write.rulesTriggered).not.toContain("authority.inbox_allow_list");
  });
});
