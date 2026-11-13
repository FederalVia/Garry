/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy, ModelStrategyConfig, SoulConfig } from "./types.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_SOUL_CONFIG } from "./types.js";
import { normalizeTreasuryPolicy } from "./treasury/policy.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";
import { writeFileSafe } from "./security/secure-fs.js";
import { registerSecret } from "./security/secret-redaction.js";
import type { ChainType } from "./identity/chain.js";
import { setConfigSources, type ValueSource } from "./providers/mode.js";
import { isFixedSurvivalTier } from "./providers/survival-source.js";

const logger = createLogger("config");
const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/** automaton.json exists but cannot be read or parsed. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly configPath: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function readRawConfig(configPath: string): Record<string, any> {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (err: any) {
    throw new ConfigError(`${configPath} cannot be read: ${err?.message || String(err)}`, configPath);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: any) {
    throw new ConfigError(`${configPath} is not valid JSON: ${err?.message || String(err)}`, configPath);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${configPath} does not hold a JSON object`, configPath);
  }
  return raw as Record<string, any>;
}

type Raw = Record<string, any>;

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function isPlainObject(v: unknown): v is Raw {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** https, or http on loopback, with no userinfo. */
function isAcceptableBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/** Refuse a providers block that would be read wrongly. */
function validateProviders(block: unknown, configPath: string): void {
  if (block === undefined) return;
  const fail = (msg: string): never => {
    throw new ConfigError(`${configPath}: providers.${msg}`, configPath);
  };
  if (!isPlainObject(block)) fail("must be an object");
  const p = block as Raw;
  if (p.mode !== undefined && p.mode !== "standalone" && p.mode !== "conway") {
    fail(`mode must be "standalone" or "conway" (got ${JSON.stringify(p.mode)})`);
  }
  for (const [name, field] of [
    ["openai", "baseUrl"],
    ["ollama", "baseUrl"],
    ["conway", "apiUrl"],
  ] as const) {
    if (p[name] === undefined) continue;
    if (!isPlainObject(p[name])) fail(`${name} must be an object`);
    const url = p[name][field];
    if (url !== undefined && (typeof url !== "string" || (url.trim() !== "" && !isAcceptableBaseUrl(url.trim())))) {
      fail(`${name}.${field} must be an https URL, or http on localhost`);
    }
  }
  if (p.anthropic !== undefined && !isPlainObject(p.anthropic)) fail("anthropic must be an object");
  for (const name of ["openai", "anthropic", "conway"] as const) {
    const key = p[name]?.apiKey;
    if (key !== undefined && typeof key !== "string") fail(`${name}.apiKey must be a string`);
  }
  const models = p.openai?.models;
  if (models !== undefined) {
    if (!Array.isArray(models)) fail("openai.models must be a list");
    models.forEach((m: unknown, i: number) => {
      if (!isPlainObject(m) || typeof m.id !== "string" || m.id.trim() === "") fail(`openai.models[${i}] needs an id`);
      for (const k of ["inputUsdPerM", "outputUsdPerM"]) {
        const v = (m as Raw)[k];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
          fail(`openai.models[${i}].${k} must be a number >= 0`);
        }
      }
      const tier = (m as Raw).tierMinimum;
      if (tier !== undefined && !["high", "normal", "low_compute", "critical"].includes(tier)) {
        fail(`openai.models[${i}].tierMinimum must be high, normal, low_compute or critical`);
      }
    });
  }
  if (p.survival !== undefined) {
    if (!isPlainObject(p.survival)) fail("survival must be an object");
    const { source, fixedTier } = p.survival;
    if (source !== undefined && source !== "fixed" && source !== "conway") fail('survival.source must be "fixed" or "conway"');
    if (fixedTier !== undefined && !isFixedSurvivalTier(fixedTier)) {
      fail("survival.fixedTier must be high, normal, low_compute or critical");
    }
  }
  const ceiling = p.dailyCapCeilingCents;
  if (ceiling !== undefined && (typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling < 0)) {
    fail("dailyCapCeilingCents must be a whole number of cents >= 0");
  }
  if (p.payments !== undefined && typeof p.payments !== "boolean") fail("payments must be true or false");
  const relay = p.relayUrl;
  if (relay !== undefined && (typeof relay !== "string" || (relay.trim() !== "" && !isAcceptableBaseUrl(relay.trim())))) {
    fail("relayUrl must be an https URL, or http on localhost");
  }
}

/**
 * Values loadConfig derived rather than read from the flat field itself
 * (from the environment, the providers block or a mode default). saveConfig
 * writes back what the file held for any of them left unchanged, so an
 * environment key or a mode default never lands in automaton.json.
 */
interface Derived {
  value: unknown;
  /** The field as the file had it (undefined: absent). */
  fileValue: unknown;
}
const DERIVED = Symbol.for("automaton.config.derived");

