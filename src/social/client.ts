/**
 * Social Client Factory
 *
 * Creates a SocialClient for the automaton runtime.
 * Self-contained: uses viem for signing and fetch for HTTP.
 *
 * Outbound: HTTPS only, shared signing, request timeouts, rate limiting.
 * Inbound: every polled message is classified (social/inbound.ts). Signed
 * messages are verified against the claimed sender and our own address;
 * unsigned ones, and signed ones outside the freshness window, are passed on
 * marked unverified; forged or misaddressed ones are dropped here and never
 * stored.
 */

import type { PrivateKeyAccount } from "viem";
import type { SocialClientInterface, InboxMessage } from "../types.js";
import type { ChainIdentity } from "../identity/chain.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { signSendPayload, signPollPayload, MESSAGE_LIMITS } from "./signing.js";
import { validateRelayUrl, validateMessage } from "./validation.js";
import { classifyInbound, type RelayInboundMessage } from "./inbound.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("social");

// Request timeout for all fetch calls (30 seconds)
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Create a SocialClient wired to the agent's wallet.
 *
 * @throws if relayUrl is not HTTPS
 */
export function createSocialClient(
  relayUrl: string,
  account: PrivateKeyAccount | ChainIdentity,
): SocialClientInterface {
  // Phase 3.2: Validate relay URL as HTTPS
  validateRelayUrl(relayUrl);

  const baseUrl = relayUrl.replace(/\/$/, "");
  const httpClient = new ResilientHttpClient();

  // Rate limiting state: track outbound message timestamps
  const outboundTimestamps: number[] = [];

  function checkRateLimit(): void {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    // Prune old timestamps
    while (outboundTimestamps.length > 0 && outboundTimestamps[0]! < oneHourAgo) {
      outboundTimestamps.shift();
    }
    if (outboundTimestamps.length >= MESSAGE_LIMITS.maxOutboundPerHour) {
      throw new Error(
        `Rate limit exceeded: ${MESSAGE_LIMITS.maxOutboundPerHour} messages per hour`,
      );
    }
  }

  return {
    send: async (
      to: string,
      content: string,
      replyTo?: string,
    ): Promise<{ id: string }> => {
      // Phase 3.2: Rate limit check
      checkRateLimit();

      // Track outbound attempt for rate limiting BEFORE the network call.
      // Counting attempts (not just successes) prevents hammering the relay
      // with unlimited retries when the server returns errors.
      outboundTimestamps.push(Date.now());

      // Phase 3.2: Validate message before sending
      const validation = validateMessage({ from: account.address, to, content });
      if (!validation.valid) {
        throw new Error(`Message validation failed: ${validation.errors.join("; ")}`);
      }

      // Phase 3.2: Use shared signing module
      const payload = await signSendPayload(account, to, content, replyTo);

      const res = await httpClient.request(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: REQUEST_TIMEOUT_MS,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Send failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as { id: string };
      return { id: data.id };
    },

    poll: async (
      cursor?: string,
      limit?: number,
    ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> => {
      // Phase 3.2: Use shared signing module
      const pollAuth = await signPollPayload(account);

      const res = await httpClient.request(`${baseUrl}/v1/messages/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Address": pollAuth.address,
          "X-Signature": pollAuth.signature,
          "X-Timestamp": pollAuth.timestamp,
        },
        body: JSON.stringify({ cursor, limit }),
        timeout: REQUEST_TIMEOUT_MS,
        // A read-only POST: re-sending it changes nothing.
        retryUnsafe: true,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Poll failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as {
        messages?: RelayInboundMessage[];
        next_cursor?: string;
      };

      const messages: InboxMessage[] = [];
      for (const m of Array.isArray(data.messages) ? data.messages : []) {
        if (!m || typeof m !== "object") continue;
        const verdict = await classifyInbound(m, account.address);
        if (verdict.verdict === "rejected") {
          // The id is relay-chosen text: quoted and cut before it is logged.
          logger.warn(`[INBOX] dropped ${JSON.stringify(String(m.id ?? "").slice(0, 80))}: ${verdict.reason}`);
          continue;
        }
        if (verdict.verdict === "unverified" && verdict.outsideWindow) {
          logger.info(
            `[INBOX] ${JSON.stringify(String(m.id).slice(0, 80))}: signed_at is ${verdict.outsideWindow}; delivered as unverified`,
          );
        }
        messages.push({
          id: m.id as string,
          from: verdict.from,
          to: account.address,
          content: m.content as string,
          signedAt: verdict.signedAt ?? "",
          createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
          replyTo: typeof m.replyTo === "string" ? m.replyTo : undefined,
          verified: verdict.verdict === "verified",
          sigHash: verdict.sigHash,
        });
      }

      return { messages, nextCursor: data.next_cursor };
    },

    unreadCount: async (): Promise<number> => {
      // Phase 3.2: Use shared signing module
      const pollAuth = await signPollPayload(account);

      const res = await httpClient.request(`${baseUrl}/v1/messages/count`, {
        method: "GET",
        headers: {
          "X-Wallet-Address": pollAuth.address,
          "X-Signature": pollAuth.signature,
          "X-Timestamp": pollAuth.timestamp,
        },
        timeout: REQUEST_TIMEOUT_MS,
      });

      // Phase 3.2: THROW on error instead of returning 0 (S-P1-7)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Unread count failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as { unread: number };
      return data.unread;
    },
  };
}
