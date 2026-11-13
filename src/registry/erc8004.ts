/**
 * ERC-8004 On-Chain Agent Registration
 *
 * Registers the automaton on-chain as a Trustless Agent via ERC-8004.
 * Uses the Identity Registry on Base mainnet (or Base Sepolia for testnet).
 *
 * The registries are deployed at deterministic addresses: one pair on every
 * mainnet and a different pair on every testnet, so Base and Base Sepolia
 * use different addresses.
 *
 * Phase 3.2: Added preflight gas check, score validation, config-based network,
 * Transfer event topic fix, and transaction logging.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toBytes,
  encodeFunctionData,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import type {
  RegistryEntry,
  DiscoveredAgent,
  AutomatonDatabase,
  OnchainTransactionRow,
} from "../types.js";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { ChainType } from "../identity/chain.js";
const logger = createLogger("registry.erc8004");

/**
 * Guard: throws if the automaton is using a Solana wallet.
 * ERC-8004 is an EVM standard and requires an EVM wallet.
 */
export function requireEvmChain(chainType?: ChainType): void {
  if (chainType === "solana") {
    throw new Error(
      "ERC-8004 requires an EVM wallet. Solana automatons cannot register on-chain via ERC-8004. " +
      "Your identity is registered via Conway API instead.",
    );
  }
}

// ─── Contract Addresses ──────────────────────────────────────

export const CONTRACTS = {
  mainnet: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,
    chain: base,
  },
  // The testnet deployment, not the mainnet addresses (which have no
  // contract on Base Sepolia). registerAgent also checks for bytecode first.
  testnet: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
    chain: baseSepolia,
  },
} as const;

// ─── ABI (minimal subset needed for registration) ────────────

// ERC-8004 Identity Registry ABI
// 正确的函数签名 (通过字节码分析确认):
// - 读取: tokenURI(uint256) - 标准 ERC-721
// - 更新: setAgentURI(uint256,string) - ERC-8004 自定义
const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) external returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newAgentURI) external",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function totalSupply() external view returns (uint256)",
  "function balanceOf(address owner) external view returns (uint256)",
]);

const REPUTATION_ABI = parseAbi([
  "function leaveFeedback(uint256 agentId, uint8 score, string comment) external",
  "function getFeedback(uint256 agentId) external view returns ((address, uint8, string, uint256)[])",
]);

// Phase 3.2: ERC-721 Transfer event topic signature for agent ID extraction
const TRANSFER_EVENT_TOPIC = keccak256(
  toBytes("Transfer(address,address,uint256)"),
);

type Network = "mainnet" | "testnet";

export function isRegistryNetwork(value: unknown): value is Network {
  return value === "mainnet" || value === "testnet";
}

/** CAIP-2 id of a network's chain, as stored in registry.chain. */
export function registryChainId(network: Network): string {
  return `eip155:${CONTRACTS[network].chain.id}`;
}

/** The local registry entry for one chain (a testnet entry says nothing about mainnet). */
export function getRegistryEntryForChain(
  rawDb: import("better-sqlite3").Database,
  chain: string,
): RegistryEntry | undefined {
  const row = rawDb
    .prepare("SELECT * FROM registry WHERE chain = ? ORDER BY registered_at DESC LIMIT 1")
    .get(chain) as
    | { agent_id: string; agent_uri: string; chain: string; contract_address: string; tx_hash: string; registered_at: string }
    | undefined;
  if (!row) return undefined;
  return {
    agentId: row.agent_id,
    agentURI: row.agent_uri,
    chain: row.chain,
    contractAddress: row.contract_address,
    txHash: row.tx_hash,
    registeredAt: row.registered_at,
  };
}

/** Broadcast, but the receipt is not in yet. Calling register again resumes it. */
export class RegistrationPendingError extends Error {
  constructor(public readonly txHash: string, detail: string) {
    super(
      `Registration tx ${txHash} is recorded as sent but is not confirmed yet (${detail}). ` +
        "Call register_erc8004 again to resume: no second transaction will be sent.",
    );
    this.name = "RegistrationPendingError";
  }
}

/** Registration was not attempted, or failed with nothing saved. */
export class RegistrationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationRefusedError";
  }
}

const RECEIPT_TIMEOUT_MS = 180_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Resolve the RPC transport URL.
 * Priority: explicit parameter > AUTOMATON_RPC_URL env var > viem default (public RPC).
 */
