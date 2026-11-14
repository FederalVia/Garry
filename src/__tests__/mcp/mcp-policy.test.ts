/**
 * MCP calls go through the policy engine like any tool: inbox and unknown
 * sources are denied, autonomous turns are allowed, the decision is logged
 * with risk level third_party, the hourly cap counts calls actually sent,
 * and registered secrets never reach the server.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { createAuthorityRules } from "../../agent/policy-rules/authority.js";
import { INBOX_ALLOWED_TOOLS } from "../../agent/inbox-isolation.js";
import { NOOP_SPEND_TRACKER } from "../../agent/harnesses/base-harness.js";
import { isMutatingTool } from "../../agent/idle-only-tools.js";
import { builtinToolNames } from "../../agent/tools.js";
import { setNpmGlobalPrefixResolver } from "../../mcp/config.js";
import { McpManager } from "../../mcp/manager.js";
import { clearRegisteredSecrets, registerSecret } from "../../security/secret-redaction.js";
import type { AutomatonDatabase, AutomatonTool, InputSource, ToolContext } from "../../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp/stdio-server.mjs", import.meta.url));

let tmp: string;
let originalHome: string | undefined;
let cfgPath: string;
let logPath: string;
let db: AutomatonDatabase;
let ctx: ToolContext;
let engine: PolicyEngine;
let m: McpManager;
let tools: AutomatonTool[];

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-policy-")));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(path.join(tmp, "home", ".automaton"), { recursive: true });
  cfgPath = path.join(tmp, "home", ".automaton", "mcp-servers.json");
  setNpmGlobalPrefixResolver(async () => null);
});

afterAll(() => {
  setNpmGlobalPrefixResolver(null);
  clearRegisteredSecrets();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

beforeEach(async () => {
  logPath = path.join(tmp, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ version: 1, servers: { fixture: { command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_LOG: logPath } } } }),
  );
  fs.chmodSync(cfgPath, 0o600);
  db = createTestDb();
  ctx = {
    identity: { ...createTestIdentity(), sandboxId: "" },
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
  engine = new PolicyEngine(db.raw, createDefaultRules());
  m = new McpManager({ configPath: cfgPath });
  tools = await m.loadTools({ db, identity: { sandboxId: "" }, otherToolCount: 80 });
});

afterEach(async () => {
  await m.shutdown();
  db.close();
});

function callsLogged(): number {
  if (!fs.existsSync(logPath)) return 0;
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((l) => JSON.parse(l).method === "tools/call").length;
}

function run(name: string, args: Record<string, unknown>, inputSource: InputSource | undefined) {
  return executeTool(name, args, tools, ctx, engine, { inputSource, turnToolCallCount: 0, sessionSpend: NOOP_SPEND_TRACKER });
}

describe("MCP tools and the policy engine", () => {
  it("denies an inbox turn before anything is sent", async () => {
    const out = await run("mcp__fixture__echo", { text: "x" }, "external" as InputSource);
    expect(out.error).toMatch(/^Policy denied: /);
    const row = db.raw
      .prepare("SELECT rules_triggered FROM policy_decisions WHERE tool_name = ? ORDER BY created_at DESC LIMIT 1")
      .get("mcp__fixture__echo") as { rules_triggered: string };
    expect(JSON.parse(row.rules_triggered)).toContain("authority.inbox_allow_list");
    expect(callsLogged()).toBe(0);
  });

  it("denies an unknown source; authority.third_party_tools denies it on its own too", async () => {
    const out = await run("mcp__fixture__echo", { text: "x" }, "mystery" as InputSource);
    expect(out.error).toMatch(/^Policy denied: /);
    expect(callsLogged()).toBe(0);

    // Defence in depth: with the inbox allow-list gone, the risk rule still denies.
    const only = new PolicyEngine(
      db.raw,
      createAuthorityRules().filter((r) => r.id === "authority.third_party_tools"),
    );
    for (const source of ["mystery", "external"]) {
      const res = await executeTool("mcp__fixture__echo", { text: "x" }, tools, ctx, only, {
        inputSource: source as InputSource,
        turnToolCallCount: 0,
        sessionSpend: NOOP_SPEND_TRACKER,
      });
      expect(res.error).toMatch(/EXTERNAL_THIRD_PARTY_TOOL/);
    }
    for (const source of [undefined, "agent", "creator", "system", "heartbeat", "wakeup"]) {
      const res = await executeTool("mcp__fixture__echo", { text: "ok" }, tools, ctx, only, {
        inputSource: source as InputSource | undefined,
        turnToolCallCount: 0,
        sessionSpend: NOOP_SPEND_TRACKER,
      });
      expect(res.error).toBeUndefined();
    }
    expect(callsLogged()).toBe(6);
  });

  it("allows source-less, heartbeat, wakeup and agent turns and logs third_party decisions", async () => {
    for (const source of [undefined, "agent", "heartbeat", "wakeup"] as (InputSource | undefined)[]) {
      const out = await run("mcp__fixture__echo", { text: `from ${source}` }, source);
      expect(out.error).toBeUndefined();
      expect(out.result).toContain(`from ${source}`);
    }
    const rows = db.raw
      .prepare("SELECT risk_level, decision FROM policy_decisions WHERE tool_name = ?")
      .all("mcp__fixture__echo") as { risk_level: string; decision: string }[];
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.risk_level).toBe("third_party");
      expect(r.decision).toBe("allow");
    }
    expect(callsLogged()).toBe(4);
  });

  it("counts sent calls in mcp_calls and refuses the 121st in an hour", async () => {
    const now = Date.now();
    const insert = db.raw.prepare("INSERT INTO mcp_calls (server, tool, sent_at) VALUES (?, ?, ?)");
    for (let i = 0; i < 119; i++) insert.run("fixture", "echo", new Date(now - 60_000).toISOString());
    // Old and other-server rows do not count; a LIKE wildcard would match fixture-x.
    insert.run("fixture", "echo", new Date(now - 2 * 3_600_000).toISOString());
    insert.run("fixture-x", "echo", new Date(now).toISOString());
    expect((await run("mcp__fixture__echo", { text: "120th" }, "agent")).result).toContain("120th");
    const denied = await run("mcp__fixture__echo", { text: "121st" }, "agent");
    expect(denied.error).toMatch(/reached its limit of 120 calls per hour/);
    expect(callsLogged()).toBe(1);
  });

  it("does not count a call refused before sending (invalid arguments)", async () => {
    await run("mcp__fixture__echo", { text: 1 }, "agent");
    const n = db.raw.prepare("SELECT COUNT(*) AS c FROM mcp_calls").get() as { c: number };
    expect(n.c).toBe(0);
  });

  it("refuses arguments that contain a registered secret, including JSON-escaped ones", async () => {
    const secret = 'wallet"key\\with-quotes-0123456789';
    registerSecret(secret, "wallet");
    const out = await run("mcp__fixture__echo", { text: `here: ${secret}` }, "agent");
    expect(out.error).toMatch(/contain a secret value; the call was not sent/);
    expect(callsLogged()).toBe(0);
  });

  it("never offers an MCP tool on an inbox turn and treats calls as mutating", () => {
    expect(INBOX_ALLOWED_TOOLS.some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(tools.filter((t) => INBOX_ALLOWED_TOOLS.includes(t.name))).toHaveLength(0);
    expect(isMutatingTool("mcp__fixture__echo")).toBe(true);
    for (const name of builtinToolNames()) expect(name.startsWith("mcp__")).toBe(false);
  });
});
