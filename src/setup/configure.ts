/**
 * Interactive Configuration Editor
 *
 * Menu-driven editor for all config sections. Complements --setup
 * (first-run) and --pick-model (model selection only) by letting
 * users update individual settings without re-running the full wizard.
 *
 * Usage: automaton --configure
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import chalk from "chalk";
import { loadConfig, saveConfig, resolvePath, ConfigError, dropConwayDefaults } from "../config.js";
import { DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { AutomatonConfig, ModelStrategyConfig, TreasuryPolicy, ModelEntry } from "../types.js";
import { closePrompts } from "./prompts.js";
import { createDatabase } from "../state/database.js";
import { ModelRegistry } from "../inference/registry.js";
import { getAutomatonDir } from "../identity/wallet.js";
import { writeFileSafe } from "../security/secure-fs.js";
import { formatInputPrice, pickableModels, providerLabel } from "./model-picker.js";

// ─── Readline helpers ─────────────────────────────────────────────

let rl: readline.Interface | null = null;

function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => getRL().question(prompt, (a) => resolve(a.trim())));
}

/**
 * Prompt for an optional string. Enter = keep current (undefined when there
 * is none, so an unset value is never read as a clear). "-" = clear (null).
 */
async function askString(
  label: string,
  current: string | undefined,
  required = false,
): Promise<string | null | undefined> {
  const display = current ? maskSecret(current) : chalk.dim("(not set)");
  const hint = required
    ? chalk.dim(" (Enter to keep)")
    : chalk.dim(" (Enter to keep, - to clear)");
  const raw = await ask(`  ${chalk.white("→")} ${label} ${chalk.dim("[" + display + "]")}${hint}: `);

  if (raw === "") return current ?? undefined;
  if (!required && raw === "-") return null;
  return raw;
}

/** Prompt for a required string. Enter = keep current. */
async function askRequiredString(label: string, current: string): Promise<string> {
  const result = await askString(label, current, true);
  return result ?? current;
}

/** Prompt for a number. Enter = keep current. */
async function askNumber(label: string, current: number): Promise<number> {
  const raw = await ask(
    `  ${chalk.white("→")} ${label} ${chalk.dim("[" + current + "]")}${chalk.dim(" (Enter to keep)")}: `,
  );
  if (raw === "") return current;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) {
    console.log(chalk.yellow(`  Invalid number, keeping ${current}`));
    return current;
  }
  return n;
}

/** Prompt for a boolean. Enter = keep current. */
async function askBool(label: string, current: boolean): Promise<boolean> {
  const display = current ? chalk.green("yes") : chalk.dim("no");
  const raw = await ask(
    `  ${chalk.white("→")} ${label} ${chalk.dim("[")}${display}${chalk.dim("]")}${chalk.dim(" (y/n, Enter to keep)")}: `,
  );
  if (raw === "") return current;
  if (raw === "y" || raw === "yes" || raw === "1" || raw === "true") return true;
  if (raw === "n" || raw === "no" || raw === "0" || raw === "false") return false;
  console.log(chalk.yellow("  Invalid input, keeping current value"));
  return current;
}

/** Prompt for a choice from a fixed set. */
async function askChoice<T extends string>(
  label: string,
  options: T[],
  current: T,
): Promise<T> {
  const display = options.map((o) => (o === current ? chalk.green(o) : chalk.dim(o))).join(" | ");
  const raw = await ask(`  ${chalk.white("→")} ${label} [${display}]${chalk.dim(" (Enter to keep)")}: `);
  if (raw === "") return current;
  if ((options as string[]).includes(raw)) return raw as T;
  console.log(chalk.yellow(`  Invalid choice, keeping "${current}"`));
  return current;
}

// ─── Model picker ─────────────────────────────────────────────────

function printModelTable(models: ModelEntry[], currentModelId: string, config: AutomatonConfig): void {
  const numWidth = String(models.length).length;
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const num = String(i + 1).padStart(numWidth);
    const provider = providerLabel(m.provider, config).padEnd(9);
    const cost =
      m.costPer1kInput === 0
        ? chalk.green("free     ")
        : chalk.dim(formatInputPrice(m.costPer1kInput));
    const active = m.modelId === currentModelId ? chalk.green(" ◀ active") : "";
    const tools = m.supportsTools ? "" : chalk.dim(" (no tools)");
    console.log(
      `  ${chalk.white(num + ".")} ${chalk.cyan(m.modelId.padEnd(36))} ${chalk.dim(provider)} ${cost}${tools}${active}`,
    );
  }
}

