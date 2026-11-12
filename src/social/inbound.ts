/**
 * Inbound message authenticity
 *
 * Every message the relay hands us gets exactly one verdict:
 * - verified: the relay supplied the sender's signature and signed_at, the
 *   signature checks out against the claimed sender over the canonical send
 *   string addressed to us, and signed_at is inside the freshness window;
 * - unverified: no signature, or a valid signature whose signed_at is outside
 *   the freshness window; the sender address is not vouched for;
 * - rejected: a signature that fails, a missing or unreadable signed_at next
 *   to a signature, an invalid sender, a recipient that is not us, or
 *   oversized content.
 *
 * The relay-assigned id and nonce prove nothing (the relay chooses them), so
 * replay protection keys on what the sender signed instead. Inbox rows are
 * never deleted, so that key stops a replay for good; the freshness window
 * only decides whether a message counts as verified, never whether it is
 * delivered (a long sleep or a fast sender clock must not lose mail).
 */

import { keccak256, toBytes } from "viem";
import { MESSAGE_LIMITS, canonicalSendMessage } from "./signing.js";
import { verifyMessageSignature } from "./protocol.js";
import { normalizeSenderAddress } from "../agent/inbox-isolation.js";

/** Oldest signed message still counted as verified. */
export const INBOUND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Clock skew allowed for a signed_at in the future before it counts as unverified. */
export const INBOUND_FUTURE_SKEW_MS = 2 * 60 * 1000;

/** A message as the relay's poll endpoint returns it. */
export interface RelayInboundMessage {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  content?: unknown;
  signature?: unknown;
  signed_at?: unknown;
  signedAt?: unknown;
  createdAt?: unknown;
  nonce?: unknown;
  replyTo?: unknown;
}

export type InboundRejectReason =
  | "missing_id"
  | "invalid_sender"
  | "invalid_content"
  | "too_large"
  | "wrong_recipient"
  | "bad_timestamp"
  | "bad_signature";

export type InboundVerdict =
  | {
      verdict: "verified";
      /** Normalized sender address (lowercase for EVM). */
      from: string;
      signedAt: string;
      /** Replay key: the same signed message always gives the same hash. */
      sigHash: string;
    }
  | {
      verdict: "unverified";
      from: string;
      /** Relay-reported; proves nothing about when the sender wrote it. */
      signedAt?: string;
      /** Duplicate key for an exact re-delivery, when the relay gives enough to tell. */
      sigHash?: string;
      /** Set when a valid signature was downgraded for its signed_at. */
      outsideWindow?: "stale" | "future";
    }
  | { verdict: "rejected"; reason: InboundRejectReason };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Hash of what the sender signed. Hashing the signature bytes would let a
 * relay replay a message with an equivalent but differently encoded ECDSA
 * signature; the signed string itself has one form.
 */
function verifiedHash(from: string, canonical: string): string {
  return keccak256(toBytes(`v|${from}|${canonical}`));
}

/**
 * Key for spotting an unsigned message re-delivered under a new relay id.
 * Kept apart from verified hashes, so unsigned traffic can never shadow a
 * signed message. Null when the relay gives no nonce or signed_at.
 */
function unverifiedHash(
  from: string,
  content: string,
  nonce: string | undefined,
  signedAt: string | undefined,
): string | undefined {
  if (!nonce && !signedAt) return undefined;
  return keccak256(
    toBytes(`u|${from}|${nonce ?? ""}|${signedAt ?? ""}|${keccak256(toBytes(content))}`),
  );
}

/**
 * Classify one polled message. `selfAddress` is our own address: the
 * signature must cover it as the recipient, so a message signed for someone
 * else cannot be forwarded to us.
 */
export async function classifyInbound(
  raw: RelayInboundMessage,
  selfAddress: string,
  now: number = Date.now(),
): Promise<InboundVerdict> {
  if (!str(raw.id)) return { verdict: "rejected", reason: "missing_id" };

  const from = normalizeSenderAddress(raw.from);
  if (!from) return { verdict: "rejected", reason: "invalid_sender" };

  if (typeof raw.content !== "string") return { verdict: "rejected", reason: "invalid_content" };
  const content = raw.content;
  if (content.length > MESSAGE_LIMITS.maxContentLength) {
    return { verdict: "rejected", reason: "too_large" };
  }

  const self = normalizeSenderAddress(selfAddress);
  const to = raw.to;
  if (to !== undefined && to !== null && to !== "") {
    if (!self || normalizeSenderAddress(to) !== self) {
      return { verdict: "rejected", reason: "wrong_recipient" };
    }
  }

  const signedAt = str(raw.signed_at) ?? str(raw.signedAt);
  const signature = str(raw.signature);
  if (!signature) {
    return {
      verdict: "unverified",
      from,
      signedAt,
      sigHash: unverifiedHash(from, content, str(raw.nonce), signedAt),
    };
  }

  if (!signedAt || !self) return { verdict: "rejected", reason: "bad_timestamp" };
  const t = Date.parse(signedAt);
  if (!Number.isFinite(t)) return { verdict: "rejected", reason: "bad_timestamp" };
  const outsideWindow =
    now - t > INBOUND_MAX_AGE_MS ? "stale" : t - now > INBOUND_FUTURE_SKEW_MS ? "future" : undefined;

  // Our own address, not the relay's `to`, is what the signature must cover.
  const ok = await verifyMessageSignature(
    { to: selfAddress, content, signed_at: signedAt, signature },
    from,
  );
  if (!ok) return { verdict: "rejected", reason: "bad_signature" };

  // The signed-content hash, even when downgraded: the sender did sign this,
  // so a later or earlier delivery of the same message is still a duplicate.
  const sigHash = verifiedHash(from, canonicalSendMessage(selfAddress, content, signedAt));
  if (outsideWindow) {
    // Too old or too far ahead to vouch for (it could be a replay into a
    // fresh database), but the text is kept and labelled NOT VERIFIED, as an
    // unsigned message would be.
    return { verdict: "unverified", from, signedAt, sigHash, outsideWindow };
  }
  return { verdict: "verified", from, signedAt, sigHash };
}
