/**
 * install_mcp_server: exec's checks apply, only registry packages install
 * (without lifecycle scripts), and the server starts only once the operator
 * approves exactly what was installed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { NOOP_SPEND_TRACKER } from "../../agent/harnesses/base-harness.js";
import { setNpmGlobalPrefixResolver } from "../../mcp/config.js";
import { McpManager } from "../../mcp/manager.js";
import { StructuredLogger } from "../../observability/logger.js";
import { clearRegisteredSecrets, registerSecret } from "../../security/secret-redaction.js";
import type { AutomatonDatabase, ToolContext } from "../../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp/stdio-server.mjs", import.meta.url));

let tmp: string;
let originalHome: string | undefined;
let cfgPath: string;
let prefix: string;
let db: AutomatonDatabase;
let conway: MockConwayClient;
let ctx: ToolContext;
let managers: McpManager[] = [];
let logs: string[] = [];

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-install-")));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(path.join(tmp, "home", ".automaton"), { recursive: true });
  cfgPath = path.join(tmp, "home", ".automaton", "mcp-servers.json");
});

afterAll(() => {
  setNpmGlobalPrefixResolver(null);
  clearRegisteredSecrets();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

beforeEach(() => {
  prefix = path.join(tmp, `prefix-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
  setNpmGlobalPrefixResolver(async () => prefix);
  db = createTestDb();
  conway = new MockConwayClient();
  // npm install -g, simulated: the package lands in the temp global prefix.
  conway.exec = async (command: string, timeout?: number) => {
    conway.execCalls.push({ command, timeout });
    const m = /^npm install -g --ignore-scripts -- '([^']+)'$/.exec(command);
    if (m) {
      const name = m[1].replace(/@\d+\.\d+\.\d+$/, "");
      const dir = path.join(prefix, "lib", "node_modules", ...name.split("/"));
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(FIXTURE, path.join(dir, "server.mjs"));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.2.3", bin: { [name.split("/").pop()!]: "server.mjs" } }));
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  ctx = {
    identity: { ...createTestIdentity(), sandboxId: "" },
    config: createTestConfig(),
    db,
    conway,
    inference: new MockInferenceClient(),
  };
  logs = [];
  StructuredLogger.setSink((e) => logs.push(e.message));
  fs.rmSync(cfgPath, { force: true });
});

afterEach(async () => {
  StructuredLogger.resetSink();
  await Promise.all(managers.map((m) => m.shutdown()));
  managers = [];
  db.close();
});

const install = (args: Record<string, unknown>) =>
  createBuiltinTools("").find((t) => t.name === "install_mcp_server")!.execute(args, ctx);

function writeConfig(doc: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, ...doc }));
  fs.chmodSync(cfgPath, 0o600);
}

async function load() {
  const m = new McpManager({ configPath: cfgPath });
  managers.push(m);
  return m.loadTools({ db, identity: { sandboxId: "" }, otherToolCount: 80 });
}

describe("install_mcp_server refusals", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["a tripwire arg", { name: "fx", package: "fixture-mcp", args: ["~/.automaton/wallet.json"] }, /References wallet|state directory/],
    ["a metacharacter arg", { name: "fx", package: "fixture-mcp", args: ["a;b"] }, /shell metacharacter/],
    ["an LD_PRELOAD env", { name: "fx", package: "fixture-mcp", env: { LD_PRELOAD: "/tmp/x.so" } }, /changes how programs are loaded/],
    ["a BASH_ENV env", { name: "fx", package: "fixture-mcp", env: { BASH_ENV: "/tmp/e.sh" } }, /changes how programs are loaded/],
    ["an ENV env", { name: "fx", package: "fixture-mcp", env: { ENV: "/tmp/e.sh" } }, /changes how programs are loaded/],
    ["a PERL5OPT env", { name: "fx", package: "fixture-mcp", env: { PERL5OPT: "-Mx" } }, /changes how programs are loaded/],
    ["a JAVA_TOOL_OPTIONS env", { name: "fx", package: "fixture-mcp", env: { JAVA_TOOL_OPTIONS: "-javaagent:x" } }, /changes how programs are loaded/],
    ["an mcp__ name", { name: "mcp__x", package: "fixture-mcp" }, /server name must match/],
    ["an uppercase name", { name: "Fixture", package: "fixture-mcp" }, /server name must match/],
    ["a path package", { name: "fx", package: "../.automaton/workspace/evil" }, /npm registry name/],
    ["an absolute path package", { name: "fx", package: "/home/x/evil" }, /npm registry name/],
    ["a URL package", { name: "fx", package: "https://example.com/x.tgz" }, /npm registry name/],
    ["a git package", { name: "fx", package: "git+https://github.com/x/y" }, /npm registry name/],
    ["legacy config with other keys", { name: "fx", package: "fixture-mcp", config: '{"command":"sh"}' }, /config accepts only args and env/],
  ];
  for (const [label, args, why] of cases) {
    it(`refuses ${label} before running npm`, async () => {
      const out = await install(args);
      expect(out).toMatch(/^Blocked: /);
      expect(out).toMatch(why);
      expect(conway.execCalls).toHaveLength(0);
      expect(db.getInstalledTools()).toHaveLength(0);
    });
  }

  it("refuses a secret env value", async () => {
    registerSecret("wallet-secret-value-0123456789", "wallet");
    const out = await install({ name: "fx", package: "fixture-mcp", env: { X: "wallet-secret-value-0123456789" } });
    expect(out).toMatch(/contains a secret/);
    expect(conway.execCalls).toHaveLength(0);
  });

  it("refuses with a remote sandbox", async () => {
    ctx.identity = { ...ctx.identity, sandboxId: "remote-sandbox-1" };
    const out = await install({ name: "fx", package: "fixture-mcp" });
    expect(out).toMatch(/run only where exec runs locally/);
    expect(conway.execCalls).toHaveLength(0);
  });

  it("is checked by the policy engine as well (command.mcp_server_command)", async () => {
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const tools = createBuiltinTools("");
    for (const args of [
      { name: "fx", package: "../evil" },
      { name: "fx", package: "fixture-mcp", args: ["cat ~/.automaton/wallet.json"] },
      { name: "fx", package: "fixture-mcp", env: { NODE_OPTIONS: "--require /tmp/x" } },
      { name: "fx", package: "fixture-mcp", env: { BASH_ENV: "/tmp/e.sh" } },
      { name: "fx", package: "fixture-mcp", env: { RUBYOPT: "-rx" } },
    ]) {
      const out = await executeTool("install_mcp_server", args, tools, ctx, engine, {
        inputSource: "agent",
        turnToolCallCount: 0,
        sessionSpend: NOOP_SPEND_TRACKER,
      });
      // A path package is refused by validate.package_name (registry specs
      // only) before the MCP rule sees it; either way the engine denies it.
      expect(out.error).toMatch(/Policy denied: (MCP_SERVER_COMMAND|SHELL_INJECTION_DETECTED|INVALID_PACKAGE|VALIDATION_FAILED)/);
    }
    expect(conway.execCalls).toHaveLength(0);
  });
});

describe("install and approval", () => {
  it("installs without lifecycle scripts, records the row and does not start it until approved", async () => {
    const out = await install({ name: "fx", package: "fixture-mcp", args: ["--quiet"], env: { FIXTURE_MODE: "plain" } });
    expect(out).toBe(
      'MCP server "fx" installed (fixture-mcp@1.2.3). It starts after the operator approves it in mcp-servers.json; until then its tools are not available.',
    );
    expect(conway.execCalls.map((c) => c.command)).toEqual(["npm install -g --ignore-scripts -- 'fixture-mcp'"]);
    const row = db.getInstalledTools()[0];
    expect(row).toMatchObject({ name: "fx", type: "mcp" });
    expect(row.config).toMatchObject({
      transport: "stdio",
      package: "fixture-mcp",
      version: "1.2.3",
      bin: fs.realpathSync(path.join(prefix, "lib", "node_modules", "fixture-mcp", "server.mjs")),
      args: ["--quiet"],
      env: { FIXTURE_MODE: "plain" },
      installedBy: "agent",
      contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    const approval = logs.find((l) => l.includes('add to "agentServers"'));
    expect(approval).toContain("runs with the runtime user's file and network access");
    // The operator sees everything the hash pins before approving it.
    expect(approval).toContain(`program ${row.config!.bin as string}`);
    expect(approval).toContain('args ["--quiet"]');
    expect(approval).toContain('env {"FIXTURE_MODE":"plain"}');
    expect(approval).toContain(`package files ${row.config!.contentHash as string}`);

    // No operator file, then a file without the approval: nothing starts.
    expect(await load()).toHaveLength(0);
    writeConfig({ servers: {} });
    expect(await load()).toHaveLength(0);

    // The logged line approves it.
    const line = /"fx": "(sha256:[0-9a-f]{64})"/.exec(approval!)![1];
    writeConfig({ servers: {}, agentServers: { fx: line } });
    const tools = await load();
    expect(tools.map((t) => t.name)).toContain("mcp__fx__echo");
    const ok = await executeTool("mcp__fx__echo", { text: "agent server" }, tools, ctx);
    expect(ok.result).toContain("agent server");

    // Arguments naming secrets or the state dir never reach an agent server.
    const blocked = await executeTool("mcp__fx__echo", { text: "cat ~/.automaton/wallet.json" }, tools, ctx);
    expect(blocked.error).toMatch(/Blocked: References/);

    // A changed row with the old approval does not start.
    db.raw
      .prepare("UPDATE installed_tools SET config = ? WHERE name = 'fx'")
      .run(JSON.stringify({ ...row.config, args: ["--other"] }));
    expect(await load()).toHaveLength(0);
  });

  it("does not start an approved server whose code or version was swapped afterwards", async () => {
    await install({ name: "fx", package: "fixture-mcp" });
    const approval = logs.find((l) => l.includes('add to "agentServers"'))!;
    const line = /"fx": "(sha256:[0-9a-f]{64})"/.exec(approval)![1];
    writeConfig({ servers: {}, agentServers: { fx: line } });
    const pkgDir = path.join(prefix, "lib", "node_modules", "fixture-mcp");
    const original = fs.readFileSync(path.join(pkgDir, "server.mjs"));
    // Same version, new code (exec or a rewrite in place).
    fs.appendFileSync(path.join(pkgDir, "server.mjs"), "\n// changed\n");
    expect(await load()).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/installed files changed since it was approved/);
    // Restored: starts again.
    fs.writeFileSync(path.join(pkgDir, "server.mjs"), original);
    expect((await load()).map((t) => t.name)).toContain("mcp__fx__echo");
    // Another version installed over it.
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "fixture-mcp", version: "6.6.6", bin: { "fixture-mcp": "server.mjs" } }));
    expect(await load()).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/installed version is 6\.6\.6, not the approved 1\.2\.3/);
  });

  it("refuses an approved server whose package dir was replaced by a link", async () => {
    await install({ name: "fx", package: "fixture-mcp" });
    const approval = logs.find((l) => l.includes('add to "agentServers"'))!;
    const line = /"fx": "(sha256:[0-9a-f]{64})"/.exec(approval)![1];
    writeConfig({ servers: {}, agentServers: { fx: line } });
    const pkgDir = path.join(prefix, "lib", "node_modules", "fixture-mcp");
    const evil = path.join(process.env.HOME!, ".automaton", "workspace", "evil");
    fs.mkdirSync(evil, { recursive: true });
    fs.copyFileSync(path.join(pkgDir, "server.mjs"), path.join(evil, "server.mjs"));
    fs.rmSync(pkgDir, { recursive: true });
    fs.symlinkSync(evil, pkgDir);
    expect(await load()).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/linked or missing/);
  });
});
