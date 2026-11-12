import { createLogger } from "../../observability/logger.js";
import type {
  AutomatonTool,
  ChatMessage,
  InferenceToolCall,
  PolicyRequest,
  SpendTrackerInterface,
} from "../../types.js";
import type { TaskNode, TaskResult } from "../../orchestration/task-graph.js";
import { LoopDetector } from "../loop-detector.js";
import { createBuiltinTools } from "../tools.js";
import {
  InferenceDeferredError,
  TaskBudgetExceededError,
  TaskOwnershipLostError,
  type AgentHarness,
  type HarnessContext,
  type HarnessTool,
} from "../harness-types.js";
import { InferenceRefusedError } from "../../inference/errors.js";

const logger = createLogger("harness.base");
const MAX_CONSECUTIVE_INFERENCE_ERRORS = 3;
const DEFAULT_INFERENCE_RETRY_BACKOFF_MS: readonly number[] = [1000, 2000];
const MAX_TOOL_OUTPUT_LENGTH = 16_000;
/** A text-only reply is answered with this once; the next one ends the task as a failure. */
export const TEXT_ONLY_REPROMPT =
  "You replied without calling a tool. Call task_done to finish: success true if the task is done, " +
  "or success false with the reason if it cannot be done.";

export const NOOP_SPEND_TRACKER: SpendTrackerInterface = {
  recordSpend: () => {},
  getHourlySpend: () => 0,
  getDailySpend: () => 0,
  getTotalSpend: () => 0,
  checkLimit: () => ({
    allowed: true,
    currentHourlySpend: 0,
    currentDailySpend: 0,
    limitHourly: Number.MAX_SAFE_INTEGER,
    limitDaily: Number.MAX_SAFE_INTEGER,
  }),
  pruneOldRecords: () => 0,
};

/**
 * Builtin tools whose policy rules govern the harness-local tools of the
 * same purpose. Harness tools carry no category or risk level, and rules
 * match by builtin name, so the builtin definition is what policy sees.
 */
export type PolicyGuardedTool = "exec" | "write_file" | "read_file";

let builtinPolicyTools: Map<string, AutomatonTool> | undefined;

function getBuiltinPolicyTool(name: PolicyGuardedTool): AutomatonTool | undefined {
  if (!builtinPolicyTools) {
    // Only name, category and riskLevel are used; execute is never called.
    builtinPolicyTools = new Map(
      createBuiltinTools("policy-lookup").map((tool) => [tool.name, tool]),
    );
  }
  return builtinPolicyTools.get(name);
}

export abstract class BaseHarness implements AgentHarness {
  abstract readonly id: string;
  abstract readonly description: string;

  protected task!: TaskNode;
  protected context!: HarnessContext;
  protected loopDetector!: LoopDetector;
  protected messages: ChatMessage[] = [];
  protected artifacts: string[] = [];

  async initialize(task: TaskNode, context: HarnessContext): Promise<void> {
    this.task = task;
    this.context = context;
    this.loopDetector = new LoopDetector({
      maxIdenticalCalls: 3,
      maxIdleOnlyTurns: 3,
      windowSize: 10,
      exemptTools: this.loopExemptTools(),
    });
    this.messages = [
      { role: "system", content: this.buildSystemPrompt() },
      { role: "user", content: this.buildTaskPrompt() },
    ];
    this.artifacts = [];
  }

  abstract getToolDefs(): HarnessTool[];
  abstract buildSystemPrompt(): string;

  protected beforeTurn(): void {}

  /** Tools expected to repeat with the same arguments (blocking waits). */
  protected loopExemptTools(): string[] {
    return [];
  }

  /** Stop as soon as the task is no longer ours (cancelled, reassigned, completed by the parent). */
  protected assertTaskOwned(): void {
    const isOwned = this.context.isTaskOwned;
    if (isOwned && !isOwned()) {
      throw new TaskOwnershipLostError(`Task ${this.task.id} is no longer owned by this worker`);
    }
  }

