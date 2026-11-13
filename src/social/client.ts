/**
 * Social Client Factory
 *
 * Creates a SocialClient for the automaton runtime.
 * Self-contained: uses viem for signing and fetch for HTTP.
 *
 * Outbound: HTTPS (plain HTTP only to loopback), shared signing, request
 * timeouts, rate limiting. The signed prefix and the accepted inbound
 * prefixes come from RelayClientOptions (social/settings.ts).
 * Inbound: every polled message is classified (social/inbound.ts). Signed
 * messages are verified against the claimed sender and our own address;
 * signed ones outside the freshness window, and unsigned ones in Conway
 * compatibility mode only, are passed on marked unverified; forged,
 * misaddressed or (in Automaton/1 mode) unsigned ones are dropped here and
 * never stored.
 */

import type { PrivateKeyAccount } from "viem";
import type { SocialClientInterface, InboxMessage } from "../types.js";
import type { ChainIdentity } from "../identity/chain.js";
import { CircuitOpenError, ResilientHttpClient } from "../conway/http-client.js";
import { signSendPayload, signPollPayload, MESSAGE_LIMITS, PREFIX_V1 } from "./signing.js";
import { validateRelayUrl, validateMessage, isLoopbackHttpUrl } from "./validation.js";
import { classifyInbound, type RelayInboundMessage } from "./inbound.js";
import { relayProtocol, resolveRelayClientOptions, type RelayClientOptions } from "./settings.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("social");

// Request timeout for all fetch calls (30 seconds)
const REQUEST_TIMEOUT_MS = 30_000;
/** Attempts for one v1 poll; each attempt is signed afresh (single-use nonce). */
const V1_POLL_ATTEMPTS = 2;
const V1_POLL_RETRY_DELAY_MS = 500;

/** Worth one more try: the request may not have reached the relay, or the relay hiccuped. */
function isRetryablePollFailure(res: Response | undefined, error: unknown): boolean {
  if (res) return res.status >= 500 && res.status !== 501;
  return !(error instanceof CircuitOpenError);
}

/**
 * Create a SocialClient wired to the agent's wallet.
 *
 * @throws if relayUrl is neither HTTPS nor loopback HTTP
 */
export function createSocialClient(
  relayUrl: string,
  account: PrivateKeyAccount | ChainIdentity,
  options: RelayClientOptions = resolveRelayClientOptions({ socialRelayUrl: relayUrl }),
): SocialClientInterface {
  validateRelayUrl(relayUrl);

  const baseUrl = relayUrl.replace(/\/$/, "");
  const httpClient = new ResilientHttpClient({ allowHttpOnLoopback: isLoopbackHttpUrl(relayUrl) });
  const protocol = relayProtocol(options);
  const v1Poll = protocol.pollPrefix === PREFIX_V1;

  async function authHeaders(): Promise<Record<string, string>> {
    const auth = await signPollPayload(account, { prefix: protocol.pollPrefix });
    const headers: Record<string, string> = {
      "X-Wallet-Address": auth.address,
      "X-Signature": auth.signature,
      "X-Timestamp": auth.timestamp,
    };
    if (auth.nonce) headers["X-Auth-Nonce"] = auth.nonce;
    return headers;
  }

  /**
   * A v1 poll credential is single-use, so the HTTP client must never re-send
   * it: retries happen here, each with a new nonce and signature.
   */
  async function authedRequest(path: string, init: { method: string; body?: string }): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const extra: Record<string, string> = init.body !== undefined ? { "Content-Type": "application/json" } : {};
    if (!v1Poll) {
      return httpClient.request(url, {
        method: init.method,
        headers: { ...extra, ...(await authHeaders()) },
        body: init.body,
        timeout: REQUEST_TIMEOUT_MS,
        // Conway's credential is replayable anyway; a read-only POST changes nothing.
        retryUnsafe: true,
      });
    }
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      let error: unknown;
      try {
        res = await httpClient.request(url, {
          method: init.method,
          headers: { ...extra, ...(await authHeaders()) },
          body: init.body,
          timeout: REQUEST_TIMEOUT_MS,
          retries: 0,
        });
      } catch (err) {
        error = err;
      }
      if (attempt >= V1_POLL_ATTEMPTS || !isRetryablePollFailure(res, error)) {
        if (res) return res;
        throw error;
      }
      await res?.body?.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, V1_POLL_RETRY_DELAY_MS));
    }
  }

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

      const payload = await signSendPayload(account, to, content, replyTo, { prefix: protocol.sendPrefix });

      const res = await httpClient.request(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: REQUEST_TIMEOUT_MS,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        // A 401 on a valid signature usually means the two sides disagree on the prefix.
        const hint =
          res.status !== 401
            ? ""
            : protocol.sendPrefix === PREFIX_V1
              ? " (the relay may only accept the Conway protocol: see relay.conwayCompat)"
              : " (the relay may only accept the Automaton/1 protocol: see relay.conwayCompat)";
        throw new Error(
          `Send failed (${res.status}): ${(err as any).error || res.statusText}${hint}`,
        );
      }

      const data = (await res.json()) as { id: string };
      return { id: data.id };
    },

    poll: async (
      cursor?: string,
      limit?: number,
    ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> => {
      const res = await authedRequest("/v1/messages/poll", {
        method: "POST",
        body: JSON.stringify({ cursor, limit }),
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
        const verdict = await classifyInbound(m, account.address, Date.now(), {
          acceptPrefixes: protocol.acceptPrefixes,
          requireSignature: protocol.requireSignature,
        });
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
      const res = await authedRequest("/v1/messages/count", { method: "GET" });

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
