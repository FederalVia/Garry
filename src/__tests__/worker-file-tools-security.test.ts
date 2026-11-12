/**
 * Worker file and shell tools: real-path confinement, sensitive and
 * protected paths, links, and no host fallback in remote mode.
 *
 * Both harnesses run with the real PolicyEngine and, in local mode, the real
 * local Conway client (fs on this machine, no network), so a read or write
 * that follows a link would really reach the file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodingHarness } from "../agent/harnesses/coding-harness.js";
import { GeneralHarness } from "../agent/harnesses/general-harness.js";
import type { BaseHarness } from "../agent/harnesses/base-harness.js";
import type { HarnessContext } from "../agent/harness-types.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { createBuiltinTools } from "../agent/tools.js";
import { createConwayClient } from "../conway/client.js";
import type { TaskNode } from "../orchestration/task-graph.js";
import { AgentWorkspace } from "../orchestration/workspace.js";
import type { AutomatonDatabase, ConwayClient, ExecResult } from "../types.js";
import { MockConwayClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

const PRIVATE_KEY = "0x" + "ab".repeat(32);
const WALLET_JSON = JSON.stringify({ privateKey: PRIVATE_KEY, createdAt: "2026-01-01" });

/** The Conway client's exact refusals when the sandbox API answers 403. */
class Forbidden403Conway extends MockConwayClient {
  override async exec(command: string, timeout?: number): Promise<ExecResult> {
    this.execCalls.push({ command, timeout });
    throw new Error(
      "Conway API authentication failed (403). Sandbox exec refused. " +
        "This may indicate a misconfigured or revoked API key. " +
        "Command will NOT be executed locally for security reasons.",
    );
  }
  override async writeFile(_filePath: string, _content: string): Promise<void> {
    throw new Error(
      "Conway API authentication failed (403). File write refused. " +
        "File will NOT be written locally for security reasons.",
    );
  }
  override async readFile(_filePath: string): Promise<string> {
    throw new Error(
      "Conway API authentication failed (403). File read refused. " +
        "File will NOT be read locally for security reasons.",
    );
  }
}

const TASK: TaskNode = {
  id: "task-1",
  parentId: null,
  goalId: "goal-1",
  title: "Worker task",
  description: "Do the work",
  status: "assigned",
  assignedTo: "local://worker",
  agentRole: "generalist",
  priority: 50,
  dependencies: [],
  result: null,
  metadata: {
    estimatedCostCents: 5,
    actualCostCents: 0,
    maxRetries: 0,
    retryCount: 0,
    timeoutMs: 5_000,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  },
};

const HARNESSES = [["general", GeneralHarness], ["coding", CodingHarness]] as const;

