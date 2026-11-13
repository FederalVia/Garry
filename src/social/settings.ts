/**
 * Relay protocol settings.
 *
 * Decides which signed prefix this agent uses toward its relay and which
 * prefixes it accepts on inbound mail. The accepted set comes only from local
 * configuration (automaton.json, which the agent cannot edit), never from the
 * relay, so a hostile relay cannot downgrade what counts as verified.
 */

import { PREFIX_CONWAY, PREFIX_V1, type SignedPrefix } from "./signing.js";

export interface RelayClientOptions {
  /** Sign the legacy "Conway:" form and also accept it inbound. */
  conwayCompat: boolean;
}

export interface RelayProtocol {
  sendPrefix: SignedPrefix;
  pollPrefix: SignedPrefix;
  acceptPrefixes: readonly SignedPrefix[];
  /** Drop inbound mail without a signature. Off only for Conway's relay, which sends none. */
  requireSignature: boolean;
}

const STRICT: RelayProtocol = Object.freeze({
  sendPrefix: PREFIX_V1,
  pollPrefix: PREFIX_V1,
  acceptPrefixes: Object.freeze([PREFIX_V1]) as readonly SignedPrefix[],
  requireSignature: true,
});

const COMPAT: RelayProtocol = Object.freeze({
  sendPrefix: PREFIX_CONWAY,
  pollPrefix: PREFIX_CONWAY,
  acceptPrefixes: Object.freeze([PREFIX_V1, PREFIX_CONWAY]) as readonly SignedPrefix[],
  requireSignature: false,
});

/** Exactly conway.tech or one of its subdomains (not "evilconway.tech" or "conway.tech.evil.example"). */
export function isConwayRelayUrl(url: string | undefined): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host === "conway.tech" || host.endsWith(".conway.tech");
  } catch {
    return false;
  }
}

/**
 * An explicit boolean relay.conwayCompat wins; otherwise compat is on only
 * when the relay is Conway's own, so an install with a Conway key and no new
 * settings keeps talking to Conway exactly as before.
 */
export function resolveRelayClientOptions(config: {
  socialRelayUrl?: string;
  relay?: { conwayCompat?: unknown } | null;
}): RelayClientOptions {
  const explicit = config.relay?.conwayCompat;
  if (typeof explicit === "boolean") return { conwayCompat: explicit };
  return { conwayCompat: isConwayRelayUrl(config.socialRelayUrl) };
}

export function relayProtocol(o: RelayClientOptions): RelayProtocol {
  return o.conwayCompat ? COMPAT : STRICT;
}

/** Wire name of the protocol the sender side uses. */
export function protocolName(o: RelayClientOptions): "automaton/1" | "conway" {
  return o.conwayCompat ? "conway" : "automaton/1";
}

/** For the startup log, e.g. "http://127.0.0.1:8787 (automaton/1)". */
export function describeRelay(config: {
  socialRelayUrl?: string;
  relay?: { conwayCompat?: unknown } | null;
}): string {
  if (!config.socialRelayUrl) return "off";
  const o = resolveRelayClientOptions(config);
  const accepts = o.conwayCompat ? ", accepts automaton/1 and conway" : "";
  return `${config.socialRelayUrl} (${protocolName(o)}${accepts})`;
}
