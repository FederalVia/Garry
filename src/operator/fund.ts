/**
 * Operator credit transfer (`automaton-cli fund`).
 *
 * The operator moves Conway credits with the automaton's API key, outside the
 * agent's treasury budgets. Amounts are dollars unless the caller asks for
 * cents, the recipient must be a valid address on the automaton's chain, and
 * the request is sent once with one idempotency key: a timeout or a 5xx is
 * reported as an unknown outcome, never retried.
 */

import { ulid } from "ulid";
import { classifyTransferStatus } from "../conway/transfer-status.js";
import { escapeForTerminal } from "../observability/terminal-safe.js";
import { hasValidEvmChecksum, isValidAddress, isZeroAddress, normalizeAddress, type ChainType } from "../identity/chain.js";

export interface OperatorFundConfig {
  name?: string;
  walletAddress?: string;
  conwayApiUrl?: string;
  conwayApiKey?: string;
  chainType?: ChainType;
}

export type ParseAmountResult =
  | { ok: true; cents: number }
  | { ok: false; error: string };

const DOLLARS_RE = /^(\d+)(?:\.(\d{1,2}))?$/;
const CENTS_RE = /^\d+$/;

/**
 * `automaton-cli fund` help. No "$" form: an unquoted $25 reaches the CLI as
 * "5" (the shell expands $2), so the operator must never be taught it.
 */
export const FUND_USAGE = `Usage: automaton-cli fund <usd> --to <address> [--cents] [--yes]
  <usd>      Amount in dollars, at most two decimals, no "$" sign (5, 0.75, 12.50)
  --cents    Read the amount as a whole number of cents instead (75 = $0.75)
  --to       Recipient on the automaton's chain (required): 0x... on EVM,
             base58 (case-sensitive) on Solana; not the automaton itself
  --yes      Skip the confirmation prompt
Examples:
  automaton-cli fund 5 --to 0xabc...
  automaton-cli fund 75 --cents --to 0xabc...`;

/**
 * Parse an operator amount. Dollars by default ("75" is $75.00, "0.75" is
 * 75 cents, at most two decimals); with `cents`, a whole number of cents.
 * Exponents, commas, signs, zero and unsafe integers are refused, and so is
 * a leading "$": the shell expands an unquoted one before the CLI sees it.
 */
export function parseUsdAmount(raw: string, opts: { cents: boolean }): ParseAmountResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, error: "Amount is required" };

  if (trimmed.startsWith("$")) {
    return {
      ok: false,
      error: `Invalid amount "${raw}": drop the "$" (give 12.50, not $12.50); unquoted, the shell turns $25 into 5`,
    };
  }

  let cents: number;
  if (opts.cents) {
    if (!CENTS_RE.test(trimmed)) {
      return { ok: false, error: `Invalid amount "${raw}": with --cents, give a whole number of cents (e.g. 75)` };
    }
    cents = Number(trimmed);
  } else {
    const m = DOLLARS_RE.exec(trimmed);
    if (!m) {
      return {
        ok: false,
        error: `Invalid amount "${raw}": give dollars with at most two decimals (e.g. 5 or 0.75), or use --cents`,
      };
    }
    const whole = Number(m[1]);
    const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
    cents = whole * 100 + frac;
  }

  if (!Number.isSafeInteger(cents)) {
    return { ok: false, error: `Invalid amount "${raw}": too large` };
  }
  if (cents <= 0) {
    return { ok: false, error: `Invalid amount "${raw}": must be more than zero` };
  }
  return { ok: true, cents };
}

export interface FundPlan {
  apiUrl: string;
  apiKey: string;
  chainType: ChainType;
  from: string;
  to: string;
  amountCents: number;
  note: string;
  /** "$X.XX (N cents) from <automaton> to <to>" */
  description: string;
}

