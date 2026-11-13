/**
 * Social Signing Module
 *
 * THE SINGLE canonical signing implementation for both runtime + CLI.
 * Supports both EVM (ECDSA secp256k1 via viem) and Solana (Ed25519 via tweetnacl).
 *
 * Signed strings carry a versioned prefix. "Automaton/1" is the default;
 * "Conway" is the legacy form, used only when relay compatibility asks for it.
 */

import { randomBytes } from "crypto";
import {
  type PrivateKeyAccount,
  keccak256,
  toBytes,
} from "viem";
import type { SignedMessagePayload } from "../types.js";
import { detectChainType, type ChainIdentity } from "../identity/chain.js";

export const MESSAGE_LIMITS = {
  maxContentLength: 64_000, // 64KB
  maxTotalSize: 128_000, // 128KB
  replayWindowMs: 300_000, // 5 minutes
  maxOutboundPerHour: 100,
} as const;

export const PREFIX_V1 = "Automaton/1" as const;
export const PREFIX_CONWAY = "Conway" as const;
/** The protocol tag at the start of every signed string. */
export type SignedPrefix = typeof PREFIX_V1 | typeof PREFIX_CONWAY;

function normalizeRecipient(to: string): string {
  return detectChainType(to) === "solana" ? to : to.toLowerCase();
}

/**
 * The string a sender signs for one message. Used by signing and by inbound
 * verification, so the two can never drift. EVM recipients are lowercased;
 * Solana base58 addresses are case-sensitive and kept as they are.
 */
export function canonicalSendMessage(
  to: string,
  content: string,
  signedAt: string,
  prefix: SignedPrefix = PREFIX_V1,
): string {
  return `${prefix}:send:${normalizeRecipient(to)}:${keccak256(toBytes(content))}:${signedAt}`;
}

/**
 * The string signed for a poll or count request. v1 binds a one-time nonce
 * so a captured header set is good for one request; the Conway form has no
 * nonce and is replayable within the relay's window.
 */
export function canonicalPollMessage(
  address: string,
  timestamp: string,
  prefix: SignedPrefix,
  nonce?: string,
): string {
  if (prefix === PREFIX_V1) {
    if (!nonce) throw new Error("Automaton/1 poll signature needs a nonce");
    return `${PREFIX_V1}:poll:${address}:${timestamp}:${nonce}`;
  }
  return `${PREFIX_CONWAY}:poll:${address}:${timestamp}`;
}

function isChainIdentity(signer: PrivateKeyAccount | ChainIdentity): signer is ChainIdentity {
  return "signMessage" in signer && "chainType" in signer;
}

function signerAddress(signer: PrivateKeyAccount | ChainIdentity): string {
  if (isChainIdentity(signer)) {
    return signer.chainType === "solana" ? signer.address : signer.address.toLowerCase();
  }
  return signer.address.toLowerCase();
}

async function signText(signer: PrivateKeyAccount | ChainIdentity, text: string): Promise<string> {
  if (isChainIdentity(signer)) return signer.signMessage(text);
  return (signer as PrivateKeyAccount).signMessage({ message: text });
}

/**
 * Sign a send message payload.
 *
 * Canonical format: {prefix}:send:{to_normalized}:{keccak256(toBytes(content))}:{signed_at_iso}
 *
 * Accepts either a PrivateKeyAccount (EVM backward compat) or a ChainIdentity (both chains).
 */
export async function signSendPayload(
  signer: PrivateKeyAccount | ChainIdentity,
  to: string,
  content: string,
  replyTo?: string,
  opts: { prefix?: SignedPrefix } = {},
): Promise<SignedMessagePayload> {
  if (content.length > MESSAGE_LIMITS.maxContentLength) {
    throw new Error(
      `Message content too long: ${content.length} bytes (max ${MESSAGE_LIMITS.maxContentLength})`,
    );
  }

  const signedAt = new Date().toISOString();
  const canonical = canonicalSendMessage(to, content, signedAt, opts.prefix ?? PREFIX_V1);
  const signature = await signText(signer, canonical);

  return {
    from: signerAddress(signer),
    to: normalizeRecipient(to),
    content,
    signed_at: signedAt,
    signature,
    reply_to: replyTo,
  };
}

/**
 * Sign a poll payload.
 *
 * v1:     Automaton/1:poll:{address}:{timestamp_iso}:{nonce}  (fresh nonce per call)
 * Conway: Conway:poll:{address}:{timestamp_iso}
 *
 * Accepts either a PrivateKeyAccount (EVM backward compat) or a ChainIdentity (both chains).
 */
export async function signPollPayload(
  signer: PrivateKeyAccount | ChainIdentity,
  opts: { prefix?: SignedPrefix } = {},
): Promise<{ address: string; signature: string; timestamp: string; nonce?: string }> {
  const prefix = opts.prefix ?? PREFIX_V1;
  const timestamp = new Date().toISOString();
  const address = signerAddress(signer);
  const nonce = prefix === PREFIX_V1 ? randomBytes(16).toString("hex") : undefined;
  const signature = await signText(signer, canonicalPollMessage(address, timestamp, prefix, nonce));
  return nonce ? { address, signature, timestamp, nonce } : { address, signature, timestamp };
}
