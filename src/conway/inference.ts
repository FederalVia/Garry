/**
 * Conway Inference Client
 *
 * Wraps Conway's /v1/chat/completions endpoint (OpenAI-compatible).
 * The automaton pays for its own thinking through Conway credits.
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
  ModelCapabilities,
  ModelEntry,
  ModelProvider,
  Effort,
} from "../types.js";
import { ResilientHttpClient, isLoopbackHttpUrl } from "./http-client.js";
import {
  canServeModel,
  openAiProtocolBase,
  providerIdForRow,
  remoteIdForRow,
  type ProviderEntry,
  type ProviderTable,
} from "../providers/table.js";
import {
  ANTHROPIC_MESSAGES_URL,
  anthropicHeaders,
  buildAnthropicRequest,
  parseAnthropicResponse,
} from "../inference/anthropic.js";
import { redactChatMessages } from "../security/secret-redaction.js";
import { getInstalledInferenceGate, currentInferenceScope, budgetClassFor } from "../inference/gate.js";
import {
  InferenceRefusedError,
  InferenceHttpError,
  InferenceResponseError,
  parseRetryAfter,
} from "../inference/errors.js";

/**
 * Per-attempt ceiling. The router passes a signal carrying the call's real
 * deadline; this only bounds a request made without one.
 */
const INFERENCE_TIMEOUT_MS = 120_000;

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  /** OpenAI-compatible base URL including /v1. Default https://api.openai.com/v1. */
  openaiBaseUrl?: string;
  /**
   * Models the operator listed for a custom OpenAI-compatible base URL; with
   * a custom URL and a list, only these are served there.
   */
  openaiModels?: string[];
  /**
   * Whether Conway serves what no other backend can (Conway mode, default).
   * When false, such a model has no backend: the call is refused before any
   * I/O and canServe says no.
   */
  conwayFallback?: boolean;
  /** Optional registry lookup — if provided, used before name heuristics */
  getModelProvider?: (modelId: string) => string | undefined;
  /** The provider table: which entry serves a row, its key and its wire protocol. */
  table?: ProviderTable;
  /** Registry lookup for a model's route; used with the table. */
  getModelRoute?: (modelId: string) => ModelRoute | undefined;
}

/** What the client needs from a registry row to send to it. */
export interface ModelRoute {
  providerId?: string | null;
  remoteId?: string | null;
  provider: ModelProvider | string;
  parameterStyle?: ModelEntry["parameterStyle"];
  capabilities?: Partial<ModelCapabilities> | null;
}

/** The route of a registry row, for getModelRoute. */
export function modelRouteOf(entry: ModelEntry | undefined): ModelRoute | undefined {
  if (!entry) return undefined;
  return {
    providerId: entry.providerId,
    remoteId: entry.remoteId,
    provider: entry.provider,
    parameterStyle: entry.parameterStyle,
    capabilities: entry.capabilities,
  };
}

type InferenceBackend = "conway" | "openai" | "anthropic" | "ollama" | "none";