export type PlanFundResult = { ok: true; plan: FundPlan } | { ok: false; error: string };

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Check everything before anything is sent: the API key, an HTTPS API URL
 * (the key goes in the Authorization header), a recipient on the
 * automaton's own chain, and not the automaton itself (the key is the
 * automaton's, so that transfer is a no-op).
 */
export function planFund(input: {
  config: OperatorFundConfig;
  to: string | undefined;
  amountCents: number;
}): PlanFundResult {
  const { config, to, amountCents } = input;
  const chainType: ChainType = config.chainType === "solana" ? "solana" : "evm";

  if (!config.conwayApiKey) {
    return { ok: false, error: "No Conway API key found in automaton config." };
  }
  const apiUrl = (config.conwayApiUrl || "https://api.conway.tech").replace(/\/+$/, "");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    return { ok: false, error: `Invalid Conway API URL: ${apiUrl}` };
  }
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && isLoopbackHost(parsedUrl.hostname))) {
    return { ok: false, error: `Conway API URL must use HTTPS: ${apiUrl}` };
  }

  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: `Invalid amount: ${amountCents} cents` };
  }

  if (typeof to !== "string" || to.trim() === "") {
    return { ok: false, error: "--to <address> is required: the recipient of the credits." };
  }
  const recipient = to.trim();
  if (!isValidAddress(recipient, chainType)) {
    return {
      ok: false,
      error:
        chainType === "solana"
          ? `Invalid --to "${recipient}": this automaton is on Solana; give a base58 Solana address (case-sensitive).`
          : `Invalid --to "${recipient}": this automaton is on EVM; give 0x followed by 40 hex characters.`,
    };
  }
  if (chainType !== "solana" && !hasValidEvmChecksum(recipient)) {
    return {
      ok: false,
      error: `Invalid --to "${recipient}": its mixed-case EIP-55 checksum is wrong, so it is probably mistyped. Check it, or give it all in lowercase.`,
    };
  }
  if (isZeroAddress(recipient)) {
    return {
      ok: false,
      error:
        chainType === "solana"
          ? "Refusing to send credits to the Solana system address (all-zero key): nothing sent there can be recovered."
          : "Refusing to send credits to the zero address.",
    };
  }

  const from = config.walletAddress || "";
  if (from && normalizeAddress(from, chainType) === normalizeAddress(recipient, chainType)) {
    return {
      ok: false,
      error: `--to is the automaton's own address (${from}); the API key is the automaton's, so this would transfer to itself.`,
    };
  }

  const amount = `${formatUsd(amountCents)} (${amountCents} cents)`;
  return {
    ok: true,
    plan: {
      apiUrl,
      apiKey: config.conwayApiKey,
      chainType,
      from,
      to: recipient,
      amountCents,
      note: `fund via automaton-cli (${config.name || "automaton"})`,
      description: `${amount} from ${from || "(unknown automaton address)"} to ${recipient}`,
    },
  };
}

export type FundResult =
  | {
      status: "ok";
      idempotencyKey: string;
      path: string;
      transferId: string;
      transferStatus: string;
      balanceAfterCents?: number;
    }
  | { status: "failed"; idempotencyKey: string; error: string }
  | { status: "unknown"; idempotencyKey: string; error: string };

/**
 * Text `automaton-cli fund` prints for a result. Error text, transfer id and
 * status come from the API response, so they are escaped for the terminal.
 */
export function formatFundResult(plan: FundPlan, result: FundResult): string {
  const safe = (s: string) => escapeForTerminal(s, { keepNewlines: false });
  if (result.status !== "ok") return safe(result.error);
  return `
Transfer submitted.
From:      ${plan.from || "(automaton)"}
To:        ${plan.to}
Amount:    ${formatUsd(plan.amountCents)} (${plan.amountCents} cents)
Status:    ${safe(result.transferStatus)}
Transfer:  ${safe(result.transferId)}
Key:       ${result.idempotencyKey}
${result.balanceAfterCents !== undefined ? `Balance:   ${formatUsd(result.balanceAfterCents)} after transfer` : ""}
`;
}