function resolveRpcUrl(rpcUrl?: string): string | undefined {
  return rpcUrl || process.env.AUTOMATON_RPC_URL || undefined;
}

// ─── Preflight Check ────────────────────────────────────────────

/**
 * Phase 3.2: Gas estimation + balance check before on-chain transaction.
 * Throws descriptive error if insufficient balance.
 */
async function preflight(
  account: PrivateKeyAccount,
  network: Network,
  functionData: {
    address: Address;
    abi: any;
    functionName: string;
    args: any[];
  },
  rpcUrl?: string,
): Promise<void> {
  const contracts = CONTRACTS[network];
  const chain = contracts.chain;

  const publicClient = createPublicClient({
    chain,
    transport: http(resolveRpcUrl(rpcUrl)),
  });

  // Encode calldata for accurate gas estimation
  const data = encodeFunctionData({
    abi: functionData.abi,
    functionName: functionData.functionName,
    args: functionData.args,
  });

  // Estimate gas
  const gasEstimate = await publicClient
    .estimateGas({
      account: account.address,
      to: functionData.address,
      data,
    })
    .catch(() => BigInt(200_000)); // Fallback estimate

  // Get gas price
  const gasPrice = await publicClient
    .getGasPrice()
    .catch(() => BigInt(1_000_000_000)); // 1 gwei fallback

  // Get balance
  const balance = await publicClient.getBalance({
    address: account.address,
  });

  const estimatedCost = gasEstimate * gasPrice;

  if (balance < estimatedCost) {
    throw new Error(
      `Insufficient ETH for gas. Balance: ${balance} wei, estimated cost: ${estimatedCost} wei (gas: ${gasEstimate}, price: ${gasPrice} wei)`,
    );
  }
}

// ─── Transaction Logging ────────────────────────────────────────

/**
 * Phase 3.2: Log a transaction to the onchain_transactions table.
 */
