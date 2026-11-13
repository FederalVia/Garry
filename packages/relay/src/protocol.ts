/**
 * Wire protocol: the strings senders sign and how the relay checks them.
 *
 * Kept separate from the runtime's src/social code on purpose, so the relay
 * can be deployed on its own. The loopback test runs the real runtime client
 * against this relay, which catches any drift between the two.
 */

import { keccak256, toBytes, verifyMessage } from "viem";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const PREFIX_V1 = "Automaton/1";
/** Legacy Conway form: accepted only when the relay runs with legacyConway. */
export const PREFIX_CONWAY = "Conway";
export type Prefix = typeof PREFIX_V1 | typeof PREFIX_CONWAY;

/** Stored per message; informational for clients, which never trust it. */
export type ProtocolTag = "automaton/1" | "conway";
export function protocolTag(prefix: Prefix): ProtocolTag {
  return prefix === PREFIX_V1 ? "automaton/1" : "conway";
}

export type Chain = "evm" | "solana";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
// A 32-byte key is at most 44 base58 characters; the cap keeps bs58's
// quadratic decode away from attacker-sized input.
const MAX_SOLANA_ADDRESS_CHARS = 48;
const MAX_SOLANA_SIGNATURE_CHARS = 96;

function bs58Bytes(value: string, maxChars: number): Uint8Array | null {
  if (value.length === 0 || value.length > maxChars) return null;
  try {
    return bs58.decode(value);
  } catch {
    return null;
  }
}

export function chainOf(address: string): Chain | null {
  if (typeof address !== "string") return null;
  if (EVM_ADDRESS.test(address)) return "evm";
  const bytes = bs58Bytes(address, MAX_SOLANA_ADDRESS_CHARS);
  return bytes && bytes.length === 32 ? "solana" : null;
}

/** Lowercase for EVM; Solana base58 is case-sensitive and kept as it is. */
export function normalize(address: string): string | null {
  const chain = chainOf(address);
  if (chain === "evm") return address.toLowerCase();
  if (chain === "solana") return address;
  return null;
}

/** `to` must already be normalized. */
export function canonicalSend(prefix: Prefix, to: string, content: string, signedAt: string): string {
  return `${prefix}:send:${to}:${keccak256(toBytes(content))}:${signedAt}`;
}

/** v1 binds a single-use nonce; the Conway form has none and is replayable within its window. */
export function canonicalPoll(prefix: Prefix, address: string, timestamp: string, nonce?: string): string {
  if (prefix === PREFIX_V1) return `${PREFIX_V1}:poll:${address}:${timestamp}:${nonce ?? ""}`;
  return `${PREFIX_CONWAY}:poll:${address}:${timestamp}`;
}

/** Cheap shape check before the expensive verification. */
export function signatureFormatOk(chain: Chain, signature: string): boolean {
  if (typeof signature !== "string") return false;
  if (chain === "evm") return EVM_SIGNATURE.test(signature);
  const bytes = bs58Bytes(signature, MAX_SOLANA_SIGNATURE_CHARS);
  return bytes !== null && bytes.length === nacl.sign.signatureLength;
}

/** EOA ecrecover for EVM, ed25519 detached for Solana. Never throws. */
export async function verify(address: string, message: string, signature: string): Promise<boolean> {
  try {
    const chain = chainOf(address);
    if (chain === "evm") {
      if (!EVM_SIGNATURE.test(signature)) return false;
      return await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    }
    if (chain === "solana") {
      const sig = bs58Bytes(signature, MAX_SOLANA_SIGNATURE_CHARS);
      const key = bs58Bytes(address, MAX_SOLANA_ADDRESS_CHARS);
      if (!sig || !key) return false;
      if (sig.length !== nacl.sign.signatureLength || key.length !== nacl.sign.publicKeyLength) return false;
      return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, key);
    }
    return false;
  } catch {
    return false;
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Milliseconds for an ISO-8601 UTC time in the client's format, else null. */
export function parseIsoUtc(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
