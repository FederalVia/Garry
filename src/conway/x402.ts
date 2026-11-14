/**
 * x402 Payment Protocol
 *
 * Enables the automaton to make USDC micropayments via HTTP 402.
 * Adapted from conway-mcp/src/x402/index.ts
 *
 * Every payment passes the Treasury between the quote and the signature:
 * the 402 requirement is parsed, checked (network, asset, amount, deadline),
 * reserved in the ledger with its nonce and validBefore, and only then
 * signed and sent. The paid request's outcome settles the ledger row.
 */

import {
  createPublicClient,
  http,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { ResilientHttpClient } from "./http-client.js";
import type { ChainType } from "../identity/chain.js";
import { createLogger } from "../observability/logger.js";
import {
  currentCancellationSignal,
  raceWithSignal,
  rethrowIfCancelled,
  runShieldedFromTimeout,
  throwIfCancelled,
} from "../runtime/cancellation.js";
import { BalanceUnavailableError } from "./balance.js";
import {
  TreasuryDeniedError,
  X402_MAX_VALIDITY_SECONDS,
  centsFromAtomic,
  classifySendError,
  requireTreasury,
  topupDedupeKey,
  x402DedupeKey,
  type OutflowQuote,
  type AuthorizationStateRead,
  type Reservation,
  type TopupPurpose,
  type Treasury,
  type TreasuryDenyCode,
  type TreasuryResolver,
  type TreasuryResultFields,
} from "../treasury/index.js";

const logger = createLogger("x402");

const x402HttpClient = new ResilientHttpClient();
// Credit topups get their own client, so failing paid APIs (which can open
// the x402 circuit breaker) never block credit purchases.
const topupHttpClient = new ResilientHttpClient();

/** Reset the x402 clients' circuit breakers. Tests only. */
export function resetX402HttpClientForTests(): void {
  x402HttpClient.resetCircuit();
  topupHttpClient.resetCircuit();
}

/** Longest wait for the error body of a paid request (read after the row is settled). */
export const PAID_ERROR_BODY_TIMEOUT_MS = 2_000;
/** Most bytes of a paid request's error body kept for the error message. */
const PAID_ERROR_BODY_MAX_BYTES = 4_096;
/** Longest wait for a probe body or a paid response body. */
export const X402_BODY_TIMEOUT_MS = 30_000;

// USDC contract addresses
const USDC_ADDRESSES: Record<string, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

const CHAINS: Record<string, any> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};
type NetworkId = keyof typeof USDC_ADDRESSES;

/**
 * EIP-712 domains of the canonical USDC contracts. Only these contracts are
 * paid, so the table is authoritative; a server's extra.name/version that
 * differs is logged and ignored (it could only make the signature fail).
 */
const USDC_DOMAINS: Record<string, { name: string; version: string }> = {
  "eip155:8453": { name: "USD Coin", version: "2" }, // Base mainnet FiatToken
  "eip155:84532": { name: "USDC", version: "2" }, // Base Sepolia
};

/** Largest digit string accepted as an atomic amount (far above any real payment). */
const ATOMIC_AMOUNT_RE = /^[0-9]{1,30}$/;

/** The only network payments are signed on unless a caller pins another. */
export const X402_DEFAULT_NETWORK = "eip155:8453";