function logTransaction(
  rawDb: import("better-sqlite3").Database | undefined,
  txHash: string,
  chain: string,
  operation: string,
  status: "pending" | "confirmed" | "failed",
  gasUsed?: number,
  metadata?: Record<string, unknown>,
): void {
  if (!rawDb) return;
  try {
    rawDb
      .prepare(
        `INSERT INTO onchain_transactions (id, tx_hash, chain, operation, status, gas_used, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        txHash,
        chain,
        operation,
        status,
        gasUsed ?? null,
        JSON.stringify(metadata ?? {}),
      );
  } catch (error) {
    logger.error(
      "Transaction log failed:",
      error instanceof Error ? error : undefined,
    );
  }
}

function updateTransactionStatus(
  rawDb: import("better-sqlite3").Database | undefined,
  txHash: string,
  status: "pending" | "confirmed" | "failed",
  gasUsed?: number,
): void {
  if (!rawDb) return;
  try {
    rawDb
      .prepare(
        "UPDATE onchain_transactions SET status = ?, gas_used = COALESCE(?, gas_used) WHERE tx_hash = ?",
      )
      .run(status, gasUsed ?? null, txHash);
  } catch (error) {
    logger.error(
      "Transaction status update failed:",
      error instanceof Error ? error : undefined,
    );
  }
}

// ─── Registration ───────────────────────────────────────────────

/** The reads finishRegistration needs (chain-specific client types differ). */
interface ReceiptReader {
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    timeout: number;
    onReplaced: (r: { reason: string; transaction?: { hash?: string } }) => void;
  }): Promise<{
    status: string;
    gasUsed?: bigint;
    transactionHash: `0x${string}`;
    logs: readonly { address?: string; topics: readonly (string | undefined)[] }[];
  }>;
  getTransaction(args: { hash: `0x${string}` }): Promise<unknown>;
}

function errorText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string } | undefined;
  return String(e?.shortMessage || e?.message || err).split("\n")[0].slice(0, 300);
}

function topicAddress(topic: string | undefined): string {
  return topic ? `0x${topic.slice(-40)}`.toLowerCase() : "";
}

/** The newest register tx on this chain still waiting for a receipt. */
function findPendingRegistration(
  rawDb: import("better-sqlite3").Database | undefined,
  chain: string,
): { txHash: string; agentURI?: string } | null {
  if (!rawDb) return null;
  const row = rawDb
    .prepare(
      `SELECT tx_hash, metadata FROM onchain_transactions
       WHERE operation = 'register' AND chain = ? AND status = 'pending'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(chain) as { tx_hash: string; metadata: string | null } | undefined;
  if (!row) return null;
  let agentURI: string | undefined;
  try {
    const meta = JSON.parse(row.metadata || "{}");
    if (typeof meta?.agentURI === "string") agentURI = meta.agentURI;
  } catch {
    // metadata is informational
  }
  return { txHash: row.tx_hash, agentURI };
}

/** Nonce of the newest register on this chain closed as dropped, if recorded. */
function findDroppedRegistrationNonce(
  rawDb: import("better-sqlite3").Database | undefined,
  chain: string,
): number | null {
  if (!rawDb) return null;
  const row = rawDb
    .prepare(
      `SELECT metadata FROM onchain_transactions
       WHERE operation = 'register' AND chain = ? AND status = 'failed'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(chain) as { metadata: string | null } | undefined;
  try {
    const meta = JSON.parse(row?.metadata || "{}");
    if (typeof meta?.failure === "string" && meta.failure.startsWith("dropped") && Number.isSafeInteger(meta.nonce)) {
      return meta.nonce;
    }
  } catch {
    // metadata is informational
  }
  return null;
}

function failTransaction(
  rawDb: import("better-sqlite3").Database | undefined,
  txHash: string,
  reason: string,
  gasUsed?: number,
  replacedBy?: string,
): void {
  updateTransactionStatus(rawDb, txHash, "failed", gasUsed);
  if (!rawDb) return;
  try {
    rawDb
      .prepare("UPDATE onchain_transactions SET metadata = json_set(COALESCE(metadata, '{}'), '$.failure', ?) WHERE tx_hash = ?")
      .run(reason, txHash);
    // Kept so a token minted by the replacement can still be found.
    if (replacedBy) {
      rawDb
        .prepare("UPDATE onchain_transactions SET metadata = json_set(metadata, '$.replacedBy', ?) WHERE tx_hash = ?")
        .run(replacedBy, txHash);
    }
  } catch {
    // the status is what matters
  }
}

/** The token id minted to `wallet` by `identity` in these logs, if any. */
function mintedAgentId(
  logs: readonly { address?: string; topics: readonly (string | undefined)[] }[],
  identity: Address,
  wallet: string,
): string | null {
  for (const log of logs) {
    if (log.address?.toLowerCase() !== identity.toLowerCase()) continue;
    if (log.topics.length < 4 || log.topics[0] !== TRANSFER_EVENT_TOPIC) continue;
    if (topicAddress(log.topics[1]) !== ZERO_ADDRESS || topicAddress(log.topics[2]) !== wallet.toLowerCase()) continue;
    return BigInt(log.topics[3]!).toString();
  }
  return null;
}

/** Reads used to adopt a token whose registration was not recorded. */
interface RecoveryReader {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: string;
    transactionHash: `0x${string}`;
    logs: readonly { address?: string; topics: readonly (string | undefined)[] }[];
  }>;
  readContract(args: { address: Address; abi: typeof IDENTITY_ABI; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

/**
 * The wallet owns a token here but no entry was saved (a register marked
 * dropped or replaced that was mined after all). Look through the register
 * transactions recorded for this chain, and their replacements, for a mint
 * to this wallet that it still owns, and save that entry.
 */
async function recoverRecordedRegistration(
  client: RecoveryReader,
  args: { account: PrivateKeyAccount; identity: Address; chainId: string; db: AutomatonDatabase },
): Promise<RegistryEntry | null> {
  const { account, identity, chainId, db } = args;
  if (!db.raw) return null;
  const rows = db.raw
    .prepare(
      `SELECT tx_hash, metadata FROM onchain_transactions
       WHERE operation = 'register' AND chain = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 20`,
    )
    .all(chainId) as { tx_hash: string; metadata: string | null }[];
  const wallet = account.address.toLowerCase();
  for (const row of rows) {
    let meta: { agentURI?: unknown; replacedBy?: unknown } = {};
    try {
      meta = JSON.parse(row.metadata || "{}") ?? {};
    } catch {
      // metadata is informational
    }
    const hashes = [row.tx_hash, typeof meta.replacedBy === "string" ? meta.replacedBy : null].filter(
      (h): h is string => !!h && /^0x[0-9a-fA-F]{64}$/.test(h),
    );
    for (const hash of hashes) {
      let receipt: Awaited<ReturnType<RecoveryReader["getTransactionReceipt"]>>;
      try {
        receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      } catch {
        continue;
      }
      if (receipt.status !== "success") continue;
      const agentId = mintedAgentId(receipt.logs, identity, wallet);
      if (agentId === null) continue;
      try {
        const owner = (await client.readContract({
          address: identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [BigInt(agentId)],
        })) as string;
        if (String(owner).toLowerCase() !== wallet) continue;
      } catch {
        continue;
      }
      let agentURI = typeof meta.agentURI === "string" ? meta.agentURI : "";
      try {
        agentURI = String(await client.readContract({
          address: identity, abi: IDENTITY_ABI, functionName: "tokenURI", args: [BigInt(agentId)],
        }));
      } catch {
        // keep the URI that was sent
      }
      const entry: RegistryEntry = {
        agentId,
        agentURI,
        chain: chainId,
        contractAddress: identity,
        txHash: receipt.transactionHash ?? hash,
        registeredAt: new Date().toISOString(),
      };
      db.raw.transaction(() => {
        db.raw!
          .prepare("UPDATE onchain_transactions SET status = 'confirmed', metadata = json_set(COALESCE(metadata, '{}'), '$.recovered', 1) WHERE tx_hash = ?")
          .run(row.tx_hash);
        db.setRegistryEntry(entry);
      })();
      logger.info(`Recovered ERC-8004 registration ${agentId} on ${chainId} from tx ${entry.txHash}`);
      return entry;
    }
  }
  return null;
}

/**
 * Register the automaton on-chain with ERC-8004.
 * Returns the agent ID (NFT token ID).
 *
 * At most one register transaction per chain is ever in flight: a pending
 * one is resumed, never re-sent, and nothing is broadcast while the wallet
 * already owns an identity token there (or that cannot be checked). An entry
 * is saved only for a successful receipt with a mint to this wallet from the
 * identity registry itself.
 */
export async function registerAgent(
  account: PrivateKeyAccount,
  agentURI: string,
  network: Network = "mainnet",
  db: AutomatonDatabase,
  rpcUrl?: string,
): Promise<RegistryEntry> {
  if (!isRegistryNetwork(network)) {
    throw new RegistrationRefusedError(`Unknown network "${String(network)}": use mainnet or testnet`);
  }
  const contracts = CONTRACTS[network];
  const chain = contracts.chain;
  const chainId = registryChainId(network);
  const rpc = resolveRpcUrl(rpcUrl);

  if (db.raw) {
    const existing = getRegistryEntryForChain(db.raw, chainId);
    if (existing) {
      throw new RegistrationRefusedError(`Already registered on ${network}: agent ID ${existing.agentId}`);
    }
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(rpc),
  });

  // 1. Resume a broadcast registration instead of sending another.
  const pending = findPendingRegistration(db.raw, chainId);
  if (pending) {
    return finishRegistration(publicClient as unknown as ReceiptReader, {
      hash: pending.txHash as `0x${string}`,
      agentURI: pending.agentURI ?? agentURI,
      account,
      identity: contracts.identity,
      chainId,
      db,
    });
  }

  // 2. On-chain checks. Any read that fails refuses: never broadcast blind.
  let code: string | undefined;
  try {
    code = await publicClient.getCode({ address: contracts.identity });
  } catch (err) {
    throw new RegistrationRefusedError(
      `Could not read the identity registry on ${network} (${errorText(err)}); no transaction was sent`,
    );
  }
  if (!code || code === "0x") {
    throw new RegistrationRefusedError(
      `No contract at ${contracts.identity} on ${network} (chain ${chain.id}); no transaction was sent`,
    );
  }
  let owned: bigint;
  try {
    owned = (await publicClient.readContract({
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
  } catch (err) {
    throw new RegistrationRefusedError(
      `Could not check whether this wallet already owns an ERC-8004 identity on ${network} (${errorText(err)}); no transaction was sent`,
    );
  }
  if (owned > 0n) {
    const recovered = await recoverRecordedRegistration(publicClient as unknown as RecoveryReader, {
      account,
      identity: contracts.identity,
      chainId,
      db,
    });
    if (recovered) return recovered;
    throw new RegistrationRefusedError(
      `This wallet already owns ${owned} ERC-8004 identity token(s) on ${network}, but no register transaction recorded here minted it; no new registration was sent`,
    );
  }

  // Phase 3.2: Preflight gas check
  await preflight(account, network, {
    address: contracts.identity,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [agentURI],
  }, rpcUrl);

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpc),
  });

  // A register marked dropped may still be live somewhere: reuse its nonce
  // while it is unspent, so the two cannot both mint.
  const droppedNonce = findDroppedRegistrationNonce(db.raw, chainId);
  let nonce: number | undefined;
  if (droppedNonce !== null) {
    let mined: number;
    try {
      mined = await publicClient.getTransactionCount({ address: account.address, blockTag: "latest" });
    } catch (err) {
      throw new RegistrationRefusedError(
        `Could not read this wallet's nonce on ${network} (${errorText(err)}), needed to replace an earlier dropped registration safely; no transaction was sent`,
      );
    }
    if (mined <= droppedNonce) nonce = droppedNonce;
  }

  // 3. Sign, record the pending row, then broadcast: a send whose response
  // is lost still leaves the row a later call resumes from.
  const request = await walletClient.prepareTransactionRequest({
    account,
    chain,
    to: contracts.identity,
    data: encodeFunctionData({ abi: IDENTITY_ABI, functionName: "register", args: [agentURI] }),
    ...(nonce !== undefined ? { nonce } : {}),
  });
  const serializedTransaction = await walletClient.signTransaction(request as any);
  const hash = keccak256(serializedTransaction);
  if (db.raw) {
    // Not logTransaction: a row that failed to save must stop the broadcast.
    // Re-signing a dropped register with the same nonce and fees gives the
    // same bytes, so the same hash: revive that row instead of failing on the
    // unique hash. A row that is still pending or confirmed is never reused.
    const saved = db.raw
      .prepare(
        `INSERT INTO onchain_transactions (id, tx_hash, chain, operation, status, gas_used, metadata)
         VALUES (?, ?, ?, 'register', 'pending', NULL, ?)
         ON CONFLICT(tx_hash) DO UPDATE SET status = 'pending', gas_used = NULL, metadata = excluded.metadata
         WHERE onchain_transactions.status = 'failed' AND onchain_transactions.operation = 'register'`,
      )
      .run(ulid(), hash, chainId, JSON.stringify({ agentURI, from: account.address, nonce: request.nonce }));
    if (saved.changes === 0) {
      throw new RegistrationRefusedError(
        `Transaction ${hash} is already recorded and not closed; no transaction was sent. Run register_erc8004 again to resume it.`,
      );
    }
  }
  try {
    await walletClient.sendRawTransaction({ serializedTransaction });
  } catch (err) {
    // The node may have it even though the call failed; the next call resumes
    // from the row, and closes it if the node never heard of the tx.
    throw new RegistrationPendingError(hash, `the send call failed and it may not have reached the network: ${errorText(err)}`);
  }

  return finishRegistration(publicClient as unknown as ReceiptReader, {
    hash,
    agentURI,
    account,
    identity: contracts.identity,
    chainId,
    db,
  });
}

