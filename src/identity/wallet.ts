/**
 * Automaton Wallet Management
 *
 * Creates and manages wallets for the automaton's identity and payments.
 * Supports both EVM (secp256k1/viem) and Solana (Ed25519/tweetnacl) wallets.
 * The private key is the automaton's sovereign identity.
 * Chain type is chosen at genesis and never changes.
 */

import type { PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import type { WalletData } from "../types.js";
import type { ChainType } from "./chain.js";
import { EvmChainIdentity, SolanaChainIdentity } from "./chain.js";
import type { ChainIdentity } from "./chain.js";
import { createFileExclusive } from "../security/secure-fs.js";
import { registerSecret } from "../security/secret-redaction.js";

/** wallet.json does not exist. */
export class WalletMissingError extends Error {
  constructor(readonly walletPath: string) {
    super(`No wallet at ${walletPath}`);
    this.name = "WalletMissingError";
  }
}

/** wallet.json exists but is empty, unreadable or holds no usable key. No new key is ever made over it. */
export class WalletCorruptError extends Error {
  constructor(
    readonly walletPath: string,
    detail: string,
  ) {
    super(
      `Cannot read wallet: wallet.json at ${walletPath} is empty or corrupt (${detail}); ` +
        "restore it from backup (no new key was created)",
    );
    this.name = "WalletCorruptError";
  }
}

/** Read wallet.json and register its key material for redaction. */
function readWalletData(): WalletData {
  let text: string;
  try {
    text = fs.readFileSync(WALLET_FILE, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new WalletMissingError(WALLET_FILE);
    throw new WalletCorruptError(WALLET_FILE, err?.message || String(err));
  }
  let walletData: WalletData;
  try {
    walletData = JSON.parse(text);
  } catch (err: any) {
    throw new WalletCorruptError(WALLET_FILE, text.trim() === "" ? "empty file" : "not valid JSON");
  }
  if (!walletData || typeof walletData !== "object" || Array.isArray(walletData)) {
    throw new WalletCorruptError(WALLET_FILE, "not a JSON object");
  }
  registerSecret(walletData.privateKey, "wallet");
  registerSecret(walletData.secretKey, "wallet");
  return walletData;
}

/**
 * Create wallet.json, failing with EEXIST when anything is already there
 * (two creators racing cannot both win). Refuses if a link sits at that name.
 */
function writeNewWallet(walletData: WalletData): void {
  createFileExclusive(WALLET_FILE, JSON.stringify(walletData, null, 2), { trustedWriter: true, mode: 0o600 });
  registerSecret(walletData.privateKey, "wallet");
  registerSecret(walletData.secretKey, "wallet");
}

/**
 * Create a stub PrivateKeyAccount for Solana wallets.
 * The stub has the Solana address but throws on any EVM signing attempt,
 * preventing accidental use of a random key.
 */
function createSolanaStubAccount(solanaAddress: string): PrivateKeyAccount {
  const throwSigning = () => {
    throw new Error(
      "Cannot use EVM signing methods on a Solana wallet. Use chainIdentity instead.",
    );
  };
  return {
    address: solanaAddress as any,
    publicKey: "0x" as any,
    source: "custom",
    type: "local",
    signMessage: throwSigning as any,
    signTypedData: throwSigning as any,
    signTransaction: throwSigning as any,
    sign: throwSigning as any,
  } as unknown as PrivateKeyAccount;
}

const AUTOMATON_DIR = path.join(
  process.env.HOME || "/root",
  ".automaton",
);
const WALLET_FILE = path.join(AUTOMATON_DIR, "wallet.json");

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

/**
 * Generate a Solana Ed25519 keypair.
 * Returns the 64-byte secret key (first 32 = private, last 32 = public).
 */
export function generateSolanaKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const keypair = nacl.sign.keyPair();
  return {
    secretKey: keypair.secretKey,
    publicKey: keypair.publicKey,
    address: bs58.encode(keypair.publicKey),
  };
}

/**
 * Get or create the automaton's wallet.
 * The private key IS the automaton's identity -- protect it.
 *
 * @param chainType - If creating a new wallet, which chain to use. Defaults to "evm".
 */
export async function getWallet(chainType?: ChainType): Promise<{
  account: PrivateKeyAccount;
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  isNew: boolean;
}> {
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  let existing = true;
  try {
    fs.lstatSync(WALLET_FILE);
  } catch {
    existing = false;
  }
  if (existing) {
    try {
      return { ...loadWallet(), isNew: false };
    } catch (err) {
      // Something is at the name but it reads as missing (a dangling link):
      // never create a wallet over it.
      if (err instanceof WalletMissingError) {
        throw new Error(`Refusing to create a wallet: ${WALLET_FILE} exists but is not a readable wallet file`);
      }
      throw err;
    }
  }

  // Create new wallet
  const resolvedChain = chainType || "evm";
  let walletData: WalletData;
  if (resolvedChain === "solana") {
    const { secretKey } = generateSolanaKeypair();
    walletData = { chainType: "solana", secretKey: bs58.encode(secretKey), createdAt: new Date().toISOString() };
  } else {
    walletData = { chainType: "evm", privateKey: generatePrivateKey(), createdAt: new Date().toISOString() };
  }
  try {
    writeNewWallet(walletData);
  } catch (err: any) {
    // Another process created it first: that wallet is the identity.
    if (err?.code === "EEXIST") return { ...loadWallet(), isNew: false };
    throw err;
  }
  return { ...loadWallet(), isNew: true };
}

/**
 * Load the existing wallet, never creating one. Throws WalletMissingError
 * when there is no wallet.json and WalletCorruptError when it is unusable.
 */
export function loadWallet(): {
  account: PrivateKeyAccount;
  chainIdentity: ChainIdentity;
  chainType: ChainType;
} {
  let loaded: ReturnType<typeof loadChainIdentity>;
  try {
    loaded = loadChainIdentity();
  } catch (err: any) {
    if (err instanceof WalletCorruptError) throw err;
    throw new WalletCorruptError(WALLET_FILE, err?.message || String(err));
  }
  if (!loaded) throw new WalletMissingError(WALLET_FILE);
  const { chainIdentity, chainType } = loaded;
  const account =
    chainType === "solana"
      ? createSolanaStubAccount(chainIdentity.address)
      : (chainIdentity as EvmChainIdentity).account;
  return { account, chainIdentity, chainType };
}

/**
 * Load the existing wallet as a ChainIdentity, never creating one (unlike
 * getWallet). Returns null when there is no wallet.json; throws a clear error
 * when the file is unreadable or holds no key for its chain type.
 */
export function loadChainIdentity(): {
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  address: string;
} | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  let walletData: WalletData;
  try {
    walletData = readWalletData();
  } catch (err: any) {
    if (err instanceof WalletMissingError) return null;
    throw err;
  }

  const chainType: ChainType = walletData.chainType || "evm";
  if (chainType === "solana") {
    if (typeof walletData.secretKey !== "string" || !walletData.secretKey) {
      throw new Error(`Solana wallet at ${WALLET_FILE} has no secretKey`);
    }
    let secretKey: Uint8Array;
    try {
      secretKey = bs58.decode(walletData.secretKey);
    } catch {
      throw new Error(`Solana wallet at ${WALLET_FILE} has a secretKey that is not base58`);
    }
    if (secretKey.length !== 64) {
      throw new Error(`Solana wallet at ${WALLET_FILE} has a secretKey of ${secretKey.length} bytes (expected 64)`);
    }
    const chainIdentity = new SolanaChainIdentity(secretKey);
    return { chainIdentity, chainType, address: chainIdentity.address };
  }

  if (chainType !== "evm") {
    throw new Error(`Wallet at ${WALLET_FILE} has unknown chainType "${String(chainType)}"`);
  }
  if (typeof walletData.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(walletData.privateKey)) {
    throw new Error(`EVM wallet at ${WALLET_FILE} has no valid privateKey`);
  }
  const chainIdentity = new EvmChainIdentity(privateKeyToAccount(walletData.privateKey));
  return { chainIdentity, chainType, address: chainIdentity.address };
}

/**
 * Get the wallet address without loading the full account.
 */
export function getWalletAddress(): string | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData = readWalletData();

  if (walletData.chainType === "solana" && walletData.secretKey) {
    const secretKey = bs58.decode(walletData.secretKey);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    return bs58.encode(keypair.publicKey);
  }

  const account = privateKeyToAccount(walletData.privateKey!);
  return account.address;
}

/**
 * Load the full wallet account (needed for signing).
 * For Solana wallets, returns a proxy account.
 */
export function loadWalletAccount(): PrivateKeyAccount | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData = readWalletData();

  if (walletData.chainType === "solana") {
    // Solana wallets don't have a PrivateKeyAccount; callers should use getWallet() instead
    return null;
  }

  return privateKeyToAccount(walletData.privateKey!);
}

/**
 * Get the chain type from the wallet file.
 */
export function getWalletChainType(): ChainType {
  if (!fs.existsSync(WALLET_FILE)) {
    return "evm";
  }
  try {
    const walletData = readWalletData();
    return walletData.chainType || "evm";
  } catch {
    return "evm";
  }
}

export function walletExists(): boolean {
  return fs.existsSync(WALLET_FILE);
}
