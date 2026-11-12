/**
 * start_child must check the process it started. A `pgrep -f 'index.js --run'`
 * inside `sh -c` matches the checking shell's own command line, so it
 * always said "running".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { ChildLifecycle } from "../replication/lifecycle.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase, ConwayClient, ExecResult, ToolContext } from "../types.js";

let db: AutomatonDatabase;

class ChildSandbox extends MockConwayClient {
  constructor(private readonly answer: (command: string) => ExecResult) {
    super();
  }
  async exec(command: string, timeout?: number): Promise<ExecResult> {
    this.execCalls.push({ command, timeout });
    return this.answer(command);
  }
}

function fundedChild(): string {
  const lifecycle = new ChildLifecycle(db.raw);
  lifecycle.initChild("child-1", "kid", "sbx-child", "genesis");
  for (const s of ["sandbox_created", "runtime_ready", "wallet_verified", "funded"] as const) {
    lifecycle.transition("child-1", s);
  }
  return "child-1";
}

async function startWith(child: ChildSandbox): Promise<string> {
  const parent = new MockConwayClient();
  parent.createScopedClient = (_id: string): ConwayClient => child;
  const ctx = {
    identity: createTestIdentity(),
    config: createTestConfig(),
    db,
    conway: parent,
    inference: new MockInferenceClient(),
  } as ToolContext;
  const tool = createBuiltinTools("test-sandbox").find((t) => t.name === "start_child")!;
  return tool.execute({ child_id: fundedChild() }, ctx);
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => db.close());

describe("start_child liveness", () => {
  it("checks the launched pid and fails when it is gone", async () => {
    const child = new ChildSandbox((cmd) =>
      cmd.includes("nohup")
        ? { stdout: "4242\n", stderr: "", exitCode: 0 }
        : { stdout: "stopped\n", stderr: "", exitCode: 0 },
    );
    const out = await startWith(child);

    const check = child.execCalls[1].command;
    expect(check).toContain("kill -0 4242");
    expect(check).not.toMatch(/pgrep -f 'index\.js/);
    expect(out).toContain("failed to start");
    expect(new ChildLifecycle(db.raw).getCurrentState("child-1")).toBe("failed");
  });

  it("reports healthy when the launched pid is alive", async () => {
    const child = new ChildSandbox((cmd) =>
      cmd.includes("nohup")
        ? { stdout: "4242\n", stderr: "", exitCode: 0 }
        : { stdout: cmd.includes("kill -0 4242") ? "running\n" : "stopped\n", stderr: "", exitCode: 0 },
    );
    expect(await startWith(child)).toContain("started and healthy");
    expect(new ChildLifecycle(db.raw).getCurrentState("child-1")).toBe("healthy");
  });

  it("falls back to a self-excluding pgrep when no pid came back", async () => {
    const child = new ChildSandbox(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    await startWith(child);
    const check = child.execCalls[1].command;
    expect(check).toContain("pgrep -f '[i]ndex.js --run'");
  });
});