/** Steps 4-6: wait for the receipt, check it, save the entry. */
async function finishRegistration(
  publicClient: ReceiptReader,
  args: {
    hash: `0x${string}`;
    agentURI: string;
    account: PrivateKeyAccount;
    identity: Address;
    chainId: string;
    db: AutomatonDatabase;
  },
): Promise<RegistryEntry> {
  const { hash, agentURI, account, identity, chainId, db } = args;

  let replacement: { reason: string; hash?: string } | null = null;
  let receipt: Awaited<ReturnType<ReceiptReader["waitForTransactionReceipt"]>>;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
      onReplaced: (r) => {
        replacement = { reason: r.reason, hash: r.transaction?.hash };
      },
    });
  } catch (err) {
    // A transaction the node has never heard of was dropped (or never sent):
    // close the row so the next call can register afresh.
    let unknownToNode = false;
    try {
      await publicClient.getTransaction({ hash });
    } catch (lookupErr) {
      unknownToNode = (lookupErr as { name?: string })?.name === "TransactionNotFoundError";
    }
    if (unknownToNode) {
      failTransaction(db.raw, hash, "dropped: unknown to the RPC node");
      throw new RegistrationRefusedError(
        `Registration tx ${hash} is unknown to the RPC node (dropped or never sent); it was marked failed. Call register_erc8004 again: a new registration reuses its nonce, so at most one of the two can be mined, and a token it minted after all is recorded.`,
      );
    }
    throw new RegistrationPendingError(hash, errorText(err));
  }

  const gasUsed = receipt.gasUsed ? Number(receipt.gasUsed) : undefined;
  const replaced = replacement as { reason: string; hash?: string } | null;
  if (replaced && (replaced.reason === "cancelled" || replaced.reason === "replaced")) {
    failTransaction(db.raw, hash, `${replaced.reason} by ${replaced.hash ?? "another transaction"}`, undefined, replaced.hash);
    throw new RegistrationRefusedError(
      `Registration tx ${hash} was ${replaced.reason} by ${replaced.hash ?? "another transaction"} at the same nonce; nothing was registered`,
    );
  }

  if (receipt.status !== "success") {
    failTransaction(db.raw, hash, "reverted", gasUsed);
    throw new RegistrationRefusedError(`Registration reverted (tx ${receipt.transactionHash}); nothing was registered`);
  }

  // The mint: Transfer(0x0 -> this wallet) emitted by the identity registry.
  const agentId = mintedAgentId(receipt.logs, identity, account.address);
  if (agentId === null) {
    failTransaction(db.raw, hash, "mined without a mint to this wallet", gasUsed);
    throw new RegistrationRefusedError(
      `Registration tx ${receipt.transactionHash} succeeded but minted no identity token to ${account.address} from ${identity}; nothing was registered`,
    );
  }

  const entry: RegistryEntry = {
    agentId,
    agentURI,
    chain: chainId,
    contractAddress: identity,
    txHash: receipt.transactionHash ?? hash,
    registeredAt: new Date().toISOString(),
  };

  // One transaction: if saving the entry fails, the row stays pending and the
  // next call resumes from it. A confirmed row with no entry could never be
  // recorded (balanceOf > 0 refuses a new registration).
  const record = () => {
    if (db.raw) {
      db.raw
        .prepare("UPDATE onchain_transactions SET status = 'confirmed', gas_used = COALESCE(?, gas_used) WHERE tx_hash = ?")
        .run(gasUsed ?? null, hash);
    }
    db.setRegistryEntry(entry);
  };
  if (db.raw) db.raw.transaction(record)();
  else record();
  return entry;
}

