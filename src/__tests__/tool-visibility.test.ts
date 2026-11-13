/**
 * Tools and heartbeat tasks that cannot work in a mode are hidden, through
 * one feature table: the tool lists per feature set, that every listed name
 * is a real built-in, that installed tools cannot bring a hidden name back,
 * that the worker catalog is the filtered list, and that a filtered
 * heartbeat task does not run (scheduled or forced).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { INBOX_ALLOWED_TOOLS } from "../agent/inbox-isolation.js";
import { runAgentLoop, getSharedWorkerPool, shutdownWorkerPools } from "../agent/loop.js";
import { createHeartbeatDaemon } from "../heartbeat/daemon.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import {
  ALL_FEATURES,
  TASK_FEATURES,
  TOOL_FEATURES,
  standaloneFeatures,
  taskAllowed,
  visibleTools,
} from "../providers/features.js";
import { resolveRuntime } from "../providers/mode.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const builtinNames = () => createBuiltinTools("").map((t) => t.name);
const names = (f: ReturnType<typeof standaloneFeatures>) => visibleTools(createBuiltinTools(""), f).map((t) => t.name);

const STANDALONE_DEFAULT = [
  "exec", "write_file", "read_file", "expose_port", "remove_port", "edit_own_file", "revert_last_edit",
  "reset_to_upstream", "install_npm_package", "review_upstream_changes", "pull_upstream", "modify_heartbeat",
  "sleep", "system_synopsis", "enter_low_compute", "update_genesis_prompt", "install_mcp_server", "install_skill",
  "list_skills", "create_skill", "remove_skill", "git_status", "git_diff", "git_commit", "git_log", "git_push",
  "git_branch", "git_clone", "update_agent_card", "check_reputation", "list_models",
  "switch_model", "check_inference_spending", "update_soul", "reflect_on_soul", "view_soul", "view_soul_history",
  "remember_fact", "recall_facts", "set_goal", "complete_goal", "save_procedure", "recall_procedure",
  "note_about_agent", "review_memory", "forget", "create_goal", "list_goals", "cancel_goal", "get_plan",
  "complete_task", "orchestrator_status",
];

describe("tool lists per feature set", () => {
  it("Conway mode offers every built-in, exactly as before", () => {
    expect(names(resolveRuntime(createTestConfig()).features)).toEqual(builtinNames());
    expect(names({ ...ALL_FEATURES })).toEqual(builtinNames());
  });

  it("standalone default", () => {
    const f = resolveRuntime(createTestConfig({ conwayApiKey: "", socialRelayUrl: "", openaiApiKey: "sk" })).features;
    expect(names(f)).toEqual(STANDALONE_DEFAULT);
    // Every gated tool is hidden except the goal tools, which need only a planner-capable provider.
    const gated = Object.keys(TOOL_FEATURES).filter((n) => TOOL_FEATURES[n].join() !== "orchestration");
    expect(names(f)).toHaveLength(builtinNames().length - gated.length);
  });

  it("standalone with orchestration off also hides the goal tools", () => {
    const f = standaloneFeatures({ relay: false, payments: false, orchestration: false });
    expect(STANDALONE_DEFAULT.filter((n) => !names(f).includes(n)).sort()).toEqual(
      ["cancel_goal", "complete_task", "create_goal", "get_plan", "list_goals", "orchestrator_status"],
    );
  });

  it("standalone with the relay adds send_message only (children stay hidden)", () => {
    const f = standaloneFeatures({ relay: true, payments: false });
    expect(names(f).filter((n) => !STANDALONE_DEFAULT.includes(n))).toEqual(["send_message"]);
  });

  it("standalone with payments adds the x402 and on-chain identity tools (no topups)", () => {
    const f = standaloneFeatures({ relay: false, payments: true });
    expect(names(f).filter((n) => !STANDALONE_DEFAULT.includes(n)).sort()).toEqual(
      ["check_usdc_balance", "discover_agents", "give_feedback", "register_erc8004", "x402_fetch"],
    );
  });

  it("standalone defaults offer no tool that reads the Base or Solana chain", () => {
    const f = resolveRuntime(createTestConfig({ conwayApiKey: "", socialRelayUrl: "", openaiApiKey: "sk" })).features;
    const chainTools = [
      "discover_agents", "register_erc8004", "give_feedback", "x402_fetch", "check_usdc_balance", "topup_credits",
    ];
    for (const name of chainTools) expect(names(f), name).not.toContain(name);
    expect(names({ ...ALL_FEATURES })).toContain("discover_agents");
  });

  it("every name in the feature table is a real built-in tool", () => {
    const all = new Set(builtinNames());
    for (const name of Object.keys(TOOL_FEATURES)) expect(all.has(name), name).toBe(true);
  });

  it("an installed tool cannot reuse a hidden name", () => {
    const installed = [{ name: "send_message" }, { name: "transfer_credits" }, { name: "my_tool" }];
    expect(visibleTools(installed, standaloneFeatures({ relay: false, payments: false })).map((t) => t.name)).toEqual([
      "my_tool",
    ]);
  });

  it("inbox turns get no tool when send_message is hidden", () => {
    const tools = visibleTools(createBuiltinTools(""), standaloneFeatures({ relay: false, payments: false }));
    expect(tools.filter((t) => INBOX_ALLOWED_TOOLS.includes(t.name))).toEqual([]);
  });
});

describe("heartbeat tasks per feature set", () => {
  it("every task in the table exists, and the standalone default skips exactly those", () => {
    const f = standaloneFeatures({ relay: false, payments: false });
    for (const task of Object.keys(TASK_FEATURES)) {
      expect(BUILTIN_TASKS[task], task).toBeTypeOf("function");
      expect(taskAllowed(task, f), task).toBe(false);
      expect(taskAllowed(task, ALL_FEATURES), task).toBe(true);
    }
    for (const task of ["heartbeat_ping", "check_for_updates", "soul_reflection", "health_check", "report_metrics"]) {
      expect(taskAllowed(task, f), task).toBe(true);
    }
    expect(taskAllowed("check_social_inbox", standaloneFeatures({ relay: true, payments: false }))).toBe(true);
  });

  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  const history = (task: string) =>
    db.raw.prepare("SELECT COUNT(*) AS n FROM heartbeat_history WHERE task_name = ?").get(task) as { n: number };

  function daemonFor(config: ReturnType<typeof createTestConfig>) {
    return createHeartbeatDaemon({
      identity: createTestIdentity(),
      config,
      heartbeatConfig: {
        entries: [
          { name: "check_credits", schedule: "*/5 * * * *", task: "check_credits", enabled: true },
          { name: "credits_alias", schedule: "*/5 * * * *", task: "check_credits", enabled: true },
        ],
        defaultIntervalMs: 60_000,
        lowComputeMultiplier: 4,
      },
      db,
      rawDb: db.raw,
      conway: new MockConwayClient(),
    });
  }

  it("forceRun of a filtered task does nothing in standalone; it runs in Conway mode", async () => {
    await daemonFor(createTestConfig({ conwayApiKey: "", socialRelayUrl: "", openaiApiKey: "sk" })).forceRun("check_credits");
    expect(history("check_credits").n).toBe(0);
    await daemonFor(createTestConfig()).forceRun("check_credits");
    expect(history("check_credits").n).toBe(1);
  });
});

describe("the worker catalog is the filtered list", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(async () => {
    await shutdownWorkerPools(1_000);
    db.close();
  });

  it("standalone workers see the same tools as the model", async () => {
    const inference = new MockInferenceClient([noToolResponse("done")]);
    const config = createTestConfig({ conwayApiKey: "", sandboxId: "", socialRelayUrl: "", openaiApiKey: "sk" });
    await runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" },
      config,
      db,
      conway: new MockConwayClient(),
      inference,
      shouldStop: () => inference.calls.length >= 1,
    });
    const pool = getSharedWorkerPool(db);
    expect(pool).toBeDefined();
    const catalog = ((pool as any).config.tools as { name: string }[]).map((t) => t.name);
    expect(catalog).toEqual(STANDALONE_DEFAULT);
    const offered = (inference.calls[0].options?.tools ?? []).map((t: any) => t.function.name);
    expect(offered).toEqual(STANDALONE_DEFAULT);
  });
});
