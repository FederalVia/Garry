import { describe, expect, it } from "vitest";
import {
  buildAnthropicRequest,
  extractJsonObject,
  JSON_OBJECT_INSTRUCTION,
  MISSING_TOOL_RESULT,
  parseAnthropicResponse,
  toAnthropicMessages,
} from "../../inference/anthropic.js";
import { InferenceResponseError } from "../../inference/errors.js";
import type { ChatMessage, InferenceToolDefinition } from "../../types.js";

const call = (id: string, name = "read_file", args = '{"path":"a.txt"}') => ({
  id,
  type: "function" as const,
  function: { name, arguments: args },
});

const tool: InferenceToolDefinition = {
  type: "function",
  function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
};

describe("toAnthropicMessages", () => {
  it("joins every system message into the top-level system string", () => {
    const out = toAnthropicMessages([
      { role: "system", content: "one" },
      { role: "user", content: "hi" },
      { role: "system", content: "two" },
    ]);
    expect(out.system).toBe("one\n\ntwo");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends a tool call and its result as tool_use then a leading tool_result block", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "list files" },
      { role: "assistant", content: "", tool_calls: [call("toolu_1")] },
      { role: "tool", content: "file.txt", tool_call_id: "toolu_1" },
      { role: "user", content: "and then?" },
    ]);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } }],
    });
    expect(out.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" },
        { type: "text", text: "and then?" },
      ],
    });
  });

  it("puts tool results first even when user text came before them", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "ok", tool_calls: [call("a"), call("b")] },
      { role: "user", content: "note" },
      { role: "tool", content: "ra", tool_call_id: "a" },
      { role: "tool", content: "rb", tool_call_id: "b" },
    ]);
    const blocks = out.messages[2].content as any[];
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(blocks.map((b) => b.tool_use_id ?? b.text)).toEqual(["a", "b", "note"]);
  });

  it("turns an orphan tool result into text and gives a missing one a synthetic error result", () => {
    const out = toAnthropicMessages([
      { role: "tool", content: "stale", tool_call_id: "gone" },
      { role: "assistant", content: "", tool_calls: [call("x")] },
      { role: "user", content: "next" },
    ]);
    expect(out.messages[0]).toEqual({ role: "user", content: "[tool result gone]: stale" });
    expect(out.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "x", is_error: true, content: MISSING_TOOL_RESULT },
        { type: "text", text: "next" },
      ],
    });
  });

  it("adds a synthetic result after a final tool call", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [call("z")] },
    ]);
    expect(out.messages).toHaveLength(3);
    expect((out.messages[2].content as any[])[0]).toMatchObject({ tool_use_id: "z", is_error: true });
  });

  it("drops an empty assistant turn, starts with a user turn and never ends on a prefill", () => {
    const out = toAnthropicMessages([
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "again" },
      { role: "assistant", content: "last words" },
    ]);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(out.messages[0].content).toBe("(conversation start)");
    expect(out.messages[2].content).toBe("hi\nagain");
    expect(out.messages[4].content).toBe("Continue.");
    for (const m of out.messages) {
      if (Array.isArray(m.content)) for (const b of m.content) expect(b.text === "").toBe(false);
    }
  });
});

describe("tool-call ids from other providers", () => {
  const blocksOf = (messages: ReturnType<typeof toAnthropicMessages>["messages"], type: string) =>
    messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === type);

  it("rewrites ids the API refuses and repeated ids, keeping each call paired with its result", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [call("functions.read_file:0")] },
      { role: "tool", content: "r1", tool_call_id: "functions.read_file:0" },
      { role: "assistant", content: "", tool_calls: [call("call_0")] },
      { role: "tool", content: "r2", tool_call_id: "call_0" },
      { role: "assistant", content: "", tool_calls: [call("call_0")] },
      { role: "tool", content: "r3", tool_call_id: "call_0" },
      { role: "assistant", content: "", tool_calls: [call("toolu_01AbC")] },
      { role: "tool", content: "r4", tool_call_id: "toolu_01AbC" },
    ]);
    const uses = blocksOf(out.messages, "tool_use").map((b) => String(b.id));
    const results = blocksOf(out.messages, "tool_result");
    expect(uses).toHaveLength(4);
    for (const id of uses) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Set(uses).size).toBe(4);
    // Valid first-seen ids are kept as they are.
    expect(uses[1]).toBe("call_0");
    expect(uses[3]).toBe("toolu_01AbC");
    expect(results.map((b) => b.tool_use_id)).toEqual(uses);
    expect(results.map((b) => b.content)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(results.some((b) => b.is_error)).toBe(false);
  });

  it("two calls with one id in the same turn get distinct ids, results in order", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [call("0"), call("0")] },
      { role: "tool", content: "a", tool_call_id: "0" },
      { role: "tool", content: "b", tool_call_id: "0" },
    ]);
    const uses = blocksOf(out.messages, "tool_use").map((b) => String(b.id));
    expect(new Set(uses).size).toBe(2);
    expect(blocksOf(out.messages, "tool_result").map((b) => [b.tool_use_id, b.content])).toEqual([
      [uses[0], "a"],
      [uses[1], "b"],
    ]);
  });
});