const AUTHORIZATION_STATE_ABI = [
  {
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    name: "authorizationState",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface PaymentRequirement {
  scheme: string;
  network: NetworkId;
  /** The exact network string the server sent ("base", "eip155:8453"...), echoed in the payment. */
  rawNetwork: string;
  /** The server's amount field as sent: `amount` (spec v2), else `maxAmountRequired`. Atomic units. */
  amountRaw: string | number;
  /** Both fields were present and they disagree. */
  amountConflict: boolean;
  /** extra.name / extra.version as the server sent them (diagnostics only). */
  extraName?: string;
  extraVersion?: string;
  payToAddress: Address;
  requiredDeadlineSeconds: number;
  /** True when the server sent requiredDeadlineSeconds (a minimum), not just maxTimeoutSeconds. */
  deadlineRequired: boolean;
  usdcAddress: Address;
}

interface PaymentRequiredResponse {
  x402Version: number;
  accepts: PaymentRequirement[];
}

interface ParsedPaymentRequirement {
  x402Version: number;
  requirement: PaymentRequirement;
}

export interface X402PaymentResult extends TreasuryResultFields {
  success: boolean;
  response?: any;
  error?: string;
  status?: number;
}

/** What a payment is for, and the extra checks that apply to it. */
export interface X402PaymentContext {
  purpose: "fetch" | "topup";
  /** credit topups: which topup budget the purchase draws on. */
  topupPurpose?: TopupPurpose;
  /** Largest atomic amount that may be signed (topups: the requested tier). */
  maxAtomic?: bigint;
  /** credit topups: the address the credits are bought for. */
  recipient?: string;
  /** credit topups: the tier in USD, for the dedupe key. */
  amountUsd?: number;
  /** Network the payment must be on. Default X402_DEFAULT_NETWORK. */
  network?: string;
  /** Explicit gate; default is the installed Treasury. */
  treasury?: TreasuryResolver;
}

export interface UsdcBalanceResult {
  balance: number;
  network: string;
  ok: boolean;
  error?: string;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function normalizeNetwork(raw: unknown): NetworkId | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "base") return "eip155:8453";
  if (normalized === "base-sepolia") return "eip155:84532";
  if (normalized === "eip155:8453" || normalized === "eip155:84532") {
    return normalized;
  }
  return null;
}

function normalizePaymentRequirement(raw: unknown): PaymentRequirement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const network = normalizeNetwork(value.network);
  if (!network) return null;

  const scheme = typeof value.scheme === "string" ? value.scheme : null;
  // The field name does not follow the version: Conway's /pay answers
  // x402Version 2 with maxAmountRequired. Either way the value is atomic.
  const amountField = (v: unknown): string | number | null =>
    typeof v === "string" || typeof v === "number" ? v : null;
  const v2Amount = amountField(value.amount);
  const v1Amount = amountField(value.maxAmountRequired);
  const amountRaw = v2Amount ?? v1Amount;
  const amountConflict = v2Amount !== null && v1Amount !== null && String(v2Amount).trim() !== String(v1Amount).trim();
  const extra = typeof value.extra === "object" && value.extra !== null ? (value.extra as Record<string, unknown>) : {};
  const payToAddress = typeof value.payToAddress === "string"
    ? value.payToAddress
    : typeof value.payTo === "string"
      ? value.payTo
      : null;
  const usdcAddress = typeof value.usdcAddress === "string"
    ? value.usdcAddress
    : typeof value.asset === "string"
      ? value.asset
      : USDC_ADDRESSES[network];
  const explicitDeadline = parsePositiveInt(value.requiredDeadlineSeconds);
  const requiredDeadlineSeconds =
    explicitDeadline ??
    parsePositiveInt(value.maxTimeoutSeconds) ??
    300;

  if (!scheme || amountRaw === null || !payToAddress || !usdcAddress) {
    return null;
  }

  return {
    scheme,
    network,
    rawNetwork: (value.network as string).trim(),
    amountRaw,
    amountConflict,
    ...(typeof extra.name === "string" ? { extraName: extra.name } : {}),
    ...(typeof extra.version === "string" ? { extraVersion: extra.version } : {}),
    payToAddress: payToAddress as Address,
    requiredDeadlineSeconds,
    deadlineRequired: explicitDeadline !== null,
    usdcAddress: usdcAddress as Address,
  };
}

function normalizePaymentRequired(raw: unknown): PaymentRequiredResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.accepts)) return null;

  const accepts = value.accepts
    .map(normalizePaymentRequirement)
    .filter((v): v is PaymentRequirement => v !== null);
  if (!accepts.length) return null;

  const x402Version = parsePositiveInt(value.x402Version) ?? 1;
  return { x402Version, accepts };
}

