/**
 * Non-interactive first start for a spawned child.
 *
 * A parent writes ~/.automaton/genesis.json and runs `--init` (wallet) in
 * the child's sandbox, then starts it with `--run`. There is no terminal for
 * the setup wizard, so the config is built from genesis.json, the wallet and
 * an auto-provisioned API key. Any failure throws, and `--run` exits 1.
 */

import fs from "node:fs";
import path from "node:path";
import type { AutomatonConfig } from "../types.js";
import type { ChainType } from "../identity/chain.js";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { provision } from "../identity/provision.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";

export const GENESIS_FILENAME = "genesis.json";
const MAX_GENESIS_BYTES = 256 * 1024;

export interface GenesisFile {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  parentAddress: string;
  chainType: ChainType;
}

export interface GenesisBootstrapDeps {
  getWallet: typeof getWallet;
  provision: typeof provision;
  detectEnvironment: () => { sandboxId: string };
  automatonDir: () => string;
}

const defaultDeps: GenesisBootstrapDeps = {
  getWallet,
  provision,
  detectEnvironment,
  automatonDir: getAutomatonDir,
};

export function genesisPath(dir: string = getAutomatonDir()): string {
  return path.join(dir, GENESIS_FILENAME);
}

/** Parse and check genesis.json; throws with the first problem found. */
export function readGenesisFile(file: string): GenesisFile {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  if (stat.size > MAX_GENESIS_BYTES) throw new Error(`${file} is larger than ${MAX_GENESIS_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`);
  const g = raw as Record<string, unknown>;
  for (const key of ["name", "genesisPrompt", "creatorAddress", "parentAddress"] as const) {
    if (typeof g[key] !== "string" || (g[key] as string).trim() === "") {
      throw new Error(`${file}: "${key}" must be a non-empty string`);
    }
  }
  const chainType = g.chainType ?? "evm";
  if (chainType !== "evm" && chainType !== "solana") {
    throw new Error(`${file}: "chainType" must be "evm" or "solana"`);
  }
  if (g.creatorMessage !== undefined && typeof g.creatorMessage !== "string") {
    throw new Error(`${file}: "creatorMessage" must be a string`);
  }
  return {
    name: (g.name as string).trim(),
    genesisPrompt: g.genesisPrompt as string,
    creatorMessage: g.creatorMessage as string | undefined,
    creatorAddress: (g.creatorAddress as string).trim(),
    parentAddress: (g.parentAddress as string).trim(),
    chainType,
  };
}

/** Build, save and return automaton.json from genesis.json. */
export async function bootstrapConfigFromGenesis(
  deps: Partial<GenesisBootstrapDeps> = {},
): Promise<AutomatonConfig> {
  const d: GenesisBootstrapDeps = { ...defaultDeps, ...deps };
  const dir = d.automatonDir();
  const genesis = readGenesisFile(genesisPath(dir));

  // The wallet `--init` created (made here if --init was skipped).
  const { chainIdentity, chainType } = await d.getWallet(genesis.chainType);
  if (chainType !== genesis.chainType) {
    throw new Error(`wallet chain is ${chainType} but genesis.json asks for ${genesis.chainType}`);
  }
  const provisioned = await d.provision(undefined, chainType === "solana" ? chainIdentity : undefined);
  if (!provisioned?.apiKey) throw new Error("API key provisioning returned no key");

  const config = createConfig({
    name: genesis.name,
    genesisPrompt: genesis.genesisPrompt,
    creatorMessage: genesis.creatorMessage,
    creatorAddress: genesis.creatorAddress,
    registeredWithConway: true,
    sandboxId: d.detectEnvironment().sandboxId || "",
    walletAddress: chainIdentity.address,
    apiKey: provisioned.apiKey,
    parentAddress: genesis.parentAddress,
    chainType,
  });
  saveConfig(config);

  // Defaults only where nothing exists yet.
  if (!fs.existsSync(path.join(dir, "heartbeat.yml"))) writeDefaultHeartbeatConfig(path.join(dir, "heartbeat.yml"));
  writeIfMissing(
    path.join(dir, "SOUL.md"),
    generateSoulMd(genesis.name, chainIdentity.address, genesis.creatorAddress, genesis.genesisPrompt, { conway: true }),
  );
  // Children always run on Conway for now: only a Conway-mode parent spawns.
  const skillsDir = path.join(dir, "skills");
  if (!fs.existsSync(skillsDir)) installDefaultSkills(skillsDir, { conway: true });

  return config;
}

/** Create a file only if nothing is at the path (no overwrite, no follow). */
export function writeIfMissing(file: string, content: string): boolean {
  try {
    fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
}