function derivedOf(config: AutomatonConfig): Map<string, Derived> | undefined {
  return (config as any)[DERIVED] as Map<string, Derived> | undefined;
}

/**
 * True when socialRelayUrl was filled in by loadConfig (Conway mode's
 * default, or "" in standalone) rather than set by the operator in the file
 * or in providers.relayUrl. A Conway default dropped in standalone counts as
 * filled in, so the operator CLI never reports it as the file's own "".
 */
export function relayUrlIsDefaulted(config: AutomatonConfig): boolean {
  const d = derivedOf(config)?.get("socialRelayUrl");
  if (!d) return false;
  const optIn = nonEmpty(config.providers?.relayUrl);
  return !(optIn && d.value === optIn);
}

/** First non-empty value, with its source. */
function pick(...candidates: Array<[ValueSource, unknown]>): { value?: string; source?: ValueSource } {
  for (const [source, v] of candidates) {
    const s = nonEmpty(v);
    if (s) return { value: s, source };
  }
  return {};
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields, resolves each provider value
 * (environment, providers block, flat field) into the flat alias fields, and
 * applies the standalone-mode defaults.
 * Returns null only when the file does not exist; an unreadable or corrupt
 * file throws ConfigError (a corrupt config must never look like a first run).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AutomatonConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const raw = readRawConfig(configPath);
  validateProviders(raw.providers, configPath);
  const block: Raw = isPlainObject(raw.providers) ? raw.providers : {};

  // Precedence, highest first. Keys are registered for redaction, never logged.
  const conwayKey = pick(
    ["env", env.CONWAY_API_KEY],
    ["providers", block.conway?.apiKey],
    ["flat", raw.conwayApiKey],
  );
  if (!conwayKey.value) {
    const fromFile = loadApiKeyFromConfig();
    if (fromFile) Object.assign(conwayKey, { value: fromFile, source: "config.json" as ValueSource });
  }
  const conwayUrl = pick(["env", env.CONWAY_API_URL], ["providers", block.conway?.apiUrl], ["flat", raw.conwayApiUrl]);
  // Mode, as resolveRuntime will decide it.
  const mode =
    block.mode === "conway" || block.mode === "standalone" ? block.mode : conwayKey.value ? "conway" : "standalone";
  // OPENAI_API_KEY from the environment is a standalone fallback only: in
  // Conway mode it would move the main loop's OpenAI calls off Conway.
  const openaiKey = pick(
    ["providers", block.openai?.apiKey],
    ["flat", raw.openaiApiKey],
    ["env", mode === "standalone" ? env.OPENAI_API_KEY : undefined],
  );
  const anthropicKey = pick(["providers", block.anthropic?.apiKey], ["flat", raw.anthropicApiKey]);
  const ollamaUrl = pick(["env", env.OLLAMA_BASE_URL], ["providers", block.ollama?.baseUrl], ["flat", raw.ollamaBaseUrl]);
  for (const v of [env.CONWAY_API_KEY, block.conway?.apiKey, raw.conwayApiKey, conwayKey.value]) {
    registerSecret(v, "conway-api-key");
  }
  for (const v of [block.openai?.apiKey, raw.openaiApiKey, env.OPENAI_API_KEY]) registerSecret(v, "openai-api-key");
  for (const v of [block.anthropic?.apiKey, raw.anthropicApiKey]) registerSecret(v, "anthropic-api-key");

  const derived = new Map<string, Derived>();
  const resolved = (field: string, r: { value?: string; source?: ValueSource }, fallback?: string): string | undefined => {
    const value = r.value ?? fallback;
    // A value from the environment or the providers block is not the flat field's own.
    if (r.source === "env" || r.source === "providers") derived.set(field, { value, fileValue: raw[field] });
    return value;
  };

  // Every field a finite number >= 0 (whatever its type), else the default.
  // Standalone starts with no x402 payees; an explicit list is kept.
  // Conway's defaults saved by older versions count as absent in standalone.
  const rawTreasury = raw.treasuryPolicy;
  const standaloneView: Raw = { socialRelayUrl: raw.socialRelayUrl, treasuryPolicy: rawTreasury };
  if (mode === "standalone") dropConwayDefaults(standaloneView);
  const treasuryPolicy: TreasuryPolicy = normalizeTreasuryPolicy(
    standaloneView.treasuryPolicy,
    mode === "standalone" ? { x402DefaultDomains: [] } : {},
  );
  const rawDomains = isPlainObject(standaloneView.treasuryPolicy) ? standaloneView.treasuryPolicy.x402AllowedDomains : undefined;
  // A mode default, in either mode, is never written back: a Conway default
  // saved into the file would follow the agent into standalone.
  if (rawDomains === undefined) {
    derived.set("treasuryPolicy.x402AllowedDomains", { value: treasuryPolicy.x402AllowedDomains, fileValue: undefined });
  }

  // Deep-merge model strategy config with defaults
  const modelStrategy: ModelStrategyConfig = {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...(raw.modelStrategy ?? {}),
  };

  // Deep-merge soul config with defaults
  const soulConfig: SoulConfig = {
    ...DEFAULT_SOUL_CONFIG,
    ...(raw.soulConfig ?? {}),
  };

  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    // Conway-only; a hand-written standalone config leaves it out.
    sandboxId: typeof raw.sandboxId === "string" ? raw.sandboxId.trim() : "",
    conwayApiKey: resolved("conwayApiKey", conwayKey) ?? null,
    conwayApiUrl: resolved("conwayApiUrl", conwayUrl, DEFAULT_CONFIG.conwayApiUrl),
    openaiApiKey: resolved("openaiApiKey", openaiKey),
    anthropicApiKey: resolved("anthropicApiKey", anthropicKey),
    ollamaBaseUrl: resolved("ollamaBaseUrl", ollamaUrl),
    treasuryPolicy,
    modelStrategy,
    soulConfig,
  } as AutomatonConfig;

  // The relay is off in standalone unless a URL is set; an explicit "" survives
  // a reload. Conway's relay URL (which older saves wrote for every install)
  // turns it on in standalone only through providers.relayUrl.
  const relayOptIn = mode === "standalone" ? nonEmpty(block.relayUrl) : undefined;
  if (relayOptIn) {
    config.socialRelayUrl = relayOptIn;
    derived.set("socialRelayUrl", { value: relayOptIn, fileValue: raw.socialRelayUrl });
  } else if (standaloneView.socialRelayUrl === undefined) {
    if (mode === "standalone") config.socialRelayUrl = "";
    derived.set("socialRelayUrl", { value: config.socialRelayUrl, fileValue: raw.socialRelayUrl });
  }

  Object.defineProperty(config, DERIVED, { value: derived, enumerable: false, configurable: true });
  setConfigSources(config, {
    conwayApiKey: conwayKey.source,
    conwayApiUrl: conwayUrl.source,
    openaiApiKey: openaiKey.source,
    anthropicApiKey: anthropicKey.source,
    ollamaBaseUrl: ollamaUrl.source,
  });
  return config;
}

