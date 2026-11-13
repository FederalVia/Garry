/**
 * Tool text in standalone mode makes no Conway or sandbox claims, and
 * expose_port says plainly when a port is only served on this machine.
 * Conway mode keeps today's descriptions byte for byte (its system prompt
 * lists them).
 */

import { describe, expect, it } from "vitest";
import { createBuiltinTools, NEUTRAL_TOOL_DESCRIPTIONS } from "../agent/tools.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { ToolContext } from "../types.js";

/** Built-ins hidden in standalone mode by default (they need Conway, the relay or payments). */
const HIDDEN_IN_STANDALONE = new Set([
  "create_sandbox", "delete_sandbox", "list_sandboxes",
  "spawn_child", "list_children", "fund_child", "check_child_status", "start_child", "stop_child",
  "verify_child_constitution", "prune_dead_children", "message_child",
  "check_credits", "transfer_credits", "heartbeat_ping", "distress_signal", "topup_credits",
  "search_domains", "register_domain", "manage_dns",
  "send_message", "x402_fetch", "check_usdc_balance", "register_erc8004", "give_feedback", "discover_agents",
]);

describe("standalone tool descriptions", () => {
  const tools = createBuiltinTools("", { standalone: true });
  const visible = tools.filter((t) => !HIDDEN_IN_STANDALONE.has(t.name));

  it("every hidden name is a real built-in, so the visible set is the standalone default", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const name of HIDDEN_IN_STANDALONE) expect(names.has(name), name).toBe(true);
    expect(visible.length).toBe(tools.length - HIDDEN_IN_STANDALONE.size);
  });

  it.each(createBuiltinTools("", { standalone: true }).filter((t) => !HIDDEN_IN_STANDALONE.has(t.name)).map((t) => [t.name]))(
    "%s mentions neither Conway nor a sandbox",
    (name) => {
      const tool = visible.find((t) => t.name === name)!;
      const text = `${tool.description}\n${JSON.stringify(tool.parameters)}`;
      expect(text).not.toMatch(/conway/i);
      expect(text).not.toMatch(/sandbox/i);
    },
  );

  it("exec, files and ports say where they act", () => {
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    expect(byName.get("exec")).toContain("on the machine you run on");
    expect(byName.get("write_file")).toContain("on the machine you run on");
    expect(byName.get("read_file")).toContain("on the machine you run on");
    expect(byName.get("expose_port")).toMatch(/localhost address that only this machine can reach/);
  });

  it("discover_agents says it reads the Base chain (offered in standalone only with payments on)", () => {
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    expect(byName.get("discover_agents")).toMatch(/JSON-RPC requests to the Base chain/);
    expect(createBuiltinTools("sbx").find((t) => t.name === "discover_agents")!.description).toBe(
      "Discover other agents via ERC-8004 registry with caching.",
    );
  });

  it("Conway mode keeps the existing descriptions", () => {
    const conway = new Map(createBuiltinTools("sbx").map((t) => [t.name, t.description]));
    expect(conway.get("exec")).toBe("Execute a shell command in your sandbox. Returns stdout, stderr, and exit code.");
    expect(conway.get("expose_port")).toBe("Expose a port from your sandbox to the internet. Returns a public URL.");
    for (const name of Object.keys(NEUTRAL_TOOL_DESCRIPTIONS)) {
      expect(conway.get(name)).not.toBe(NEUTRAL_TOOL_DESCRIPTIONS[name]);
    }
    // Only descriptions differ between the two lists.
    const standalone = createBuiltinTools("", { standalone: true });
    expect(standalone.map((t) => t.name)).toEqual(createBuiltinTools("sbx").map((t) => t.name));
  });
});

describe("expose_port result", () => {
  function ctx(sandboxId: string): ToolContext {
    const db = createTestDb();
    return {
      identity: { ...createTestIdentity(), sandboxId },
      config: createTestConfig({ sandboxId }),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    } as ToolContext;
  }

  async function expose(sandboxId: string, conway?: MockConwayClient): Promise<string> {
    const tool = createBuiltinTools(sandboxId).find((t) => t.name === "expose_port")!;
    const context = ctx(sandboxId);
    if (conway) context.conway = conway;
    try {
      return await tool.execute({ port: 8080 }, context);
    } finally {
      context.db.close();
    }
  }

  it.each(["", "undefined", "  "])("with local sandbox id %j says the port is local only", async (id) => {
    const conway = new MockConwayClient();
    conway.exposePort = async (port: number) => ({ port, publicUrl: `http://localhost:${port}`, sandboxId: "local" });
    const out = await expose(id, conway);
    expect(out).toBe("Port 8080 is served on this machine only at http://localhost:8080 (not reachable from the internet).");
  });

  it("with a remote sandbox id it reports the public URL as before", async () => {
    const conway = new MockConwayClient();
    conway.exposePort = async (port: number) => ({ port, publicUrl: `https://${port}-sbx.example`, sandboxId: "sbx" });
    const out = await expose("sbx", conway);
    expect(out).toBe("Port 8080 exposed at: https://8080-sbx.example");
  });
});
