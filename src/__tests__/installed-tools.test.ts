/**
 * Installed tools: a tool name the providers reject, or a duplicate name,
 * would fail every inference request. MCP tools cannot be invoked, so they
 * are not offered to the model at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools, loadInstalledTools, toolsToInferenceFormat } from "../agent/tools.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";

let db: AutomatonDatabase;
let conway: MockConwayClient;
let ctx: ToolContext;

beforeEach(() => {
  db = createTestDb();
  conway = new MockConwayClient();
  ctx = {
    identity: createTestIdentity(),
    config: createTestConfig(),
    db,
    conway,
    inference: new MockInferenceClient(),
  };
});

afterEach(() => db.close());

function install(args: Record<string, unknown>) {
  const tool = createBuiltinTools("test-sandbox").find((t) => t.name === "install_mcp_server")!;
  return tool.execute(args, ctx);
}

function row(name: string, type: "mcp" | "custom", id: string) {
  db.installTool({
    id,
    name,
    type: type as any,
    config: type === "custom" ? { command: "echo" } : {},
    installedAt: new Date().toISOString(),
    enabled: true,
  });
}

describe("install_mcp_server", () => {
  it("refuses an invalid name and a builtin name before running npm", async () => {
    const scoped = await install({ name: "@modelcontextprotocol/server-github", package: "@modelcontextprotocol/server-github" });
    const builtin = await install({ name: "exec", package: "some-mcp-server" });
    expect(scoped).toMatch(/^Blocked: tool name must match/);
    expect(builtin).toMatch(/^Blocked: "exec" is the name of a built-in tool/);
    expect(conway.execCalls).toHaveLength(0);
    expect(db.getInstalledTools()).toHaveLength(0);
  });

  it("refuses bad config JSON and a name that is already installed", async () => {
    expect(await install({ name: "gh", package: "gh-mcp", config: "{not json" })).toMatch(/^Blocked: config/);
    row("gh", "custom", "t1");
    expect(await install({ name: "gh", package: "gh-mcp" })).toMatch(/already installed/);
    expect(conway.execCalls).toHaveLength(0);
  });

  it("says the package installed but is not available as a tool", async () => {
    const out = await install({ name: "github", package: "@modelcontextprotocol/server-github" });
    expect(out).toContain("MCP invocation is not supported yet");
    expect(out).not.toMatch(/MCP server installed/);
    expect(conway.execCalls).toHaveLength(1);
  });
});

describe("loadInstalledTools", () => {
  it("offers only valid, unique, non-MCP tools", () => {
    row("@scope/server", "custom", "a");
    row("exec", "custom", "b");
    row("slack", "mcp", "c");
    row("my_tool", "custom", "d");
    row("my_tool", "custom", "e");

    const sent = toolsToInferenceFormat(loadInstalledTools(db)).map((t) => t.function.name);
    expect(sent).toEqual(["my_tool"]);

    const all = toolsToInferenceFormat([...createBuiltinTools("x"), ...loadInstalledTools(db)]).map((t) => t.function.name);
    expect(new Set(all).size).toBe(all.length);
    for (const name of all) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});
