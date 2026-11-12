/**
 * Operator social message (`automaton-cli send`).
 *
 * Signs with the automaton's existing wallet (EVM or Solana) through the
 * runtime social client, so the CLI gets the same relay URL check, message
 * validation and canonical signing (base58 recipients keep their case).
 * Never creates a wallet.
 */

import { loadChainIdentity } from "../identity/wallet.js";
import { createSocialClient } from "../social/client.js";
import type { ChainIdentity, ChainType } from "../identity/chain.js";
import { escapeForTerminal } from "../observability/terminal-safe.js";

export const DEFAULT_SOCIAL_RELAY_URL = "https://social.conway.tech";

export interface OperatorSigner {
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  address: string;
}

/** The automaton's wallet as a signer, or null when there is no wallet. */
export function loadOperatorSigner(): OperatorSigner | null {
  return loadChainIdentity();
}

/** Relay URL from the config, then SOCIAL_RELAY_URL, then the default. */
export function resolveRelayUrl(config: { socialRelayUrl?: string } | null | undefined): string {
  return config?.socialRelayUrl || process.env.SOCIAL_RELAY_URL || DEFAULT_SOCIAL_RELAY_URL;
}

export type SendOperatorResult =
  | { ok: true; id: string; from: string; to: string; relayUrl: string; chainType: ChainType }
  | { ok: false; error: string };

export async function sendOperatorMessage(input: {
  relayUrl: string;
  to: string;
  content: string;
  /** Defaults to the wallet in ~/.automaton (loaded, never created). */
  signer?: OperatorSigner | null;
}): Promise<SendOperatorResult> {
  let signer: OperatorSigner | null;
  try {
    signer = input.signer !== undefined ? input.signer : loadOperatorSigner();
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (!signer) {
    return { ok: false, error: "No wallet found at ~/.automaton/wallet.json. Run: automaton --init" };
  }

  try {
    // Throws on a non-HTTPS relay before anything is signed.
    const client = createSocialClient(input.relayUrl, signer.chainIdentity);
    const { id } = await client.send(input.to, input.content);
    return {
      ok: true,
      id: id || "n/a",
      from: signer.address,
      to: input.to,
      relayUrl: input.relayUrl,
      chainType: signer.chainType,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Lines `automaton-cli send` prints. The relay chooses the error text and
 * the message id, so both are escaped for the terminal on one line each.
 */
export function formatSendResult(result: SendOperatorResult): { ok: boolean; lines: string[] } {
  const safe = (s: string) => escapeForTerminal(s, { keepNewlines: false });
  if (!result.ok) return { ok: false, lines: [`Failed to send message: ${safe(result.error)}`] };
  return {
    ok: true,
    lines: [
      "Message sent (signed).",
      `  ID:    ${safe(result.id)}`,
      `  From:  ${safe(result.from)}`,
      `  To:    ${safe(result.to)}`,
      `  Relay: ${safe(result.relayUrl)}`,
    ],
  };
}
