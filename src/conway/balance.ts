/**
 * Balance reads that never guess.
 *
 * A balance that could not be read is unknown, not zero. The primitives
 * (getCreditsBalance, getUsdcBalance) throw on anything they cannot trust;
 * these wrappers turn that into a typed result, so a caller has to decide
 * what an unknown balance means before it can use the number.
 */

import type { ConwayClient } from "../types.js";
import type { ChainType } from "../identity/chain.js";
import { CircuitOpenError } from "./http-client.js";
import { getUsdcBalance } from "./x402.js";
import { isFeatureDisabledError } from "../providers/features.js";

export type BalanceUnknownReason =
  | "http_error"
  | "network_error"
  | "circuit_open"
  | "malformed_response"
  | "rpc_error"
  | "unsupported_network"
  | "timeout"
  /** Not read on purpose: standalone mode, or a tier fixed by the creator. */
  | "disabled";

/** value: cents for credits, USDC (decimal) for usdc. */
export type BalanceRead =
  | { known: true; value: number; at: string }
  | { known: false; reason: BalanceUnknownReason; detail: string };

/** Thrown by balance primitives when the answer cannot be trusted. */
export class BalanceUnavailableError extends Error {
  constructor(
    readonly reason: BalanceUnknownReason,
    detail: string,
  ) {
    super(`Balance unavailable (${reason}): ${detail}`);
    this.name = "BalanceUnavailableError";
  }
}

export function classifyBalanceError(err: unknown): BalanceUnknownReason {
  if (err instanceof BalanceUnavailableError) return err.reason;
  if (isFeatureDisabledError(err)) return "disabled";
  if (err instanceof CircuitOpenError) return "circuit_open";
  const e = err as { name?: unknown; status?: unknown } | null;
  if (e && (e.name === "AbortError" || e.name === "TimeoutError")) return "timeout";
  if (e && typeof e.status === "number" && e.status >= 400) return "http_error";
  return "network_error";
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unknownRead(err: unknown): BalanceRead {
  return { known: false, reason: classifyBalanceError(err), detail: errorDetail(err) };
}

/** Conway credits in cents. */
export async function readCredits(conway: ConwayClient): Promise<BalanceRead> {
  try {
    const value = await conway.getCreditsBalance();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { known: false, reason: "malformed_response", detail: `non-numeric balance: ${String(value)}` };
    }
    return { known: true, value, at: new Date().toISOString() };
  } catch (err) {
    return unknownRead(err);
  }
}

/** On-chain USDC (decimal units) for the wallet. */
export async function readUsdc(
  address: string,
  network: string,
  chainType?: ChainType,
): Promise<BalanceRead> {
  try {
    const value = await getUsdcBalance(address, network, chainType);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { known: false, reason: "malformed_response", detail: `non-numeric balance: ${String(value)}` };
    }
    return { known: true, value, at: new Date().toISOString() };
  } catch (err) {
    // A thrown error from the RPC layer is an RPC failure unless it says otherwise.
    if (err instanceof BalanceUnavailableError) return unknownRead(err);
    return { known: false, reason: "rpc_error", detail: errorDetail(err) };
  }
}

/** The network id used for the wallet's own USDC reads. */
export function usdcNetworkFor(chainType?: string): string {
  return chainType === "solana" ? "solana:mainnet" : "eip155:8453";
}
