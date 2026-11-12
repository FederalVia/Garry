import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AutomatonTool } from "../../types.js";
import { isProtectedFile } from "../../self-mod/code.js";
import { BaseHarness, NOOP_SPEND_TRACKER } from "./base-harness.js";
import type { HarnessTool } from "../harness-types.js";
import { sanitizeToolResult } from "../injection-defense.js";
import { executeTool } from "../tools.js";
import { getForbiddenCommandMatch, isForbiddenCommand } from "../policy-rules/command-safety.js";
import { isSensitiveFile } from "../policy-rules/path-protection.js";
import { CREDIT_TRANSFER_TOOLS } from "../policy-rules/financial.js";

const MAX_EXEC_TIMEOUT_MS = 30_000;
const MAX_READ_SIZE = 10_000;
const MAX_EXEC_OUTPUT = 16_000;
const GENERAL_WRAPPED_TOOL_ALLOWLIST = new Set([
  "expose_port",
  "remove_port",
  "check_credits",
  "check_usdc_balance",
  "transfer_credits",
  "send_message",
  "list_models",
  "switch_model",
  "check_inference_spending",
  "discover_agents",
  "check_reputation",
  "search_domains",
  "register_domain",
  "manage_dns",
  "list_skills",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_clone",
  "remember_fact",
  "recall_facts",
  "save_procedure",
  "recall_procedure",
  "note_about_agent",
  "review_memory",
  "forget",
  "x402_fetch",
]);
// Every credit transfer tool counts toward the per-turn transfer limit.
const CREDIT_TRANSFER_NAMES: ReadonlySet<string> = new Set(CREDIT_TRANSFER_TOOLS);
const GENERAL_SPEC_ALIAS_TARGETS = {
  web_fetch: "x402_fetch",
} as const;

export class GeneralHarness extends BaseHarness {
  readonly id = "general";
  readonly description = "General-purpose agent for research, web interaction, and non-coding execution tasks.";
  private transferToolCallCount = 0;

  buildSystemPrompt(): string {
    const role = this.task.agentRole ?? "generalist";
    return `You are a worker agent with the role: ${role}.

You have been assigned a specific task by the orchestrator. Your singular objective
is to complete this task efficiently and report your results.

## Rules

1. Focus ONLY on the assigned task. Do not deviate or explore unrelated topics.
2. Use the tools available to you to accomplish the task.
3. When done, call the task_done tool with a clear summary of what you accomplished.
4. If you cannot complete the task, call task_done with an explanation of why.
5. Do NOT call tools after calling task_done.
6. Be efficient. Minimize unnecessary tool calls. Every tool call costs money.
7. You have a limited turn budget. Do not waste turns on status checks.
8. NEVER check your own balance or credits. That is not your job.
9. NEVER call check_credits, check_usdc_balance, or system_synopsis unless
the task specifically requires financial information.

## Anti-Loop Rules

- If you receive a LOOP DETECTED warning, you MUST immediately change your approach.
- If you find yourself calling the same tool repeatedly, STOP and reconsider.
- If you are stuck, call task_done with a failure explanation rather than looping.

## Output Format

When calling task_done, provide:
- A concise summary of what was accomplished
- Any file paths created or modified (these become task artifacts)
- Any important findings or data discovered`;
  }

  protected override beforeTurn(): void {
    this.transferToolCallCount = 0;
  }

  protected override policyTurnToolCallCount(): number {
    return this.transferToolCallCount;
  }