/**
 * An x402 amount in atomic USDC units (6 decimals), in every protocol
 * version: a digit string or a safe JSON integer. Decimals, exponents and
 * signs are refused: the unit is never guessed from the string's shape.
 */
export function parseAtomicAmount(raw: unknown): bigint {
  if (typeof raw === "number") {
    if (Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  } else if (typeof raw === "string") {
    const amount = raw.trim();
    if (ATOMIC_AMOUNT_RE.test(amount)) return BigInt(amount);
  }
  throw new Error(`amount must be an integer in atomic units, got ${JSON.stringify(raw)}`);
}

function selectRequirement(
  parsed: PaymentRequiredResponse,
  network: string = X402_DEFAULT_NETWORK,
): PaymentRequirement {
  // Prefer an offer the payment checks will accept: exact scheme, the pinned
  // network and that network's canonical USDC contract.
  const pinned = parsed.accepts.find(
    (r) => r.scheme === "exact" && r.network === network && isCanonicalUsdc(r),
  );
  if (pinned) return pinned;
  const exactSupported = parsed.accepts.find(
    (r) => r.scheme === "exact" && !!CHAINS[r.network],
  );
  if (exactSupported) return exactSupported;
  return parsed.accepts[0];
}

function isCanonicalUsdc(r: PaymentRequirement): boolean {
  const expected = USDC_ADDRESSES[r.network];
  return !!expected && r.usdcAddress.toLowerCase() === expected.toLowerCase();
}

/** Solana USDC mint address (mainnet). */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Get the USDC balance for the automaton's wallet on a given network.
 * Supports both EVM (Base) and Solana networks.
 */
export async function getUsdcBalance(
  address: string,
  network: string = "eip155:8453",
  chainType?: ChainType,
): Promise<number> {
  if (chainType === "solana" || network === "solana:mainnet") {
    return getSolanaUsdcBalance(address);
  }
  const result = await getUsdcBalanceDetailed(address as Address, network);
  // A failed RPC read is not an empty wallet.
  if (!result.ok) {
    const reason = !CHAINS[network] || !USDC_ADDRESSES[network] ? "unsupported_network" : "rpc_error";
    throw new BalanceUnavailableError(reason, result.error ?? `USDC balance read failed on ${network}`);
  }
  return result.balance;
}

/**
 * Get the USDC balance on Solana using @solana/web3.js.
 */
async function getSolanaUsdcBalance(address: string): Promise<number> {
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const ownerPubkey = new PublicKey(address);
    const mintPubkey = new PublicKey(SOLANA_USDC_MINT);

    // Find associated token account for USDC
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      ownerPubkey,
      { mint: mintPubkey },
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    // Sum all USDC token accounts (usually just one)
    let totalBalance = 0;
    for (const account of tokenAccounts.value) {
      const parsed = account.account.data.parsed;
      if (parsed?.info?.tokenAmount?.uiAmount != null) {
        totalBalance += parsed.info.tokenAmount.uiAmount;
      }
    }

    return totalBalance;
  } catch (err: any) {
    throw new BalanceUnavailableError("rpc_error", `Solana USDC balance check failed: ${err?.message || String(err)}`);
  }
}

/**
 * Get the USDC balance and read status details for diagnostics.
 */
