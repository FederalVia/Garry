/**
 * Interactive Model Picker
 *
 * Presents a numbered list of available models and lets the user
 * pick one to set as the active inference model.
 *
 * Usage: automaton --pick-model
 */

import chalk from "chalk";
import { loadConfig, saveConfig, resolvePath, ConfigError } from "../config.js";
import { createDatabase } from "../state/database.js";
import { ModelRegistry } from "../inference/registry.js";
import { discoverOllamaModels } from "../ollama/discover.js";
import { canServeModel, providerIdForRow, resolveProviderTable, type ProviderTable } from "../providers/table.js";
import { refreshProviderModels } from "../providers/discovery.js";
import type { AutomatonConfig, ModelEntry } from "../types.js";
import { promptOptional, closePrompts } from "./prompts.js";

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  conway: "Conway",
  ollama: "Ollama",
  other: "Other",
};

export type ProviderCredentials = Partial<
  Pick<AutomatonConfig, "conwayApiKey" | "openaiApiKey" | "anthropicApiKey" | "ollamaBaseUrl" | "providers">
>;

function tableFor(config: ProviderCredentials, env: NodeJS.ProcessEnv): ProviderTable | null {
  try {
    return resolveProviderTable(config as AutomatonConfig, env);
  } catch {
    return null;
  }
}

/**
 * Models the configured providers can serve. A Conway key serves every row
 * (Conway proxies all providers), so a keyed install lists what it always
 * did; without one, the provider table's serve rule decides, so a compatible
 * entry's models appear and an unservable baseline row does not.
 */
export function pickableModels(
  models: ModelEntry[],
  config: ProviderCredentials,
  env: NodeJS.ProcessEnv = process.env,
): ModelEntry[] {
  if (config.conwayApiKey) return models;
  const table = tableFor(config, env);
  if (table) return models.filter((m) => canServeModel(table, m));
  const has: Record<string, boolean> = {
    openai: !!config.openaiApiKey,
    anthropic: !!config.anthropicApiKey,
    ollama: !!(env.OLLAMA_BASE_URL || config.ollamaBaseUrl),
  };
  return models.filter((m) => has[m.provider] === true);
}

/** A row's provider label: a compatible entry by its name. */
export function rowProviderLabel(m: ModelEntry, config: ProviderCredentials, table?: ProviderTable | null): string {
  const id = m.providerId ? providerIdForRow(m) : undefined;
  const entry = id ? table?.get(id) : undefined;
  if (entry && entry.kind === "openai" && entry.id !== "openai") return entry.label;
  return providerLabel(m.provider, config);
}

/** Provider column label; "Conway" is shown only when a Conway key is set. */
export function providerLabel(provider: string, config: ProviderCredentials): string {
  if (provider === "conway" && !config.conwayApiKey) return provider;
  return PROVIDER_LABEL[provider] || provider;
}

/**
 * Input price per million tokens. costPer1kInput is in hundredths of a cent
 * per 1k tokens, so dollars per million is c / 10.
 */
export function formatInputPrice(costPer1kInput: number): string {
  return `$${(costPer1kInput / 10).toFixed(2)}/M in`;
}

export async function runModelPicker(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.log(chalk.red(`  automaton.json cannot be read: ${err.message}\n  Fix or restore it, then try again.`));
    process.exitCode = 1;
    return;
  }
  if (!config) {
    console.log(chalk.red("  Automaton is not configured. Run: automaton --setup"));
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Seed static baseline + discover Ollama models
  const table = resolveProviderTable(config);
  const registry = new ModelRegistry(db.raw, { table, config });
  registry.initialize();
  registry.seedFromPriceTable(table);

  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;
  if (ollamaBaseUrl) {
    console.log(chalk.dim(`  Checking Ollama at ${ollamaBaseUrl}...`));
    await discoverOllamaModels(ollamaBaseUrl, db.raw);
  }
  // A fresh list from every provider that lists its models, cache or not.
  const discoverIds = table.entries
    .filter((e) => e.discover && e.kind !== "ollama" && e.kind !== "conway")
    .map((e) => e.id);
  if (discoverIds.length > 0) {
    console.log(chalk.dim(`  Fetching model lists from ${discoverIds.join(", ")}...`));
    try {
      await refreshProviderModels(table, registry, db, { providerIds: discoverIds, force: true });
    } catch {
      console.log(chalk.yellow("  Some model lists could not be fetched; showing the models already known."));
    }
  }

  const models = pickableModels(
    registry.getAll().filter((m) => m.enabled && m.listed !== false),
    config,
  );

  if (models.length === 0) {
    console.log(chalk.yellow("  No models available for your configured providers."));
    db.close();
    closePrompts();
    return;
  }

  console.log(chalk.cyan("\n  Available Models\n"));
  printModelTable(models, config.inferenceModel, config, table);

  console.log("");
  const input = await promptOptional("Enter model number (or press Enter to cancel)");
  closePrompts();

  if (!input) {
    console.log(chalk.dim("  Cancelled."));
    db.close();
    return;
  }

  const idx = parseInt(input, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= models.length) {
    console.log(chalk.red(`  Invalid selection: "${input}"`));
    db.close();
    return;
  }

  const selected = models[idx];
  config.inferenceModel = selected.modelId;
  if (config.modelStrategy) {
    config.modelStrategy.inferenceModel = selected.modelId;
  }
  saveConfig(config);

  console.log(chalk.green(`\n  Active model set to: ${selected.modelId} (${selected.displayName})`));
  console.log(chalk.dim("  Restart the automaton for the change to take effect.\n"));

  db.close();
}

function printModelTable(
  models: ModelEntry[],
  currentModelId: string,
  config: ProviderCredentials,
  table?: ProviderTable,
): void {
  const numWidth = String(models.length).length;

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const num = String(i + 1).padStart(numWidth);
    const provider = rowProviderLabel(m, config, table).padEnd(9);
    const free = m.free === true || m.provider === "ollama";
    const cost = free
      ? chalk.green("free     ")
      : m.costPer1kInput > 0
        ? chalk.dim(formatInputPrice(m.costPer1kInput))
        : chalk.yellow("no price ");
    const active = m.modelId === currentModelId ? chalk.green(" ◀ active") : "";
    const tools = m.supportsTools ? "" : chalk.dim(" (no tools)");

    console.log(
      `  ${chalk.white(num + ".")} ${chalk.cyan(m.modelId.padEnd(32))} ${chalk.dim(provider)} ${cost}${tools}${active}`,
    );
  }
}
