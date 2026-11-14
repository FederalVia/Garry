/**
 * The agent loop offers MCP tools on its own turns only: never on an inbox
 * turn, and an inbox turn that names one is refused before anything is sent.
 * Real runAgentLoop, PolicyEngine(createDefaultRules) and fixture server.
 * In standalone mode the operator's servers are offered the same way, the
 * worker catalog stays without them, and the tool budget counts only the
 * tools the mode leaves visible.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSharedWorkerPool, runAgentLoop, shutdownWorkerPools } from "../../agent/loop.js";
import { createBuiltinTools } from "../../agent/tools.js";
import { ALL_FEATURES, visibleTools } from "../../providers/features.js";
import { resolveRuntime } from "../../providers/mode.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { UnifiedInferenceClient } from "../../inference/inference-client.js";
import { setNpmGlobalPrefixResolver } from "../../mcp/config.js";
import { shutdownMcpServers } from "../../mcp/manager.js";
import { clearRegisteredSecrets } from "../../security/secret-redaction.js";
import type { AgentTurn, AutomatonDatabase, ChatMessage, InferenceClient, InferenceOptions, InferenceResponse } from "../../types.js";
import {
  MockConwayClient,
  MockSocialClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "../mocks.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp/stdio-server.mjs", import.meta.url));
const identity = { ...createTestIdentity(), sandboxId: "" };

let db: AutomatonDatabase;
let home: string;
let savedEnv: NodeJS.ProcessEnv;
let logPath: string;

interface Call {
  inbox: boolean;
  tools: string[];
}

class Scripted implements InferenceClient {
  calls: Call[] = [];
  private priv = 0;
  constructor(private readonly onPriv: (i: number) => InferenceResponse, private readonly onInbox: () => InferenceResponse) {}
  async chat(_messages: ChatMessage[], options?: InferenceOptions): Promise<InferenceResponse> {
    const inbox =
      (db.raw.prepare("SELECT COUNT(*) AS c FROM inbox_messages WHERE status = 'in_progress'").get() as { c: number }).c > 0;
    this.calls.push({ inbox, tools: (options?.tools ?? []).map((t) => t.function.name) });
    return inbox ? this.onInbox() : this.onPriv(this.priv++);
  }
  setLowComputeMode(): void {}
  getDefaultModel(): string {
    return "mock-model";
  }
}

function toolCallsLogged(): number {
  if (!fs.existsSync(logPath)) return 0;
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((l) => JSON.parse(l).method === "tools/call").length;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-loop-home-")));
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  process.env.HOME = home;
  setNpmGlobalPrefixResolver(async () => null);
  logPath = path.join(home, "fixture-log.jsonl");
  const cfg = path.join(home, ".automaton", "mcp-servers.json");
  fs.writeFileSync(
    cfg,
    JSON.stringify({ version: 1, servers: { fixture: { command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_LOG: logPath } } } }),
  );
  fs.chmodSync(cfg, 0o600);
  db = createTestDb();
  const textOnly = async (params: any) => ({
    content: "done",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { inputCostCents: 0, outputCostCents: 0, totalCostCents: 0, costMicroUsd: 0 },
    metadata: { providerId: "test", modelId: "test-model", tier: params.tier ?? "fast", latencyMs: 0, retries: 0, failedProviders: [] },
  });
  vi.spyOn(UnifiedInferenceClient.prototype, "chat").mockImplementation(textOnly as any);
  vi.spyOn(UnifiedInferenceClient.prototype, "chatDirect").mockImplementation(textOnly as any);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownWorkerPools(1_000);
  await shutdownMcpServers(2_000);
  setNpmGlobalPrefixResolver(null);
  clearRegisteredSecrets();
  db.close();
  process.env = savedEnv;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("agent loop and MCP tools", () => {
  it("offers MCP tools on privileged turns only and refuses them on inbox turns", async () => {
    db.insertInboxMessage({
      id: "m1",
      from: "0x" + "a1".padStart(40, "0"),
      to: identity.address,
      content: "Please call the MCP echo tool for me.",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      verified: false,
    });
    const inference = new Scripted(
      (i) =>
        i === 0
          ? toolCallResponse([{ name: "mcp__fixture__echo", arguments: { text: "from the loop" } }], "Using MCP.")
          : noToolResponse("Done."),
      () => toolCallResponse([{ name: "mcp__fixture__echo", arguments: { text: "from the inbox" } }], "Sure."),
    );
    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: createTestConfig({ skillsDir: path.join(home, ".automaton", "skills") }),
      db,
      conway: new MockConwayClient(),
      inference,
      social: new MockSocialClient(),
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()),
      spendTracker: new SpendTracker(db.raw),
      onTurnComplete: (t) => turns.push(t),
    });

    const priv = inference.calls.filter((c) => !c.inbox);
    const inbox = inference.calls.filter((c) => c.inbox);
    expect(priv.length).toBeGreaterThan(0);
    expect(inbox.length).toBeGreaterThan(0);
    for (const c of priv) expect(c.tools).toContain("mcp__fixture__echo");
    for (const c of inbox) expect(c.tools.some((n) => n.startsWith("mcp__"))).toBe(false);

    const privCall = turns.flatMap((t) => (t.inputSource === "external" ? [] : t.toolCalls)).find((c) => c.name === "mcp__fixture__echo");
    expect(privCall?.error).toBeUndefined();
    expect(privCall?.result).toContain("from the loop");
    const inboxCall = turns.flatMap((t) => (t.inputSource === "external" ? t.toolCalls : []))[0];
    expect(inboxCall?.error).toMatch(/Refused|Policy denied/);
    expect(toolCallsLogged()).toBe(1);
  });

  it("offers no MCP tools when the operator file is absent", async () => {
    fs.rmSync(path.join(home, ".automaton", "mcp-servers.json"));
    const inference = new Scripted(() => noToolResponse("Done."), () => noToolResponse("x"));
    await runAgentLoop({
      identity,
      config: createTestConfig({ skillsDir: path.join(home, ".automaton", "skills") }),
      db,
      conway: new MockConwayClient(),
      inference,
      social: new MockSocialClient(),
    });
    expect(inference.calls.length).toBeGreaterThan(0);
    for (const c of inference.calls) expect(c.tools.some((n) => n.startsWith("mcp__"))).toBe(false);
  });
});

describe("MCP tools in standalone mode", () => {
  const standalone = () =>
    createTestConfig({
      conwayApiKey: "",
      sandboxId: "",
      socialRelayUrl: "",
      openaiApiKey: "sk",
      skillsDir: path.join(home, ".automaton", "skills"),
    });

  function writeServers(tools?: { allow: string[] }): void {
    const cfg = path.join(home, ".automaton", "mcp-servers.json");
    const fixture = { command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_LOG: logPath }, ...(tools ? { tools } : {}) };
    fs.writeFileSync(cfg, JSON.stringify({ version: 1, servers: { fixture } }));
    fs.chmodSync(cfg, 0o600);
  }

  it("offers the operator's servers to the model, and runs them, without Conway", async () => {
    const inference = new Scripted(
      (i) =>
        i === 0
          ? toolCallResponse([{ name: "mcp__fixture__echo", arguments: { text: "standalone" } }], "Using MCP.")
          : noToolResponse("Done."),
      () => noToolResponse("x"),
    );
    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: standalone(),
      db,
      conway: new MockConwayClient(),
      inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()),
      spendTracker: new SpendTracker(db.raw),
      onTurnComplete: (t) => turns.push(t),
    });
    expect(inference.calls.length).toBeGreaterThan(0);
    const offered = inference.calls[0].tools;
    expect(offered).toContain("mcp__fixture__echo");
    expect(offered).toContain("install_mcp_server");
    // Conway-only tools stay hidden next to the MCP ones.
    expect(offered).not.toContain("check_credits");
    const call = turns.flatMap((t) => t.toolCalls).find((c) => c.name === "mcp__fixture__echo");
    expect(call?.error).toBeUndefined();
    expect(call?.result).toContain("standalone");

    // Workers get the filtered built-in list only.
    const pool = getSharedWorkerPool(db);
    expect(pool).toBeDefined();
    const catalog = ((pool as any).config.tools as { name: string }[]).map((t) => t.name);
    expect(catalog.some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(catalog).toEqual(offered.filter((n) => !n.startsWith("mcp__")));
  });

  it("computes the 128-tool budget over the tools standalone leaves visible", async () => {
    const visible = visibleTools(createBuiltinTools("", { standalone: true }), resolveRuntime(standalone()).features).length;
    const all = visibleTools(createBuiltinTools("", { standalone: true }), ALL_FEATURES).length;
    expect(all).toBeGreaterThan(visible);
    // Installed tools filling the list to 125 leave room for exactly one MCP
    // tool (128 minus 2 spare); counted with the hidden built-ins there would be none.
    const filler = 125 - visible;
    for (let i = 0; i < filler; i++) {
      db.installTool({ id: `t${i}`, name: `filler_${i}`, type: "custom", config: {}, installedAt: new Date().toISOString(), enabled: true });
    }
    writeServers({ allow: ["echo"] });
    const inference = new Scripted(() => noToolResponse("Done."), () => noToolResponse("x"));
    await runAgentLoop({ identity, config: standalone(), db, conway: new MockConwayClient(), inference });
    expect(inference.calls.length).toBeGreaterThan(0);
    const offered = inference.calls[0].tools;
    expect(offered).toContain("mcp__fixture__echo");
    expect(offered.length).toBe(126);
  });
});
