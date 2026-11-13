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
  Pick<AutomatonConfig, "conwayApiKey" | "openaiApiKey" | "anthropicApiKey" | "ollamaBaseUrl">
>;

/**
 * Models the configured providers can serve. A Conway key serves every row
 * (Conway proxies all providers), so a keyed install lists what it always
 * did; without one, only rows whose own provider has a credential.
 */
export function pickableModels(
  models: ModelEntry[],
  config: ProviderCredentials,
  env: NodeJS.ProcessEnv = process.env,
): ModelEntry[] {
  if (config.conwayApiKey) return models;
  const has: Record<string, boolean> = {
    openai: !!config.openaiApiKey,
    anthropic: !!config.anthropicApiKey,
    ollama: !!(env.OLLAMA_BASE_URL || config.ollamaBaseUrl),
  };
  return models.filter((m) => has[m.provider] === true);
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
  const registry = new ModelRegistry(db.raw);
  registry.initialize();

  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;
  if (ollamaBaseUrl) {
    console.log(chalk.dim(`  Checking Ollama at ${ollamaBaseUrl}...`));
    await discoverOllamaModels(ollamaBaseUrl, db.raw);
  }

  const models = pickableModels(registry.getAll().filter((m) => m.enabled), config);

  if (models.length === 0) {
    console.log(chalk.yellow("  No models available for your configured providers."));
    db.close();
    closePrompts();
    return;
  }

  console.log(chalk.cyan("\n  Available Models\n"));
  printModelTable(models, config.inferenceModel, config);

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

function printModelTable(models: ModelEntry[], currentModelId: string, config: ProviderCredentials): void {
  const numWidth = String(models.length).length;

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const num = String(i + 1).padStart(numWidth);
    const provider = providerLabel(m.provider, config).padEnd(9);
    const cost = m.costPer1kInput === 0
      ? chalk.green("free     ")
      : chalk.dim(formatInputPrice(m.costPer1kInput));
    const active = m.modelId === currentModelId ? chalk.green(" ◀ active") : "";
    const tools = m.supportsTools ? "" : chalk.dim(" (no tools)");

    console.log(
      `  ${chalk.white(num + ".")} ${chalk.cyan(m.modelId.padEnd(32))} ${chalk.dim(provider)} ${cost}${tools}${active}`,
    );
  }
}
