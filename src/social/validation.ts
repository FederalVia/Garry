/**
 * Message Validation
 *
 * Validates social messages for size limits, replay protection,
 * and address format.
 *
 * Phase 3.2: Social & Registry Hardening
 */

import type { MessageValidationResult } from "../types.js";
import { MESSAGE_LIMITS } from "./signing.js";
import { isValidAddress } from "../identity/chain.js";

export { isValidAddress } from "../identity/chain.js";

/**
 * Validate a social message for size, timestamp, and address constraints.
 */
export function validateMessage(message: {
  from: string;
  to: string;
  content: string;
  signed_at?: string;
  timestamp?: string;
}): MessageValidationResult {
  const errors: string[] = [];

  // Size limits
  const totalSize = JSON.stringify(message).length;
  if (totalSize > MESSAGE_LIMITS.maxTotalSize) {
    errors.push(`Message exceeds total size limit: ${totalSize} > ${MESSAGE_LIMITS.maxTotalSize}`);
  }
  if (message.content.length > MESSAGE_LIMITS.maxContentLength) {
    errors.push(`Content exceeds size limit: ${message.content.length} > ${MESSAGE_LIMITS.maxContentLength}`);
  }

  // A relay stores text as UTF-8, which has no form for an unpaired surrogate: it
  // would return different text and the recipient would drop it as a forgery.
  if (/[\uD800-\uDFFF]/u.test(message.content)) {
    errors.push("Content contains an unpaired UTF-16 surrogate");
  }

  // Timestamp validation (replay protection)
  const ts = message.signed_at || message.timestamp;
  if (ts) {
    const parsed = new Date(ts).getTime();
    if (isNaN(parsed)) {
      errors.push("Invalid timestamp");
    } else {
      const age = Date.now() - parsed;
      if (age > MESSAGE_LIMITS.replayWindowMs) {
        errors.push("Message too old (possible replay)");
      }
      if (age < -60_000) {
        errors.push("Message from future");
      }
    }
  }

  // Address validation
  if (!isValidAddress(message.from)) {
    errors.push("Invalid sender address");
  }
  if (!isValidAddress(message.to)) {
    errors.push("Invalid recipient address");
  }

  return { valid: errors.length === 0, errors };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** URL.hostname keeps the brackets of an IPv6 literal ("[::1]"). */
function bareHostname(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/** True for an http: URL whose host is localhost, 127.0.0.1 or ::1. */
export function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(bareHostname(parsed));
  } catch {
    return false;
  }
}

/**
 * Validate a relay (or webhook) URL: HTTPS, or plain HTTP only to this
 * machine's loopback, where there is no network to protect against.
 * Throws otherwise, before anything is signed or sent.
 */
export function validateRelayUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid relay URL: ${url}`);
  }
  if (parsed.protocol === "https:") return;
  if (isLoopbackHttpUrl(url)) return;
  throw new Error(`Relay URL must use HTTPS (plain HTTP only for localhost, 127.0.0.1 or [::1]): ${url}`);
}

// isValidAddress is re-exported from ../identity/chain.js (supports both EVM and Solana)