/**
 * Update the agent's URI on-chain.
 */
export async function updateAgentURI(
  account: PrivateKeyAccount,
  agentId: string,
  newAgentURI: string,
  network: Network = "mainnet",
  db: AutomatonDatabase,
  rpcUrl?: string,
): Promise<string> {
  const contracts = CONTRACTS[network];
  const chain = contracts.chain;

  // Phase 3.2: Preflight gas check
  await preflight(account, network, {
    address: contracts.identity,
    abi: IDENTITY_ABI,
    functionName: "setAgentURI",
    args: [BigInt(agentId), newAgentURI],
  }, rpcUrl);

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(resolveRpcUrl(rpcUrl)),
  });

  const hash = await walletClient.writeContract({
    address: contracts.identity,
    abi: IDENTITY_ABI,
    functionName: "setAgentURI",
    args: [BigInt(agentId), newAgentURI],
  });

  // Phase 3.2: Log transaction
  logTransaction(
    db.raw,
    hash,
    `eip155:${chain.id}`,
    "updateAgentURI",
    "pending",
    undefined,
    { agentId, newAgentURI },
  );

  // Update in DB: the entry for this network's chain only.
  const entry = db.raw ? getRegistryEntryForChain(db.raw, `eip155:${chain.id}`) : undefined;
  if (entry) {
    entry.agentURI = newAgentURI;
    entry.txHash = hash;
    db.setRegistryEntry(entry);
  }

  return hash;
}

