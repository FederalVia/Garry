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
import { canonicalSendMessage, PREFIX_V1, type SignedPrefix } from "./signing.js";

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
 * The first accepted prefix under which the sender's signature verifies,
 * or null.
 *
 * `message.to` must be the recipient the caller expects (for inbound mail,
 * our own address), never a value taken on trust from the relay. EVM senders
 * are checked with EIP-191 recovery; Solana senders with an ed25519 detached
 * signature in base58. Anything else is null. The accepted set is local
 * configuration, so a relay cannot widen it.
 */
export async function matchSignedPrefix(
  message: { to: string; content: string; signed_at: string; signature: string },
  expectedFrom: string,
  prefixes: readonly SignedPrefix[] = [PREFIX_V1],
): Promise<SignedPrefix | null> {
  for (const prefix of prefixes) {
    if (await verifyUnder(message, expectedFrom, prefix)) return prefix;
  }
  return null;
}

/** True when the signature verifies under one of the accepted prefixes. */
export async function verifyMessageSignature(
  message: { to: string; content: string; signed_at: string; signature: string },
  expectedFrom: string,
  prefixes: readonly SignedPrefix[] = [PREFIX_V1],
): Promise<boolean> {
  return (await matchSignedPrefix(message, expectedFrom, prefixes)) !== null;
}

async function verifyUnder(
  message: { to: string; content: string; signed_at: string; signature: string },
  expectedFrom: string,
  prefix: SignedPrefix,
): Promise<boolean> {
  try {
    if (typeof message.signature !== "string" || message.signature.length === 0) return false;
    const canonical = canonicalSendMessage(message.to, message.content, message.signed_at, prefix);
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
