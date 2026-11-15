/**
 * The provider table: entry order and kinds, keys held out of the entries,
 * per-provider env keys, the Conway entry only in Conway mode, the free
 * loopback rule (Ollama stays free on a LAN host, with a warning), and the
 * one serve rule every stack uses.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTestConfig } from "./mocks.js";
import type { AutomatonConfig, LogEntry, ModelEntry } from "../types.js";
import { StructuredLogger } from "../observability/logger.js";
import {
  canServeModel,
  providerIdForRow,
  registryIdFor,
  remoteIdForRow,
  resolveProviderTable,
  providerKeyEnvVar,
  openAiProtocolBase,
} from "../providers/table.js";
import { describeRuntime, resolveRuntime } from "../providers/mode.js";

const OPENAI_KEY = "sk-table-openai-SECRET-0123456789";
const ANTHROPIC_KEY = "sk-ant-table-SECRET-0123456789";
const OR_KEY = "sk-or-table-SECRET-0123456789";
const GROQ_KEY = "gsk_table_SECRET_0123456789";

function standalone(over: Partial<AutomatonConfig> = {}): AutomatonConfig {
  return createTestConfig({
    conwayApiKey: undefined as unknown as string,
    openaiApiKey: undefined,
    anthropicApiKey: undefined,
    ollamaBaseUrl: undefined,
    ...over,
    providers: { mode: "standalone", ...(over.providers ?? {}) },
  });
}

function model(over: Partial<ModelEntry>): ModelEntry {
  return {
    modelId: "m",
    provider: "openai",
    displayName: "m",
    tierMinimum: "normal",
    costPer1kInput: 10,
    costPer1kOutput: 20,
    maxTokens: 4096,
    contextWindow: 128000,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
    lastSeen: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const logs: LogEntry[] = [];
afterEach(() => {
  StructuredLogger.resetSink();
  logs.length = 0;
});

describe("resolveProviderTable", () => {
  const full = () =>
    standalone({
      openaiApiKey: OPENAI_KEY,
      anthropicApiKey: ANTHROPIC_KEY,
      ollamaBaseUrl: "http://localhost:11434/",
      providers: {
        anthropic: { effort: "high" },
        compatible: [
          { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1/", apiKey: OR_KEY },
          { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", priority: 7 },
          { id: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", free: true, models: [{ id: "qwen" }] },
        ],
      },
    });

  it("orders entries openai, anthropic, ollama, then compatible, with their kinds", () => {
    const t = resolveProviderTable(full(), { AUTOMATON_PROVIDER_GROQ_API_KEY: GROQ_KEY });
    expect(t.mode).toBe("standalone");
    expect(t.entries.map((e) => [e.id, e.kind])).toEqual([
      ["openai", "openai"],
      ["anthropic", "anthropic"],
      ["ollama", "ollama"],
      ["openrouter", "openai"],
      ["groq", "openai"],
      ["lmstudio", "openai"],
    ]);
    expect(t.get("anthropic")?.baseUrl).toBe("https://api.anthropic.com");
    expect(t.get("anthropic")?.effort).toBe("high");
    expect(t.get("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(t.get("ollama")?.baseUrl).toBe("http://localhost:11434");
    expect(openAiProtocolBase(t.get("ollama")!)).toBe("http://localhost:11434/v1");
    expect(t.get("groq")).toMatchObject({ label: "Groq", priority: 7, keySource: "provider-env", hasKey: true });
    expect(t.get("lmstudio")).toMatchObject({ loopback: true, free: true, hasKey: false, allowlist: true });
    expect(t.get("openrouter")).toMatchObject({ keySource: "providers", free: false, allowUnpriced: false, discover: true });
  });

  it("keeps keys out of the entries: JSON and describeRuntime hold none, key(id) returns each", () => {
    const config = full();
    const env = { AUTOMATON_PROVIDER_GROQ_API_KEY: GROQ_KEY };
    const t = resolveProviderTable(config, env);
    expect(JSON.stringify(t)).not.toMatch(/SECRET/);
    expect(JSON.stringify(t.entries)).not.toMatch(/SECRET/);
    expect(describeRuntime(resolveRuntime(config, env))).not.toMatch(/SECRET/);
    expect(t.key("openai")).toBe(OPENAI_KEY);
    expect(t.key("anthropic")).toBe(ANTHROPIC_KEY);
    expect(t.key("openrouter")).toBe(OR_KEY);
    expect(t.key("groq")).toBe(GROQ_KEY);
    expect(t.key("lmstudio")).toBeUndefined();
    expect(t.key("ollama")).toBeUndefined();
    expect(providerKeyEnvVar("my-llm")).toBe("AUTOMATON_PROVIDER_MY_LLM_API_KEY");
  });

  it("a file key wins over the env key; a remote entry with neither has no key", () => {
    const t = resolveProviderTable(
      standalone({
        providers: {
          compatible: [
            { id: "a", baseUrl: "https://a.example/v1", apiKey: "file-key-0123456789" },
            { id: "b", baseUrl: "https://b.example/v1" },
          ],
        },
      }),
      { AUTOMATON_PROVIDER_A_API_KEY: "env-key-0123456789" },
    );
    expect(t.key("a")).toBe("file-key-0123456789");
    expect(t.get("b")).toMatchObject({ hasKey: false, keySource: null });
  });

  it("has a Conway entry only in Conway mode", () => {
    const conway = resolveProviderTable(createTestConfig({ conwayApiKey: "cnwy_k_x", providers: { mode: "conway" } }), {});
    expect(conway.mode).toBe("conway");
    expect(conway.get("conway")).toMatchObject({ kind: "conway", baseUrl: "https://api.conway.tech", discover: false });
    expect(conway.key("conway")).toBe("cnwy_k_x");
    const sa = resolveProviderTable(createTestConfig({ conwayApiKey: "cnwy_k_x", providers: { mode: "standalone" } }), {});
    expect(sa.get("conway")).toBeUndefined();
  });

  it("built-in entries discover by default only in standalone; compatible ones in both modes", () => {
    const providers = { compatible: [{ id: "groq", baseUrl: "https://api.groq.com/openai/v1" }] };
    const sa = resolveProviderTable(standalone({ openaiApiKey: OPENAI_KEY, anthropicApiKey: ANTHROPIC_KEY, providers }), {});
    expect(sa.entries.map((e) => [e.id, e.discover])).toEqual([
      ["openai", true],
      ["anthropic", true],
      ["groq", true],
    ]);
    const cw = resolveProviderTable(
      createTestConfig({
        conwayApiKey: "cnwy_k_x",
        openaiApiKey: OPENAI_KEY,
        anthropicApiKey: ANTHROPIC_KEY,
        ollamaBaseUrl: "http://localhost:11434",
        providers: { ...providers, anthropic: { discover: true } },
      }),
      {},
    );
    expect(cw.entries.map((e) => [e.id, e.discover])).toEqual([
      ["openai", false],
      ["anthropic", true],
      ["ollama", false],
      ["groq", true],
      ["conway", false],
    ]);
    const off = resolveProviderTable(standalone({ openaiApiKey: OPENAI_KEY, providers: { openai: { discover: false } } }), {});
    expect(off.get("openai")?.discover).toBe(false);
  });

  it("free only on loopback: [::1] and 127.0.0.1 yes, a LAN host never (even if the flag slipped through)", () => {
    const t = resolveProviderTable(
      standalone({
        providers: {
          compatible: [
            { id: "v6", baseUrl: "http://[::1]:1234/v1", free: true },
            { id: "v4", baseUrl: "http://127.0.0.1:1234/v1", free: true },
            { id: "lan", baseUrl: "https://192.168.1.5/v1", free: true },
            { id: "unflagged", baseUrl: "http://localhost:1234/v1" },
          ],
        },
      }),
      {},
    );
    expect(t.isFree("v6")).toBe(true);
    expect(t.isFree("v4")).toBe(true);
    expect(t.isFree("lan")).toBe(false);
    expect(t.isFree("unflagged")).toBe(false);
    expect(t.isFree("missing")).toBe(false);
  });

  it("providers.openai.free applies only on a loopback baseUrl", () => {
    const local = resolveProviderTable(
      standalone({ openaiApiKey: "x", providers: { openai: { baseUrl: "http://localhost:8080/v1", free: true } } }),
      {},
    );
    expect(local.isFree("openai")).toBe(true);
    const remote = resolveProviderTable(standalone({ openaiApiKey: "x", providers: { openai: { free: true } } }), {});
    expect(remote.isFree("openai")).toBe(false);
  });

  it("Ollama on a LAN host stays free, with one warning naming the host", () => {
    StructuredLogger.setSink((e) => logs.push(e));
    const config = standalone({ ollamaBaseUrl: "http://10.1.2.77:11434" });
    const t = resolveProviderTable(config, {});
    resolveProviderTable(config, {});
    expect(t.get("ollama")).toMatchObject({ loopback: false, free: true });
    const warnings = logs.filter((l) => l.level === "warn" && l.message.includes("10.1.2.77"));
    expect(warnings).toHaveLength(1);
  });

  it("OLLAMA_BASE_URL in the environment wins over the config", () => {
    const t = resolveProviderTable(standalone({ ollamaBaseUrl: "http://localhost:1" }), { OLLAMA_BASE_URL: "http://127.0.0.1:2" });
    expect(t.get("ollama")?.baseUrl).toBe("http://127.0.0.1:2");
  });
});

describe("row ids", () => {
  it("providerIdForRow: provider_id, else the label; Conway's labels map to conway", () => {
    expect(providerIdForRow({ provider: "openai", providerId: "groq" })).toBe("groq");
    expect(providerIdForRow({ provider: "openai" })).toBe("openai");
    expect(providerIdForRow({ provider: "anthropic", providerId: null })).toBe("anthropic");
    expect(providerIdForRow({ provider: "ollama" })).toBe("ollama");
    expect(providerIdForRow({ provider: "conway" })).toBe("conway");
    expect(providerIdForRow({ provider: "other" })).toBe("conway");
  });

  it("compatible ids are qualified; built-in ones are bare", () => {
    expect(registryIdFor({ id: "groq", kind: "openai" }, "llama-3.3-70b-versatile")).toBe("groq/llama-3.3-70b-versatile");
    expect(registryIdFor({ id: "openrouter", kind: "openai" }, "anthropic/claude-opus-5-5")).toBe(
      "openrouter/anthropic/claude-opus-5-5",
    );
    expect(registryIdFor({ id: "openai", kind: "openai" }, "gpt-5.2")).toBe("gpt-5.2");
    expect(registryIdFor({ id: "anthropic", kind: "anthropic" }, "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(remoteIdForRow({ modelId: "groq/x" }, "groq")).toBe("x");
    expect(remoteIdForRow({ modelId: "groq/x", remoteId: "y" }, "groq")).toBe("y");
  });
});

describe("canServeModel", () => {
  it("standalone: needs the row's entry, a key or loopback, and the allowlist", () => {
    const t = resolveProviderTable(
      standalone({
        anthropicApiKey: ANTHROPIC_KEY,
        providers: {
          compatible: [
            { id: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: GROQ_KEY, models: [{ id: "llama" }] },
            { id: "nokey", baseUrl: "https://nokey.example/v1" },
            { id: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" },
          ],
        },
      }),
      {},
    );
    expect(canServeModel(t, model({ modelId: "claude-opus-5-5", provider: "anthropic" }))).toBe(true);
    expect(canServeModel(t, model({ modelId: "gpt-5.2", provider: "openai" }))).toBe(false);
    expect(canServeModel(t, model({ modelId: "groq/llama", providerId: "groq", remoteId: "llama" }))).toBe(true);
    expect(canServeModel(t, model({ modelId: "groq/other", providerId: "groq", remoteId: "other" }))).toBe(false);
    expect(canServeModel(t, model({ modelId: "nokey/m", providerId: "nokey" }))).toBe(false);
    expect(canServeModel(t, model({ modelId: "lmstudio/m", providerId: "lmstudio" }))).toBe(true);
    expect(canServeModel(t, model({ modelId: "x", provider: "other" }))).toBe(false);
    expect(canServeModel(t, model({ modelId: "c", provider: "conway", providerId: "conway" }))).toBe(false);
    // Disabled or unlisted rows are never served.
    expect(canServeModel(t, model({ modelId: "claude-opus-5-5", provider: "anthropic", enabled: false }))).toBe(false);
    expect(canServeModel(t, model({ modelId: "claude-opus-5-5", provider: "anthropic", listed: false }))).toBe(false);
  });

  it("serves Ollama on a non-loopback host (no key needed)", () => {
    const t = resolveProviderTable(standalone({ ollamaBaseUrl: "http://10.0.0.9:11434" }), {});
    expect(canServeModel(t, model({ modelId: "llama3", provider: "ollama" }))).toBe(true);
    expect(canServeModel(t, model({ modelId: "llama3", provider: "ollama", providerId: "ollama" }))).toBe(true);
  });

  it("Conway mode: legacy rows keep the old rule (provider key, else Conway)", () => {
    const t = resolveProviderTable(
      createTestConfig({ conwayApiKey: "cnwy_k_x", providers: { openai: { baseUrl: "https://llm.example/v1", models: [{ id: "a" }] } }, openaiApiKey: "k" }),
      {},
    );
    // The custom endpoint's allowlist did not apply in Conway mode: Conway can serve it.
    expect(canServeModel(t, model({ modelId: "gpt-5.2", provider: "openai" }))).toBe(true);
    expect(canServeModel(t, model({ modelId: "claude-x", provider: "anthropic" }))).toBe(true);
    expect(canServeModel(t, model({ modelId: "z", provider: "other" }))).toBe(true);
    expect(canServeModel(t, model({ modelId: "llama3", provider: "ollama" }))).toBe(false);
    expect(canServeModel(t, model({ modelId: "c", provider: "other", providerId: "conway" }))).toBe(true);
  });
});