/**
 * Leave reputation feedback for another agent.
 *
 * Phase 3.2: Validates score 1-5, comment max 500 chars,
 * uses config-based network (not hardcoded "mainnet").
 */
export async function leaveFeedback(
  account: PrivateKeyAccount,
  agentId: string,
  score: number,
  comment: string,
  network: Network = "mainnet",
  db: AutomatonDatabase,
  rpcUrl?: string,
): Promise<string> {
  // Phase 3.2: Validate score range 1-5
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error(
      `Invalid score: ${score}. Must be an integer between 1 and 5.`,
    );
  }

  // Phase 3.2: Validate comment length
  if (comment.length > 500) {
    throw new Error(`Comment too long: ${comment.length} chars (max 500).`);
  }

  const contracts = CONTRACTS[network];
  const chain = contracts.chain;

  // Phase 3.2: Preflight gas check
  await preflight(account, network, {
    address: contracts.reputation,
    abi: REPUTATION_ABI,
    functionName: "leaveFeedback",
    args: [BigInt(agentId), score, comment],
  }, rpcUrl);

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(resolveRpcUrl(rpcUrl)),
  });

  const hash = await walletClient.writeContract({
    address: contracts.reputation,
    abi: REPUTATION_ABI,
    functionName: "leaveFeedback",
    args: [BigInt(agentId), score, comment],
  });

  // Phase 3.2: Log transaction
  logTransaction(
    db.raw,
    hash,
    `eip155:${chain.id}`,
    "leaveFeedback",
    "pending",
    undefined,
    { agentId, score, comment },
  );

  return hash;
}