export async function getUsdcBalanceDetailed(
  address: Address,
  network: string = "eip155:8453",
): Promise<UsdcBalanceResult> {
  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!chain || !usdcAddress) {
    return {
      balance: 0,
      network,
      ok: false,
      error: `Unsupported USDC network: ${network}`,
    };
  }

  try {
    const rpcUrl = process.env.AUTOMATON_RPC_URL || undefined;
    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 10_000 }),
    });

    // Read-only: an abort stops the wait; the RPC timeout bounds the read.
    const balance = await raceWithSignal(
      client.readContract({
        address: usdcAddress,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [address],
      }),
      currentCancellationSignal(),
    );

    // USDC has 6 decimals
    return {
      balance: Number(balance) / 1_000_000,
      network,
      ok: true,
    };
  } catch (err: any) {
    // An aborted read is not a failed one.
    rethrowIfCancelled(err);
    return {
      balance: 0,
      network,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Read EIP-3009 authorizationState(from, nonce) on the USDC contract the
 * authorization was signed for, at the latest block: true once used,
 * { used: false, blockTimestamp } while unused as of that block (so the
 * caller can compare validBefore with chain time, not its own clock), null
 * when it cannot be determined (unsupported network, bad input, RPC error).
 */
export async function readUsdcAuthorizationState(a: {
  network: string;
  asset: string;
  from: string;
  nonce: string;
}): Promise<AuthorizationStateRead> {
  const chain = CHAINS[a.network];
  if (!chain) return null;
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(a.asset) ||
    !/^0x[0-9a-fA-F]{40}$/.test(a.from) ||
    !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)
  ) {
    return null;
  }
  try {
    const rpcUrl = process.env.AUTOMATON_RPC_URL || undefined;
    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 10_000 }),
    });
    const block = await client.getBlock({ blockTag: "latest" });
    if (typeof block?.number !== "bigint" || typeof block.timestamp !== "bigint") return null;
    const used = await client.readContract({
      address: a.asset as Address,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: "authorizationState",
      args: [a.from as Address, a.nonce as `0x${string}`],
      blockNumber: block.number,
    });
    if (typeof used !== "boolean") return null;
    return used ? true : { used: false, blockTimestamp: Number(block.timestamp) };
  } catch (err: any) {
    logger.warn(`authorizationState read failed: ${err?.message || String(err)}`);
    return null;
  }
}

/**
 * Check if a URL requires x402 payment.
 */