/** Names that need max_completion_tokens on OpenAI (o-series, gpt-5.x, gpt-4.1). */
const COMPLETION_TOKENS_RE = /^(o[1-9]|gpt-5|gpt-4\.1)/;

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiUrl, apiKey, openaiApiKey, anthropicApiKey, ollamaBaseUrl, getModelProvider, table, getModelRoute } = options;
  const conwayFallback = options.conwayFallback !== false;
  const openaiBaseUrl = (options.openaiBaseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const customOpenAi = openaiBaseUrl !== DEFAULT_OPENAI_BASE_URL;
  const openaiModels = options.openaiModels && options.openaiModels.length > 0 ? new Set(options.openaiModels) : null;
  // The per-request host check still applies; this only lets plain http
  // through to loopback servers someone configured.
  const httpClient = new ResilientHttpClient({
    baseTimeout: INFERENCE_TIMEOUT_MS,
    retryableStatuses: [429, 500, 502, 503, 504],
    allowHttpOnLoopback:
      isLoopbackHttpUrl(ollamaBaseUrl) ||
      isLoopbackHttpUrl(openaiBaseUrl) ||
      (table?.entries ?? []).some((e) => isLoopbackHttpUrl(e.baseUrl)),
  });

  /**
   * The table entry for a model, or undefined to use the legacy rules. In
   * standalone every routed row goes through the table; in Conway mode only
   * rows that name their provider_id do, so a Conway install is unchanged.
   */
  const tableEntryFor = (route: ModelRoute | undefined): ProviderEntry | null | undefined => {
    if (!table || !route) return undefined;
    if (!route.providerId && table.mode !== "standalone") return undefined;
    const id = route.providerId || providerIdForRow({ provider: String(route.provider) });
    const entry = table.get(id);
    if (!entry) return null;
    if (entry.kind === "conway" && table.mode !== "conway") return null;
    if (!entry.hasKey && !entry.loopback && entry.kind !== "ollama") return null;
    return entry;
  };
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const chat = async (
    rawMessages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    // Only a caller holding an open reservation on the installed gate (the
    // router) may spend; anything else fails closed before any I/O.
    const gate = getInstalledInferenceGate();
    if (!opts?.reservationId || !gate || !gate.isOpen(opts.reservationId)) {
      throw new InferenceRefusedError(
        "UNGATED_CALL",
        "Inference must go through the inference router (no open budget reservation)",
        { retryAfterMs: null, budgetClass: budgetClassFor(currentInferenceScope().caller) },
      );
    }
    if (opts.signal?.aborted) {
      const err = new Error("Inference aborted before sending");
      err.name = "AbortError";
      throw err;
    }

    // Known secret values (wallet key, API keys, their hex/base64 forms)
    // never leave for a provider, whatever a tool printed.
    const messages = redactChatMessages(rawMessages);
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    const route = getModelRoute?.(model);
    const entry = tableEntryFor(route);
    if (entry === null) {
      gate.release(opts.reservationId, "no_provider");
      throw new InferenceRefusedError("NO_MODEL", `No configured provider can serve model ${model}`, {
        retryAfterMs: null,
        budgetClass: budgetClassFor(currentInferenceScope().caller),
      });
    }
    if (entry && route) {
      return chatViaTableEntry({
        entry,
        key: table!.key(entry.id),
        route,
        model,
        messages,
        tools,
        tokenLimit: opts?.maxTokens || maxTokens,
        temperature: opts?.temperature,
        effort: opts?.effort,
        httpClient,
        signal: opts.signal,
      });
    }

    const backend = resolveInferenceBackend(model, {
      openaiApiKey,
      anthropicApiKey,
      ollamaBaseUrl,
      getModelProvider,
      conwayFallback,
    });

    if (backend === "none") {
      // Nothing was sent, so the reservation is released, not held.
      gate.release(opts.reservationId, "no_provider");
      throw new InferenceRefusedError("NO_MODEL", `No configured provider can serve model ${model}`, {
        retryAfterMs: null,
        budgetClass: budgetClassFor(currentInferenceScope().caller),
      });
    }

    // Newer models (o-series, gpt-5.x, gpt-4.1) require max_completion_tokens.
    // Ollama always uses max_tokens.
    const usesCompletionTokens = backend !== "ollama" && COMPLETION_TOKENS_RE.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    if (backend === "anthropic") {
      return chatViaAnthropic({
        model,
        tokenLimit,
        messages,
        tools,
        effort: opts?.effort,
        capabilities: route?.capabilities,
        anthropicApiKey: anthropicApiKey as string,
        httpClient,
        signal: opts.signal,
      });
    }

    const endpoint =
      backend === "openai" ? `${openaiBaseUrl}/chat/completions` :
      backend === "ollama" ? `${(ollamaBaseUrl as string).replace(/\/$/, "")}/v1/chat/completions` :
      `${apiUrl}/v1/chat/completions`;
    const openAiLikeApiKey =
      backend === "openai" ? (openaiApiKey as string) :
      backend === "ollama" ? "ollama" :
      apiKey;

    return chatViaOpenAiCompatible({
      model,
      body,
      endpoint,
      apiKey: openAiLikeApiKey,
      backend,
      httpClient,
      signal: opts.signal,
    });
  };

  /**
   * @deprecated Use InferenceRouter for tier-based model selection.
   * Still functional as a fallback; router takes priority when available.
   */
  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-5-mini";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  /**
   * Whether some backend can serve the model. Conway mode: Ollama needs its
   * base URL; any other model goes to its provider's key or, failing that,
   * to Conway. Without the Conway fallback each provider needs its own
   * credential, and a custom OpenAI-compatible URL serves only the models
   * listed for it, so the router never picks a model nobody can serve.
   */
  const canServe = (model: { modelId: string; provider: string }): boolean => {
    // The table's one serve rule, for every row in standalone and for rows
    // naming their provider in Conway mode.
    const row = model as ModelEntry;
    if (table && (table.mode === "standalone" || row.providerId)) {
      return canServeModel(table, row);
    }
    if (model.provider === "ollama") return !!ollamaBaseUrl;
    if (conwayFallback) {
      if (model.provider === "anthropic" && anthropicApiKey) return true;
      if (model.provider === "openai" && openaiApiKey) return true;
      return !!apiKey;
    }
    if (model.provider === "anthropic") return !!anthropicApiKey;
    if (model.provider === "openai") {
      if (!openaiApiKey) return false;
      return !customOpenAi || !openaiModels || openaiModels.has(model.modelId);
    }
    return false;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
    canServe,
  };
}

