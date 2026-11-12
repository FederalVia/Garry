import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneralHarness } from "../../agent/harnesses/general-harness.js";
import type { HarnessContext } from "../../agent/harness-types.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import type { AutomatonDatabase, ConwayClient } from "../../types.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";

function createConwayStub(overrides?: Partial<ConwayClient>): ConwayClient {
  return {
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    writeFile: async () => undefined,
    readFile: async () => "",
    exposePort: async () => ({ port: 0, publicUrl: "", sandboxId: "" }),
    removePort: async () => undefined,
    createSandbox: async () => ({ id: "", status: "", region: "", vcpu: 0, memoryMb: 0, diskGb: 0, createdAt: "" }),
    deleteSandbox: async () => undefined,
    listSandboxes: async () => [],
    getCreditsBalance: async () => 0,
    getCreditsPricing: async () => [],
    transferCredits: async () => ({ id: "", fromAddress: "", toAddress: "", amountCents: 0, status: "completed", timestamp: "" }),
    registerAutomaton: async () => ({ automaton: {} }),
    searchDomains: async () => [],
    registerDomain: async () => ({ domain: "", status: "pending", registrationDate: "", expirationDate: "", nameservers: [] }),
    listDnsRecords: async () => [],
    addDnsRecord: async () => ({ id: "", type: "A", host: "", value: "", ttl: 300 }),
    deleteDnsRecord: async () => undefined,
    listModels: async () => [],
    createScopedClient: () => createConwayStub(),
    ...overrides,
  } as ConwayClient;
}

describe("agent/general-harness security", () => {
  let db: AutomatonDatabase;
  let testRoot: string;

  beforeEach(() => {
    db = createTestDb();
    testRoot = mkdtempSync(path.join(os.tmpdir(), "general-harness-"));
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  async function createHarness(conway: ConwayClient, mode: "local" | "remote") {
    const harness = new GeneralHarness();
    const workspace = new AgentWorkspace("goal-test", path.join(testRoot, "workspace"));
    const identity = createTestIdentity();
    // Local mode (no sandbox) is where the harness touches the host filesystem.
    const config = mode === "local" ? createTestConfig({ sandboxId: "" }) : createTestConfig();
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot: testRoot,
      workspace,
      identity,
      config,
      db: db.raw,
      conway,
      inference: { chat: async () => ({ content: "done" }) },
      budget: {
        maxTurns: 5,
        maxCostCents: 50,
        timeoutMs: 5_000,
        turnsUsed: 0,
        costUsedCents: 0,
        startedAt: 0,
      },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-test",
      toolContext: { identity, config, db, conway, inference: {} as any },
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()),
    };

    await harness.initialize(
      {
        id: "task-1",
        parentId: null,
        goalId: "goal-test",
        title: "Read and write files safely",
        description: "Use file tools safely",
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
      },
      context,
    );

    return harness;
  }

  async function runTool(
    conway: ConwayClient,
    toolName: string,
    args: Record<string, unknown>,
    mode: "local" | "remote" = "remote",
  ): Promise<string> {
    const harness = await createHarness(conway, mode);
    const tool = harness.getToolDefs().find((entry) => entry.name === toolName);
    if (!tool) throw new Error(`missing tool: ${toolName}`);
    return tool.execute(args);
  }

  it("blocks sensitive file reads (wallet.json)", async () => {
    const out = await runTool(createConwayStub(), "read_file", { path: "wallet.json" });
    expect(out).toContain("Blocked:");
    expect(out).toContain("SENSITIVE_FILE_READ");
  });

  it("blocks traversal reads outside the allowed edit root", async () => {
    const out = await runTool(createConwayStub(), "read_file", { path: "../../etc/passwd" });
    expect(out).toContain("Blocked: path");
    expect(out).toContain("outside workspace");
  });

  it("blocks absolute-path reads outside the allowed edit root", async () => {
    const out = await runTool(createConwayStub(), "read_file", { path: "/etc/passwd" });
    expect(out).toContain("Blocked: path");
  });

  it("blocks writes outside the allowed edit root", async () => {
    const out = await runTool(createConwayStub(), "write_file", {
      path: "../../tmp/pwned.txt",
      content: "x",
    });
    expect(out).toContain("Blocked: path");
  });

  it("blocks writes to protected files", async () => {
    const out = await runTool(createConwayStub(), "write_file", {
      path: "constitution.md",
      content: "tamper",
    });
    expect(out).toContain("Blocked:");
    expect(out).toContain("PROTECTED_FILE");
  });

  it("blocks forbidden shell commands", async () => {
    const out = await runTool(createConwayStub(), "exec", {
      command: "cat ~/.automaton/wallet.json",
    });
    expect(out).toContain("Blocked:");
    expect(out).toContain("FORBIDDEN_COMMAND");
  });

  it("allows normal read_file paths inside the allowed edit root in local mode", async () => {
    const filePath = path.join(testRoot, "notes.txt");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "hello", "utf8");

    const out = await runTool(createConwayStub(), "read_file", { path: filePath }, "local");
    expect(out).toBe("hello");
  });

  it("allows normal write_file paths inside the allowed edit root in local mode", async () => {
    const filePath = path.join(testRoot, "out", "data.txt");

    const out = await runTool(createConwayStub(), "write_file", { path: filePath, content: "ok" }, "local");
    expect(out).toContain("Wrote 2 bytes");
    expect(readFileSync(filePath, "utf8")).toBe("ok");
  });

  it("in remote mode, a failing sandbox gives an error and nothing is read or written on the host", async () => {
    const existing = path.join(testRoot, "notes.txt");
    writeFileSync(existing, "host-only", "utf8");
    const fresh = path.join(testRoot, "out", "data.txt");
    const conway = createConwayStub({
      readFile: async () => {
        throw new Error("sandbox unavailable");
      },
      writeFile: async () => {
        throw new Error("sandbox unavailable");
      },
    });

    const readOut = await runTool(conway, "read_file", { path: existing });
    const writeOut = await runTool(conway, "write_file", { path: fresh, content: "ok" });

    expect(readOut).toContain("read error");
    expect(readOut).not.toContain("host-only");
    expect(writeOut).toContain("write error");
    expect(existsSync(fresh)).toBe(false);
  });
});
