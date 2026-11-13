import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { AutomatonConfig, TreasuryPolicy } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { provision } from "../identity/provision.js";
import { createConfig, saveConfig } from "../config.js";
import { writeFileSafe } from "../security/secure-fs.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { showBanner } from "./banner.js";
import {
  promptRequired,
  promptMultiline,
  promptAddress,
  promptOptional,
  promptWithDefault,
  closePrompts,
} from "./prompts.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";
import { writeIfMissing } from "./genesis-bootstrap.js";
import { forgetStoredConwayKey } from "./configure.js";
import type { ChainType } from "../identity/chain.js";

/**
 * Default daily AI cap offered to a keyless (standalone) setup. It matches the
 * runtime's standalone ceiling, so a default install is not clamped (and
 * warned about) at every start.
 */
export const STANDALONE_SETUP_DAILY_INFERENCE_CENTS = 200;

/** True for an explicit yes; anything else (including Enter) is no. */
export function isYes(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

export async function runSetupWizard(): Promise<AutomatonConfig> {
  showBanner();

  console.log(chalk.white("  First-run setup. Let's bring your automaton to life.\n"));

  // ─── 1. Chain selection + wallet ──────────────────────────────
  console.log(chalk.cyan("  [1/6] Chain selection & identity (wallet)..."));
  let selectedChain: ChainType = "evm";
  const chainInput = await promptOptional("Chain type (evm or solana) [evm]");
  if (chainInput && chainInput.toLowerCase() === "solana") {
    selectedChain = "solana";
    console.log(chalk.green("  Chain: Solana (Ed25519)\n"));
  } else {
    console.log(chalk.green("  Chain: EVM (secp256k1)\n"));
  }

  const { account, chainIdentity, chainType: walletChainType, isNew } = await getWallet(selectedChain);
  const walletAddress = chainIdentity.address;
  if (isNew) {
    console.log(chalk.green(`  Wallet created: ${walletAddress}`));
  } else {
    console.log(chalk.green(`  Wallet loaded: ${walletAddress}`));
  }
  console.log(chalk.dim(`  Private key stored at: ${getAutomatonDir()}/wallet.json\n`));

  // ─── 2. Conway sign-in (opt-in) ───────────────────────────────
  console.log(chalk.cyan("  [2/6] Conway account (optional)"));
  const useConway = isYes(await promptOptional("Sign in to Conway with this wallet? [y/N]"));
  let apiKey = "";
  if (useConway) {
    apiKey = await provisionConway(walletAddress, walletChainType, chainIdentity);
    if (!apiKey) {
      console.log(chalk.yellow("  No API key set. Continuing without Conway."));
    }
  }
  if (!apiKey) {
    // A key stored by an earlier setup would otherwise keep the next run in Conway mode.
    if (forgetStoredConwayKey()) {
      console.log(chalk.dim("  Removed the Conway key stored by an earlier setup (automaton --provision signs in again)."));
    }
    if (process.env.CONWAY_API_KEY) {
      console.log(chalk.yellow('  CONWAY_API_KEY is set in your environment; it stays unused (providers.mode is saved as "standalone").'));
    }
    console.log(chalk.green("  No Conway key: running standalone with your own AI provider(s)\n"));
  }

  // ─── 3. Interactive questions ─────────────────────────────────
  console.log(chalk.cyan("  [3/6] Setup questions\n"));

  const name = await promptRequired("What do you want to name your automaton?");
  console.log(chalk.green(`  Name: ${name}\n`));

  const genesisPrompt = await promptMultiline("Enter the genesis prompt (system prompt) for your automaton.");
  console.log(chalk.green(`  Genesis prompt set (${genesisPrompt.length} chars)\n`));

  console.log(chalk.dim(`  Your automaton's address is ${walletAddress}`));
  console.log(chalk.dim("  Now enter YOUR wallet address (the human creator/owner).\n"));
  const creatorAddressLabel = walletChainType === "solana"
    ? "Creator wallet address (base58)"
    : "Creator wallet address (0x...)";
  const creatorAddress = await promptAddress(creatorAddressLabel, walletChainType);
  console.log(chalk.green(`  Creator: ${creatorAddress}\n`));

  // Without Conway at least one provider is required: nothing else can serve a model.
  let openaiApiKey = "";
  let anthropicApiKey = "";
  let ollamaBaseUrl: string | undefined;
  for (;;) {
    if (apiKey) {
      console.log(chalk.white("  Optional: bring your own inference provider keys (press Enter to skip)."));
    } else {
      console.log(chalk.white("  Your AI provider(s): enter at least one."));
    }
    ({ openaiApiKey, anthropicApiKey, ollamaBaseUrl } = await promptProviders());
    if (apiKey || openaiApiKey || anthropicApiKey || ollamaBaseUrl) break;
    console.log(chalk.yellow("  Without a Conway key the automaton needs an AI provider. Enter at least one.\n"));
  }

  if (openaiApiKey || anthropicApiKey || ollamaBaseUrl) {
    const providers = [
      openaiApiKey ? "OpenAI" : null,
      anthropicApiKey ? "Anthropic" : null,
      ollamaBaseUrl ? "Ollama" : null,
    ].filter(Boolean).join(", ");
    console.log(chalk.green(`  Provider keys/URLs saved: ${providers}\n`));
  } else {
    console.log(chalk.dim("  No provider keys set. Inference will default to Conway.\n"));
  }

  // ─── Financial Safety Policy ─────────────────────────────────
  console.log(chalk.cyan("  Financial Safety Policy"));
  console.log(chalk.dim("  These limits protect against unauthorized spending. Press Enter for defaults.\n"));

  // Standalone: no x402 payees by default and a daily AI cap inside the
  // runtime's standalone ceiling.
  const treasuryPolicy: TreasuryPolicy = {
    maxSingleTransferCents: await promptWithDefault(
      "Max single transfer (cents)", DEFAULT_TREASURY_POLICY.maxSingleTransferCents),
    maxHourlyTransferCents: await promptWithDefault(
      "Max hourly transfers (cents)", DEFAULT_TREASURY_POLICY.maxHourlyTransferCents),
    maxDailyTransferCents: await promptWithDefault(
      "Max daily transfers (cents)", DEFAULT_TREASURY_POLICY.maxDailyTransferCents),
    minimumReserveCents: await promptWithDefault(
      "Minimum reserve (cents)", DEFAULT_TREASURY_POLICY.minimumReserveCents),
    maxX402PaymentCents: await promptWithDefault(
      "Max x402 payment (cents)", DEFAULT_TREASURY_POLICY.maxX402PaymentCents),
    x402AllowedDomains: apiKey ? DEFAULT_TREASURY_POLICY.x402AllowedDomains : [],
    transferCooldownMs: DEFAULT_TREASURY_POLICY.transferCooldownMs,
    maxTransfersPerTurn: DEFAULT_TREASURY_POLICY.maxTransfersPerTurn,
    maxInferenceDailyCents: await promptWithDefault(
      "Max daily inference spend (cents)",
      apiKey ? DEFAULT_TREASURY_POLICY.maxInferenceDailyCents : STANDALONE_SETUP_DAILY_INFERENCE_CENTS),
    requireConfirmationAboveCents: await promptWithDefault(
      "Require confirmation above (cents)", DEFAULT_TREASURY_POLICY.requireConfirmationAboveCents),
  };

  console.log(chalk.green("  Treasury policy configured.\n"));

  // ─── 4. Detect environment ────────────────────────────────────
  console.log(chalk.cyan("  [4/6] Detecting environment..."));
  const env = detectEnvironment();
  // Without a Conway key the runtime ignores a sandbox id, so none is saved.
  const sandboxId = apiKey ? env.sandboxId : "";
  if (env.sandboxId && apiKey) {
    console.log(chalk.green(`  Conway sandbox detected: ${env.sandboxId}\n`));
  } else if (env.sandboxId) {
    console.log(chalk.dim(`  Conway sandbox ${env.sandboxId} detected; without a Conway key the automaton runs on this machine.\n`));
  } else {
    console.log(chalk.dim(`  Environment: ${env.type} (no sandbox detected)\n`));
  }

  // ─── 5. Write config + heartbeat + SOUL.md + skills ───────────
  console.log(chalk.cyan("  [5/6] Writing configuration..."));

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress,
    registeredWithConway: !!apiKey,
    sandboxId,
    walletAddress,
    apiKey,
    openaiApiKey: openaiApiKey || undefined,
    anthropicApiKey: anthropicApiKey || undefined,
    ollamaBaseUrl,
    treasuryPolicy,
    chainType: walletChainType,
  });

  // Explicit, so a Conway key stored later does not silently move this
  // install to Conway mode and out of the standalone daily cap ceiling.
  if (!apiKey) config.providers = { ...(config.providers ?? {}), mode: "standalone" };
  saveConfig(config);
  console.log(chalk.green("  automaton.json written"));

  writeDefaultHeartbeatConfig();
  console.log(chalk.green("  heartbeat.yml written"));

  // constitution.md (immutable — copied from repo, protected from self-modification)
  const automatonDir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc)) {
    if (installConstitution(constitutionSrc, constitutionDst)) {
      console.log(chalk.green("  constitution.md installed (read-only)"));
    } else {
      console.log(chalk.dim("  constitution.md already installed (read-only)"));
    }
  }

  // SOUL.md: an existing (possibly evolved) soul is kept.
  const soulPath = path.join(automatonDir, "SOUL.md");
  const soul = generateSoulMd(name, walletAddress, creatorAddress, genesisPrompt, { conway: !!apiKey });
  if (writeIfMissing(soulPath, soul)) {
    console.log(chalk.green("  SOUL.md written"));
  } else {
    console.log(chalk.dim("  SOUL.md already exists; kept"));
  }

  // Default skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  const installed = installDefaultSkills(skillsDir, { conway: !!apiKey });
  console.log(chalk.green(`  Default skills installed (${installed.join(", ")})\n`));

  // ─── 6. Funding guidance ──────────────────────────────────────
  if (apiKey) {
    console.log(chalk.cyan("  [6/6] Funding\n"));
    showFundingPanel(walletAddress, walletChainType);
  } else {
    console.log(chalk.cyan("  [6/6] Spending\n"));
    console.log(chalk.white(
      `  AI calls are paid by your provider key(s), capped at ${treasuryPolicy.maxInferenceDailyCents}c per rolling day.`,
    ));
    console.log(chalk.white("  Set a spending limit at your AI provider too.\n"));
  }

  closePrompts();

  return config;
}