export async function checkX402(
  url: string,
): Promise<PaymentRequirement | null> {
  try {
    const resp = await x402HttpClient.request(url, { method: "HEAD", redirect: "manual" });
    if (resp.status !== 402) {
      return null;
    }
    const parsed = parsePaymentRequired(resp.headers, await readBody(resp, { timeoutMs: X402_BODY_TIMEOUT_MS }));
    return parsed?.requirement ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with automatic x402 payment.
 * If the endpoint returns 402, reserve the payment with the Treasury, sign
 * it, pay, and settle the ledger row from the paid request's outcome.
 *
 * A refusal comes back as { success: false, denied }, with nothing signed.
 * A payment that was sent without a reliable answer comes back as
 * { success: false, settlement: "unknown" }: it stays counted and is
 * reconciled on chain by its nonce.
 */
export async function x402Fetch(
  url: string,
  account: PrivateKeyAccount,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
  maxPaymentCents?: number,
  chainType?: ChainType,
  payment: X402PaymentContext = { purpose: "fetch" },
): Promise<X402PaymentResult> {
  // Solana wallets cannot sign EVM x402 payments
  if (chainType === "solana") {
    return {
      success: false,
      error: "x402 payment requires an EVM wallet. Solana automatons should use Conway credits API instead.",
    };
  }

  const httpClient = payment.purpose === "topup" ? topupHttpClient : x402HttpClient;
  // An aborted heartbeat task pays nothing; the probe carries the signal too.
  throwIfCancelled();

  // Probe (non-mutating for GET, uses the resilient client). The body is
  // read exactly once, so a non-JSON answer is returned as text. Redirects
  // are never followed: the gate checks this URL, so the offer must come
  // from it and the payment must go to it.
  let initialResp: Response;
  let initialBody: BodyRead;
  try {
    initialResp = await httpClient.request(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      redirect: "manual",
    });
    initialBody = await readBody(initialResp, { timeoutMs: X402_BODY_TIMEOUT_MS });
  } catch (err: any) {
    rethrowIfCancelled(err);
    return { success: false, error: err?.message || String(err), settlement: "none" };
  }

  if (isRedirect(initialResp.status)) {
    return {
      success: false,
      error: `HTTP ${initialResp.status} redirect to ${initialResp.headers.get("location") ?? "(no location)"}; x402 requests do not follow redirects`,
      status: initialResp.status,
      settlement: "none",
    };
  }

  if (initialResp.status !== 402) {
    // A topup that was never paid bought nothing, whatever the status says.
    if (payment.purpose === "topup") {
      return {
        success: false,
        error: `Topup endpoint did not ask for payment (HTTP ${initialResp.status}); nothing was paid`,
        status: initialResp.status,
        settlement: "none",
      };
    }
    return {
      success: initialResp.ok,
      response: initialBody.data,
      status: initialResp.status,
      settlement: "none",
    };
  }

  const network = payment.network ?? X402_DEFAULT_NETWORK;
  const parsed = parsePaymentRequired(initialResp.headers, initialBody, network);
  if (!parsed) {
    return {
      success: false,
      error: "Could not parse payment requirements",
      status: initialResp.status,
      settlement: "none",
    };
  }
  const requirement = parsed.requirement;

  // Only the pinned network and its canonical USDC contract are paid.
  if (requirement.scheme !== "exact" || requirement.network !== network || !isCanonicalUsdc(requirement)) {
    return refuse(
      "INVALID_QUOTE",
      `Payment requirement (${requirement.scheme} on ${requirement.network}, asset ${requirement.usdcAddress}) ` +
        `is not an exact USDC payment on ${network}`,
    );
  }

  if (requirement.amountConflict) {
    return refuse("INVALID_QUOTE", "Payment requirement has both amount and maxAmountRequired, and they differ");
  }
  let atomic: bigint;
  try {
    atomic = parseAtomicAmount(requirement.amountRaw);
  } catch (err) {
    return refuse("INVALID_QUOTE", errMessage(err));
  }
  if (atomic <= 0n) {
    return refuse("INVALID_AMOUNT", "Payment requirement asks for a zero amount");
  }
  // A topup must quote exactly the tier: less would sign an underpayment
  // that leaves the topup unconfirmed, more would overpay.
  if (payment.purpose === "topup" && payment.maxAtomic !== undefined && atomic !== payment.maxAtomic) {
    return refuse(
      "X402_AMOUNT_MISMATCH",
      `Topup asks for ${atomic} atomic USDC; the tier is exactly ${payment.maxAtomic}`,
    );
  }
  if (payment.maxAtomic !== undefined && atomic > payment.maxAtomic) {
    return refuse(
      "X402_AMOUNT_MISMATCH",
      `Payment asks for ${atomic} atomic USDC, more than the expected ${payment.maxAtomic}`,
    );
  }

  // Check amount against maxPaymentCents BEFORE signing, rounding up like the gate.
  if (maxPaymentCents !== undefined) {
    const amountCents = centsFromAtomic(atomic);
    if (amountCents > maxPaymentCents) {
      return {
        success: false,
        error: `Payment of ${amountCents} cents (${atomic} atomic USDC) exceeds max allowed ${maxPaymentCents} cents`,
        status: 402,
        settlement: "none",
      };
    }
  }

  // A server that insists on a long-lived authorization is refused; a long
  // maxTimeoutSeconds is only an upper bound and is shortened instead.
  if (requirement.deadlineRequired && requirement.requiredDeadlineSeconds > X402_MAX_VALIDITY_SECONDS) {
    return refuse(
      "X402_DEADLINE_TOO_LONG",
      `Payment requires an authorization valid for ${requirement.requiredDeadlineSeconds}s; ` +
        `at most ${X402_MAX_VALIDITY_SECONDS}s is signed`,
    );
  }

  let treasury: Treasury;
  try {
    treasury = requireTreasury(payment.treasury);
  } catch (err) {
    if (err instanceof TreasuryDeniedError) return refuse(err.code, err.message);
    throw err;
  }

  const validSeconds = Math.min(
    Math.max(1, Math.floor(requirement.requiredDeadlineSeconds)),
    X402_MAX_VALIDITY_SECONDS,
  );
  const validBefore = treasury.x402ValidBefore(validSeconds);
  const validAfter = validBefore - validSeconds - 60;
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
  const quote = buildQuote(url, method, body, atomic, requirement, payment, {
    nonce,
    validBefore,
    from: account.address,
  });

  let reservation: Reservation;
  try {
    reservation = await treasury.reserve(quote);
  } catch (err) {
    if (err instanceof TreasuryDeniedError) return refuse(err.code, err.message);
    return { success: false, error: errMessage(err), status: 402, settlement: "none" };
  }

  // From here on the ledger row exists; every path settles it.
  let paymentHeader: string;
  try {
    const signed = await signPayment(account, requirement, parsed.x402Version, {
      value: atomic,
      nonce,
      validAfter,
      validBefore,
    });
    paymentHeader = Buffer.from(JSON.stringify(signed)).toString("base64");
  } catch (err) {
    treasury.settle(reservation, { outcome: "released", reason: `signing failed: ${errMessage(err)}` });
    return {
      success: false,
      error: `Failed to sign payment: ${errMessage(err)}`,
      status: initialResp.status,
      reservationId: reservation.id,
      settlement: "released",
    };
  }

  // Last point where nothing has left: an abort releases the reservation.
  const cancel = currentCancellationSignal();
  if (cancel?.aborted) {
    treasury.settle(reservation, { outcome: "released", reason: "not sent: aborted" });
    return {
      success: false,
      error: "Payment not sent: the task was cancelled",
      reservationId: reservation.id,
      settlement: "released",
    };
  }

  try {
    treasury.markSent(reservation);
  } catch (err) {
    treasury.settle(reservation, { outcome: "released", reason: `not sent: ${errMessage(err)}` });
    return {
      success: false,
      error: errMessage(err),
      reservationId: reservation.id,
      settlement: "released",
    };
  }

  let paidResp: Response;
  try {
    // Sent: a task timeout would only make the outcome unknown, so only
    // shutdown aborts it; its own HTTP deadline still bounds it.
    paidResp = await runShieldedFromTimeout(() =>
      httpClient.request(url, {
        method,
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "X-Payment": paymentHeader,
        },
        body,
        retries: 0, // Paid request: do not auto-retry (payment already signed)
        // Never forward X-Payment to another URL. With redirects off, a refused
        // connection can only come from this first hop, before anything arrived.
        redirect: "manual",
      }),
    );
  } catch (err) {
    // Released only when nothing can have reached the server.
    const outcome = classifySendError(err, { sent: true });
    if (outcome === "released") {
      treasury.settle(reservation, { outcome: "released", reason: `not delivered: ${errMessage(err)}` });
      return {
        success: false,
        error: errMessage(err),
        reservationId: reservation.id,
        settlement: "released",
      };
    }
    return unknownOutcome(treasury, reservation, validBefore, errMessage(err));
  }

  if (!paidResp.ok) {
    // The signed authorization stays valid until validBefore, so a non-2xx
    // answer (a redirect included) does not prove the payment did not
    // settle. Settle first: a body that never finishes must not leave the
    // row 'sent'. Then read a little of it, briefly, for the message.
    const result = unknownOutcome(treasury, reservation, validBefore, `HTTP ${paidResp.status}`);
    result.status = paidResp.status;
    try {
      const read = await readBody(paidResp, {
        timeoutMs: PAID_ERROR_BODY_TIMEOUT_MS,
        maxBytes: PAID_ERROR_BODY_MAX_BYTES,
      });
      if (read.text) result.error += ` Server said: ${read.text.slice(0, 200)}`;
    } catch {
      // Body unreadable or too slow; the status is enough.
    }
    return result;
  }

  // 2xx: the payment was accepted. Commit before reading the body, so a
  // body that fails to arrive cannot turn a delivered payment into a retry.
  treasury.settle(reservation, {
    outcome: "committed",
    externalRef: paymentResponseRef(paidResp.headers),
  });
  let data: unknown;
  try {
    data = (await readBody(paidResp, { timeoutMs: X402_BODY_TIMEOUT_MS })).data;
  } catch (err) {
    logger.warn(`Paid response body could not be read: ${errMessage(err)}`);
    data = "";
  }
  return {
    success: true,
    response: data,
    status: paidResp.status,
    paidCents: reservation.amountCents,
    reservationId: reservation.id,
    settlement: "committed",
  };
}