  /** Count passed to policy as turnToolCallCount. */
  protected policyTurnToolCallCount(): number {
    return 0;
  }

  /**
   * Run a harness-local tool call through the PolicyEngine as the builtin
   * tool of the same purpose, with the worker's input source, and record
   * the decision. Returns null when the call may run, or a "Blocked:"
   * message. Without a policy engine or tool context the call is refused,
   * so a worker can never run a shell command or write a file unchecked.
   */
  protected authorizeLocalTool(
    builtinName: PolicyGuardedTool,
    args: Record<string, unknown>,
  ): string | null {
    const policyEngine = this.context.policyEngine;
    const toolContext = this.context.toolContext;
    const tool = getBuiltinPolicyTool(builtinName);
    if (!policyEngine || !toolContext || !tool) {
      return `Blocked: ${builtinName} requires a policy check and no policy engine is configured for this worker`;
    }

    const request: PolicyRequest = {
      tool,
      args,
      context: toolContext,
      turnContext: {
        inputSource: this.context.inputSource,
        turnToolCallCount: this.policyTurnToolCallCount(),
        sessionSpend: this.context.spendTracker ?? NOOP_SPEND_TRACKER,
      },
    };
    const decision = policyEngine.evaluate(request);
    policyEngine.logDecision(decision);
    if (decision.action !== "allow") {
      return `Blocked: policy denied ${builtinName} (${decision.reasonCode}): ${decision.humanMessage}`;
    }
    return null;
  }

  buildTaskPrompt(): string {
    const lines = [
      "# Task Assignment",
      "",
      `**Title:** ${this.task.title}`,
      `**Description:** ${this.task.description}`,
      `**Role:** ${this.task.agentRole ?? "generalist"}`,
      `**Task ID:** ${this.task.id}`,
      `**Goal ID:** ${this.task.goalId}`,
    ];

    if (this.task.dependencies.length > 0) {
      lines.push(`**Dependencies (completed):** ${this.task.dependencies.join(", ")}`);
    }

    const wisdom = this.context.wisdom;
    if (
      wisdom.conventions.length > 0 ||
      wisdom.failures.length > 0 ||
      wisdom.gotchas.length > 0 ||
      wisdom.successes.length > 0
    ) {
      lines.push("", "## Learnings from Previous Tasks");
      if (wisdom.conventions.length > 0) {
        lines.push("", "### Conventions");
        for (const item of wisdom.conventions) lines.push(`- ${item}`);
      }
      if (wisdom.failures.length > 0) {
        lines.push("", "### Known Failures (avoid these approaches)");
        for (const item of wisdom.failures) lines.push(`- ${item}`);
      }
      if (wisdom.gotchas.length > 0) {
        lines.push("", "### Gotchas");
        for (const item of wisdom.gotchas) lines.push(`- ${item}`);
      }
      if (wisdom.successes.length > 0) {
        lines.push("", "### What Worked");
        for (const item of wisdom.successes.slice(0, 5)) lines.push(`- ${item}`);
      }
    }

    lines.push("", "Complete this task and provide your results. Call task_done when finished.");
    return lines.join("\n");
  }