/** OpenAI, Anthropic and Ollama prompts; each may be left empty. */
async function promptProviders(): Promise<{ openaiApiKey: string; anthropicApiKey: string; ollamaBaseUrl?: string }> {
  const openaiApiKey = await promptOptional("OpenAI API key (sk-..., optional)");
  if (openaiApiKey && !openaiApiKey.startsWith("sk-")) {
    console.log(chalk.yellow("  Warning: OpenAI keys usually start with sk-. Saving anyway."));
  }

  const anthropicApiKey = await promptOptional("Anthropic API key (sk-ant-..., optional)");
  if (anthropicApiKey && !anthropicApiKey.startsWith("sk-ant-")) {
    console.log(chalk.yellow("  Warning: Anthropic keys usually start with sk-ant-. Saving anyway."));
  }

  const ollamaInput = await promptOptional("Ollama base URL (http://localhost:11434, optional)");
  const ollamaBaseUrl = ollamaInput || undefined;
  if (ollamaBaseUrl) {
    console.log(chalk.green(`  Ollama URL saved: ${ollamaBaseUrl}`));
  }
  return { openaiApiKey, anthropicApiKey, ollamaBaseUrl };
}

/**
 * Install constitution.md read-only. A temp file plus rename replaces a 0444
 * file without opening it for writing (only the directory must be writable),
 * so a re-run as a non-root owner works. Returns false when the installed
 * copy already has the same content.
 */