describe("buildAnthropicRequest", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];

  it("never sends temperature, top_p, top_k or thinking", () => {
    const body = buildAnthropicRequest({
      model: "claude-opus-5-5",
      maxTokens: 2048,
      messages,
      tools: [tool],
      effort: "low",
      capabilities: { effort: true },
      ...({ temperature: 0.2, top_p: 0.9 } as object),
    });
    for (const key of ["temperature", "top_p", "top_k", "thinking"]) expect(body).not.toHaveProperty(key);
    expect(body.max_tokens).toBe(2048);
    expect(body.system).toBe("sys");
  });

  it("maps tool definitions and tool choice", () => {
    const body = buildAnthropicRequest({
      model: "m",
      maxTokens: 10,
      messages,
      tools: [tool, { type: "function", function: { name: "bare", description: "x", parameters: undefined as any } }],
    });
    expect(body.tools).toEqual([
      { name: "read_file", description: "Read a file", input_schema: tool.function.parameters },
      { name: "bare", description: "x", input_schema: { type: "object", properties: {} } },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(buildAnthropicRequest({ model: "m", maxTokens: 10, messages, tools: [tool], toolChoice: "none" }).tool_choice).toEqual({
      type: "none",
    });
    expect(
      buildAnthropicRequest({ model: "m", maxTokens: 10, messages, tools: [tool], toolChoice: "required" }).tool_choice,
    ).toEqual({ type: "auto" });
    expect(
      buildAnthropicRequest({
        model: "m",
        maxTokens: 10,
        messages,
        tools: [tool],
        toolChoice: { type: "function", function: { name: "read_file" } },
      }).tool_choice,
    ).toEqual({ type: "auto" });
    expect(buildAnthropicRequest({ model: "m", maxTokens: 10, messages })).not.toHaveProperty("tool_choice");
  });

  it("sends effort only when the model accepts it", () => {
    expect(
      buildAnthropicRequest({ model: "m", maxTokens: 10, messages, effort: "low", capabilities: { effort: true } }).output_config,
    ).toEqual({ effort: "low" });
    expect(
      buildAnthropicRequest({ model: "m", maxTokens: 10, messages, effort: "low", capabilities: { effort: false } }),
    ).not.toHaveProperty("output_config");
    expect(buildAnthropicRequest({ model: "m", maxTokens: 10, messages, effort: "low" })).not.toHaveProperty("output_config");
    expect(
      buildAnthropicRequest({
        model: "m",
        maxTokens: 10,
        messages,
        effort: "xhigh",
        capabilities: { effort: true, effortLevels: ["low", "medium", "high", "max"] },
      }),
    ).not.toHaveProperty("output_config");
    expect(buildAnthropicRequest({ model: "m", maxTokens: 10, messages, capabilities: { effort: true } })).not.toHaveProperty(
      "output_config",
    );
  });

  it("asks for one JSON object in the system prompt", () => {
    expect(buildAnthropicRequest({ model: "m", maxTokens: 10, messages, jsonObject: true }).system).toBe(
      `sys\n\n${JSON_OBJECT_INSTRUCTION}`,
    );
  });
});

describe("parseAnthropicResponse", () => {
  it("joins text, maps tool calls and ignores thinking blocks", () => {
    const out = parseAnthropicResponse(
      {
        id: "msg_1",
        model: "claude-opus-5-5",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "redacted_thinking", data: "x" },
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "tool_use", id: "toolu_9", name: "read_file", input: { path: "x" } },
          { type: "mystery" },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-opus-5-5",
    );
    expect(out.content).toBe("a\nb");
    expect(out.toolCalls).toEqual([
      { id: "toolu_9", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } },
    ]);
    expect(out.finishReason).toBe("tool_calls");
    expect(JSON.stringify(out)).not.toContain("sig");
  });

  it("maps stop reasons", () => {
    const r = (stop_reason: string) =>
      parseAnthropicResponse({ content: [{ type: "text", text: "x" }], stop_reason, usage: {} }, "m").finishReason;
    expect(r("end_turn")).toBe("stop");
    expect(r("stop_sequence")).toBe("stop");
    expect(r("pause_turn")).toBe("stop");
    expect(r("max_tokens")).toBe("length");
    expect(r("model_context_window_exceeded")).toBe("length");
  });

  it("counts cache reads at full input and cache writes at 1.25x", () => {
    const out = parseAnthropicResponse(
      {
        content: [{ type: "text", text: "x" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 7 },
      },
      "m",
    );
    expect(out.usage).toEqual({ promptTokens: 100 + 40 + 13, completionTokens: 7 });
  });

  it("throws a billed InferenceResponseError for a refusal", () => {
    let err: unknown;
    try {
      parseAnthropicResponse(
        {
          content: [{ type: "text", text: "partial" }],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber" },
          usage: { input_tokens: 50, output_tokens: 3 },
        },
        "m",
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InferenceResponseError);
    expect((err as Error).message).toContain("cyber");
    expect((err as InferenceResponseError).usage).toEqual({ inputTokens: 50, outputTokens: 3 });
  });

  it("throws a billed InferenceResponseError when thinking used up the output limit", () => {
    let err: unknown;
    try {
      parseAnthropicResponse(
        { content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens", usage: { input_tokens: 9, output_tokens: 2048 } },
        "m",
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InferenceResponseError);
    expect((err as Error).message).toBe("output limit used up by thinking");
    expect((err as InferenceResponseError).usage).toEqual({ inputTokens: 9, outputTokens: 2048 });
  });

  it("extracts the JSON object from a fenced reply", () => {
    const fenced = 'Here you go:\n```json\n{"tasks":[{"title":"a"}]}\n```';
    const out = parseAnthropicResponse({ content: [{ type: "text", text: fenced }], stop_reason: "end_turn" }, "m", {
      jsonObject: true,
    });
    expect(JSON.parse(out.content)).toEqual({ tasks: [{ title: "a" }] });
    expect(extractJsonObject("no json here")).toBe("no json here");
  });
});