function buildQuote(
  url: string,
  method: string,
  body: string | undefined,
  atomic: bigint,
  requirement: PaymentRequirement,
  payment: X402PaymentContext,
  auth: { nonce: `0x${string}`; validBefore: number; from: string },
): OutflowQuote {
  const amountCents = centsFromAtomic(atomic);
  const x402 = {
    nonce: auth.nonce,
    validBefore: auth.validBefore,
    from: auth.from,
    network: requirement.network,
    asset: requirement.usdcAddress,
  };
  if (payment.purpose === "topup") {
    const purpose = payment.topupPurpose ?? "manual";
    const amountUsd =
      payment.amountUsd ??
      (payment.maxAtomic !== undefined ? Number(payment.maxAtomic / 1_000_000n) : amountCents / 100);
    return {
      kind: "credit_topup",
      amountCents,
      amountAtomic: atomic,
      amountBasis: "exact",
      counterparty: requirement.payToAddress,
      dedupeKey: topupDedupeKey(purpose, amountUsd),
      description: `x402 credit topup: $${amountUsd} USD (${purpose})`,
      topupPurpose: purpose,
      recipient: payment.recipient,
      url,
      x402,
    };
  }
  return {
    kind: "x402_payment",
    amountCents,
    amountAtomic: atomic,
    amountBasis: "exact",
    counterparty: requirement.payToAddress,
    dedupeKey: x402DedupeKey(method, url, body, atomic),
    description: `x402 ${method.toUpperCase()} ${url}`,
    url,
    x402,
  };
}