async function pickFromList(
  label: string,
  current: string,
  models: ModelEntry[],
  config: AutomatonConfig,
): Promise<string> {
  if (models.length === 0) {
    return askRequiredString(label, current);
  }
  console.log(chalk.cyan(`\n  ── Select ${label} ──\n`));
  printModelTable(models, current, config);
  console.log("");
  const raw = await ask(
    `  ${chalk.white("→")} Enter number ${chalk.dim("(Enter to keep " + current + ")")}: `,
  );
  if (raw === "") return current;
  const idx = parseInt(raw, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= models.length) {
    console.log(chalk.yellow(`  Invalid, keeping "${current}"`));
    return current;
  }
  return models[idx].modelId;
}

// ─── Display helpers ──────────────────────────────────────────────

/** Mask secrets: show first 8 chars + "***" + last 4 chars. */
function maskSecret(s: string | undefined): string {
  if (!s) return chalk.dim("(not set)");
  if (s.length <= 12) return s.slice(0, 4) + "***";
  return s.slice(0, 8) + "***" + s.slice(-4);
}

function dim(v: string | number | boolean | undefined): string {
  if (v === undefined || v === null || v === "") return chalk.dim("(not set)");
  return chalk.dim(String(v));
}

function val(v: string | number | boolean | undefined): string {
  if (v === undefined || v === null || v === "") return chalk.dim("(not set)");
  if (typeof v === "boolean") return v ? chalk.green("yes") : chalk.red("no");
  return chalk.white(String(v));
}

// ─── Main menu ────────────────────────────────────────────────────

function printMainMenu(config: AutomatonConfig): void {
  const providers = [
    config.openaiApiKey ? "OpenAI" : null,
    config.anthropicApiKey ? "Anthropic" : null,
    config.ollamaBaseUrl ? "Ollama" : null,
    config.conwayApiKey ? "Conway" : null,
  ].filter(Boolean).join(", ");

  const strategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG;

  console.log(chalk.cyan("  ┌────────────────────────────────────────────┐"));
  console.log(chalk.cyan("  │  Configure Automaton                        │"));
  console.log(chalk.cyan("  └────────────────────────────────────────────┘"));
  console.log("");
  console.log(`  ${chalk.white("1.")} Inference Providers   ${dim(providers)}`);
  console.log(`  ${chalk.white("2.")} Model Strategy        ${dim(config.inferenceModel)} / ${dim(strategy.maxTokensPerTurn + " tokens")}`);
  console.log(`  ${chalk.white("3.")} Treasury Policy       ${dim("max transfer: " + (config.treasuryPolicy?.maxSingleTransferCents ?? DEFAULT_TREASURY_POLICY.maxSingleTransferCents) + "¢")}`);
  console.log(`  ${chalk.white("4.")} General               ${dim(config.name)} / ${dim(config.logLevel)}`);
  console.log("");
  console.log(chalk.dim("  q  Quit"));
  console.log("");
}

// ─── Section: Inference Providers ────────────────────────────────

async function configureProviders(config: AutomatonConfig): Promise<void> {
  console.log(chalk.cyan("\n  ── Inference Providers ─────────────────────────\n"));
  console.log(chalk.dim("  Press Enter to keep the current value. Type - to clear an optional field.\n"));

  // Optional: with no Conway key the next run is standalone.
  const conwayKey = await askString("Conway API key  (cnwy_k_..., optional)", config.conwayApiKey);
  if (conwayKey === null) {
    config.conwayApiKey = "";
    forgetStoredConwayKey();
    // An explicit Conway mode with no key would not start.
    if (config.providers?.mode === "conway") config.providers = { ...config.providers, mode: "standalone" };
    // Conway's relay and payee defaults must not carry into standalone.
    dropConwayDefaults(config);
    // Pinned here, so CONWAY_API_KEY in the environment cannot bring Conway mode back.
    pinStandaloneWithoutConwayKey(config);
    console.log(chalk.yellow("  Conway key cleared: the next run is standalone with your own AI provider(s)."));
  } else if (conwayKey !== undefined) {
    config.conwayApiKey = conwayKey;
  }

  // Leaving standalone (and its daily cap ceiling) is only ever this explicit choice.
  const current = config.providers?.mode ?? "auto";
  const mode = await askChoice("Mode (auto: Conway when a Conway key is set)", ["auto", "standalone", "conway"], current);
  if (mode !== current) {
    const { mode: _mode, ...rest } = config.providers ?? {};
    config.providers = mode === "auto" ? rest : { ...rest, mode };
  }
  if (config.conwayApiKey && config.providers?.mode === "standalone") {
    console.log(chalk.yellow("  providers.mode is standalone: the Conway key is kept but not used."));
  }

  config.openaiApiKey = await askString("OpenAI API key  (sk-...)", config.openaiApiKey) || undefined;
  config.anthropicApiKey = await askString("Anthropic API key  (sk-ant-...)", config.anthropicApiKey) || undefined;
  config.ollamaBaseUrl = await askString("Ollama base URL  (http://localhost:11434)", config.ollamaBaseUrl) || undefined;

  if (!config.conwayApiKey && !config.openaiApiKey && !config.anthropicApiKey && !config.ollamaBaseUrl) {
    console.log(chalk.yellow("  No AI provider configured: the automaton will not start until you add one."));
  }
  console.log("");
}