  async execute(): Promise<TaskResult> {
    this.context.budget.startedAt = Date.now();

    const tools = this.getToolDefs();
    const toolDefs = tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    let consecutiveInferenceErrors = 0;
    let finalOutput = "";
    let finalSuccess = true;
    let textOnlyReplies = 0;

    while (true) {
      this.checkBudget();

      if (this.context.abortSignal.aborted) {
        throw new Error("Harness execution aborted by abort signal");
      }
      this.assertTaskOwned();

      let response: { content: string; toolCalls?: InferenceToolCall[]; costCents?: number };
      try {
        response = await this.context.inference.chat({
          tier: "fast",
          purpose: "worker_turn",
          messages: this.messages,
          tools: toolDefs,
          toolChoice: "auto",
          signal: this.context.abortSignal,
        });
        consecutiveInferenceErrors = 0;
        this.recordInferenceCost(response.costCents);
      } catch (error) {
        // A budget refusal is not a provider failure: retrying now cannot help.
        if (error instanceof InferenceRefusedError) {
          if (error.code === "TASK_CAP") {
            throw new TaskBudgetExceededError(
              `Task "${this.task.title}" exhausted its inference budget: ${error.message}`,
            );
          }
          throw new InferenceDeferredError(
            `Inference refused (${error.code}): ${error.message}`,
            error.code,
            error.retryAfterMs,
          );
        }
        consecutiveInferenceErrors++;
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `[${this.id}] Inference error (${consecutiveInferenceErrors}/${MAX_CONSECUTIVE_INFERENCE_ERRORS}): ${message}`,
        );
        if (consecutiveInferenceErrors >= MAX_CONSECUTIVE_INFERENCE_ERRORS) {
          throw new Error(
            `${MAX_CONSECUTIVE_INFERENCE_ERRORS} consecutive inference failures. Last error: ${message}`,
          );
        }
        await this.backoffAfterInferenceError(consecutiveInferenceErrors);
        continue;
      }

      if (this.context.abortSignal.aborted) {
        throw new Error("Harness execution aborted by abort signal");
      }
      this.assertTaskOwned();
      this.beforeTurn();
      this.context.budget.turnsUsed++;
      logger.info(
        `[${this.id}] Turn ${this.context.budget.turnsUsed}/${this.context.budget.maxTurns} — task: ${this.task.title.slice(0, 60)}`,
      );

      if (response.toolCalls && response.toolCalls.length > 0) {
        textOnlyReplies = 0;
        this.messages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls,
        });

        let taskDone: { summary: string; success: boolean } | null = null;

        for (const toolCall of response.toolCalls) {
          const loopResult = this.loopDetector.recordToolCall(
            toolCall.function.name,
            toolCall.function.arguments,
          );
          if (loopResult.blocked) {
            logger.warn(`[${this.id}] Loop detected: ${loopResult.reason}`);
            this.messages.push({
              role: "tool",
              content:
                `LOOP DETECTED: ${loopResult.reason}\n\n` +
                "You MUST take a DIFFERENT action. If you cannot make progress, call task_done with a failure summary.",
              tool_call_id: toolCall.id,
            });
            continue;
          }

          const tool = tools.find((entry) => entry.name === toolCall.function.name);
          let output: string;

          if (!tool) {
            output = `Error: Unknown tool '${toolCall.function.name}'. Available tools: ${tools.map((entry) => entry.name).join(", ")}`;
            logger.warn(`[${this.id}] Unknown tool: ${toolCall.function.name}`);
          } else {
            try {
              const args = typeof toolCall.function.arguments === "string"
                ? JSON.parse(toolCall.function.arguments)
                : toolCall.function.arguments;
              output = await tool.execute(args as Record<string, unknown>);
              if (output.length > MAX_TOOL_OUTPUT_LENGTH) {
                output = output.slice(0, MAX_TOOL_OUTPUT_LENGTH) +
                  `\n[TRUNCATED: ${output.length - MAX_TOOL_OUTPUT_LENGTH} chars omitted]`;
              }
              logger.info(`[${this.id}] ${tool.name} → ${output.slice(0, 120)}`);

              if (tool.name === "write_file" || tool.name === "patch_file") {
                try {
                  const parsedArgs = typeof toolCall.function.arguments === "string"
                    ? JSON.parse(toolCall.function.arguments)
                    : toolCall.function.arguments;
                  if (typeof parsedArgs.path === "string") {
                    this.artifacts.push(parsedArgs.path);
                  }
                } catch {
                  // ignore artifact tracking parse errors
                }
              }

              if (tool.name === "task_done") {
                const parsedArgs = typeof toolCall.function.arguments === "string"
                  ? JSON.parse(toolCall.function.arguments)
                  : toolCall.function.arguments;
                taskDone = {
                  summary: typeof parsedArgs.summary === "string" ? parsedArgs.summary : output,
                  success: parsedArgs.success !== false,
                };
              }
            } catch (error) {
              output = `Error executing ${toolCall.function.name}: ${error instanceof Error ? error.message : String(error)}`;
              logger.error(`[${this.id}] Tool error: ${output}`);
            }
          }

          this.messages.push({
            role: "tool",
            content: output,
            tool_call_id: toolCall.id,
          });
        }

