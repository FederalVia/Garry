import type { AgentHarness } from "./harness-types.js";
import { CodingHarness } from "./harnesses/coding-harness.js";
import { GeneralHarness, RestrictedGeneralHarness } from "./harnesses/general-harness.js";
import { OrchestratorHarness } from "./harnesses/orchestrator-harness.js";

type HarnessConstructor = new () => AgentHarness;

const DEFAULT_ROLE_MAP: Record<string, HarnessConstructor> = {
  executor: CodingHarness,
  debugger: CodingHarness,
  architect: CodingHarness,
  "code-reviewer": CodingHarness,
  tester: CodingHarness,
  devops: CodingHarness,
  developer: CodingHarness,
  engineer: CodingHarness,

  // Review roles do the review themselves instead of decomposing it.
  critic: CodingHarness,
  reviewer: CodingHarness,

  orchestrator: OrchestratorHarness,
  planner: OrchestratorHarness,
  coordinator: OrchestratorHarness,

  generalist: GeneralHarness,
  researcher: GeneralHarness,
  marketer: GeneralHarness,
  "social-manager": GeneralHarness,
  "domain-manager": GeneralHarness,
  "financial-analyst": GeneralHarness,
  writer: GeneralHarness,
  analyst: GeneralHarness,
};

/**
 * Deepest task that may run the orchestrator harness. Top-level tasks
 * (depth 0) may decompose once; the tasks they delegate run a plain harness.
 */
export const MAX_ORCHESTRATOR_TASK_DEPTH = 0;

export interface CreateHarnessOptions {
  /** Ancestors of the task along parent_id (0 for a top-level task). */
  depth?: number;
}

export class HarnessRegistry {
  private readonly roleMap: Map<string, HarnessConstructor>;
  private fallback: HarnessConstructor;

  constructor() {
    this.roleMap = new Map(Object.entries(DEFAULT_ROLE_MAP));
    // Unknown (custom) roles get no financial tools.
    this.fallback = RestrictedGeneralHarness;
  }

  register(role: string, constructor: HarnessConstructor): void {
    this.roleMap.set(role.toLowerCase().trim(), constructor);
  }

  setFallback(constructor: HarnessConstructor): void {
    this.fallback = constructor;
  }

  createForRole(role: string | null | undefined, options: CreateHarnessOptions = {}): AgentHarness {
    const normalized = (role ?? "generalist").toLowerCase().trim();
    const Constructor = this.roleMap.get(normalized) ?? this.fallback;
    // A task delegated by a sub-orchestrator must not decompose again.
    if (Constructor === OrchestratorHarness && (options.depth ?? 0) > MAX_ORCHESTRATOR_TASK_DEPTH) {
      return new GeneralHarness();
    }
    return new Constructor();
  }

  getHarnessIdForRole(role: string | null | undefined): string {
    return this.createForRole(role).id;
  }

  listMappings(): Array<{ role: string; harnessId: string }> {
    const mappings: Array<{ role: string; harnessId: string }> = [];
    for (const [role, Constructor] of this.roleMap) {
      mappings.push({ role, harnessId: new Constructor().id });
    }
    return mappings;
  }
}
