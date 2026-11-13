/**
 * Distress notification webhook.
 *
 * Off unless automaton.json sets distressWebhookUrl (which the agent cannot
 * edit). When on, a fixed set of fields goes out: never the model's own text,
 * config, keys or inbox content, so the hook cannot become an exfiltration
 * channel. Information flows out only: the response is discarded unread and
 * never reaches the model, KV or any decision. At most one notice per level
 * and source every 6 hours, sooner only when the level gets worse. Agent and
 * heartbeat notices are debounced apart, so a distress_signal call the model
 * makes while healthy can never hold back the heartbeat's real notice.
 */

import type { AutomatonConfig } from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { registerSecret } from "../security/secret-redaction.js";
import { isLoopbackHttpUrl } from "../social/validation.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("distress");

/** Debounce record for heartbeat notices; agent notices use DISTRESS_WEBHOOK_AGENT_KV. */
export const DISTRESS_WEBHOOK_KV = "distress_webhook_last";
export const DISTRESS_WEBHOOK_AGENT_KV = "distress_webhook_last_agent";
export const DISTRESS_DEBOUNCE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;
const NAME_MAX = 64;
const HINT = "The agent is low on funds. Add budget or credits for it.";
const LEVEL_RANK = { critical: 1, dead: 2 } as const;

export interface DistressNotice {
  level: "critical" | "dead";
  source: "heartbeat" | "agent";
  balanceCents: number | null;
}

export type DistressOutcome = "sent" | "skipped" | "disabled" | "failed";

interface KVStore {
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
}

/** The configured URL, or null when none is set. */
function configuredUrl(config: Pick<AutomatonConfig, "distressWebhookUrl">): string | null {
  const url = config.distressWebhookUrl;
  return typeof url === "string" && url.trim().length > 0 ? url.trim() : null;
}

/** Why a URL cannot be used, or null. The message never contains the URL. */
function urlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "distressWebhookUrl is not a valid URL";
  }
  if (parsed.protocol === "https:" || isLoopbackHttpUrl(url)) return null;
  return "distressWebhookUrl must use HTTPS (plain HTTP only for localhost, 127.0.0.1 or [::1])";
}

/** Registers the URL as a secret and validates it once. Called at startup. */
export function initDistressWebhook(
  config: Pick<AutomatonConfig, "distressWebhookUrl">,
): { enabled: boolean; problem?: string } {
  const url = configuredUrl(config);
  if (!url) {
    logger.info("Distress webhook: off");
    return { enabled: false };
  }
  // A token may live in the URL: keep it out of logs and model-visible text.
  registerSecret(url, "distress-webhook-url");
  const problem = urlProblem(url);
  if (problem) {
    logger.warn(`Distress webhook: off (${problem})`);
    return { enabled: false, problem };
  }
  logger.info("Distress webhook: on");
  return { enabled: true };
}

/** The exact JSON body sent. Built from fixed fields only. */
export function buildDistressPayload(
  config: Pick<AutomatonConfig, "name">,
  identity: { name?: string; address: string },
  notice: DistressNotice,
  now: number,
): Record<string, unknown> {
  const name = String(config.name ?? identity.name ?? "").slice(0, NAME_MAX);
  return {
    event: "automaton.distress",
    version: 1,
    level: notice.level,
    source: notice.source,
    agent: { name, address: String(identity.address) },
    balanceCents:
      typeof notice.balanceCents === "number" && Number.isFinite(notice.balanceCents)
        ? Math.round(notice.balanceCents)
        : null,
    hint: HINT,
    timestamp: new Date(now).toISOString(),
  };
}

function debounceKey(source: DistressNotice["source"]): string {
  return source === "heartbeat" ? DISTRESS_WEBHOOK_KV : DISTRESS_WEBHOOK_AGENT_KV;
}

function readLast(db: KVStore, key: string): { level: DistressNotice["level"]; at: number } | null {
  try {
    const raw = db.getKV(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as { level?: unknown; at?: unknown };
    if ((v.level === "critical" || v.level === "dead") && typeof v.at === "number") {
      return { level: v.level, at: v.at };
    }
  } catch {
    // An unreadable record counts as none.
  }
  return null;
}

/** Due when nothing was sent, the level got worse, or 6 hours have passed. */
function isDue(last: ReturnType<typeof readLast>, level: DistressNotice["level"], now: number): boolean {
  if (!last) return true;
  if (LEVEL_RANK[level] > LEVEL_RANK[last.level]) return true;
  return now - last.at >= DISTRESS_DEBOUNCE_MS || now < last.at;
}

/** Never throws. Returns what happened, for the caller's log line or tool result. */
export async function notifyDistress(
  config: Pick<AutomatonConfig, "name" | "distressWebhookUrl">,
  identity: { name?: string; address: string },
  db: KVStore,
  notice: DistressNotice,
  deps: { http?: ResilientHttpClient; now?: () => number; timeoutMs?: number } = {},
): Promise<DistressOutcome> {
  try {
    const url = configuredUrl(config);
    if (!url) return "disabled";
    registerSecret(url, "distress-webhook-url");
    if (urlProblem(url)) return "disabled";

    const now = (deps.now ?? Date.now)();
    const key = debounceKey(notice.source);
    if (!isDue(readLast(db, key), notice.level, now)) return "skipped";
    // Recorded before sending, so a failing hook is tried at most once per window too.
    db.setKV(key, JSON.stringify({ level: notice.level, at: now }));

    const http = deps.http ?? new ResilientHttpClient({ allowHttpOnLoopback: isLoopbackHttpUrl(url) });
    let res: Response;
    try {
      res = await http.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "automaton-distress/1" },
        body: JSON.stringify(buildDistressPayload(config, identity, notice, now)),
        timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retries: 0,
      });
    } catch (err) {
      // The error text can carry the URL; only its kind is logged.
      logger.warn(`Distress webhook failed: ${err instanceof Error ? err.name : "error"}`);
      return "failed";
    }
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return "sent";
    logger.warn(`Distress webhook failed: HTTP ${res.status}`);
    return "failed";
  } catch (err) {
    logger.warn(`Distress webhook failed: ${err instanceof Error ? err.name : "error"}`);
    return "failed";
  }
}