        const turnCheck = this.loopDetector.endTurn();
        if (turnCheck.reason) {
          if (turnCheck.blocked) {
            throw new Error(`Unrecoverable loop detected: ${turnCheck.reason}`);
          }
          this.messages.push({
            role: "system",
            content: turnCheck.reason,
          });
        }

        if (taskDone) {
          finalOutput = taskDone.summary;
          finalSuccess = taskDone.success;
          break;
        }

        continue;
      }

      // Prose is not a result: ask once for task_done, then give up as a failure.
      textOnlyReplies++;
      logger.info(
        `[${this.id}] Text-only response ${textOnlyReplies} on turn ${this.context.budget.turnsUsed}: ${(response.content || "").slice(0, 200)}`,
      );
      if (textOnlyReplies >= 2) {
        finalOutput = `Worker ended without calling task_done: ${response.content || "(empty reply)"}`;
        finalSuccess = false;
        break;
      }
      this.messages.push({ role: "assistant", content: response.content || "" });
      this.messages.push({ role: "system", content: TEXT_ONLY_REPROMPT });
    }

    return {
      success: finalSuccess,
      output: finalOutput,
      artifacts: [...new Set(this.artifacts)],
      costCents: this.context.budget.costUsedCents,
      duration: Date.now() - this.context.budget.startedAt,
    };
  }

  /** Adds a call's committed cost; also used by subclasses that call inference directly. */
  protected recordInferenceCost(costCents: number | undefined): void {
    if (typeof costCents === "number" && Number.isFinite(costCents) && costCents > 0) {
      this.context.budget.costUsedCents += costCents;
    }
  }

  private async backoffAfterInferenceError(consecutiveErrors: number): Promise<void> {
    const schedule = this.context.inferenceRetryBackoffMs ?? DEFAULT_INFERENCE_RETRY_BACKOFF_MS;
    if (schedule.length === 0) return;
    const delayMs = schedule[Math.min(consecutiveErrors - 1, schedule.length - 1)];
    if (!(delayMs > 0)) return;
    const signal = this.context.abortSignal;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private checkBudget(): void {
    const budget = this.context.budget;

    if (budget.turnsUsed >= budget.maxTurns) {
      throw new Error(
        `Budget exhausted: reached max turns (${budget.turnsUsed}/${budget.maxTurns}). ` +
        `Task "${this.task.title}" did not complete within the turn budget.`,
      );
    }

    if (budget.costUsedCents >= budget.maxCostCents) {
      throw new TaskBudgetExceededError(
        `Budget exhausted: cost limit reached ($${(budget.costUsedCents / 100).toFixed(2)} / $${(budget.maxCostCents / 100).toFixed(2)}). ` +
        `Task "${this.task.title}" exceeded its cost budget.`,
      );
    }

    if (budget.startedAt > 0) {
      const elapsed = Date.now() - budget.startedAt;
      if (elapsed >= budget.timeoutMs) {
        throw new Error(
          `Budget exhausted: timeout (${Math.round(elapsed / 1000)}s / ${Math.round(budget.timeoutMs / 1000)}s). ` +
          `Task "${this.task.title}" exceeded its time budget.`,
        );
      }
    }
  }
}