/**
 * Query the registry for an agent by ID.
 */
export async function queryAgent(
  agentId: string,
  network: Network = "mainnet",
  rpcUrl?: string,
): Promise<DiscoveredAgent | null> {
  const contracts = CONTRACTS[network];
  const chain = contracts.chain;

  const publicClient = createPublicClient({
    chain,
    transport: http(resolveRpcUrl(rpcUrl)),
  });

  try {
    const uri = await publicClient.readContract({
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "tokenURI",
      args: [BigInt(agentId)],
    });

    // ownerOf may revert on contracts that don't implement it
    let owner = "";
    try {
      owner = (await publicClient.readContract({
        address: contracts.identity,
        abi: IDENTITY_ABI,
        functionName: "ownerOf",
        args: [BigInt(agentId)],
      })) as string;
    } catch {
      logger.warn(`ownerOf reverted for agent ${agentId}, continuing without owner`);
    }

    return {
      agentId,
      owner,
      agentURI: uri as string,
    };
  } catch {
    return null;
  }
}

/**
 * Get the total number of registered agents.
 * Tries totalSupply() first; if that reverts (proxy contracts without
 * ERC-721 Enumerable), falls back to a binary search on ownerOf().
 */
export async function getTotalAgents(
  network: Network = "mainnet",
  rpcUrl?: string,
): Promise<number> {
  const contracts = CONTRACTS[network];
  const chain = contracts.chain;

  const publicClient = createPublicClient({
    chain,
    transport: http(resolveRpcUrl(rpcUrl)),
  });

  try {
    const supply = await publicClient.readContract({
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "totalSupply",
    });
    return Number(supply);
  } catch {
    // totalSupply() reverted — proxy may lack ERC-721 Enumerable.
    // Binary search for the highest minted tokenId via ownerOf().
    return estimateTotalByBinarySearch(publicClient, contracts.identity);
  }
}

/**
 * Estimate total minted tokens by binary-searching ownerOf().
 * Token IDs are sequential starting from 1, so the highest existing
 * tokenId equals the total minted count.
 */
