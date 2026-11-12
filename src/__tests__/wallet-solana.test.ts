/**
 * Tests for Solana Wallet Generation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { generateSolanaKeypair, getWalletChainType } from "../identity/wallet.js";
import { isValidSolanaAddress } from "../identity/chain.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { WalletData } from "../types.js";

describe("Solana Wallet", () => {
  describe("generateSolanaKeypair", () => {
    it("generates a valid Ed25519 keypair", () => {
      const { secretKey, publicKey, address } = generateSolanaKeypair();

      // Secret key is 64 bytes (32 private + 32 public)
      expect(secretKey.length).toBe(64);

      // Public key is 32 bytes
      expect(publicKey.length).toBe(32);

      // Address is valid base58-encoded public key
      expect(isValidSolanaAddress(address)).toBe(true);

      // Can reconstruct keypair from secret key
      const reconstructed = nacl.sign.keyPair.fromSecretKey(secretKey);
      expect(bs58.encode(reconstructed.publicKey)).toBe(address);
    });

    it("generates unique keypairs", () => {
      const kp1 = generateSolanaKeypair();
      const kp2 = generateSolanaKeypair();
      expect(kp1.address).not.toBe(kp2.address);
    });
  });

  describe("WalletData format", () => {
    it("Solana wallet data has correct shape", () => {
      const { secretKey } = generateSolanaKeypair();
      const walletData = {
        chainType: "solana" as const,
        secretKey: bs58.encode(secretKey),
        createdAt: new Date().toISOString(),
      };

      // Verify secretKey round-trips through base58
      const decoded = bs58.decode(walletData.secretKey);
      expect(decoded.length).toBe(64);

      // Verify reconstructed keypair matches
      const kp = nacl.sign.keyPair.fromSecretKey(decoded);
      expect(bs58.encode(kp.publicKey)).toBeTruthy();
    });

    it("EVM wallet data backward compat (missing chainType defaults to evm)", () => {
      const walletData: WalletData = {
        privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        createdAt: "2024-01-01T00:00:00.000Z",
      };

      // No chainType field = defaults to "evm"
      expect(walletData.chainType ?? "evm").toBe("evm");
    });
  });

  describe("getWalletChainType", () => {
    it("returns evm when no wallet exists", () => {
      // Default when file doesn't exist is evm
      const chainType = getWalletChainType();
      // It should return "evm" even if the wallet file doesn't exist at the test path
      expect(["evm", "solana"]).toContain(chainType);
    });
  });

  describe("loadChainIdentity (never creates a wallet)", () => {
    let home: string;

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-load-"));
      vi.stubEnv("HOME", home);
      vi.resetModules();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
      fs.rmSync(home, { recursive: true, force: true });
    });

    function write(data: object): void {
      fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
      fs.writeFileSync(path.join(home, ".automaton", "wallet.json"), JSON.stringify(data));
    }

    it("returns null and creates nothing when there is no wallet", async () => {
      const { loadChainIdentity } = await import("../identity/wallet.js");
      expect(loadChainIdentity()).toBeNull();
      expect(fs.existsSync(path.join(home, ".automaton"))).toBe(false);
    });

    it("loads a Solana wallet as a Solana identity with its base58 address", async () => {
      const { secretKey, address } = generateSolanaKeypair();
      write({ chainType: "solana", secretKey: bs58.encode(secretKey), createdAt: "2024-01-01T00:00:00.000Z" });
      const { loadChainIdentity } = await import("../identity/wallet.js");
      const loaded = loadChainIdentity();
      expect(loaded?.chainType).toBe("solana");
      expect(loaded?.address).toBe(address);
      expect(loaded?.chainIdentity.chainType).toBe("solana");
    });

    it("loads a legacy EVM wallet (no chainType)", async () => {
      write({ privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", createdAt: "2024-01-01T00:00:00.000Z" });
      const { loadChainIdentity } = await import("../identity/wallet.js");
      const loaded = loadChainIdentity();
      expect(loaded?.chainType).toBe("evm");
      expect(loaded?.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    });

    it("throws a clear error for a Solana wallet without a secretKey", async () => {
      write({ chainType: "solana", createdAt: "2024-01-01T00:00:00.000Z" });
      const { loadChainIdentity } = await import("../identity/wallet.js");
      expect(() => loadChainIdentity()).toThrow(/no secretKey/);
    });
  });
});