/** Keys the running agent may change in automaton.json. */
export interface RuntimeConfigPatch {
  genesisPrompt?: string;
  inferenceModel?: string;
}

/**
 * Change only the given keys in automaton.json, re-read from disk right
 * before the write, so edits the operator made since startup (treasury
 * limits, keys, URLs) are kept. inferenceModel also updates
 * modelStrategy.inferenceModel when the file has a modelStrategy. Throws,
 * writing nothing, when the file is missing or corrupt. The write is atomic.
 */
export function updateConfigFile(patch: RuntimeConfigPatch): void {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`${configPath} does not exist`, configPath);
  }
  const raw = readRawConfig(configPath);
  if (patch.genesisPrompt !== undefined) {
    raw.genesisPrompt = patch.genesisPrompt;
  }
  if (patch.inferenceModel !== undefined) {
    raw.inferenceModel = patch.inferenceModel;
    if (raw.modelStrategy && typeof raw.modelStrategy === "object" && !Array.isArray(raw.modelStrategy)) {
      raw.modelStrategy.inferenceModel = patch.inferenceModel;
    }
  }
  writeFileSafe(configPath, JSON.stringify(raw, null, 2), { trustedWriter: true, mode: 0o600 });
}

/** Provider values the providers block may hold, and their flat aliases. */
const BLOCK_ALIASES: ReadonlyArray<[keyof AutomatonConfig, string, string]> = [
  ["conwayApiKey", "conway", "apiKey"],
  ["conwayApiUrl", "conway", "apiUrl"],
  ["openaiApiKey", "openai", "apiKey"],
  ["anthropicApiKey", "anthropic", "apiKey"],
  ["ollamaBaseUrl", "ollama", "baseUrl"],
];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Save the automaton config to disk.
 * Includes treasuryPolicy in the persisted config. Values loadConfig took
 * from the environment or a mode default are written back as the file had
 * them unless they were changed; when the file has a providers block, an
 * edited flat value also replaces the block's value, so it is never shadowed.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave: Raw = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };

  const derived = derivedOf(config);
  const unchanged = new Set<string>();
  for (const [field, d] of derived ?? []) {
    if (field === "treasuryPolicy.x402AllowedDomains") {
      if (toSave.treasuryPolicy && sameValue(toSave.treasuryPolicy.x402AllowedDomains, d.value)) {
        toSave.treasuryPolicy = { ...toSave.treasuryPolicy };
        delete toSave.treasuryPolicy.x402AllowedDomains;
      }
      continue;
    }
    if (!sameValue(toSave[field], d.value)) continue;
    unchanged.add(field);
    if (d.fileValue === undefined) delete toSave[field];
    else toSave[field] = d.fileValue;
  }

  if (isPlainObject(config.providers)) {
    const block: Raw = JSON.parse(JSON.stringify(config.providers));
    for (const [field, provider, key] of BLOCK_ALIASES) {
      if (unchanged.has(field as string)) continue;
      const current = block[provider]?.[key];
      if (current === undefined) continue;
      // The block holds this value: the edit goes there, and the flat field
      // keeps what the file had (the block wins on load).
      const flat = (config as Raw)[field as string];
      block[provider] = { ...(block[provider] ?? {}), [key]: flat ?? "" };
      const fileValue = derived?.get(field as string)?.fileValue;
      if (fileValue === undefined) delete toSave[field as string];
      else toSave[field as string] = fileValue;
    }
    toSave.providers = block;
  }

  // Temp file + rename: a link at automaton.json is refused, not written through.
  writeFileSafe(configPath, JSON.stringify(toSave, null, 2), { trustedWriter: true, mode: 0o600 });
}

