import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodingHarness } from "../../agent/harnesses/coding-harness.js";
import type { HarnessContext } from "../../agent/harness-types.js";
import type { TaskResult } from "../../orchestration/task-graph.js";
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

describe("agent/CodingHarness confinement", () => {
  let db: AutomatonDatabase;
  let testRoot: string;

  beforeEach(() => {
    db = createTestDb();
    testRoot = mkdtempSync(path.join(os.tmpdir(), "coding-harness-"));
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  async function createHarness(conway: ConwayClient, mode: "local" | "remote" = "remote") {
    const harness = new CodingHarness();
    const workspace = new AgentWorkspace("goal-coding", path.join(testRoot, "workspace"));
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
      goalId: "goal-coding",
      toolContext: { identity, config, db, conway, inference: {} as any },
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()),
    };

    await harness.initialize(
      {
        id: "task-coding-1",
        parentId: null,
        goalId: "goal-coding",
        title: "Apply a scoped code edit",
        description: "Only edit files inside the allowed edit root",
        status: "assigned",
        assignedTo: "local://worker",
        agentRole: "executor",
        priority: 50,
        dependencies: [],
        result: null as TaskResult | null,
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

  it("blocks patch_file traversal outside the allowed edit root", async () => {
    const outsideFile = path.join(testRoot, "..", "outside.ts");
    const out = await runTool(createConwayStub(), "patch_file", {
      path: outsideFile,
      search: "before",
      replace: "after",
    });

    expect(out).toContain("Blocked: path");
    expect(out).toContain("outside workspace");
  });

  it("blocks list_dir traversal outside the allowed edit root", async () => {
    const out = await runTool(createConwayStub(), "list_dir", { path: "../../etc" });
    expect(out).toContain("Blocked: path");
    expect(out).toContain("outside workspace");
  });

  it("allows patch_file inside the allowed edit root in local mode", async () => {
    const filePath = path.join(testRoot, "src", "example.ts");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "const value = 'before';\n", "utf8");

    const out = await runTool(createConwayStub(), "patch_file", {
      path: filePath,
      search: "'before'",
      replace: "'after'",
    }, "local");

    expect(out).toContain("Patched");
    expect(readFileSync(filePath, "utf8")).toContain("'after'");
  });

  it("in remote mode, a failing sandbox gives a patch error and never falls back to the host", async () => {
    const filePath = path.join(testRoot, "src", "example.ts");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "const value = 'before';\n", "utf8");

    const conway = createConwayStub({
      readFile: async () => {
        throw new Error("sandbox unavailable");
      },
      writeFile: async () => {
        throw new Error("sandbox unavailable");
      },
    });

    const out = await runTool(conway, "patch_file", {
      path: filePath,
      search: "'before'",
      replace: "'after'",
    });

    expect(out).toContain("patch error");
    expect(readFileSync(filePath, "utf8")).toContain("'before'");
  });
});