/** An unexpected error from the fund command, on one escaped line. */
export function formatFundError(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === "string" && message ? message : String(err);
  return `Credit transfer failed: ${escapeForTerminal(text, { keepNewlines: false })}`;
}

export const FUND_TIMEOUT_MS = 30_000;

function unknownOutcome(key: string, why: string): FundResult {
  return {
    status: "unknown",
    idempotencyKey: key,
    error: `${why}. The transfer outcome is unknown: check the balance before re-running, do not re-run blindly (idempotency key ${key}).`,
  };
}

/**
 * Send the planned transfer: one idempotency key for every endpoint shape in
 * `paths` (the next is tried only after a 404), no retries, no redirects, a
 * 30 s timeout. The endpoint paths come from the operator CLI: the runtime
 * source holds no credit-transfer call outside the treasury's primitives.
 */
export async function executeFund(
  plan: FundPlan,
  opts: { paths: readonly string[]; fetch?: typeof fetch; idempotencyKey?: string; timeoutMs?: number },
): Promise<FundResult> {
  if (!Array.isArray(opts?.paths) || opts.paths.length === 0) {
    throw new Error("executeFund needs the transfer endpoint paths");
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const key = opts.idempotencyKey ?? ulid();
  const timeoutMs = opts.timeoutMs ?? FUND_TIMEOUT_MS;
  const body = JSON.stringify({ to_address: plan.to, amount_cents: plan.amountCents, note: plan.note });
  let last404 = "";

  for (const path of opts.paths) {
    let resp: Response;
    try {
      resp = await doFetch(`${plan.apiUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: plan.apiKey,
          "Idempotency-Key": key,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      const why = err?.name === "TimeoutError" || err?.name === "AbortError"
        ? `No answer within ${Math.round(timeoutMs / 1000)} s`
        : `Request failed (${err?.message || String(err)})`;
      return unknownOutcome(key, why);
    }

    if (resp.status === 404) {
      last404 = await resp.text().catch(() => "");
      continue;
    }
    if (resp.status >= 300 && resp.status < 400) {
      return unknownOutcome(key, `Server answered ${resp.status} redirect to ${resp.headers.get("location") ?? "(no location)"}; it was not followed`);
    }
    if (resp.status >= 400 && resp.status < 500) {
      const text = await resp.text().catch(() => "");
      return { status: "failed", idempotencyKey: key, error: `Credit transfer refused (${path}): ${resp.status} ${text}`.trim() };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return unknownOutcome(key, `Server error (${path}): ${resp.status} ${text}`.trim());
    }

    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    const transferStatus = typeof data.status === "string" && data.status ? data.status : "submitted";
    // A 2xx can still carry a refusal; report it as a failure, not a submission.
    const statusClass = classifyTransferStatus(transferStatus);
    if (statusClass === "rejected") {
      return { status: "failed", idempotencyKey: key, error: `Credit transfer ${transferStatus} (${path})` };
    }
    if (statusClass === "unknown") {
      return unknownOutcome(key, `Server answered with unrecognised transfer status "${transferStatus}" (${path})`);
    }
    const balance = Number(data.balance_after_cents ?? data.new_balance_cents);
    return {
      status: "ok",
      idempotencyKey: key,
      path,
      transferId: String(data.transfer_id ?? data.id ?? "n/a"),
      transferStatus,
      ...(Number.isFinite(balance) && (data.balance_after_cents ?? data.new_balance_cents) !== undefined
        ? { balanceAfterCents: balance }
        : {}),
    };
  }

  return { status: "failed", idempotencyKey: key, error: `Credit transfer endpoint not found (404): ${last404}`.trim() };
}

/**
 * Ask a yes/no question on an interactive terminal. Returns null when stdin
 * or stdout is not a TTY, so the caller can refuse without --yes.
 */
export async function confirmOnTty(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
