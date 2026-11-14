/**
 * mcp-servers.json holds launch commands and tokens: agent tools can neither
 * read nor write it, exec commands naming it trip, and hard links to it are
 * caught by the inode check. MCP code is guard code.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { NOOP_SPEND_TRACKER } from "../../agent/harnesses/base-harness.js";
import { checkRead, checkWrite, matchProtected, matchSensitive } from "../../security/protected-paths.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";

let tmp: string;
let home: string;
let originalHome: string | undefined;
let cfg: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-protected-")));
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = home;
  cfg = path.join(home, ".automaton", "mcp-servers.json");
  fs.writeFileSync(cfg, JSON.stringify({ version: 1, servers: { gh: { command: "/bin/true", env: { T: "operator-token-0123456789" } } } }));
  fs.chmodSync(cfg, 0o600);
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("mcp-servers.json protection", () => {
  it("is secret and protected by name, and denied to reads and writes", () => {
    expect(matchSensitive(cfg)).not.toBeNull();
    expect(matchProtected(cfg)).not.toBeNull();
    expect(checkRead(cfg).ok).toBe(false);
    expect(checkWrite(cfg).ok).toBe(false);
  });

  it("read_file, write_file and edit_own_file are denied through the policy engine", async () => {
    const db = createTestDb();
    try {
      const conway = new MockConwayClient();
      const ctx = {
        identity: { ...createTestIdentity(), sandboxId: "" },
        config: createTestConfig(),
        db,
        conway,
        inference: new MockInferenceClient(),
      };
      const tools = createBuiltinTools("");
      const engine = new PolicyEngine(db.raw, createDefaultRules());
      const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: NOOP_SPEND_TRACKER };
      for (const [name, args] of [
        ["read_file", { path: "~/.automaton/mcp-servers.json" }],
        ["read_file", { path: cfg }],
        ["write_file", { path: cfg, content: "{}" }],
        ["edit_own_file", { path: cfg, content: "{}", description: "x" }],
        ["exec", { command: "cat ~/.automaton/mcp-servers.json" }],
        ["exec", { command: "ln ~/.automaton/mcp-servers.json /tmp/x.json" }],
        ["exec", { command: "cp mcp-servers.json /tmp/x" }],
      ] as [string, Record<string, unknown>][]) {
        const out = await executeTool(name, args, tools, ctx, engine, turn);
        expect(out.error, `${name} ${JSON.stringify(args)}`).toBeDefined();
        expect(out.result).not.toContain("operator-token");
      }
      expect(conway.execCalls).toHaveLength(0);
      expect(fs.readFileSync(cfg, "utf8")).toContain("operator-token");
    } finally {
      db.close();
    }
  });

  it("a hard link to it is caught by the inode check", () => {
    const link = path.join(tmp, "innocent.json");
    fs.linkSync(cfg, link);
    try {
      expect(checkRead(link).code).toBe("HARDLINK");
    } finally {
      fs.rmSync(link);
    }
  });

  it("exec commands that write MCP or scheduler guard code trip; an unrelated repo name does not", () => {
    for (const cmd of [
      "echo x > src/mcp/manager.ts",
      "sed -i s/x/y/ dist/mcp/config.js",
      "cp /tmp/x src/runtime/cancellation.ts",
      "tee src/heartbeat/scheduler.ts < /tmp/x",
      "mv x.ts src/orchestration/health-monitor.ts",
    ]) {
      expect(getForbiddenCommandMatch(cmd), cmd).not.toBeNull();
    }
    expect(getForbiddenCommandMatch("git clone https://github.com/punkpeye/awesome-mcp-servers")).toBeNull();
  });

  it("every checkout guard file this feature relies on is refused to write_file and to exec alike", () => {
    const checkout = process.cwd();
    for (const rel of [
      "src/heartbeat/scheduler.ts",
      "src/heartbeat/tasks.ts",
      "src/runtime/cancellation.ts",
      "src/runtime/shutdown.ts",
      "src/orchestration/health-monitor.ts",
      "src/mcp/config.ts",
      // MCP HTTP address checks live here.
      "src/registry/safe-fetch.ts",
    ]) {
      expect(matchProtected(path.join(checkout, rel)), rel).not.toBeNull();
      for (const cmd of [`sed -i s/a/b/ ${path.join(checkout, rel)}`, `cd ${checkout} && echo x >> ${rel}`]) {
        expect(getForbiddenCommandMatch(cmd), cmd).not.toBeNull();
      }
    }
  });
});
