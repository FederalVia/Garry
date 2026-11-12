import { describe, expect, it, vi } from "vitest";
import { createWorkerInferenceBridge } from "../../agent/worker-inference-bridge.js";
import { InferenceRefusedError } from "../../inference/errors.js";

describe("agent/worker-inference-bridge", () => {
  it("forwards tier, responseFormat, tools, and token settings to unified inference", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '{"analysis":"ok"}',
      toolCalls: [
        {
          id: "tool-1",
          type: "function",
          function: { name: "delegate_task", arguments: "{}" },
        },
      ],
    });

    const bridge = createWorkerInferenceBridge({ chat } as any);
    const result = await bridge.chat({
      tier: "reasoning",
      messages: [{ role: "system", content: "# Planner Agent" }],
      tools: [{ type: "function", function: { name: "delegate_task", description: "delegate", parameters: { type: "object", properties: {} } } }],
      maxTokens: 123,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });

    expect(chat).toHaveBeenCalledWith({
      tier: "reasoning",
      messages: [{ role: "system", content: "# Planner Agent" }],
      tools: [{ type: "function", function: { name: "delegate_task", description: "delegate", parameters: { type: "object", properties: {} } } }],
      maxTokens: 123,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
      purpose: undefined,
      signal: undefined,
    });
    expect(result.content).toBe('{"analysis":"ok"}');
    expect(result.toolCalls?.[0].function.name).toBe("delegate_task");
  });

  it("defaults tier to fast when omitted", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "ok", toolCalls: [] });
    const bridge = createWorkerInferenceBridge({ chat } as any);

    await bridge.chat({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(chat).toHaveBeenCalledWith({
      tier: "fast",
      messages: [{ role: "user", content: "hello" }],
      tools: undefined,
      maxTokens: undefined,
      temperature: undefined,
      responseFormat: undefined,
      purpose: undefined,
      signal: undefined,
    });
  });

  it("returns the call's committed cost and usage", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: "ok",
      usage: { inputTokens: 20_000, outputTokens: 2_000, totalTokens: 22_000 },
      cost: { inputCostCents: 4, outputCostCents: 1.6, totalCostCents: 5.6, costMicroUsd: 56_000 },
    });
    const bridge = createWorkerInferenceBridge({ chat } as any);

    const result = await bridge.chat({ messages: [{ role: "user", content: "hi" }], purpose: "worker_turn" });

    expect(result.costCents).toBe(5.6);
    expect(result.usage).toEqual({ inputTokens: 20_000, outputTokens: 2_000 });
    expect(chat.mock.calls[0][0].purpose).toBe("worker_turn");
  });

  it("lets a budget refusal through unchanged", async () => {
    const refusal = new InferenceRefusedError("TASK_CAP", "task cap reached", {
      retryAfterMs: null,
      budgetClass: "orchestration",
    });
    const bridge = createWorkerInferenceBridge({ chat: vi.fn().mockRejectedValue(refusal) } as any);

    await expect(bridge.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toBe(refusal);
  });
});
