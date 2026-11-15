/**
 * Anthropic Messages API codec, shared by the main-loop client and the
 * orchestration transport so both stacks send the same request.
 *
 * Written for the current models: no temperature, top_p, top_k or thinking
 * is ever sent (each is a 400 on some current model), prefills are never
 * sent, and thinking blocks in a reply are dropped rather than stored.
 */

import { createHash } from "node:crypto";
import type { ChatMessage, InferenceToolCall, InferenceToolDefinition } from "../types.js";
import { InferenceResponseError } from "./errors.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("inference.anthropic");

export const ANTHROPIC_API_BASE = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_API_BASE}/v1/messages`;

/** Added to the system prompt when the caller wants one JSON object back. */
export const JSON_OBJECT_INSTRUCTION = "Reply with one JSON object and nothing else.";
export const MISSING_TOOL_RESULT = "No result was recorded for this call.";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** The capability fields the codec reads (a subset of the price table's). */
export interface AnthropicModelCapabilities {
  effort?: boolean;
  /** The levels the model accepts, when not every level. */
  effortLevels?: readonly string[];
  minOutputTokens?: number;
}

type Block = Record<string, unknown>;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

interface Turn {
  role: "user" | "assistant";
  blocks: Block[];
}

const isToolResult = (b: Block): boolean => b.type === "tool_result";

function toolUseIds(turn: Turn | undefined): string[] {
  if (!turn || turn.role !== "assistant") return [];
  return turn.blocks.filter((b) => b.type === "tool_use").map((b) => String(b.id));
}

function resultText(b: Block): string {
  const c = b.content;
  return typeof c === "string" ? c : c === undefined ? "" : JSON.stringify(c);
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

const TOOL_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Tool-call ids for one request. The Messages API wants tool_use ids that
 * match [A-Za-z0-9_-]+ and are unique; another provider may have issued ids
 * like "functions.read_file:0", or restarted its counter so "call_0" repeats.
 * A valid id seen for the first time is kept; any other gets a stable
 * replacement. Each tool result takes the id given to its call.
 */
class ToolIdMap {
  private readonly used = new Set<string>();
  private readonly pending = new Map<string, string[]>();
  private readonly latest = new Map<string, string>();

  forCall(original: string): string {
    let id = original;
    if (!TOOL_ID_RE.test(id) || this.used.has(id)) {
      const base = `toolu_${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
      id = base;
      for (let n = 2; this.used.has(id); n++) id = `${base}_${n}`;
    }
    this.used.add(id);
    const queue = this.pending.get(original) ?? [];
    queue.push(id);
    this.pending.set(original, queue);
    this.latest.set(original, id);
    return id;
  }

  forResult(original: string): string {
    return this.pending.get(original)?.shift() ?? this.latest.get(original) ?? original;
  }
}

