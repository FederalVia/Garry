/**
 * Operator social message (`automaton-cli send`).
 *
 * Signs with the automaton's existing wallet (EVM or Solana) through the
 * runtime social client, so the CLI gets the same relay URL check, message
 * validation and canonical signing (base58 recipients keep their case).
 * Never creates a wallet. The relay is the one automaton.json names, else
 * SOCIAL_RELAY_URL, else the runtime's own default: the same relay the agent
 * itself uses, never a separate CLI fallback.
 */

import { loadConfig, relayUrlIsDefaulted } from "../config.js";
import { loadChainIdentity } from "../identity/wallet.js";
import { createSocialClient } from "../social/client.js";
import {
  protocolName,
  resolveRelayClientOptions,
  type RelayClientOptions,
} from "../social/settings.js";
import type { ChainIdentity, ChainType } from "../identity/chain.js";
import { escapeForTerminal } from "../observability/terminal-safe.js";

/** Conway's hosted relay. Used only when configured explicitly (or by DEFAULT_CONFIG). */
export const CONWAY_SOCIAL_RELAY_URL = "https://social.conway.tech";
/** @deprecated kept for outside callers; no longer a fallback. */
export const DEFAULT_SOCIAL_RELAY_URL = CONWAY_SOCIAL_RELAY_URL;

export interface OperatorSigner {
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  address: string;
}

/** The automaton's wallet as a signer, or null when there is no wallet. */
export function loadOperatorSigner(): OperatorSigner | null {
  return loadChainIdentity();
}

type RelayConfig = { socialRelayUrl?: string; relay?: { conwayCompat?: unknown } } | null | undefined;

export type RelayTarget =
  | { ok: true; relayUrl: string; options: RelayClientOptions }
  | { ok: false; error: string };

/**
 * Relay URL from the config, then SOCIAL_RELAY_URL, else an error. An empty
 * socialRelayUrl in the file means messaging is off.
 *
 * `fileSetsRelayUrl: false` says the config's socialRelayUrl was filled in
 * from the runtime defaults, not written in automaton.json: SOCIAL_RELAY_URL
 * then wins over it, and the default is used only when the variable is unset.
 */
export function resolveRelayTarget(
  config: RelayConfig,
  env: NodeJS.ProcessEnv = process.env,
  opts: { fileSetsRelayUrl?: boolean } = {},
): RelayTarget {
  const configured = typeof config?.socialRelayUrl === "string" ? config.socialRelayUrl.trim() : undefined;
  const fromFile = opts.fileSetsRelayUrl ?? true;
  const fromEnv = typeof env.SOCIAL_RELAY_URL === "string" ? env.SOCIAL_RELAY_URL.trim() : "";
  let relayUrl: string | undefined;
  if (fromFile && configured !== undefined) {
    if (configured === "") {
      return {
        ok: false,
        error:
          "Messaging is off (socialRelayUrl is empty in automaton.json). Set it to your relay, for example http://127.0.0.1:8787.",
      };
    }
    relayUrl = configured;
  } else if (fromEnv) {
    relayUrl = fromEnv;
  } else if (configured) {
    relayUrl = configured;
  }
  if (!relayUrl) {
    return {
      ok: false,
      error:
        "No relay configured. Set socialRelayUrl in automaton.json or the SOCIAL_RELAY_URL environment variable, for example http://127.0.0.1:8787.",
    };
  }
  return { ok: true, relayUrl, options: resolveRelayClientOptions({ socialRelayUrl: relayUrl, relay: config?.relay }) };
}

/**
 * The relay `automaton-cli send` uses: loadConfig() (which throws on a
 * corrupt file), with SOCIAL_RELAY_URL ahead of a defaulted socialRelayUrl.
 */
export function loadRelayTarget(env: NodeJS.ProcessEnv = process.env): RelayTarget {
  const config = loadConfig();
  return resolveRelayTarget(config, env, {
    fileSetsRelayUrl: config !== null && !relayUrlIsDefaulted(config),
  });
}

/** The relay URL, or throws when none is configured. */
export function resolveRelayUrl(config: RelayConfig): string {
  const target = resolveRelayTarget(config);
  if (!target.ok) throw new Error(target.error);
  return target.relayUrl;
}

export type SendOperatorResult =
  | {
      ok: true;
      id: string;
      from: string;
      to: string;
      relayUrl: string;
      chainType: ChainType;
      protocol: "automaton/1" | "conway";
    }
  | { ok: false; error: string };

export async function sendOperatorMessage(input: {
  relayUrl: string;
  to: string;
  content: string;
  /** Defaults to the wallet in ~/.automaton (loaded, never created). */
  signer?: OperatorSigner | null;
  /** Defaults to what the relay URL implies (compat only for conway.tech). */
  options?: RelayClientOptions;
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

  const options = input.options ?? resolveRelayClientOptions({ socialRelayUrl: input.relayUrl });
  try {
    // Throws on a relay URL that is neither HTTPS nor loopback HTTP, before anything is signed.
    const client = createSocialClient(input.relayUrl, signer.chainIdentity, options);
    const { id } = await client.send(input.to, input.content);
    return {
      ok: true,
      id: id || "n/a",
      from: signer.address,
      to: input.to,
      relayUrl: input.relayUrl,
      chainType: signer.chainType,
      protocol: protocolName(options),
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
      `  ID:       ${safe(result.id)}`,
      `  From:     ${safe(result.from)}`,
      `  To:       ${safe(result.to)}`,
      `  Relay:    ${safe(result.relayUrl)}`,
      `  Protocol: ${safe(String(result.protocol))}`,
    ],
  };
}