// ─── Section: Model Strategy ──────────────────────────────────────

async function configureModelStrategy(config: AutomatonConfig): Promise<void> {
  console.log(chalk.cyan("\n  ── Model Strategy ──────────────────────────────\n"));

  // Load available models from registry + Ollama
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);
  const registry = new ModelRegistry(db.raw);
  registry.initialize();

  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;
  if (ollamaBaseUrl) {
    console.log(chalk.dim(`  Checking Ollama at ${ollamaBaseUrl}...`));
    const { discoverOllamaModels } = await import("../ollama/discover.js");
    await discoverOllamaModels(ollamaBaseUrl, db.raw);
  }

  const models = pickableModels(registry.getAll().filter((m) => m.enabled), config);
  db.close();

  const s: ModelStrategyConfig = {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...(config.modelStrategy ?? {}),
  };

  config.inferenceModel = await pickFromList("Active model", config.inferenceModel, models, config);
  s.inferenceModel = config.inferenceModel;
  s.lowComputeModel = await pickFromList("Low-compute fallback", s.lowComputeModel, models, config);
  s.criticalModel = await pickFromList("Critical fallback", s.criticalModel, models, config);


  const maxTokens = await askNumber("Max tokens per turn", s.maxTokensPerTurn);
  s.maxTokensPerTurn = maxTokens;
  config.maxTokensPerTurn = maxTokens;

  s.hourlyBudgetCents = await askNumber(
    "Hourly inference budget (cents, 0 = derived from the daily cap: daily / 6)",
    s.hourlyBudgetCents,
  );
  s.sessionBudgetCents = await askNumber(
    "Inference budget per wake cycle (cents, 0 = unlimited)",
    s.sessionBudgetCents,
  );
  s.orchestrationSharePct = await askNumber(
    "Share of the hourly and daily inference caps workers and planning may use (%)",
    s.orchestrationSharePct ?? 50,
  );
  s.survivalAllowanceCents = await askNumber(
    "Survival allowance once the caps are spent (cents per 24h, 0 = off)",
    s.survivalAllowanceCents ?? 25,
  );
  s.perCallCeilingCents = await askNumber(
    "Per-call ceiling (cents, 0 = unlimited)",
    s.perCallCeilingCents,
  );
  s.enableModelFallback = await askBool("Enable model fallback", s.enableModelFallback);

  config.modelStrategy = s;
  console.log("");
}

// ─── Section: Treasury Policy ─────────────────────────────────────

async function configureTreasury(config: AutomatonConfig): Promise<void> {
  console.log(chalk.cyan("\n  ── Treasury Policy ─────────────────────────────\n"));
  console.log(chalk.dim("  All values are in cents (100 cents = $1.00).\n"));

  const t: TreasuryPolicy = {
    ...DEFAULT_TREASURY_POLICY,
    ...(config.treasuryPolicy ?? {}),
  };
  // No payee list means the mode's default on load; do not fill in Conway's.
  if (config.treasuryPolicy && !("x402AllowedDomains" in config.treasuryPolicy)) {
    delete (t as Partial<TreasuryPolicy>).x402AllowedDomains;
  }

  t.maxSingleTransferCents = await askNumber("Max single transfer", t.maxSingleTransferCents);
  t.maxHourlyTransferCents = await askNumber("Max hourly transfers", t.maxHourlyTransferCents);
  t.maxDailyTransferCents = await askNumber("Max daily transfers", t.maxDailyTransferCents);
  t.minimumReserveCents = await askNumber("Minimum reserve", t.minimumReserveCents);
  t.maxX402PaymentCents = await askNumber("Max x402 payment", t.maxX402PaymentCents);
  t.maxInferenceDailyCents = await askNumber(
    "Max inference spend per rolling 24h (0 = paid inference off)",
    t.maxInferenceDailyCents,
  );
  t.requireConfirmationAboveCents = await askNumber(
    "Require confirmation above",
    t.requireConfirmationAboveCents,
  );

  config.treasuryPolicy = t;
  console.log("");
}

