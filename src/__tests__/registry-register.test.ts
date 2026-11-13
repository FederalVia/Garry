/**
 * ERC-8004 registration: an entry is saved only for a successful receipt with
 * a mint to this wallet from the identity registry; a broadcast that is not
 * confirmed yet is resumed, never re-sent; checks are per chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient, MockInferenceClient } from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../state/database.js";

const fake = vi.hoisted(() => ({ publicClient: {} as any, walletClient: {} as any }));
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => fake.publicClient,
    createWalletClient: () => fake.walletClient,
  };
});

const { CONTRACTS, registerAgent, RegistrationPendingError, RegistrationRefusedError } = await import(
  "../registry/erc8004.js"
);
const { createBuiltinTools } = await import("../agent/tools.js");

const TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"));
// The tx hash is the keccak of the signed bytes, as on chain.
const SIGNED = `0x02${"ab".repeat(40)}` as `0x${string}`;
const SIGNED2 = `0x02${"cd".repeat(40)}` as `0x${string}`;
const HASH = keccak256(SIGNED);
const HASH2 = keccak256(SIGNED2);
const word = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
const ZERO = "0x0000000000000000000000000000000000000000";

let db: AutomatonDatabase;
let account: ReturnType<typeof privateKeyToAccount>;

function mintReceipt(opts: { emitter?: string; to?: string; status?: string; hash?: string; id?: bigint } = {}) {
  return {
    status: opts.status ?? "success",
    gasUsed: 90_000n,
    transactionHash: opts.hash ?? HASH,
    logs: [
      {
        address: opts.emitter ?? CONTRACTS.mainnet.identity,
        topics: [TRANSFER, word(ZERO), word(opts.to ?? account.address), `0x${(opts.id ?? 42n).toString(16).padStart(64, "0")}`],
      },
    ],
  };
}

function txRows(): { tx_hash: string; status: string }[] {
  return db.raw.prepare("SELECT tx_hash, status FROM onchain_transactions ORDER BY rowid").all() as any;
}

function registryRows(): { agent_id: string; chain: string }[] {
  return db.raw.prepare("SELECT agent_id, chain FROM registry").all() as any;
}

beforeEach(() => {
  db = createTestDb();
  account = privateKeyToAccount(generatePrivateKey());
  fake.publicClient = {
    getCode: vi.fn(async () => "0x6080604052"),
    readContract: vi.fn(async () => 0n),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1n),
    getBalance: vi.fn(async () => 10n ** 18n),
    waitForTransactionReceipt: vi.fn(async () => mintReceipt()),
    getTransaction: vi.fn(async () => ({ hash: HASH })),
    getTransactionCount: vi.fn(async () => 7),
    getTransactionReceipt: vi.fn(async () => mintReceipt()),
  };
  fake.walletClient = {
    prepareTransactionRequest: vi.fn(async (r: any) => ({ ...r, nonce: r.nonce ?? 7 })),
    signTransaction: vi.fn(async () => SIGNED),
    sendRawTransaction: vi.fn(async () => HASH),
  };
});

afterEach(() => {
  db.close();
});

describe("CONTRACTS", () => {
  it("uses different registry addresses on Base Sepolia than on Base", () => {
    expect(CONTRACTS.testnet.identity).not.toBe(CONTRACTS.mainnet.identity);
    expect(CONTRACTS.testnet.reputation).not.toBe(CONTRACTS.mainnet.reputation);
  });
});

describe("F162: receipt handling", () => {
  it("saves the minted agent id for a successful receipt", async () => {
    const entry = await registerAgent(account, "https://a/card.json", "mainnet", db);
    expect(entry.agentId).toBe("42");
    expect(registryRows()).toEqual([{ agent_id: "42", chain: "eip155:8453" }]);
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "confirmed" }]);
  });

  it("throws on a reverted receipt, saves no entry and marks the tx failed", async () => {
    fake.publicClient.waitForTransactionReceipt.mockResolvedValue({ ...mintReceipt(), status: "reverted", logs: [] });
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/reverted/);
    expect(registryRows()).toEqual([]);
    expect(txRows()[0].status).toBe("failed");
  });

  it("ignores a Transfer emitted by another contract or minted to another wallet", async () => {
    fake.publicClient.waitForTransactionReceipt.mockResolvedValue(
      mintReceipt({ emitter: "0x1111111111111111111111111111111111111111" }),
    );
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/minted no identity/);
    expect(registryRows()).toEqual([]);
    expect(txRows()[0].status).toBe("failed");

    db.raw.prepare("DELETE FROM onchain_transactions").run();
    fake.publicClient.waitForTransactionReceipt.mockResolvedValue(
      mintReceipt({ to: "0x2222222222222222222222222222222222222222" }),
    );
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/minted no identity/);
    expect(registryRows()).toEqual([]);
  });

  it("treats a cancelled or replaced transaction as failed", async () => {
    fake.publicClient.waitForTransactionReceipt.mockImplementation(async (args: any) => {
      args.onReplaced({ reason: "cancelled", transaction: { hash: HASH2 } });
      return { ...mintReceipt({ hash: HASH2 }), logs: [] };
    });
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/cancelled/);
    expect(registryRows()).toEqual([]);
    expect(txRows()[0].status).toBe("failed");
  });
});

describe("F166: a broadcast registration is resumed, never re-sent", () => {
  it("reports pending when the receipt wait fails, then completes from the same hash", async () => {
    fake.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("rate limited"));
    const first = registerAgent(account, "https://a/card.json", "mainnet", db);
    await expect(first).rejects.toBeInstanceOf(RegistrationPendingError);
    await expect(first).rejects.toThrow(/no second transaction will be sent/);
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "pending" }]);
    expect(registryRows()).toEqual([]);

    const entry = await registerAgent(account, "https://a/card.json", "mainnet", db);
    expect(fake.walletClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(entry.txHash).toBe(HASH);
    expect(entry.agentId).toBe("42");
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "confirmed" }]);
  });

  it("closes a dropped transaction so the next call can register afresh", async () => {
    const notFound = Object.assign(new Error("not found"), { name: "TransactionNotFoundError" });
    fake.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timed out"));
    fake.publicClient.getTransaction.mockRejectedValueOnce(notFound);
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toBeInstanceOf(
      RegistrationRefusedError,
    );
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "failed" }]);

    fake.walletClient.signTransaction.mockResolvedValueOnce(SIGNED2);
    fake.publicClient.waitForTransactionReceipt.mockResolvedValueOnce(mintReceipt({ hash: HASH2 }));
    const entry = await registerAgent(account, "https://a/card.json", "mainnet", db);
    expect(fake.walletClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(entry.txHash).toBe(HASH2);
    // The dropped tx's nonce (7) is unspent, so the new one reuses it.
    expect(fake.walletClient.prepareTransactionRequest.mock.calls[1][0].nonce).toBe(7);
  });

  it("re-sends a dropped register whose re-signed bytes are identical (same hash) by reviving its row", async () => {
    const notFound = Object.assign(new Error("not found"), { name: "TransactionNotFoundError" });
    fake.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timed out"));
    fake.publicClient.getTransaction.mockRejectedValueOnce(notFound);
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toBeInstanceOf(
      RegistrationRefusedError,
    );
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "failed" }]);

    // Quiet chain: same nonce and fees, so signing yields the same bytes again.
    const entry = await registerAgent(account, "https://a/card.json", "mainnet", db);
    expect(fake.walletClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(entry.txHash).toBe(HASH);
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "confirmed" }]);
  });

  it("records the pending row before sending, so a lost send response is resumed", async () => {
    fake.walletClient.sendRawTransaction.mockRejectedValueOnce(new Error("request timed out"));
    const first = registerAgent(account, "https://a/card.json", "mainnet", db);
    await expect(first).rejects.toBeInstanceOf(RegistrationPendingError);
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "pending" }]);

    // The tx did reach the node and was mined: balanceOf is 1 now.
    fake.publicClient.readContract.mockResolvedValue(1n);
    const entry = await registerAgent(account, "https://a/card.json", "mainnet", db);
    expect(entry.agentId).toBe("42");
    expect(fake.walletClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(registryRows()).toEqual([{ agent_id: "42", chain: "eip155:8453" }]);
  });

  it("adopts a token minted by a register that was marked dropped or replaced", async () => {
    const owned = (uri = "https://chain/card.json") =>
      fake.publicClient.readContract.mockImplementation(async (a: any) =>
        a.functionName === "balanceOf" ? 1n : a.functionName === "ownerOf" ? account.address : uri,
      );
    const notFound = Object.assign(new Error("not found"), { name: "TransactionNotFoundError" });
    fake.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timed out"));
    fake.publicClient.getTransaction.mockRejectedValueOnce(notFound);
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toBeInstanceOf(
      RegistrationRefusedError,
    );
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "failed" }]);

    // It was mined after all.
    owned();
    const entry = await registerAgent(account, "https://a/card.json", "mainnet", db);
    expect(entry).toMatchObject({ agentId: "42", txHash: HASH, agentURI: "https://chain/card.json" });
    expect(fake.walletClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "confirmed" }]);
    expect(registryRows()).toEqual([{ agent_id: "42", chain: "eip155:8453" }]);
  });

  it("adopts a token minted by the transaction that replaced a register", async () => {
    fake.publicClient.waitForTransactionReceipt.mockImplementationOnce(async (args: any) => {
      args.onReplaced({ reason: "replaced", transaction: { hash: HASH2 } });
      return mintReceipt({ hash: HASH2, id: 9n });
    });
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/replaced/);
    expect(registryRows()).toEqual([]);

    fake.publicClient.readContract.mockImplementation(async (a: any) =>
      a.functionName === "balanceOf" ? 1n : a.functionName === "ownerOf" ? account.address : "https://b/card.json",
    );
    fake.publicClient.getTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === HASH2) return mintReceipt({ hash: HASH2, id: 9n });
      throw Object.assign(new Error("no receipt"), { name: "TransactionReceiptNotFoundError" });
    });
    const entry = await registerAgent(account, "https://a/card.json", "mainnet", db);
    expect(entry).toMatchObject({ agentId: "9", txHash: HASH2 });
    expect(registryRows()).toEqual([{ agent_id: "9", chain: "eip155:8453" }]);
  });

  it("still refuses a token it cannot trace to a recorded register, or that moved away", async () => {
    fake.publicClient.readContract.mockImplementation(async (a: any) =>
      a.functionName === "balanceOf" ? 1n : a.functionName === "ownerOf" ? "0x2222222222222222222222222222222222222222" : "",
    );
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/no register transaction recorded here/);
    db.raw
      .prepare("INSERT INTO onchain_transactions (id, tx_hash, chain, operation, status, metadata) VALUES ('x', ?, 'eip155:8453', 'register', 'failed', '{}')")
      .run(HASH);
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/already owns 1/);
    expect(registryRows()).toEqual([]);
    expect(fake.walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("keeps the tx pending when saving the entry fails, so the next call records it", async () => {
    const save = db.setRegistryEntry.bind(db);
    let fail = true;
    db.setRegistryEntry = (entry) => {
      if (fail) {
        fail = false;
        throw new Error("SQLITE_BUSY: database is locked");
      }
      save(entry);
    };
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/SQLITE_BUSY/);
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "pending" }]);
    expect(registryRows()).toEqual([]);

    // balanceOf now reports the minted token; the pending row is resumed first.
    fake.publicClient.readContract.mockResolvedValue(1n);
    const entry = await registerAgent(account, "https://a/card.json", "mainnet", db);
    expect(entry.agentId).toBe("42");
    expect(fake.walletClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(txRows()).toEqual([{ tx_hash: HASH, status: "confirmed" }]);
    expect(registryRows()).toEqual([{ agent_id: "42", chain: "eip155:8453" }]);
  });

  it("refuses when the wallet already owns an identity token, or when that cannot be read", async () => {
    fake.publicClient.readContract.mockResolvedValueOnce(1n);
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/already owns 1/);
    fake.publicClient.readContract.mockRejectedValueOnce(new Error("rpc down"));
    await expect(registerAgent(account, "https://a/card.json", "mainnet", db)).rejects.toThrow(/Could not check/);
    fake.publicClient.getCode.mockResolvedValueOnce("0x");
    await expect(registerAgent(account, "https://a/card.json", "testnet", db)).rejects.toThrow(/No contract/);
    expect(fake.walletClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(txRows()).toEqual([]);
  });
});

describe("H5-009: register_erc8004 checks the target chain only", () => {
  function ctx(): ToolContext {
    return {
      identity: { ...createTestIdentity(), account, address: account.address },
      config: { ...createTestConfig(), chainType: "evm" },
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    } as unknown as ToolContext;
  }
  const tool = () => createBuiltinTools("").find((t) => t.name === "register_erc8004")!;

  it("a testnet entry does not block a mainnet registration", async () => {
    db.setRegistryEntry({
      agentId: "7",
      agentURI: "https://a/card.json",
      chain: "eip155:84532",
      contractAddress: CONTRACTS.testnet.identity,
      txHash: HASH2,
      registeredAt: new Date().toISOString(),
    });
    const out = await tool().execute({ agent_uri: "https://a/card.json", network: "mainnet" }, ctx());
    expect(out).toMatch(/Registered on-chain \(mainnet\)! Agent ID: 42/);
    expect(fake.walletClient.sendRawTransaction).toHaveBeenCalledTimes(1);

    const again = await tool().execute({ agent_uri: "https://a/card.json", network: "testnet" }, ctx());
    expect(again).toMatch(/Already registered on testnet! Agent ID: 7/);
  });

  it("the same token id on testnet and mainnet keeps both entries", async () => {
    fake.publicClient.waitForTransactionReceipt.mockResolvedValueOnce(
      mintReceipt({ emitter: CONTRACTS.testnet.identity, id: 5n }),
    );
    expect(await tool().execute({ agent_uri: "https://a/card.json", network: "testnet" }, ctx())).toMatch(
      /Registered on-chain \(testnet\)! Agent ID: 5/,
    );
    fake.walletClient.signTransaction.mockResolvedValueOnce(SIGNED2);
    fake.publicClient.waitForTransactionReceipt.mockResolvedValueOnce(mintReceipt({ hash: HASH2, id: 5n }));
    expect(await tool().execute({ agent_uri: "https://a/card.json", network: "mainnet" }, ctx())).toMatch(
      /Registered on-chain \(mainnet\)! Agent ID: 5/,
    );
    expect(registryRows().sort((a, b) => a.chain.localeCompare(b.chain))).toEqual([
      { agent_id: "5", chain: "eip155:84532" },
      { agent_id: "5", chain: "eip155:8453" },
    ].sort((a, b) => a.chain.localeCompare(b.chain)));
    expect(db.getRegistryEntry()?.chain).toBe("eip155:8453");
    expect(await tool().execute({ agent_uri: "https://a/card.json", network: "testnet" }, ctx())).toMatch(
      /Already registered on testnet! Agent ID: 5/,
    );
  });

  it("says so when a resumed registration used a different agent URI", async () => {
    fake.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timed out"));
    await tool().execute({ agent_uri: "https://old/card.json" }, ctx());
    const out = await tool().execute({ agent_uri: "https://new/card.json" }, ctx());
    expect(fake.walletClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Registered on-chain \(mainnet\)! Agent ID: 42/);
    expect(out).toContain("on-chain agent URI is https://old/card.json, not the requested https://new/card.json");
    expect(db.getRegistryEntry()?.agentURI).toBe("https://old/card.json");
  });

  it("refuses an unknown network", async () => {
    const out = await tool().execute({ agent_uri: "https://a/card.json", network: "foo" }, ctx());
    expect(out).toMatch(/^Refused: network must be "mainnet" or "testnet"/);
    expect(fake.walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("reports a pending registration instead of failing", async () => {
    fake.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timed out"));
    const out = await tool().execute({ agent_uri: "https://a/card.json" }, ctx());
    expect(out).toMatch(/not confirmed yet/);
    expect(out).toContain(HASH);
  });
});

describe("registry table key", () => {
  it("rebuilds a legacy agent_id-keyed table so both chains fit, keeping its rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-key-"));
    const file = path.join(dir, "state.db");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE registry (
      agent_id TEXT PRIMARY KEY, agent_uri TEXT NOT NULL, chain TEXT NOT NULL DEFAULT 'eip155:8453',
      contract_address TEXT NOT NULL, tx_hash TEXT NOT NULL, registered_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    legacy.prepare("INSERT INTO registry VALUES ('5', 'https://a/card.json', 'eip155:84532', '0xT', '0x1', '2026-01-01')").run();
    legacy.close();

    const upgraded = createDatabase(file);
    try {
      upgraded.setRegistryEntry({
        agentId: "5",
        agentURI: "https://a/card.json",
        chain: "eip155:8453",
        contractAddress: "0xM",
        txHash: "0x2",
        registeredAt: "2026-02-01",
      });
      const rows = upgraded.raw.prepare("SELECT agent_id, chain FROM registry ORDER BY chain").all();
      expect(rows).toEqual([
        { agent_id: "5", chain: "eip155:8453" },
        { agent_id: "5", chain: "eip155:84532" },
      ]);
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