/**
 * Chat messages to the Messages API shape: system text pulled out, tool
 * results as tool_result blocks first in the next user turn, and repairs so
 * a history cut by the context window is still accepted.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const turns: Turn[] = [];

  const push = (role: Turn["role"], blocks: Block[]): void => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (!last || last.role !== role) {
      turns.push({ role, blocks: [...blocks] });
      return;
    }
    if (role === "assistant") {
      last.blocks.push(...blocks);
      return;
    }
    // Tool results must lead the user turn; text goes after them.
    const results = blocks.filter(isToolResult);
    const rest = blocks.filter((b) => !isToolResult(b));
    const firstOther = last.blocks.findIndex((b) => !isToolResult(b));
    last.blocks.splice(firstOther === -1 ? last.blocks.length : firstOther, 0, ...results);
    last.blocks.push(...rest);
  };

  let syntheticId = 0;
  const toolIds = new ToolIdMap();
  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
    if (msg.role === "system") {
      if (text) systemParts.push(text);
    } else if (msg.role === "user") {
      // An empty text block is a 400.
      if (text.trim()) push("user", [{ type: "text", text }]);
    } else if (msg.role === "tool") {
      const block: Block = { type: "tool_result", tool_use_id: toolIds.forResult(msg.tool_call_id || "unknown_tool_call") };
      if (text) block.content = text;
      push("user", [block]);
    } else if (msg.role === "assistant") {
      const blocks: Block[] = [];
      if (text.trim()) blocks.push({ type: "text", text });
      for (const call of msg.tool_calls || []) {
        blocks.push({
          type: "tool_use",
          id: toolIds.forCall(call.id || `toolu_missing_${++syntheticId}`),
          name: call.function?.name || "unknown_tool",
          input: parseToolArguments(call.function?.arguments ?? "{}"),
        });
      }
      // Neither text nor a tool call: dropped, since an empty block is a 400.
      push("assistant", blocks);
    }
  }

  const out: Turn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === "assistant") {
      out.push(turn);
      const ids = toolUseIds(turn);
      if (ids.length > 0 && !turns[i + 1]) {
        out.push({ role: "user", blocks: ids.map(missingResult) });
      }
      continue;
    }
    const expected = toolUseIds(out[out.length - 1]);
    const allowed = new Set(expected);
    const found = new Map<string, Block>();
    const texts: Block[] = [];
    for (const b of turn.blocks) {
      if (!isToolResult(b)) {
        texts.push(b);
        continue;
      }
      const id = String(b.tool_use_id);
      if (allowed.has(id) && !found.has(id)) {
        found.set(id, b);
      } else {
        // No matching tool_use right before it: kept as plain text.
        texts.push({ type: "text", text: `[tool result ${id}]: ${resultText(b)}` });
      }
    }
    const results = expected.map((id) => found.get(id) ?? missingResult(id));
    out.push({ role: "user", blocks: [...results, ...texts] });
  }

  if (out.length === 0 || out[0].role !== "user") {
    out.unshift({ role: "user", blocks: [{ type: "text", text: "(conversation start)" }] });
  }
  // Current models refuse a prefill (a final assistant turn).
  if (out[out.length - 1].role === "assistant") {
    out.push({ role: "user", blocks: [{ type: "text", text: "Continue." }] });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out.map((t) => ({
      role: t.role,
      content:
        t.role === "user" && t.blocks.every((b) => b.type === "text")
          ? t.blocks.map((b) => String(b.text)).join("\n")
          : t.blocks,
    })),
  };
}

function missingResult(id: string): Block {
  return { type: "tool_result", tool_use_id: id, is_error: true, content: MISSING_TOOL_RESULT };
}

let forcedChoiceWarned = false;

function mapToolChoice(choice: unknown): Block {
  if (choice === undefined || choice === null || choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  // Forced tool choice is a 400 on several current models.
  if (!forcedChoiceWarned) {
    forcedChoiceWarned = true;
    logger.warn("Forced tool choice is not sent to Anthropic models; using auto instead");
  }
  return { type: "auto" };
}

export function buildAnthropicRequest(p: {
  model: string;
  maxTokens: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[] | unknown[];
  toolChoice?: unknown;
  effort?: AnthropicEffort;
  capabilities?: AnthropicModelCapabilities | null;
  jsonObject?: boolean;
}): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(p.messages);
  const systemText = p.jsonObject ? (system ? `${system}\n\n` : "") + JSON_OBJECT_INSTRUCTION : system;
  const body: Record<string, unknown> = {
    model: p.model,
    // Exactly the reserved amount: the gate priced this many output tokens.
    max_tokens: p.maxTokens,
    messages,
  };
  if (systemText) body.system = systemText;

  const tools = (p.tools ?? []) as Array<Partial<InferenceToolDefinition>>;
  if (tools.length > 0) {
    body.tools = tools.map((tool) => {
      const fn = (tool?.function ?? {}) as Partial<InferenceToolDefinition["function"]>;
      const schema = fn.parameters;
      return {
        name: fn.name,
        description: fn.description ?? "",
        input_schema:
          schema && typeof schema === "object" && !Array.isArray(schema) ? schema : { type: "object", properties: {} },
      };
    });
    body.tool_choice = mapToolChoice(p.toolChoice);
  }

  // An effort the model does not accept is a 400: send it only when known good.
  const levels = p.capabilities?.effortLevels;
  if (p.effort && p.capabilities?.effort === true && (!levels || levels.includes(p.effort))) {
    body.output_config = { effort: p.effort };
  }
  return body;
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

export interface ParsedAnthropicResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: InferenceToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
}

function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Cache tokens are not requested; if billed anyway, reads count as full input and writes at 1.25x. */
export function anthropicUsage(raw: unknown): { promptTokens: number; completionTokens: number } {
  const u = (raw ?? {}) as Record<string, unknown>;
  return {
    promptTokens:
      count(u.input_tokens) + count(u.cache_read_input_tokens) + Math.ceil(1.25 * count(u.cache_creation_input_tokens)),
    completionTokens: count(u.output_tokens),
  };
}

function finishReasonOf(reason: unknown): string {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case undefined:
    case null:
      return "stop";
    default:
      return typeof reason === "string" ? reason : "stop";
  }
}

/** The outermost {...} of a reply, code fences stripped. */
export function extractJsonObject(text: string): string {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start !== -1 && end > start ? unfenced.slice(start, end + 1) : text;
}

/**
 * Throws InferenceResponseError, carrying the usage so the attempt is billed,
 * for a refusal or a reply with no usable output.
 */
export function parseAnthropicResponse(
  data: unknown,
  requestedModel: string,
  opts: { jsonObject?: boolean } = {},
): ParsedAnthropicResponse {
  const d = (data ?? {}) as Record<string, any>;
  const usage = anthropicUsage(d.usage);
  const billed = d.usage ? { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens } : undefined;

  if (d.stop_reason === "refusal") {
    const category = typeof d.stop_details?.category === "string" ? d.stop_details.category : "no category";
    throw new InferenceResponseError(`Anthropic declined the request (${category})`, billed);
  }

  const blocks: any[] = Array.isArray(d.content) ? d.content : [];
  const text = blocks
    .filter((b) => b?.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n")
    .trim();
  const toolUses = blocks.filter((b) => b?.type === "tool_use");
  const toolCalls: InferenceToolCall[] | undefined =
    toolUses.length > 0
      ? toolUses.map((b) => ({
          id: String(b.id),
          type: "function" as const,
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        }))
      : undefined;

  if (!text && !toolCalls) {
    const thought = blocks.some((b) => b?.type === "thinking" || b?.type === "redacted_thinking");
    if (thought && d.stop_reason === "max_tokens") {
      throw new InferenceResponseError("output limit used up by thinking", billed);
    }
    throw new InferenceResponseError("No completion content returned from anthropic inference", billed);
  }

  return {
    id: typeof d.id === "string" ? d.id : "",
    model: typeof d.model === "string" ? d.model : requestedModel,
    content: opts.jsonObject && text ? extractJsonObject(text) : text,
    toolCalls,
    usage,
    finishReason: finishReasonOf(d.stop_reason),
  };
}
