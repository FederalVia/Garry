import { describe, expect, it } from "vitest";
import type { TaskResult } from "../../orchestration/task-graph.js";
import type { AgentHarness, HarnessContext, HarnessTool } from "../../agent/harness-types.js";
import { HarnessRegistry } from "../../agent/harness-registry.js";
import { GeneralHarness, RestrictedGeneralHarness } from "../../agent/harnesses/general-harness.js";

class DummyHarness implements AgentHarness {
  readonly id = "dummy";
  readonly description = "dummy";
  async initialize(): Promise<void> {}
  async execute(): Promise<TaskResult> {
    return { success: true, output: "ok", artifacts: [], costCents: 0, duration: 0 };
  }
  getToolDefs(): HarnessTool[] {
    return [];
  }
  buildSystemPrompt(): string {
    return "";
  }
  buildTaskPrompt(): string {
    return "";
  }
}

describe("agent/HarnessRegistry", () => {
  it("maps executor to coding and orchestrator to orchestrator harness", () => {
    const registry = new HarnessRegistry();
    expect(registry.getHarnessIdForRole("executor")).toBe("coding");
    expect(registry.getHarnessIdForRole("orchestrator")).toBe("orchestrator");
  });

  it("falls back to the general harness for unknown roles", () => {
    const registry = new HarnessRegistry();
    expect(registry.getHarnessIdForRole("unknown-role")).toBe("general");
    expect(registry.getHarnessIdForRole(null)).toBe("general");
  });

  it("treats role lookups as case-insensitive", () => {
    const registry = new HarnessRegistry();
    expect(registry.getHarnessIdForRole("ExEcUtOr")).toBe("coding");
  });

  it("allows custom registrations to override defaults", () => {
    const registry = new HarnessRegistry();
    registry.register("executor", DummyHarness);
    expect(registry.getHarnessIdForRole("executor")).toBe("dummy");
  });

  it("lists mappings with harness ids", () => {
    const registry = new HarnessRegistry();
    const mappings = registry.listMappings();
    expect(mappings.some((mapping) => mapping.role === "generalist" && mapping.harnessId === "general")).toBe(true);
    expect(mappings.some((mapping) => mapping.role === "executor" && mapping.harnessId === "coding")).toBe(true);
  });

  it("F063: review roles get the coding harness instead of decomposing", () => {
    const registry = new HarnessRegistry();
    expect(registry.getHarnessIdForRole("critic")).toBe("coding");
    expect(registry.getHarnessIdForRole("reviewer")).toBe("coding");
    expect(registry.getHarnessIdForRole("planner")).toBe("orchestrator");
    expect(registry.getHarnessIdForRole("coordinator")).toBe("orchestrator");
  });

  it("F063: a task delegated by a sub-orchestrator does not get the orchestrator harness", () => {
    const registry = new HarnessRegistry();
    expect(registry.createForRole("orchestrator", { depth: 0 }).id).toBe("orchestrator");
    for (const role of ["orchestrator", "planner", "coordinator"]) {
      const harness = registry.createForRole(role, { depth: 1 });
      expect(harness.id).toBe("general");
      expect(harness).toBeInstanceOf(GeneralHarness);
    }
  });

  it("F063: unknown roles get the restricted harness", () => {
    const registry = new HarnessRegistry();
    expect(registry.createForRole("seo-auditor")).toBeInstanceOf(RestrictedGeneralHarness);
    expect(registry.createForRole("generalist")).not.toBeInstanceOf(RestrictedGeneralHarness);
  });
});