  getToolDefs(): HarnessTool[] {
    const customTools: HarnessTool[] = [
      {
        name: "exec",
        description: "Execute a shell command. Use for installing packages, running scripts, making HTTP requests with curl, etc.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to execute" },
            timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 30000, max: 30000)" },
          },
          required: ["command"],
        },
        execute: async (args) => {
          const command = args.command as string;
          const timeoutMs = Math.min(
            typeof args.timeout_ms === "number" ? args.timeout_ms : MAX_EXEC_TIMEOUT_MS,
            MAX_EXEC_TIMEOUT_MS,
          );
          const denied = this.authorizeLocalTool("exec", { command, timeout: timeoutMs });
          if (denied) {
            return denied;
          }
          const forbidden = getForbiddenCommandMatch(command);
          if (forbidden || isForbiddenCommand(command)) {
            return `Blocked: ${forbidden?.description ?? "Forbidden command pattern detected"}`;
          }
          try {
            const result = await this.context.conway.exec(command, timeoutMs);
            return formatExecResult(result.stdout ?? "", result.stderr ?? "");
          } catch {
            return localExec(command, timeoutMs);
          }
        },
      },
      {
        name: "write_file",
        description: "Write content to a file. Creates parent directories if needed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to write to" },
            content: { type: "string", description: "File content to write" },
          },
          required: ["path", "content"],
        },
        execute: async (args) => {
          const filePath = args.path as string;
          const content = args.content as string;
          const confined = confineToWorkspace(filePath, this.context.allowedEditRoot);
          if (typeof confined !== "string") {
            return confined.error;
          }
          const denied = this.authorizeLocalTool("write_file", { path: confined, content });
          if (denied) {
            return denied;
          }
          if (isProtectedFile(confined)) {
            return `Blocked: cannot write to protected file "${filePath}"`;
          }
          try {
            await this.context.conway.writeFile(confined, content);
            return `Wrote ${content.length} bytes to ${confined}`;
          } catch {
            try {
              await fs.mkdir(path.dirname(confined), { recursive: true });
              await fs.writeFile(confined, content, "utf8");
              return `Wrote ${content.length} bytes to ${confined} (local)`;
            } catch (error) {
              return `write error: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        },
      },
      {
        name: "read_file",
        description: "Read the contents of a file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to read" },
          },
          required: ["path"],
        },
        execute: async (args) => {
          const filePath = args.path as string;
          const confined = confineToWorkspace(filePath, this.context.allowedEditRoot);
          if (typeof confined !== "string") {
            return confined.error;
          }
          const denied = this.authorizeLocalTool("read_file", { path: confined });
          if (denied) {
            return denied;
          }
          if (isSensitiveFile(filePath)) {
            return `Blocked: cannot read sensitive file "${filePath}"`;
          }
          try {
            const content = await this.context.conway.readFile(confined);
            return content.slice(0, MAX_READ_SIZE) || "(empty file)";
          } catch {
            try {
              const content = await fs.readFile(confined, "utf8");
              return content.slice(0, MAX_READ_SIZE) || "(empty file)";
            } catch (error) {
              return `read error: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        },
      },
      {
        name: "task_done",
        description: "Signal that you have finished the task. Call this as your FINAL action with a summary of what you accomplished. If you failed, explain why.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Summary of what was accomplished or why the task failed" },
            success: { type: "boolean", description: "Whether the task was completed successfully (default: true)" },
          },
          required: ["summary"],
        },
        execute: async (args) => {
          const summary = args.summary as string;
          const success = args.success !== false;
          return `TASK_COMPLETE:${success ? "SUCCESS" : "FAILURE"}:${summary}`;
        },
      },
    ];

    const toolContext = this.context.toolContext;
    const toolCatalog = this.context.toolCatalog ?? [];
    if (!toolContext || toolCatalog.length === 0) {
      return customTools;
    }

    const customToolNames = new Set(customTools.map((tool) => tool.name));
    const aliasTools = this.createSpecAliasTools(toolCatalog, customToolNames);
    const reservedToolNames = new Set([
      ...customToolNames,
      ...aliasTools.map((tool) => tool.name),
    ]);
    const wrappedTools = toolCatalog
      .filter((tool) => GENERAL_WRAPPED_TOOL_ALLOWLIST.has(tool.name))
      .filter((tool) => !reservedToolNames.has(tool.name))
      .map((tool) => this.createWrappedTool(tool, toolCatalog));

    return [...customTools, ...aliasTools, ...wrappedTools];
  }

  private createWrappedTool(tool: AutomatonTool, toolCatalog: AutomatonTool[]): HarnessTool {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (args) => {
        if (!this.context.toolContext) {
          return `Error: tool context unavailable for ${tool.name}`;
        }

        const result = await executeTool(
          tool.name,
          args,
          toolCatalog,
          this.context.toolContext,
          this.context.policyEngine,
          {
            inputSource: this.context.inputSource,
            turnToolCallCount: this.transferToolCallCount,
            sessionSpend: this.context.spendTracker ?? NOOP_SPEND_TRACKER,
          },
        );
        if (CREDIT_TRANSFER_NAMES.has(tool.name)) {
          this.transferToolCallCount += 1;
        }

        if (result.error) {
          return `Error: ${result.error}`;
        }

        return tool.name === "x402_fetch"
          ? sanitizeToolResult(result.result)
          : result.result;
      },
    };
  }

  private createSpecAliasTools(
    toolCatalog: AutomatonTool[],
    reservedToolNames: Set<string>,
  ): HarnessTool[] {
    return Object.entries(GENERAL_SPEC_ALIAS_TARGETS)
      .filter(([alias]) => !reservedToolNames.has(alias))
      .flatMap(([alias, targetName]) => {
        const targetTool = toolCatalog.find((tool) => tool.name === targetName);
        if (!targetTool) {
          return [];
        }

        return [{
          name: alias,
          description: `${targetTool.description} (SPEC alias for ${targetName})`,
          parameters: targetTool.parameters,
          execute: async (args) => {
            if (!this.context.toolContext) {
              return `Error: tool context unavailable for ${alias}`;
            }

            const result = await executeTool(
              targetName,
              args,
              toolCatalog,
              this.context.toolContext,
              this.context.policyEngine,
              {
                inputSource: this.context.inputSource,
                turnToolCallCount: this.transferToolCallCount,
                sessionSpend: this.context.spendTracker ?? NOOP_SPEND_TRACKER,
              },
            );

            if (result.error) {
              return `Error: ${result.error}`;
            }

            return sanitizeToolResult(result.result);
          },
        }];
      });
  }
}

function confineToWorkspace(
  filePath: string,
  allowedRoot: string,
): string | { error: string } {
  const expanded = filePath.startsWith("~")
    ? path.join(allowedRoot, filePath.slice(1))
    : filePath;
  const resolved = path.resolve(allowedRoot, expanded);
  if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) {
    return { error: `Blocked: path "${filePath}" resolves outside workspace (${allowedRoot})` };
  }
  return resolved;
}

function formatExecResult(stdout: string, stderr: string): string {
  const out = stdout.length > MAX_EXEC_OUTPUT
    ? stdout.slice(0, MAX_EXEC_OUTPUT) + `\n[TRUNCATED: ${stdout.length - MAX_EXEC_OUTPUT} chars]`
    : stdout;
  const err = stderr.length > 4000
    ? stderr.slice(0, 4000) + "\n[TRUNCATED]"
    : stderr;
  return err ? `stdout:\n${out}\nstderr:\n${err}` : out || "(no output)";
}

function localExec(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execCb(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) {
        resolve(`exec error: ${error.message}`);
        return;
      }
      resolve(formatExecResult(stdout ?? "", stderr ?? ""));
    });
  });
}
