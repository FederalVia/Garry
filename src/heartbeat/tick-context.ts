/**
 * Tick Context
 *
 * Builds a shared context for each heartbeat tick.
 * Fetches credit balance ONCE per tick, derives survival tier,
 * and shares across all tasks to avoid redundant API calls.
 */

import type BetterSqlite3 from "better-sqlite3";

import type {
  ConwayClient,
  HeartbeatConfig,
  SurvivalTier,
  TickContext,
} from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { readCredits, readUsdc, usdcNetworkFor, type BalanceRead } from "../conway/balance.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.tick");

/** KV: the tier of the last tick whose balance was read. */
export const LAST_KNOWN_TIER_KEY = "last_known_tier";
/** KV: when the current balance outage started (deleted on the next good read). */
export const BALANCE_UNKNOWN_SINCE_KEY = "balance_unknown_since";
/** KV: when the outage was last logged, so it is logged at most hourly. */
const BALANCE_UNKNOWN_LOGGED_KEY = "balance_unknown_logged_at";
const UNKNOWN_LOG_INTERVAL_MS = 60 * 60 * 1000;

const TIERS: readonly SurvivalTier[] = ["dead", "critical", "low_compute", "normal", "high"];

let counter = 0;
function generateTickId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  counter++;
  return `${timestamp}-${random}-${counter.toString(36)}`;
}

/**
 * Build a TickContext for the current tick.
 *
 * - Generates a unique tickId
 * - Reads the credit and USDC balances ONCE each
 * - Derives survivalTier from a known credit balance; an unknown balance
 *   keeps the last known tier (else low_compute), never critical or dead
 * - Reads lowComputeMultiplier from config
 */
export async function buildTickContext(
  db: DatabaseType,
  conway: ConwayClient,
  config: HeartbeatConfig,
  walletAddress?: string,
  chainType?: string,
): Promise<TickContext> {
  const tickId = generateTickId();
  const startedAt = new Date();

  const creditRead = await readCredits(conway);
  const usdcRead: BalanceRead = walletAddress
    ? await readUsdc(walletAddress, usdcNetworkFor(chainType), chainType as any)
    : { known: false, reason: "unsupported_network", detail: "no wallet address" };
  if (walletAddress && !usdcRead.known) {
    logger.warn(`USDC balance unavailable (${usdcRead.reason}): ${usdcRead.detail}`);
  }

  let survivalTier: SurvivalTier;
  let survivalTierKnown: boolean;
  if (creditRead.known) {
    survivalTier = getSurvivalTier(creditRead.value);
    survivalTierKnown = true;
    kvSet(db, LAST_KNOWN_TIER_KEY, survivalTier);
    kvDelete(db, BALANCE_UNKNOWN_SINCE_KEY);
    kvDelete(db, BALANCE_UNKNOWN_LOGGED_KEY);
    // Any trustworthy non-zero reading ends a zero-credit streak, so the dead
    // grace period is never measured across a funded stretch.
    if (creditRead.value > 0) kvDelete(db, "zero_credits_since");
  } else {
    const last = kvGet(db, LAST_KNOWN_TIER_KEY);
    survivalTier = last && (TIERS as readonly string[]).includes(last) ? (last as SurvivalTier) : "low_compute";
    survivalTierKnown = false;
    noteUnknownBalance(db, creditRead);
  }

  const lowComputeMultiplier = config.lowComputeMultiplier ?? 4;

  return {
    tickId,
    startedAt,
    creditBalance: creditRead.known ? creditRead.value : null,
    usdcBalance: usdcRead.known ? usdcRead.value : null,
    creditRead,
    usdcRead,
    survivalTier,
    survivalTierKnown,
    lowComputeMultiplier,
    config,
    db,
  };
}

/** Record the outage start and log it at most once an hour; never wakes. */
function noteUnknownBalance(db: DatabaseType, read: Extract<BalanceRead, { known: false }>): void {
  const nowIso = new Date().toISOString();
  const since = kvGet(db, BALANCE_UNKNOWN_SINCE_KEY);
  if (!since) kvSet(db, BALANCE_UNKNOWN_SINCE_KEY, nowIso);
  const lastLogged = Date.parse(kvGet(db, BALANCE_UNKNOWN_LOGGED_KEY) ?? "");
  if (!Number.isFinite(lastLogged) || Date.now() - lastLogged >= UNKNOWN_LOG_INTERVAL_MS) {
    kvSet(db, BALANCE_UNKNOWN_LOGGED_KEY, nowIso);
    logger.warn(
      `Credit balance unavailable (${read.reason}) since ${since ?? nowIso}: ${read.detail}. ` +
        "No topups, distress or dead timer until it can be read.",
    );
  }
}

function kvGet(db: DatabaseType, key: string): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? undefined;
  } catch {
    return undefined;
  }
}

function kvSet(db: DatabaseType, key: string, value: string): void {
  try {
    db.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value);
  } catch (err: any) {
    logger.warn(`Could not write ${key}: ${err?.message || String(err)}`);
  }
}

function kvDelete(db: DatabaseType, key: string): void {
  try {
    db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  } catch (err: any) {
    logger.warn(`Could not clear ${key}: ${err?.message || String(err)}`);
  }
}