async function estimateTotalByBinarySearch(
  client: { readContract: (args: any) => Promise<any> },
  contractAddress: Address,
): Promise<number> {
  const exists = async (id: number): Promise<boolean> => {
    try {
      await client.readContract({
        address: contractAddress,
        abi: IDENTITY_ABI,
        functionName: "ownerOf",
        args: [BigInt(id)],
      });
      return true;
    } catch {
      return false;
    }
  };

  // Quick probe to find an upper bound
  // Quick probe to find an upper bound
  let upper = 1;
  while (await exists(upper)) {
    upper *= 2;
    if (upper > 10_000_000) break; // safety cap
  }

  // Binary search between 0 and upper
  let lo = 0;
  let hi = upper;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (await exists(mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lo > 0) {
    logger.info(`Binary search estimated total agents: ${lo}`);
  }
  return lo;
}

/**
 * Discover registered agents by scanning Transfer mint events.
 * Fallback for contracts that don't implement totalSupply (ERC-721 Enumerable).
 *
 * Scans for Transfer(address(0), to, tokenId) events to find minted tokens.
 * Returns token IDs and owners extracted directly from event data.
 */
export async function getRegisteredAgentsByEvents(
  network: Network = "mainnet",
  limit: number = 20,
  rpcUrl?: string,
): Promise<{ tokenId: string; owner: string }[]> {
  const contracts = CONTRACTS[network];
  const chain = contracts.chain;

  const publicClient = createPublicClient({
    chain,
    transport: http(resolveRpcUrl(rpcUrl)),
  });

  try {
    const currentBlock = await publicClient.getBlockNumber();
    // Scan last 500,000 blocks (~11.5 days on Base at 2s blocks)
    const earliestBlock = currentBlock > 500_000n ? currentBlock - 500_000n : 0n;

    // Paginate backward in ≤10K-block chunks (newest-first).
    // Base public RPC enforces a 10,000-block limit on eth_getLogs.
    const MAX_BLOCK_RANGE = 10_000n;
    const MAX_CONSECUTIVE_FAILURES = 5;
    const PER_CHUNK_TIMEOUT_MS = 8_000;
    const allLogs: { args: { tokenId?: bigint; to?: string; from?: string } }[] = [];
    let scanTo = currentBlock;
    let consecutiveFailures = 0;

    while (scanTo > earliestBlock) {
      const scanFrom = scanTo - MAX_BLOCK_RANGE > earliestBlock
        ? scanTo - MAX_BLOCK_RANGE
        : earliestBlock;

      try {
        const chunkLogs = await Promise.race([
          publicClient.getLogs({
            address: contracts.identity,
            event: {
              type: "event",
              name: "Transfer",
              inputs: [
                { type: "address", name: "from", indexed: true },
                { type: "address", name: "to", indexed: true },
                { type: "uint256", name: "tokenId", indexed: true },
              ],
            },
            args: {
              from: "0x0000000000000000000000000000000000000000" as Address,
            },
            fromBlock: scanFrom,
            toBlock: scanTo,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("chunk timeout")), PER_CHUNK_TIMEOUT_MS),
          ),
        ]);
        allLogs.push(...chunkLogs);
        consecutiveFailures = 0;
      } catch (chunkError) {
        consecutiveFailures++;
        logger.warn(`Event scan chunk ${scanFrom}-${scanTo} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${chunkError instanceof Error ? chunkError.message : "unknown error"}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.warn("Too many consecutive chunk failures, stopping scan");
          break;
        }
      }

      // Early exit if we already have enough logs
      if (allLogs.length >= limit) break;

      scanTo = scanFrom - 1n; // -1n prevents overlap between chunks
    }

    // Deduplicate by tokenId (defensive against RPC edge cases)
    const seen = new Set<string>();
    const uniqueLogs = allLogs.filter((log) => {
      const id = log.args.tokenId!.toString();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // Extract token IDs and owners, sorted by tokenId descending (most recent first).
    // tokenIds are monotonically increasing on mint, so this gives correct
    // newest-first ordering regardless of chunk collection order.
    const agents = uniqueLogs
      .map((log) => ({
        tokenId: (log.args.tokenId!).toString(),
        owner: log.args.to as string,
      }))
      .sort((a, b) => {
        const diff = BigInt(b.tokenId) - BigInt(a.tokenId);
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
      })
      .slice(0, limit);
    
    logger.info(`Event scan found ${agents.length} minted agents (scanned ${allLogs.length} Transfer events across ${Math.ceil(Number(currentBlock - earliestBlock) / Number(MAX_BLOCK_RANGE))} chunks)`);
    return agents;
  } catch (error) {
    logger.warn(`Transfer event scan failed, returning empty results: ${error instanceof Error ? error.message : "unknown error"}`);
    return [];
  }
}

/**
 * Check if an address has a registered agent.
 */
export async function hasRegisteredAgent(
  address: Address,
  network: Network = "mainnet",
  rpcUrl?: string,
): Promise<boolean> {
  const contracts = CONTRACTS[network];
  const chain = contracts.chain;

  const publicClient = createPublicClient({
    chain,
    transport: http(resolveRpcUrl(rpcUrl)),
  });

  try {
    const balance = await publicClient.readContract({
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "balanceOf",
      args: [address],
    });
    return Number(balance) > 0;
  } catch {
    return false;
  }
}