/**
 * Remove the Conway relay URL and x402 payee list when they hold Conway's
 * defaults (older saves wrote them), so leaving Conway does not keep the
 * relay on or Conway as a payee. Edited values are kept.
 */
export function dropConwayDefaults(target: { socialRelayUrl?: string; treasuryPolicy?: unknown }): void {
  if (target.socialRelayUrl === DEFAULT_CONFIG.socialRelayUrl) delete target.socialRelayUrl;
  const tp = target.treasuryPolicy;
  if (isPlainObject(tp) && sameValue(tp.x402AllowedDomains, DEFAULT_TREASURY_POLICY.x402AllowedDomains)) {
    const { x402AllowedDomains: _drop, ...rest } = tp;
    target.treasuryPolicy = rest;
  }
}

/**
 * Operator-only (never part of RuntimeConfigPatch): store a new Conway key
 * in automaton.json, where the runtime reads it, so a re-provisioned key is
 * not shadowed by the old one. The key goes into providers.conway.apiKey
 * when that holds the key, else into conwayApiKey. An empty key clears it
 * and sets providers.mode to "standalone", since a key provisioned into
 * ~/.automaton/config.json would otherwise still select Conway mode. A new
 * key never lifts an explicit providers.mode "standalone": only the operator
 * changing the mode leaves standalone (and its daily cap ceiling).
 * Does nothing when automaton.json does not exist.
 */
export function setConwayApiKey(key: string): boolean {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return false;
  const raw = readRawConfig(configPath);
  const k = key.trim();
  registerSecret(k, "conway-api-key");
  const block: Raw | undefined = isPlainObject(raw.providers) ? raw.providers : undefined;
  if (k) {
    if (block && isPlainObject(block.conway) && nonEmpty(block.conway.apiKey)) {
      block.conway.apiKey = k;
    } else {
      raw.conwayApiKey = k;
    }
  } else {
    delete raw.conwayApiKey;
    if (block && isPlainObject(block.conway)) delete block.conway.apiKey;
    raw.providers = { ...(block ?? {}), mode: "standalone" };
    dropConwayDefaults(raw);
  }
  writeFileSafe(configPath, JSON.stringify(raw, null, 2), { trustedWriter: true, mode: 0o600 });
  return true;
}

/**
 * Write providers.mode "standalone" into automaton.json when it sets no mode
 * and holds no Conway key, so a key stored later (config.json, the
 * environment) cannot switch a running standalone install to Conway mode,
 * which has no daily cap ceiling. Only the operator changing the mode leaves
 * standalone after that. Re-reads the file first; returns true when it wrote.
 */
export function pinStandaloneModeInFile(): boolean {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return false;
  const raw = readRawConfig(configPath);
  const block: Raw = isPlainObject(raw.providers) ? raw.providers : {};
  if (block.mode === "conway" || block.mode === "standalone") return false;
  // A key the operator put in the file since startup is their choice, not drift.
  if (nonEmpty(raw.conwayApiKey) || nonEmpty(block.conway?.apiKey)) return false;
  raw.providers = { ...block, mode: "standalone" };
  writeFileSafe(configPath, JSON.stringify(raw, null, 2), { trustedWriter: true, mode: 0o600 });
  return true;
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredWithConway: boolean;
  sandboxId: string;
  walletAddress: string;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  parentAddress?: string;
  treasuryPolicy?: TreasuryPolicy;
  chainType?: ChainType;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: params.registeredWithConway,
    sandboxId: normalizedSandboxId,
    // The wizard saves the host it provisioned against.
    conwayApiUrl:
      nonEmpty(process.env.CONWAY_API_URL) || DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: params.apiKey,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "gpt-5.2",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    chainType: params.chainType || "evm",
  };
}