export function installConstitution(src: string, dst: string): boolean {
  const content = fs.readFileSync(src, "utf-8");
  try {
    if (fs.readFileSync(dst, "utf-8") === content) {
      fs.chmodSync(dst, 0o444);
      return false;
    }
  } catch {
    // Missing or unreadable: written below.
  }
  writeFileSafe(dst, content, { trustedWriter: true, mode: 0o444 });
  return true;
}

/** Conway SIWE/SIWS provisioning, with a manual key as the fallback. Returns "" for none. */
async function provisionConway(
  walletAddress: string,
  walletChainType: ChainType,
  chainIdentity: Awaited<ReturnType<typeof getWallet>>["chainIdentity"],
): Promise<string> {
  const provisionLabel = walletChainType === "solana"
    ? "  Provisioning Conway API key (SIWS)..."
    : "  Provisioning Conway API key (SIWE)...";
  console.log(chalk.cyan(provisionLabel));
  let apiKey = "";
  try {
    const result = await provision(undefined, walletChainType === "solana" ? chainIdentity : undefined);
    apiKey = result.apiKey;
    console.log(chalk.green(`  API key provisioned: ${result.keyPrefix}...\n`));
  } catch (err: any) {
    console.log(chalk.yellow(`  Auto-provision failed: ${err.message}`));
    console.log(chalk.yellow("  You can enter a key manually, or press Enter to skip.\n"));
    const manual = await promptOptional("Conway API key (cnwy_k_..., optional)");
    if (manual) {
      apiKey = manual;
      // Save to config.json for loadApiKeyFromConfig()
      const configDir = getAutomatonDir();
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ apiKey, walletAddress: walletAddress, provisionedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
      console.log(chalk.green("  API key saved.\n"));
    }
  }

  return apiKey;
}

function showFundingPanel(address: string, chainType: ChainType = "evm"): void {
  const short = `${address.slice(0, 6)}...${address.slice(-5)}`;
  const usdcNetwork = chainType === "solana" ? "Solana" : "Base";
  const w = 58;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));

  console.log(chalk.cyan(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.cyan(`  │${pad("  Fund your automaton", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Address: ${short}`, w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Chain: ${chainType === "solana" ? "Solana" : "EVM (Base)"}`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  1. Transfer Conway credits", w)}│`));
  console.log(chalk.cyan(`  │${pad("     conway credits transfer <address> <amount>", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  2. Send USDC on ${usdcNetwork} to the address above`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  3. Fund via Conway Cloud dashboard", w)}│`));
  console.log(chalk.cyan(`  │${pad("     https://app.conway.tech", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  The automaton will start now. Fund it anytime —", w)}│`));
  console.log(chalk.cyan(`  │${pad("  the survival system handles zero-credit gracefully.", w)}│`));
  console.log(chalk.cyan(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}