function refuse(code: TreasuryDenyCode, message: string): X402PaymentResult {
  return {
    success: false,
    error: `Policy denied: ${code} — ${message}`,
    status: 402,
    denied: { code, message },
    settlement: "none",
  };
}

function unknownOutcome(
  treasury: Treasury,
  reservation: Reservation,
  validBefore: number,
  reason: string,
): X402PaymentResult {
  treasury.settle(reservation, { outcome: "unknown", reason });
  logger.warn(`x402 payment outcome unknown (ledger ${reservation.id}): ${reason}`);
  return {
    success: false,
    error:
      `Payment outcome unknown (ledger ${reservation.id}): ${reason}. ` +
      `The signed authorization can settle until ${new Date(validBefore * 1000).toISOString()}; ` +
      `it counts against your limits, and an identical request is refused while it is unconfirmed.`,
    reservationId: reservation.id,
    settlement: "unknown",
  };
}

/** Transaction reference from an X-Payment-Response header, when present. */
function paymentResponseRef(headers: Headers): string | undefined {
  const raw = headers.get("X-Payment-Response");
  if (!raw) return undefined;
  const decoded = safeJsonParse(raw) ?? safeJsonParse(Buffer.from(raw, "base64").toString("utf-8"));
  if (decoded && typeof decoded === "object") {
    const ref = (decoded as Record<string, unknown>).transaction ?? (decoded as Record<string, unknown>).txHash;
    if (typeof ref === "string" && ref.length <= 200) return ref;
  }
  return undefined;
}