function formatMessage(
  msg: ChatMessage,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}

/**
 * Resolve which backend to use for a model.
 * When InferenceRouter is available, it uses the model registry's provider field.
 * This function is kept for backward compatibility with direct inference calls.
 */
function resolveInferenceBackend(
  model: string,
  keys: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    ollamaBaseUrl?: string;
    getModelProvider?: (modelId: string) => string | undefined;
    conwayFallback?: boolean;
  },
): InferenceBackend {
  const fallback: InferenceBackend = keys.conwayFallback === false ? "none" : "conway";
  // Registry-based routing: most accurate, no name guessing
  if (keys.getModelProvider) {
    const provider = keys.getModelProvider(model);
    if (provider === "ollama" && keys.ollamaBaseUrl) return "ollama";
    if (provider === "anthropic" && keys.anthropicApiKey) return "anthropic";
    if (provider === "openai" && keys.openaiApiKey) return "openai";
    if (provider === "conway") return fallback;
    // provider unknown or key not configured — fall through to heuristics
  }

  // Heuristic fallback (model not in registry yet)
  if (keys.anthropicApiKey && /^claude/i.test(model)) return "anthropic";
  if (keys.openaiApiKey && /^(gpt-[3-9]|gpt-4|gpt-5|o[1-9][-\s.]|o[1-9]$|chatgpt)/i.test(model)) return "openai";
  return fallback;

}

/**
 * Send to the table entry serving the row, by the entry's wire protocol. A
 * key only ever goes to its own entry's base URL (Anthropic's is pinned).
 */
async function chatViaTableEntry(params: {
  entry: ProviderEntry;
  key: string | undefined;
  route: ModelRoute;
  model: string;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  tokenLimit: number;
  temperature?: number;
  effort?: Effort;
  httpClient: ResilientHttpClient;
  signal?: AbortSignal;
}): Promise<InferenceResponse> {
  const { entry, route } = params;
  // Conway rows go out exactly as before the table: the registry id on the
  // wire (an id like "conway/kimi-k2" keeps its prefix) and the token field
  // chosen from the id alone.
  const conway = entry.kind === "conway";
  const remoteId = conway ? params.model : remoteIdForRow({ modelId: params.model, remoteId: route.remoteId }, entry.id);
  if (entry.kind === "anthropic") {
    return chatViaAnthropic({
      model: remoteId,
      tokenLimit: params.tokenLimit,
      messages: params.messages,
      tools: params.tools,
      effort: params.effort ?? entry.effort,
      capabilities: route.capabilities,
      anthropicApiKey: params.key ?? "",
      httpClient: params.httpClient,
      signal: params.signal,
      reportedModel: params.model,
    });
  }

  const endpoint =
    entry.kind === "conway"
      ? `${entry.baseUrl}/v1/chat/completions`
      : `${openAiProtocolBase(entry)}/chat/completions`;
  const body: Record<string, unknown> = {
    model: remoteId,
    messages: params.messages.map(formatMessage),
    stream: false,
  };
  const completionTokens = conway
    ? COMPLETION_TOKENS_RE.test(remoteId)
    : entry.kind !== "ollama" && (route.parameterStyle === "max_completion_tokens" || COMPLETION_TOKENS_RE.test(remoteId));
  body[completionTokens ? "max_completion_tokens" : "max_tokens"] = params.tokenLimit;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = "auto";
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (entry.kind === "conway") {
    if (params.key) headers.Authorization = params.key;
  } else if (entry.kind === "ollama") {
    headers.Authorization = `Bearer ${params.key || "ollama"}`;
  } else if (params.key) {
    // A keyless loopback server gets no Authorization header.
    headers.Authorization = `Bearer ${params.key}`;
  }
  const response = await chatViaOpenAiCompatible({
    model: params.model,
    body,
    endpoint,
    headers,
    backend: entry.id,
    httpClient: params.httpClient,
    signal: params.signal,
  });
  // The ledger and the loop see the registry id, not the wire id.
  return { ...response, model: params.model };
}