// ─── Section: General ─────────────────────────────────────────────

async function configureGeneral(config: AutomatonConfig): Promise<void> {
  console.log(chalk.cyan("\n  ── General ─────────────────────────────────────\n"));

  config.name = await askRequiredString("Agent name", config.name);
  config.logLevel = await askChoice(
    "Log level",
    ["debug", "info", "warn", "error"] as const,
    config.logLevel,
  );
  config.maxChildren = await askNumber("Max child automatons", config.maxChildren);
  // A cleared relay is stored as "": an absent key would load the default relay again.
  const relay = await askString("Social relay URL", config.socialRelayUrl);
  config.socialRelayUrl = relay === null ? "" : relay;
  config.rpcUrl = (await askString("RPC endpoint  (Base chain, e.g. https://mainnet.base.org)", config.rpcUrl)) || undefined;

  console.log("");
}

// ─── Save ─────────────────────────────────────────────────────────

/**
 * With no Conway key, "auto" would let a key stored later (by --provision or
 * another tool) switch the next start to Conway mode, which has no daily cap
 * ceiling. An explicit standalone mode survives that; only the Mode question
 * leaves it. Returns true when it set the mode.
 */
export function pinStandaloneWithoutConwayKey(config: AutomatonConfig): boolean {
  if ((config.conwayApiKey ?? "").trim() !== "") return false;
  if (config.providers?.mode === "conway" || config.providers?.mode === "standalone") return false;
  config.providers = { ...(config.providers ?? {}), mode: "standalone" };
  return true;
}

function saveConfigured(config: AutomatonConfig): void {
  if (pinStandaloneWithoutConwayKey(config)) {
    console.log(chalk.dim('  providers.mode saved as "standalone": an API key for a hosted account added later stays unused until you change the mode.'));
  }
  saveConfig(config);
}

// ─── Stored Conway key ────────────────────────────────────────────

/**
 * Drop the provisioned key from ~/.automaton/config.json. The runtime falls
 * back to that file when automaton.json has no key, so clearing only
 * automaton.json would leave the next run in Conway mode. The wallet address
 * recorded there is kept. Returns true when a key was removed.
 */
export function forgetStoredConwayKey(): boolean {
  const configPath = path.join(getAutomatonDir(), "config.json");
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    data = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!("apiKey" in data)) return false;
  delete data.apiKey;
  writeFileSafe(configPath, JSON.stringify(data, null, 2), { trustedWriter: true, mode: 0o600 });
  return true;
}

// ─── Entry point ──────────────────────────────────────────────────

export async function runConfigure(): Promise<void> {
  let config: AutomatonConfig | null;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.log(chalk.red(`  automaton.json cannot be read: ${err.message}\n  Fix or restore it, then try again.\n`));
    process.exitCode = 1;
    return;
  }
  if (!config) {
    console.log(chalk.red("  Automaton is not configured. Run: automaton --setup\n"));
    return;
  }

  let running = true;
  while (running) {
    printMainMenu(config);

    const choice = await ask(`  ${chalk.white("→")} Choice: `);

    switch (choice) {
      case "1":
        await configureProviders(config);
        saveConfigured(config);
        console.log(chalk.green("  ✓ Providers saved.\n"));
        break;
      case "2":
        await configureModelStrategy(config);
        saveConfigured(config);
        console.log(chalk.green("  ✓ Model strategy saved.\n"));
        break;
      case "3":
        await configureTreasury(config);
        saveConfigured(config);
        console.log(chalk.green("  ✓ Treasury policy saved.\n"));
        break;
      case "4":
        await configureGeneral(config);
        saveConfigured(config);
        console.log(chalk.green("  ✓ General settings saved.\n"));
        break;
      case "q":
      case "":
        running = false;
        break;
      default:
        console.log(chalk.yellow(`  Unknown option: "${choice}". Enter 1-4 or q.\n`));
    }
  }

  if (rl) { rl.close(); rl = null; }
  closePrompts();
  console.log(chalk.dim("  Done. Restart the automaton to apply changes.\n"));
}