interface BodyRead {
  text: string;
  /** Parsed JSON, or the text when it is not JSON. */
  data: unknown;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Read a response body once: text first, then JSON if it parses. The whole
 * read is bounded by timeoutMs (a server can trickle bytes forever, and the
 * HTTP client's timeout ends when the headers arrive); maxBytes stops early
 * and keeps what was read.
 */
async function readBody(
  resp: Response,
  opts: { timeoutMs: number; maxBytes?: number },
): Promise<BodyRead> {
  const text = await readText(resp, opts);
  if (text === "") return { text, data: "" };
  const json = safeJsonParse(text);
  return { text, data: json ?? text };
}

async function readText(resp: Response, opts: { timeoutMs: number; maxBytes?: number }): Promise<string> {
  if (!resp.body) return resp.text();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`response body not received within ${opts.timeoutMs}ms`)),
      opts.timeoutMs,
    );
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (value) {
        chunks.push(value);
        size += value.byteLength;
      }
      if (opts.maxBytes !== undefined && size >= opts.maxBytes) break;
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return opts.maxBytes !== undefined ? text.slice(0, opts.maxBytes) : text;
}

function parsePaymentRequired(
  headers: Headers,
  body: BodyRead,
  network?: string,
): ParsedPaymentRequirement | null {
  const header = headers.get("X-Payment-Required");
  if (header) {
    const rawHeader = safeJsonParse(header);
    const normalizedRaw = normalizePaymentRequired(rawHeader);
    if (normalizedRaw) {
      return {
        x402Version: normalizedRaw.x402Version,
        requirement: selectRequirement(normalizedRaw, network),
      };
    }

    try {
      const decoded = Buffer.from(header, "base64").toString("utf-8");
      const parsedDecoded = normalizePaymentRequired(safeJsonParse(decoded));
      if (parsedDecoded) {
        return {
          x402Version: parsedDecoded.x402Version,
          requirement: selectRequirement(parsedDecoded, network),
        };
      }
    } catch {
      // Ignore header decode errors and continue with body parsing.
    }
  }

  const parsedBody = normalizePaymentRequired(body.data);
  if (!parsedBody) return null;
  return {
    x402Version: parsedBody.x402Version,
    requirement: selectRequirement(parsedBody, network),
  };
}

/**
 * Sign the EIP-3009 authorization for exactly the value, nonce and validity
 * window that were reserved with the Treasury.
 */
async function signPayment(
  account: PrivateKeyAccount,
  requirement: PaymentRequirement,
  x402Version: number,
  auth: { value: bigint; nonce: `0x${string}`; validAfter: number; validBefore: number },
): Promise<any> {
  const chain = CHAINS[requirement.network];
  if (!chain) {
    throw new Error(`Unsupported network: ${requirement.network}`);
  }

  const known = USDC_DOMAINS[requirement.network];
  if (!known) {
    throw new Error(`No USDC EIP-712 domain known for ${requirement.network}`);
  }
  if (
    (requirement.extraName !== undefined && requirement.extraName !== known.name) ||
    (requirement.extraVersion !== undefined && requirement.extraVersion !== known.version)
  ) {
    logger.warn(
      `x402 server sent USDC domain ${requirement.extraName ?? "?"}/${requirement.extraVersion ?? "?"} ` +
        `for ${requirement.network}; signing with ${known.name}/${known.version}`,
    );
  }

  // EIP-712 typed data for TransferWithAuthorization
  const domain = {
    name: known.name,
    version: known.version,
    chainId: chain.id,
    verifyingContract: requirement.usdcAddress,
  } as const;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: account.address,
    to: requirement.payToAddress,
    value: auth.value,
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    x402Version,
    scheme: requirement.scheme,
    // The server matches this against its own requirement string.
    network: requirement.rawNetwork,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirement.payToAddress,
        value: auth.value.toString(),
        validAfter: auth.validAfter.toString(),
        validBefore: auth.validBefore.toString(),
        nonce: auth.nonce,
      },
    },
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
