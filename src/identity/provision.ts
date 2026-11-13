/**
 * Automaton SIWE Provisioning
 *
 * Uses the automaton's wallet to authenticate via Sign-In With Ethereum (SIWE)
 * and create an API key for Conway API access.
 * Adapted from conway-mcp/src/cli/provision.ts
 */

import fs from "fs";
import path from "path";
import { SiweMessage } from "siwe";
import { loadWallet, getAutomatonDir } from "./wallet.js";
import type { ProvisionResult } from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import type { ChainIdentity } from "./chain.js";
import { buildSiwsMessage, signSiwsMessage } from "./siws.js";
import { writeFileSafe } from "../security/secure-fs.js";
import { registerSecret } from "../security/secret-redaction.js";
import { assertConwayAllowed } from "../providers/mode.js";
import { setConwayApiKey } from "../config.js";

const httpClient = new ResilientHttpClient();

const DEFAULT_API_URL = "https://api.conway.tech";

/**
 * Load API key from ~/.automaton/config.json if it exists.
 */
export function loadApiKeyFromConfig(): string | null {
  const configPath = path.join(getAutomatonDir(), "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    registerSecret(config.apiKey, "conway-api-key");
    return config.apiKey || null;
  } catch {
    return null;
  }
}

/**
 * Save API key and wallet address to ~/.automaton/config.json
 */
function saveConfig(apiKey: string, walletAddress: string): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const configPath = path.join(dir, "config.json");
  const config = {
    apiKey,
    walletAddress,
    provisionedAt: new Date().toISOString(),
  };
  writeFileSafe(configPath, JSON.stringify(config, null, 2), { trustedWriter: true, mode: 0o600 });
  registerSecret(apiKey, "conway-api-key");
}

/**
 * The SIWE/SIWS domain for a Conway API URL: the URL's host, so a signature
 * sent to another host cannot be replayed to conway.tech. Production keeps
 * the domain it has always signed.
 */
export function siweDomainFor(apiUrl: string): string {
  let host: string;
  try {
    host = new URL(apiUrl).host.toLowerCase();
  } catch {
    throw new Error(`Invalid Conway API URL: ${apiUrl}`);
  }
  return host === "api.conway.tech" ? "conway.tech" : host;
}

/**
 * Run the full SIWE provisioning flow:
 * 1. Load wallet
 * 2. Get nonce from Conway API
 * 3. Sign SIWE message
 * 4. Verify signature -> get JWT
 * 5. Create API key
 * 6. Save to config.json, and to automaton.json when it exists (the key
 *    the runtime reads), so a re-provisioned key replaces the old one
 *
 * Never creates a wallet. Refused while a standalone runtime is installed;
 * the --provision CLI and the setup wizard run before any runtime is.
 */
export async function provision(
  apiUrl?: string,
  solanaIdentity?: ChainIdentity,
): Promise<ProvisionResult> {
  assertConwayAllowed("Conway API key provisioning");
  const url = (apiUrl || process.env.CONWAY_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const domain = siweDomainFor(url);

  // 1. Load wallet (never created here)
  const { account, chainIdentity } = loadWallet();
  const identity = solanaIdentity || chainIdentity;
  const address = identity.address;
  const isSolana = identity.chainType === "solana";

  // 2. Get nonce
  const nonceResp = await httpClient.request(`${url}/v1/auth/nonce`, {
    method: "POST",
  });
  if (!nonceResp.ok) {
    throw new Error(
      `Failed to get nonce: ${nonceResp.status} ${await nonceResp.text()}`,
    );
  }
  const { nonce } = (await nonceResp.json()) as { nonce: string };

  let messageString: string;
  let signature: string;

  if (isSolana) {
    // 3a. SIWS path: Sign-In With Solana
    const siwsMsg = buildSiwsMessage({
      domain,
      address,
      statement: "Sign in to Conway as an Automaton to provision an API key.",
      uri: `${url}/v1/auth/verify`,
      nonce,
      issuedAt: new Date().toISOString(),
      chainId: "mainnet",
    });
    messageString = siwsMsg;
    signature = await signSiwsMessage(siwsMsg, identity);
  } else {
    // 3b. SIWE path: Sign-In With Ethereum (unchanged)
    const siweMessage = new SiweMessage({
      domain,
      address,
      statement:
        "Sign in to Conway as an Automaton to provision an API key.",
      uri: `${url}/v1/auth/verify`,
      version: "1",
      chainId: 8453, // Base
      nonce,
      issuedAt: new Date().toISOString(),
    });
    messageString = siweMessage.prepareMessage();
    signature = await account.signMessage({ message: messageString });
  }

  // 4. Verify signature -> get JWT
  const verifyBody: Record<string, string> = { message: messageString, signature };
  if (isSolana) {
    verifyBody.chain_type = "solana";
  }

  const verifyResp = await httpClient.request(`${url}/v1/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(verifyBody),
  });

  if (!verifyResp.ok) {
    const protocol = isSolana ? "SIWS" : "SIWE";
    throw new Error(
      `${protocol} verification failed: ${verifyResp.status} ${await verifyResp.text()}`,
    );
  }

  const { access_token } = (await verifyResp.json()) as {
    access_token: string;
  };

  // 5. Create API key
  const keyResp = await httpClient.request(`${url}/v1/auth/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ name: "conway-automaton" }),
  });

  if (!keyResp.ok) {
    throw new Error(
      `Failed to create API key: ${keyResp.status} ${await keyResp.text()}`,
    );
  }

  const { key, key_prefix } = (await keyResp.json()) as {
    key: string;
    key_prefix: string;
  };

  // 6. Save to config
  saveConfig(key, address);
  setConwayApiKey(key);

  return { apiKey: key, walletAddress: address, keyPrefix: key_prefix };
}