describe("worker file tools security", () => {
  let appDb: AutomatonDatabase;
  let tmp: string;
  let home: string;
  let root: string;
  let walletPath: string;
  let originalHome: string | undefined;
  let originalOpenAiKey: string | undefined;

  beforeEach(() => {
    appDb = createTestDb();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worker-fs-security-")));
    home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    walletPath = path.join(home, ".automaton", "wallet.json");
    fs.writeFileSync(walletPath, WALLET_JSON, { mode: 0o600 });
    root = path.join(tmp, "work");
    fs.mkdirSync(path.join(root, "repo"), { recursive: true });
    originalHome = process.env.HOME;
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    appDb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function makeHarness(
    HarnessClass: new () => BaseHarness,
    mode: "local" | "remote",
    remoteConway?: ConwayClient,
  ): Promise<BaseHarness> {
    const identity = createTestIdentity();
    const config = mode === "local" ? createTestConfig({ sandboxId: "" }) : createTestConfig();
    const conway = mode === "local"
      ? createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "x", sandboxId: "" })
      : remoteConway ?? new Forbidden403Conway();
    const context: HarnessContext = {
      workspaceRoot: root,
      allowedEditRoot: root,
      workspace: new AgentWorkspace("goal-1", path.join(tmp, "workspace")),
      identity,
      config,
      db: appDb.raw,
      conway,
      inference: { chat: async () => ({ content: "done" }) },
      budget: { maxTurns: 5, maxCostCents: 50, timeoutMs: 5_000, turnsUsed: 0, costUsedCents: 0, startedAt: 0 },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-1",
      toolCatalog: createBuiltinTools(identity.sandboxId),
      toolContext: {
        identity,
        config,
        db: appDb,
        conway,
        inference: {
          chat: async () => {
            throw new Error("not used");
          },
          setLowComputeMode: () => {},
          getDefaultModel: () => "mock-model",
        } as any,
      },
      policyEngine: new PolicyEngine(appDb.raw, createDefaultRules()),
    };
    const harness = new HarnessClass();
    await harness.initialize(TASK, context);
    return harness;
  }

  function tool(harness: BaseHarness, name: string) {
    const found = harness.getToolDefs().find((entry) => entry.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  }

  for (const [label, HarnessClass] of HARNESSES) {
    // ── F079: reads ────────────────────────────────────────────

    it(`${label}: read_file of a symlink to wallet.json inside the root is blocked`, async () => {
      fs.symlinkSync(walletPath, path.join(root, "repo", "README.md"));
      const harness = await makeHarness(HarnessClass, "local");

      const out = await tool(harness, "read_file").execute({ path: "repo/README.md" });

      expect(out).toContain("Blocked");
      expect(out).not.toContain("privateKey");
      expect(out).not.toContain(PRIVATE_KEY.slice(2));
    });

    it(`${label}: read_file of env files, SSH keys and state.db inside the root is blocked; .env.example is readable`, async () => {
      for (const name of [".env.local", ".env.production", "id_rsa", "state.db"]) {
        fs.writeFileSync(path.join(root, name), `SECRET_${name}=sk-live-secret`);
      }
      fs.writeFileSync(path.join(root, ".env.example"), "API_KEY=changeme");
      const harness = await makeHarness(HarnessClass, "local");

      for (const name of [".env.local", ".env.production", "id_rsa", "state.db"]) {
        const out = await tool(harness, "read_file").execute({ path: name });
        expect(out, name).toContain("Blocked");
        expect(out, name).not.toContain("sk-live-secret");
      }
      const example = await tool(harness, "read_file").execute({ path: ".env.example" });
      expect(example).toContain("API_KEY=changeme");
    });

    it(`${label}: read_file of a hard link to wallet.json is blocked`, async () => {
      fs.linkSync(walletPath, path.join(root, "notes.txt"));
      const harness = await makeHarness(HarnessClass, "local");

      const out = await tool(harness, "read_file").execute({ path: "notes.txt" });

      expect(out).toContain("Blocked");
      expect(out).not.toContain("privateKey");
    });

    it(`${label}: read_file of a symlink to an ordinary file outside the root is blocked`, async () => {
      fs.mkdirSync(path.join(tmp, "outside"));
      fs.writeFileSync(path.join(tmp, "outside", "plain.txt"), "outside-content");
      fs.symlinkSync(path.join(tmp, "outside", "plain.txt"), path.join(root, "out.txt"));
      const harness = await makeHarness(HarnessClass, "local");

      const out = await tool(harness, "read_file").execute({ path: "out.txt" });

      expect(out).toContain("Blocked");
      expect(out).toContain("OUTSIDE_ROOT");
      expect(out).not.toContain("outside-content");
    });

    // ── F080: writes ───────────────────────────────────────────

    it(`${label}: writes to guard files in a runtime-shaped tree are blocked and the files are unchanged`, async () => {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@conway/automaton" }));
      const guards = [
        "src/agent/harnesses/coding-harness.ts",
        "src/agent/spend-tracker.ts",
        "dist/agent/policy-rules/financial.js",
      ];
      for (const rel of guards) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), "ORIGINAL guard");
      }
      const harness = await makeHarness(HarnessClass, "local");
      const toolNames = harness.getToolDefs().map((entry) => entry.name);

      for (const rel of guards) {
        const out = await tool(harness, "write_file").execute({ path: rel, content: "PWNED" });
        expect(out, rel).toContain("Blocked");
        if (toolNames.includes("patch_file")) {
          const patched = await tool(harness, "patch_file").execute({ path: rel, search: "ORIGINAL", replace: "PWNED" });
          expect(patched, rel).toContain("Blocked");
        }
        expect(fs.readFileSync(path.join(root, rel), "utf8"), rel).toBe("ORIGINAL guard");
      }
    });

    it(`${label}: write_file onto a symlink to ~/.bashrc is blocked and .bashrc is unchanged`, async () => {
      const bashrc = path.join(home, ".bashrc");
      fs.writeFileSync(bashrc, "# original\n");
      fs.symlinkSync(bashrc, path.join(root, "setup.sh"));
      const harness = await makeHarness(HarnessClass, "local");

      const out = await tool(harness, "write_file").execute({
        path: "setup.sh",
        content: "export NODE_OPTIONS=--require=/tmp/evil.js\n",
      });

      expect(out).toContain("Blocked");
      expect(fs.readFileSync(bashrc, "utf8")).toBe("# original\n");
    });

    it(`${label}: ordinary files in the root can still be written and read`, async () => {
      const harness = await makeHarness(HarnessClass, "local");

      const written = await tool(harness, "write_file").execute({ path: "src/app.ts", content: "export const ok = 1;\n" });
      const read = await tool(harness, "read_file").execute({ path: "src/app.ts" });

      expect(written).toContain("Wrote");
      expect(read).toContain("export const ok = 1;");
    });

    // ── F207: no host fallback, scrubbed exec ─────────────────

    it(`${label}: remote mode never falls back to the host when the sandbox refuses`, async () => {
      const marker = path.join(tmp, "RAN");
      fs.writeFileSync(path.join(root, "exists.txt"), "local-only-content");
      const harness = await makeHarness(HarnessClass, "remote");

      const execOut = await tool(harness, "exec").execute({ command: `touch ${marker}` });
      const writeOut = await tool(harness, "write_file").execute({ path: "new.txt", content: "x" });
      const readOut = await tool(harness, "read_file").execute({ path: "exists.txt" });

      expect(execOut).toContain("exec error");
      expect(fs.existsSync(marker)).toBe(false);
      expect(writeOut).toContain("write error");
      expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
      expect(readOut).toContain("read error");
      expect(readOut).not.toContain("local-only-content");
    });

    it(`${label}: local exec runs in the root without the runtime's API keys`, async () => {
      process.env.OPENAI_API_KEY = "sk-test-envscrub-000000000000";
      const harness = await makeHarness(HarnessClass, "local");

      const out = await tool(harness, "exec").execute({ command: "echo key=$OPENAI_API_KEY; pwd" });

      expect(out).not.toContain("sk-test-envscrub");
      expect(out).toContain("key=");
      expect(out.trim().split("\n")).toContain(root);
    });
  }
});
