/**
 * Unified Signed Message Protocol
 *
 * Defines the signed message interface and utilities for message creation
 * and verification using ECDSA secp256k1.
 *
 * Phase 3.2: Social & Registry Hardening
 */

import crypto from "crypto";
import { ulid } from "ulid";
import { verifyMessage } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { detectChainType } from "../identity/chain.js";
import { canonicalSendMessage } from "./signing.js";

/**
 * A fully signed social message.
 */
export interface SignedMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * Create a unique message ID using ULID.
 */
export function createMessageId(): string {
  return ulid();
}

/**
 * Create a cryptographically random nonce for replay protection.
 */
export function createNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Verify a sender's signature over the canonical send string.
 *
 * `message.to` must be the recipient the caller expects (for inbound mail,
 * our own address), never a value taken on trust from the relay. EVM senders
 * are checked with EIP-191 recovery; Solana senders with an ed25519 detached
 * signature in base58. Anything else is false.
 */
export async function verifyMessageSignature(
  message: { to: string; content: string; signed_at: string; signature: string },
  expectedFrom: string,
): Promise<boolean> {
  try {
    if (typeof message.signature !== "string" || message.signature.length === 0) return false;
    const canonical = canonicalSendMessage(message.to, message.content, message.signed_at);
    const chain = detectChainType(expectedFrom);
    if (chain === "evm") {
      if (!/^0x[0-9a-fA-F]+$/.test(message.signature)) return false;
      return await verifyMessage({
        address: expectedFrom as `0x${string}`,
        message: canonical,
        signature: message.signature as `0x${string}`,
      });
    }
    if (chain === "solana") {
      const sig = bs58.decode(message.signature);
      const key = bs58.decode(expectedFrom);
      if (sig.length !== nacl.sign.signatureLength || key.length !== nacl.sign.publicKeyLength) return false;
      return nacl.sign.detached.verify(new TextEncoder().encode(canonical), sig, key);
    }
    return false;
  } catch {
    return false;
  }
}