async function chatViaOpenAiCompatible(params: {
  model: string;
  body: Record<string, unknown>;
  /** Full chat completions URL. */
  endpoint: string;
  apiKey?: string;
  /** Full headers; when absent they are built from apiKey and backend. */
  headers?: Record<string, string>;
  backend: string;
  httpClient: ResilientHttpClient;
  signal?: AbortSignal;
}): Promise<InferenceResponse> {
  // retries: 0 — a billable POST is never resent here; the router owns retries.
  const resp = await params.httpClient.request(params.endpoint, {
    method: "POST",
    headers: params.headers ?? {
      "Content-Type": "application/json",
      Authorization:
        params.backend === "openai" || params.backend === "ollama"
          ? `Bearer ${params.apiKey}`
          : String(params.apiKey),
    },
    body: JSON.stringify(params.body),
    timeout: INFERENCE_TIMEOUT_MS,
    retries: 0,
    signal: params.signal,
  });

  if (!resp.ok) throw await httpError(params.backend, resp);

  const data = await readJson(resp);
  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };
  const choice = data.choices?.[0];

  if (!choice || !choice.message) {
    throw new InferenceResponseError("No completion choice returned from inference", usageOf(usage));
  }

  const message = choice.message;

  const toolCalls: InferenceToolCall[] | undefined =
    message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: message.role,
      content: message.content || "",
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: choice.finish_reason || "stop",
  };
}

/** Through the shared codec: the same request the orchestration transport sends. */
async function chatViaAnthropic(params: {
  model: string;
  tokenLimit: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  effort?: Effort;
  capabilities?: Partial<ModelCapabilities> | null;
  anthropicApiKey: string;
  httpClient: ResilientHttpClient;
  signal?: AbortSignal;
  /** The registry id, when the wire id differs. */
  reportedModel?: string;
}): Promise<InferenceResponse> {
  const body = buildAnthropicRequest({
    model: params.model,
    maxTokens: params.tokenLimit,
    messages: params.messages,
    tools: params.tools,
    effort: params.effort,
    capabilities: params.capabilities,
  });

  const resp = await params.httpClient.request(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: anthropicHeaders(params.anthropicApiKey),
    body: JSON.stringify(body),
    timeout: INFERENCE_TIMEOUT_MS,
    retries: 0,
    signal: params.signal,
  });

  if (!resp.ok) throw await httpError("anthropic", resp);

  const parsed = parseAnthropicResponse(await readJson(resp), params.model);
  const usage: TokenUsage = {
    promptTokens: parsed.usage.promptTokens,
    completionTokens: parsed.usage.completionTokens,
    totalTokens: parsed.usage.promptTokens + parsed.usage.completionTokens,
  };
  return {
    id: parsed.id,
    model: params.reportedModel ?? parsed.model,
    message: {
      role: "assistant",
      content: parsed.content,
      tool_calls: parsed.toolCalls,
    },
    toolCalls: parsed.toolCalls,
    usage,
    finishReason: parsed.finishReason,
  };
}

async function httpError(backend: string, resp: Response): Promise<InferenceHttpError> {
  let text = "";
  try {
    text = await resp.text();
  } catch {
    /* body unreadable; the status is what matters */
  }
  return new InferenceHttpError(backend, resp.status, text, parseRetryAfter(resp.headers?.get?.("retry-after")));
}

/** A 2xx body that is not JSON may still have been billed. */
async function readJson(resp: Response): Promise<any> {
  try {
    return (await resp.json()) as any;
  } catch (err) {
    if ((err as any)?.name === "AbortError") throw err;
    throw new InferenceResponseError(
      `Unreadable inference response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function usageOf(u: TokenUsage): { inputTokens: number; outputTokens: number } | undefined {
  return u.promptTokens || u.completionTokens
    ? { inputTokens: u.promptTokens, outputTokens: u.completionTokens }
    : undefined;
}
