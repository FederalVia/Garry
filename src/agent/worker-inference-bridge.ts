import type { UnifiedInferenceClient } from "../inference/inference-client.js";
import type { ModelTier } from "../inference/provider-registry.js";
import type { InferenceToolCall } from "../types.js";
import type { WorkerInferenceClient } from "./harness-types.js";

export function createWorkerInferenceBridge(
  inference: Pick<UnifiedInferenceClient, "chat">,
): WorkerInferenceClient {
  return {
    chat: async (params) => {
      const response = await inference.chat({
        tier: normalizeTier(params.tier),
        messages: params.messages,
        tools: params.tools,
        toolChoice: params.toolChoice as any,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        responseFormat: normalizeResponseFormat(params.responseFormat),
        purpose: params.purpose,
        signal: params.signal,
      });

      // InferenceRefusedError propagates unchanged so the harness can tell a
      // task-cap refusal from one that clears with time.
      return {
        content: response.content,
        toolCalls: response.toolCalls as InferenceToolCall[] | undefined,
        costCents: response.cost?.totalCostCents,
        usage: response.usage
          ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
          : undefined,
      };
    },
  };
}

function normalizeTier(tier: string | undefined): ModelTier {
  return tier === "reasoning" || tier === "cheap" || tier === "fast"
    ? tier
    : "fast";
}

function normalizeResponseFormat(
  responseFormat: { type: string } | undefined,
): { type: "json_object" | "text" } | undefined {
  if (!responseFormat) {
    return undefined;
  }

  return responseFormat.type === "json_object"
    ? { type: "json_object" }
    : { type: "text" };
}
