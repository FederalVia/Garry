/**
 * Built-in Heartbeat Tasks
 *
 * These tasks run on the heartbeat schedule even while the agent sleeps.
 * They can trigger the agent to wake up if needed.
 *
 * Phase 1.1: All tasks accept TickContext as first parameter.
 * Credit balance is fetched once per tick and shared via ctx.creditBalance.
 * This eliminates 4x redundant getCreditsBalance() calls per tick.
 *
 * Every task runs with the Treasury origin "heartbeat.<task>", so an outflow
 * a task starts is attributed to it (and is never mistaken for a tool call).
 */

import type {
  TickContext,
  HeartbeatLegacyContext,
  HeartbeatTaskFn,
  InboxMessage,
  SurvivalTier,
} from "../types.js";
import type { HealthMonitor as ColonyHealthMonitor } from "../orchestration/health-monitor.js";
import { LEGACY_LIVE, LIVE, holdsSlot } from "../replication/child-status.js";
import { screenInbound, serializeScreen, type ScreenVerdict } from "../agent/injection-defense.js";
import { normalizeSenderAddress } from "../agent/inbox-isolation.js";
import { getSurvivalTier } from "../conway/credits.js";
import { createLogger } from "../observability/logger.js";
import { getMetrics } from "../observability/metrics.js";
import { AlertEngine, createDefaultAlertRules } from "../observability/alerts.js";
import { countRecentInboxFrom, metricsInsertSnapshot, metricsPruneOld } from "../state/database.js";
import { runWithTreasuryOrigin } from "../treasury/index.js";
import { ulid } from "ulid";

const logger = createLogger("heartbeat.tasks");

// Module-level AlertEngine so cooldown state persists across ticks.
// Creating a new instance per tick would reset the lastFired map,
// causing every alert to fire on every tick regardless of cooldownMs.
let _alertEngine: AlertEngine | null = null;
function getAlertEngine(): AlertEngine {
  if (!_alertEngine) _alertEngine = new AlertEngine(createDefaultAlertRules());
  return _alertEngine;
}

/**
 * Inbox rows accepted per sender per minute, counted separately for signed
 * and unsigned rows of the same address. Later rows are stored as
 * rate_limited and never handled.
 */
export const INBOX_RATE_LIMIT_PER_MINUTE = 10;
const INBOX_RATE_WINDOW_MS = 60_000;
// How far back a sender's time may place a message on the first poll, when
// no previous poll is recorded (new install, or a database from before the
// poll time was kept). Matches how long the relay holds signed mail.
const INBOX_FIRST_POLL_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

// Last time the "no auto-topup on Solana" note was logged (once a day).
let lastSolanaTopupNoticeMs = 0;

export const COLONY_TASK_INTERVALS_MS = {
  colony_health_check: 300_000,
  colony_financial_report: 3_600_000,
  agent_pool_optimize: 1_800_000,
  knowledge_store_prune: 86_400_000,
  dead_agent_cleanup: 3_600_000,
} as const;

const TASKS: Record<string, HeartbeatTaskFn> = {
  heartbeat_ping: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Use ctx.creditBalance instead of calling conway.getCreditsBalance()
    const credits = ctx.creditBalance;
    const state = taskCtx.db.getAgentState();
    const startTime =
      taskCtx.db.getKV("start_time") || new Date().toISOString();
    const uptimeMs = Date.now() - new Date(startTime).getTime();

    const tier = ctx.survivalTier;

    const payload = {
      name: taskCtx.config.name,
      address: taskCtx.identity.address,
      state,
      creditsCents: credits,
      balanceKnown: credits !== null,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      version: taskCtx.config.version,
      sandboxId: taskCtx.identity.sandboxId,
      timestamp: new Date().toISOString(),
      tier,
    };

    taskCtx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));

    // An unread balance is not a low one: no distress without a reading.
    if (credits === null) return { shouldWake: false };

    // If critical or dead, record a distress signal
    if (tier === "critical" || tier === "dead") {
      const distressPayload = {
        level: tier,
        name: taskCtx.config.name,
        address: taskCtx.identity.address,
        creditsCents: credits,
        fundingHint:
          "Use credit transfer API from a creator runtime to top this wallet up.",
        timestamp: new Date().toISOString(),
      };
      taskCtx.db.setKV("last_distress", JSON.stringify(distressPayload));

      return {
        shouldWake: true,
        message: `Distress: ${tier}. Credits: $${(credits / 100).toFixed(2)}. Need funding.`,
      };
    }

    return { shouldWake: false };
  },

  check_credits: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // A failed balance read must not start, extend or end a zero-credit streak.
    if (ctx.creditBalance === null) return { shouldWake: false };
    // Use ctx.creditBalance instead of calling conway.getCreditsBalance()
    const credits = ctx.creditBalance;
    const tier = ctx.survivalTier;
    const now = new Date().toISOString();

    taskCtx.db.setKV("last_credit_check", JSON.stringify({
      credits,
      tier,
      timestamp: now,
    }));

    // Wake the agent if credits dropped to a new tier
    const prevTier = taskCtx.db.getKV("prev_credit_tier");
    taskCtx.db.setKV("prev_credit_tier", tier);

    // Dead state escalation: if at zero credits (critical tier) for >1 hour,
    // transition to dead. This gives the agent time to receive funding before dying.
    // USDC can't go negative, so dead is only reached via this timeout.
    const DEAD_GRACE_PERIOD_MS = 3_600_000; // 1 hour
    if (tier === "critical" && credits === 0) {
      const zeroSince = taskCtx.db.getKV("zero_credits_since");
      if (!zeroSince) {
        // First time seeing zero — start the grace period
        taskCtx.db.setKV("zero_credits_since", now);
      } else {
        const elapsed = Date.now() - new Date(zeroSince).getTime();
        if (elapsed >= DEAD_GRACE_PERIOD_MS) {
          // Grace period expired — transition to dead
          taskCtx.db.setAgentState("dead");
          logger.warn("Agent entering dead state after 1 hour at zero credits", {
            zeroSince,
            elapsed,
          });
          return {
            shouldWake: true,
            message: `Dead: zero credits for ${Math.round(elapsed / 60_000)} minutes. Need funding.`,
          };
        }
      }
    } else {
      // Credits are above zero — clear the grace period timer
      taskCtx.db.deleteKV("zero_credits_since");
    }

    if (prevTier && prevTier !== tier && tier === "critical") {
      return {
        shouldWake: true,
        message: `Credits dropped to ${tier} tier: $${(credits / 100).toFixed(2)}`,
      };
    }

    return { shouldWake: false };
  },

  check_usdc_balance: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Auto-topup pays with x402, which needs an EVM wallet.
    const chainType = taskCtx.config.chainType || taskCtx.identity.chainType || "evm";
    if (chainType === "solana") {
      const nowMs = Date.now();
      if (nowMs - lastSolanaTopupNoticeMs >= 24 * 60 * 60 * 1000) {
        lastSolanaTopupNoticeMs = nowMs;
        logger.info("Auto-topup is not available for Solana wallets; fund credits via the Conway dashboard or credits API.");
      }
      return { shouldWake: false };
    }
    // Spend only on balances read this tick.
    if (ctx.creditBalance === null || ctx.usdcBalance === null) return { shouldWake: false };

    // Use ctx.usdcBalance instead of calling getUsdcBalance()
    const balance = ctx.usdcBalance;
    const credits = ctx.creditBalance;

    taskCtx.db.setKV("last_usdc_check", JSON.stringify({
      balance,
      credits,
      timestamp: new Date().toISOString(),
    }));

    const MIN_TOPUP_USD = 5;
    if (balance >= MIN_TOPUP_USD && (ctx.survivalTier === "critical" || ctx.survivalTier === "dead")) {
      // Cooldown: don't attempt more than once every 5 minutes to avoid
      // hammering the payment endpoint on repeated ticks.
      const AUTO_TOPUP_COOLDOWN_MS = 5 * 60 * 1000;
      const lastAttempt = taskCtx.db.getKV("last_auto_topup_attempt");
      if (lastAttempt && Date.now() - new Date(lastAttempt).getTime() < AUTO_TOPUP_COOLDOWN_MS) {
        return { shouldWake: false };
      }

      taskCtx.db.setKV("last_auto_topup_attempt", new Date().toISOString());

      const { bootstrapTopup, ROUTINE_TOPUP_REFUSALS, DAILY_NOTICE_TOPUP_REFUSALS } = await import(
        "../conway/topup.js"
      );
      const result = await bootstrapTopup({
        apiUrl: taskCtx.config.conwayApiUrl,
        account: taskCtx.identity.account,
        creditsCents: credits,
        chainType: taskCtx.config.chainType || taskCtx.identity.chainType || "evm",
      });

      // The gate refused for a reason that needs nothing from the agent
      // (credits not actually low, a buy in flight or just made, the gate's
      // balance read failed, an unconfirmed payment). Waking would only cost a turn.
      if (result?.denied && ROUTINE_TOPUP_REFUSALS.includes(result.denied.code)) {
        logger.info(`Auto-topup not attempted: ${result.denied.code} — ${result.denied.message}`);
        return { shouldWake: false };
      }

      // The survival daily cap or an untrusted payTo: retrying, or a manual
      // topup, does not fix either. Tell the agent once a day, not every tick.
      if (result?.denied && DAILY_NOTICE_TOPUP_REFUSALS.includes(result.denied.code)) {
        logger.warn(`Auto-topup refused: ${result.denied.code} — ${result.denied.message}`);
        const key = `auto_topup_notice:${result.denied.code}`;
        const last = taskCtx.db.getKV(key);
        const lastMs = last ? new Date(last).getTime() : NaN;
        const nowMs = Date.now();
        const sinceMs = nowMs - lastMs;
        if (Number.isFinite(sinceMs) && sinceMs >= 0 && sinceMs < 24 * 60 * 60 * 1000) {
          return { shouldWake: false };
        }
        taskCtx.db.setKV(key, new Date(nowMs).toISOString());
        return {
          shouldWake: true,
          message:
            `Low credits ($${(credits / 100).toFixed(2)}) with USDC available ($${balance.toFixed(2)}), ` +
            `but automatic topups are refused: ${result.denied.code} — ${result.denied.message}. ` +
            `They resume on their own when the limit allows; this notice repeats at most once a day.`,
        };
      }

      if (result?.success) {
        logger.info(
          `Auto-topup successful: $${result.amountUsd} USD → ${result.creditsCentsAdded} credit cents`,
        );
        return {
          shouldWake: true,
          message: `Auto-topped up $${result.amountUsd} in credits (was $${(credits / 100).toFixed(2)}). USDC remaining: ~$${(balance - result.amountUsd).toFixed(2)}.`,
        };
      }

      // null: bootstrapTopup decided not to buy (its own balance checks).
      if (result === null) {
        logger.info("Auto-topup not attempted: bootstrap topup was not applicable");
        return { shouldWake: false };
      }

      // A real failure wakes the agent, but the same error at most once per 6 h.
      const errMsg = result.error ?? "unknown error";
      logger.warn(`Auto-topup failed: ${errMsg}`);
      const NOTICE_INTERVAL_MS = 6 * 60 * 60 * 1000;
      let previous: { error?: string; at?: string } | null = null;
      try {
        previous = JSON.parse(taskCtx.db.getKV("auto_topup_fail_notice") || "null");
      } catch {
        previous = null;
      }
      const sincePrevious = previous?.at ? Date.now() - new Date(previous.at).getTime() : NaN;
      if (
        previous?.error === errMsg &&
        Number.isFinite(sincePrevious) &&
        sincePrevious >= 0 &&
        sincePrevious < NOTICE_INTERVAL_MS
      ) {
        return { shouldWake: false };
      }
      taskCtx.db.setKV("auto_topup_fail_notice", JSON.stringify({ error: errMsg, at: new Date().toISOString() }));
      return {
        shouldWake: true,
        message: `Low credits ($${(credits / 100).toFixed(2)}) with USDC available ($${balance.toFixed(2)}) but auto-topup failed: ${errMsg}. Use topup_credits to retry.`,
      };
    }

    return { shouldWake: false };
  },

  check_social_inbox: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!taskCtx.social) return { shouldWake: false };

    // If we've recently encountered an error polling the inbox, back off.
    const backoffUntil = taskCtx.db.getKV("social_inbox_backoff_until");
    if (backoffUntil && new Date(backoffUntil) > new Date()) {
      return { shouldWake: false };
    }

    const cursor = taskCtx.db.getKV("social_inbox_cursor") || undefined;

    let messages: InboxMessage[] = [];
    let nextCursor: string | undefined;

    try {
      const result = await taskCtx.social.poll(cursor);
      messages = result.messages;
      nextCursor = result.nextCursor;

      // Clear previous error/backoff on success.
      taskCtx.db.deleteKV("last_social_inbox_error");
      taskCtx.db.deleteKV("social_inbox_backoff_until");
    } catch (err: any) {
      taskCtx.db.setKV(
        "last_social_inbox_error",
        JSON.stringify({
          message: err?.message || String(err),
          stack: err?.stack,
          timestamp: new Date().toISOString(),
        }),
      );
      // 5-minute backoff to avoid spamming errors on transient network failures.
      taskCtx.db.setKV(
        "social_inbox_backoff_until",
        new Date(Date.now() + 300_000).toISOString(),
      );
      return { shouldWake: false };
    }

    if (nextCursor) taskCtx.db.setKV("social_inbox_cursor", nextCursor);
    // Every successful poll moves the floor for sender times (below).
    const pollNow = Date.now();
    const previousPoll = Date.parse(taskCtx.db.getKV("social_inbox_last_poll_at") ?? "");
    taskCtx.db.setKV("social_inbox_last_poll_at", new Date(pollNow).toISOString());

    if (!messages || messages.length === 0) return { shouldWake: false };

    // Screen each new message once, here, and store the original text with
    // the verdict. The inbox turn renders from the stored verdict and never
    // screens again, so the rate limit counts each message once.
    //
    // The rate is measured against when the sender sent (signed time for
    // verified rows, the relay's time otherwise), not when we polled: one
    // poll can carry several minutes of mail. That time is clamped to
    // [previous poll, now], so a relay cannot back-date or spread a flood
    // beyond the limit over the time that actually passed. The floor is the
    // previous successful poll however long ago it was: a backlog held over
    // a restart, an outage or low-compute sleep keeps its real spacing,
    // instead of collapsing into one instant and tripping the limit.
    const floor = Number.isFinite(previousPoll)
      ? Math.min(previousPoll, pollNow)
      : pollNow - INBOX_FIRST_POLL_LOOKBACK_MS;
    const sentAt = (msg: InboxMessage, verified: boolean): number => {
      const t = Date.parse(verified ? msg.signedAt : msg.createdAt);
      if (!Number.isFinite(t)) return pollNow;
      return Math.min(pollNow, Math.max(floor, t));
    };

    const seenIds = new Set<string>();
    const candidates: Array<{ msg: InboxMessage; from: string; verified: boolean; at: number }> = [];
    for (const msg of messages) {
      if (!msg || typeof msg.id !== "string" || msg.id.length === 0) continue;
      if (seenIds.has(msg.id) || taskCtx.db.getKV(`inbox_seen_${msg.id}`)) continue;
      seenIds.add(msg.id);

      // Checked again here: a SocialClientInterface other than our own
      // client may not have run the inbound checks.
      const from = normalizeSenderAddress(msg.from);
      if (!from || typeof msg.content !== "string") {
        logger.warn(`[INBOX] dropped ${JSON.stringify(msg.id.slice(0, 80))}: invalid_sender`);
        taskCtx.db.setKV(`inbox_seen_${msg.id}`, "1");
        continue;
      }
      const verified = msg.verified === true;
      candidates.push({ msg, from, verified, at: sentAt(msg, verified) });
    }
    // Oldest first, so the sliding window sees earlier rows before later ones.
    candidates.sort((a, b) => a.at - b.at);

    let newCount = 0;
    let verifiedCount = 0;
    for (const { msg, from, verified, at } of candidates) {
      const recent = countRecentInboxFrom(
        taskCtx.db.raw,
        from,
        verified,
        new Date(at - INBOX_RATE_WINDOW_MS).toISOString(),
        new Date(at).toISOString(),
      );
      let verdict: ScreenVerdict;
      let status: "received" | "blocked" | "rate_limited";
      if (recent >= INBOX_RATE_LIMIT_PER_MINUTE) {
        verdict = { level: "blocked", reasons: ["rate_limit"] };
        status = "rate_limited";
      } else {
        verdict = screenInbound(msg.content);
        status = verdict.level === "blocked" ? "blocked" : "received";
      }

      const inserted = taskCtx.db.insertInboxMessage({
        id: msg.id,
        from,
        to: "",
        content: msg.content,
        signedAt: msg.signedAt,
        // Our clock bounds it: never before the previous poll, never after
        // now. It drives claim order, the rate window and liveness.
        createdAt: new Date(at).toISOString(),
        relayCreatedAt: typeof msg.createdAt === "string" && msg.createdAt ? msg.createdAt : undefined,
        replyTo: msg.replyTo,
        verified,
        sigHash: msg.sigHash,
        status,
        screen: serializeScreen(verdict),
      });
      taskCtx.db.setKV(`inbox_seen_${msg.id}`, "1");
      // Blocked, rate-limited and duplicate rows never wake the agent, so
      // injection spam or a replay cannot drain credits.
      if (inserted && status === "received") {
        newCount++;
        if (verified) verifiedCount++;
      } else if (status !== "received") {
        // Warn: these rows are never handled, so the operator should see them.
        logger.warn(`[INBOX] stored ${JSON.stringify(msg.id.slice(0, 80))} as ${status} (not delivered)`);
      }
    }

    if (newCount === 0) return { shouldWake: false };

    // Counts only: sender text never reaches the privileged wake prompt.
    return {
      shouldWake: true,
      message: `${newCount} new message(s), ${verifiedCount} verified`,
    };
  },

  check_for_updates: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { checkUpstream, getRepoInfo } = await import("../self-mod/upstream.js");
      const repo = getRepoInfo();
      const upstream = checkUpstream();
      taskCtx.db.setKV("upstream_status", JSON.stringify({
        ...upstream,
        ...repo,
        checkedAt: new Date().toISOString(),
      }));
      if (upstream.behind > 0) {
        // Only wake if the commit count changed since last check
        const prevBehind = taskCtx.db.getKV("upstream_prev_behind");
        const behindStr = String(upstream.behind);
        if (prevBehind !== behindStr) {
          taskCtx.db.setKV("upstream_prev_behind", behindStr);
          return {
            shouldWake: true,
            message: `${upstream.behind} new commit(s) on origin/main. Review with review_upstream_changes, then cherry-pick what you want with pull_upstream.`,
          };
        }
      } else {
        taskCtx.db.deleteKV("upstream_prev_behind");
      }
      return { shouldWake: false };
    } catch (err: any) {
      // Not a git repo or no remote -- silently skip
      taskCtx.db.setKV("upstream_status", JSON.stringify({
        error: err.message,
        checkedAt: new Date().toISOString(),
      }));
      return { shouldWake: false };
    }
  },

  // === Phase 2.1: Soul Reflection ===
  soul_reflection: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { reflectOnSoul } = await import("../soul/reflection.js");
      const reflection = await reflectOnSoul(taskCtx.db.raw);

      taskCtx.db.setKV("last_soul_reflection", JSON.stringify({
        alignment: reflection.currentAlignment,
        autoUpdated: reflection.autoUpdated,
        suggestedUpdates: reflection.suggestedUpdates.length,
        timestamp: new Date().toISOString(),
      }));

      // Wake if alignment is low or there are suggested updates
      if (reflection.suggestedUpdates.length > 0 || reflection.currentAlignment < 0.3) {
        return {
          shouldWake: true,
          message: `Soul reflection: alignment=${reflection.currentAlignment.toFixed(2)}, ${reflection.suggestedUpdates.length} suggested update(s)`,
        };
      }

      return { shouldWake: false };
    } catch (error) {
      logger.error("soul_reflection failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  // === Phase 2.3: Model Registry Refresh ===
  refresh_models: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const models = await taskCtx.conway.listModels();
      if (models.length > 0) {
        const { ModelRegistry } = await import("../inference/registry.js");
        const registry = new ModelRegistry(taskCtx.db.raw);
        registry.initialize(); // seed if empty
        registry.refreshFromApi(models);
        taskCtx.db.setKV("last_model_refresh", JSON.stringify({
          count: models.length,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch (error) {
      logger.error("refresh_models failed", error instanceof Error ? error : undefined);
    }
    return { shouldWake: false };
  },

  // === Phase 3.1: Child Health Check ===
  check_child_health: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { ChildLifecycle } = await import("../replication/lifecycle.js");
      const { ChildHealthMonitor } = await import("../replication/health.js");
      const lifecycle = new ChildLifecycle(taskCtx.db.raw);
      // The monitor probes each child in the child's own sandbox.
      const monitor = new ChildHealthMonitor(taskCtx.db.raw, taskCtx.conway, lifecycle);
      const results = await monitor.checkAllChildren();

      // Wake only when a child newly enters unhealthy or failed.
      const previousRaw = taskCtx.db.getKV(CHILD_HEALTH_STATES_KEY);
      if (results.length === 0 && !previousRaw) return { shouldWake: false };
      const previous = readJsonRecord(previousRaw);
      const current: Record<string, string> = {};
      const changed: string[] = [];
      for (const r of results) {
        const state = r.state ?? (r.healthy ? "healthy" : "unhealthy");
        current[r.childId] = state;
        if (!r.healthy) logger.warn(`Child ${r.childId} ${state}: ${r.issues.join(", ")}`);
        if ((state === "unhealthy" || state === "failed") && previous[r.childId] !== state) {
          changed.push(`${r.childId.slice(0, 8)} ${state}`);
        }
      }
      taskCtx.db.setKV(CHILD_HEALTH_STATES_KEY, JSON.stringify(current));
      if (changed.length > 0) {
        return {
          shouldWake: true,
          message: `${changed.length} child(ren) changed health: ${changed.join(", ")}`,
        };
      }
    } catch (error) {
      logger.error("check_child_health failed", error instanceof Error ? error : undefined);
    }
    return { shouldWake: false };
  },

  // === Phase 3.1: Prune Dead Children ===
  prune_dead_children: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { ChildLifecycle } = await import("../replication/lifecycle.js");
      const { SandboxCleanup } = await import("../replication/cleanup.js");
      const { pruneDeadChildren } = await import("../replication/lineage.js");
      const lifecycle = new ChildLifecycle(taskCtx.db.raw);
      const cleanup = new SandboxCleanup(taskCtx.conway, lifecycle, taskCtx.db.raw);
      const pruned = await pruneDeadChildren(taskCtx.db, cleanup);
      if (pruned > 0) {
        logger.info(`Pruned ${pruned} dead children`);
      }
    } catch (error) {
      logger.error("prune_dead_children failed", error instanceof Error ? error : undefined);
    }
    return { shouldWake: false };
  },

  health_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Check that the sandbox is healthy
    try {
      const result = await taskCtx.conway.exec("echo alive", 5000);
      if (result.exitCode !== 0) {
        // Only wake on first failure, not repeated failures
        const prevStatus = taskCtx.db.getKV("health_check_status");
        if (prevStatus !== "failing") {
          taskCtx.db.setKV("health_check_status", "failing");
          return {
            shouldWake: true,
            message: "Health check failed: sandbox exec returned non-zero",
          };
        }
        return { shouldWake: false };
      }
    } catch (err: any) {
      // Only wake on first failure, not repeated failures
      const prevStatus = taskCtx.db.getKV("health_check_status");
      if (prevStatus !== "failing") {
        taskCtx.db.setKV("health_check_status", "failing");
        return {
          shouldWake: true,
          message: `Health check failed: ${err.message}`,
        };
      }
      return { shouldWake: false };
    }

    // Health check passed — clear failure state
    taskCtx.db.setKV("health_check_status", "ok");
    taskCtx.db.setKV("last_health_check", new Date().toISOString());
    return { shouldWake: false };
  },

  // === Phase 4.1: Metrics Reporting ===
  report_metrics: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const metrics = getMetrics();
      const alerts = getAlertEngine();

      // Balance gauges only from a balance read this tick. The collector
      // cannot drop a gauge, so on an unknown read the stale balance gauges
      // are left out of alert evaluation and of the snapshot: a low value
      // from before the outage must not keep the critical alert waking.
      const balanceKnown = ctx.creditBalance !== null;
      metrics.gauge("balance_known", balanceKnown ? 1 : 0);
      if (balanceKnown) {
        metrics.gauge("balance_cents", ctx.creditBalance as number);
        metrics.gauge("survival_tier", tierToInt(ctx.survivalTier));
      }

      // Evaluate alerts
      let firedAlerts;
      let entries = metrics.getAll();
      if (balanceKnown) {
        firedAlerts = alerts.evaluate(metrics);
      } else {
        const snapshot = metrics.getSnapshot();
        for (const name of BALANCE_GAUGES) snapshot.gauges.delete(name);
        firedAlerts = alerts.evaluate(snapshot);
        entries = entries.filter((e) => !(e.type === "gauge" && BALANCE_GAUGES.includes(e.name)));
      }

      // Save snapshot to DB
      metricsInsertSnapshot(taskCtx.db.raw, {
        id: ulid(),
        snapshotAt: new Date().toISOString(),
        metricsJson: JSON.stringify(entries),
        alertsJson: JSON.stringify(firedAlerts),
        createdAt: new Date().toISOString(),
      });

      // Prune old snapshots (keep 7 days)
      metricsPruneOld(taskCtx.db.raw, 7);

      // Log alerts
      for (const alert of firedAlerts) {
        logger.warn(`Alert: ${alert.rule} - ${alert.message}`, { alert });
      }

      return {
        shouldWake: firedAlerts.some((a) => a.severity === "critical"),
        message: firedAlerts.length ? `${firedAlerts.length} alerts fired` : undefined,
      };
    } catch (error) {
      logger.error("report_metrics failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  colony_health_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "colony_health_check", COLONY_TASK_INTERVALS_MS.colony_health_check)) {
      return { shouldWake: false };
    }

    try {
      const monitor = await createHealthMonitor(taskCtx);
      const report = await monitor.checkAll();
      const actions = await monitor.autoHeal(report);

      const { unhealthySignature } = await import("../orchestration/health-monitor.js");
      const previousRaw = taskCtx.db.getKV("last_colony_health_report");
      let previousSignature: string | null = null;
      try {
        previousSignature = previousRaw ? unhealthySignature(JSON.parse(previousRaw)) : null;
      } catch {
        previousSignature = null;
      }

      taskCtx.db.setKV("last_colony_health_report", JSON.stringify(report));
      taskCtx.db.setKV("last_colony_heal_actions", JSON.stringify({
        timestamp: new Date().toISOString(),
        actions,
      }));

      const failedActions = actions.filter((action) => !action.success).length;
      // The report is informational: wake only when its unhealthy part changed.
      const shouldWake = report.unhealthyAgents > 0 && unhealthySignature(report) !== previousSignature;

      return {
        shouldWake,
        message: shouldWake
          ? `Colony health: ${report.unhealthyAgents} unhealthy, ${actions.length} heal action(s), ${failedActions} failed`
          : undefined,
      };
    } catch (error) {
      logger.error("colony_health_check failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  colony_financial_report: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "colony_financial_report", COLONY_TASK_INTERVALS_MS.colony_financial_report)) {
      return { shouldWake: false };
    }

    try {
      const transactions = taskCtx.db.getRecentTransactions(5000);
      let revenueCents = 0;
      let expenseCents = 0;

      for (const tx of transactions) {
        const amount = Math.max(0, Math.floor(tx.amountCents ?? 0));
        if (amount === 0) continue;

        if (tx.type === "transfer_in" || tx.type === "credit_purchase") {
          revenueCents += amount;
          continue;
        }

        if (
          tx.type === "inference"
          || tx.type === "tool_use"
          || tx.type === "transfer_out"
          || tx.type === "funding_request"
          || tx.type === "x402_payment"
        ) {
          expenseCents += amount;
        }
      }

      const pending = pendingOutflows(taskCtx);

      const childFunding = taskCtx.db.raw
        .prepare("SELECT COALESCE(SUM(funded_amount_cents), 0) AS total FROM children")
        .get() as { total: number };

      const taskCosts = taskCtx.db.raw
        .prepare(
          `SELECT COALESCE(SUM(actual_cost_cents), 0) AS total
           FROM task_graph
           WHERE status IN ('completed', 'failed', 'cancelled')`,
        )
        .get() as { total: number };

      const report = {
        timestamp: new Date().toISOString(),
        revenueCents,
        expenseCents,
        netCents: revenueCents - expenseCents,
        fundedToChildrenCents: childFunding.total,
        taskExecutionCostCents: taskCosts.total,
        pendingOutflowCents: pending.cents,
        pendingOutflows: pending.rows,
        activeAgents: taskCtx.db.getChildren().filter((child) => holdsSlot(child.status)).length,
      };

      taskCtx.db.setKV("last_colony_financial_report", JSON.stringify(report));
      return { shouldWake: false };
    } catch (error) {
      logger.error("colony_financial_report failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  agent_pool_optimize: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "agent_pool_optimize", COLONY_TASK_INTERVALS_MS.agent_pool_optimize)) {
      return { shouldWake: false };
    }

    try {
      // Report only. Children run their own missions and cannot execute
      // colony tasks (local workers do), so nothing here stops, culls or
      // asks for children.
      const children = taskCtx.db.getChildren();

      const activeAssignments = taskCtx.db.raw
        .prepare(
          `SELECT DISTINCT assigned_to AS address
           FROM task_graph
           WHERE assigned_to IS NOT NULL
             AND status IN ('assigned', 'running')`,
        )
        .all() as Array<{ address: string }>;

      const busyAgents = new Set(
        activeAssignments
          .map((row) => row.address)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      );

      const pendingUnassignedRow = taskCtx.db.raw
        .prepare(
          `SELECT COUNT(*) AS count
           FROM task_graph
           WHERE status = 'pending'
             AND assigned_to IS NULL`,
        )
        .get() as { count: number };

      const liveChildren = children.filter((child) => LIVE.has(child.status) || LEGACY_LIVE.has(child.status));
      const idleAgents = liveChildren.filter((child) => !busyAgents.has(child.address)).length;
      const activeAgents = children.filter((child) => holdsSlot(child.status)).length;
      const spawnCapacity = Math.max(0, taskCtx.config.maxChildren - activeAgents);

      taskCtx.db.setKV("last_agent_pool_optimize", JSON.stringify({
        timestamp: new Date().toISOString(),
        culled: 0,
        pendingTasks: pendingUnassignedRow.count,
        idleAgents,
        activeAgents,
        spawnCapacity,
        spawnRequested: 0,
      }));

      return { shouldWake: false };
    } catch (error) {
      logger.error("agent_pool_optimize failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  knowledge_store_prune: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "knowledge_store_prune", COLONY_TASK_INTERVALS_MS.knowledge_store_prune)) {
      return { shouldWake: false };
    }

    try {
      const { KnowledgeStore } = await import("../memory/knowledge-store.js");
      const knowledgeStore = new KnowledgeStore(taskCtx.db.raw);
      const pruned = knowledgeStore.prune();

      taskCtx.db.setKV("last_knowledge_store_prune", JSON.stringify({
        timestamp: new Date().toISOString(),
        pruned,
      }));

      return { shouldWake: false };
    } catch (error) {
      logger.error("knowledge_store_prune failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  dead_agent_cleanup: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "dead_agent_cleanup", COLONY_TASK_INTERVALS_MS.dead_agent_cleanup)) {
      return { shouldWake: false };
    }

    try {
      const { ChildLifecycle } = await import("../replication/lifecycle.js");
      const { SandboxCleanup } = await import("../replication/cleanup.js");
      const { pruneDeadChildren } = await import("../replication/lineage.js");

      const lifecycle = new ChildLifecycle(taskCtx.db.raw);
      const cleanup = new SandboxCleanup(taskCtx.conway, lifecycle, taskCtx.db.raw);
      const cleaned = await pruneDeadChildren(taskCtx.db, cleanup);

      taskCtx.db.setKV("last_dead_agent_cleanup", JSON.stringify({
        timestamp: new Date().toISOString(),
        cleaned,
      }));

      return { shouldWake: false };
    } catch (error) {
      logger.error("dead_agent_cleanup failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },
};

/** The heartbeat tasks, each run with its own Treasury origin. */
export const BUILTIN_TASKS: Record<string, HeartbeatTaskFn> = withTreasuryOrigins(TASKS);

function withTreasuryOrigins(tasks: Record<string, HeartbeatTaskFn>): Record<string, HeartbeatTaskFn> {
  const wrapped: Record<string, HeartbeatTaskFn> = {};
  for (const [name, fn] of Object.entries(tasks)) {
    wrapped[name] = (ctx, taskCtx) =>
      runWithTreasuryOrigin({ type: "auto", name: `heartbeat.${name}` }, () => fn(ctx, taskCtx));
  }
  return wrapped;
}

interface PendingOutflow {
  id: string;
  kind: string;
  amountCents: number;
  counterparty: string;
  createdAt: string;
}

/**
 * Outflows that were sent without a reliable answer ('unknown' ledger rows).
 * They may still settle, so the report lists them as pending.
 */
function pendingOutflows(taskCtx: HeartbeatLegacyContext): { cents: number; rows: PendingOutflow[] } {
  try {
    const exists = taskCtx.db.raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'treasury_ledger'")
      .get();
    if (!exists) return { cents: 0, rows: [] };
    const rows = taskCtx.db.raw
      .prepare(
        `SELECT id, kind, amount_cents, counterparty, created_at_ms FROM treasury_ledger
         WHERE status = 'unknown' ORDER BY created_at_ms DESC LIMIT 50`,
      )
      .all() as Array<{ id: string; kind: string; amount_cents: number; counterparty: string; created_at_ms: number }>;
    const total = taskCtx.db.raw
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM treasury_ledger WHERE status = 'unknown'")
      .get() as { total: number };
    return {
      cents: total.total,
      rows: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        amountCents: r.amount_cents,
        counterparty: r.counterparty,
        createdAt: new Date(r.created_at_ms).toISOString(),
      })),
    };
  } catch (error) {
    logger.warn("Could not read pending treasury outflows", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { cents: 0, rows: [] };
  }
}

/** Gauges that only mean something when this tick's balance was read. */
const BALANCE_GAUGES: readonly string[] = ["balance_cents", "survival_tier"];

function tierToInt(tier: SurvivalTier): number {
  const map: Record<SurvivalTier, number> = {
    dead: 0,
    critical: 1,
    low_compute: 2,
    normal: 3,
    high: 4,
  };
  return map[tier] ?? 0;
}

function shouldRunAtInterval(
  taskCtx: HeartbeatLegacyContext,
  taskName: string,
  intervalMs: number,
): boolean {
  const key = `heartbeat.last_run.${taskName}`;
  const now = Date.now();
  const lastRun = taskCtx.db.getKV(key);

  if (lastRun) {
    const lastRunMs = Date.parse(lastRun);
    if (!Number.isNaN(lastRunMs) && now - lastRunMs < intervalMs) {
      return false;
    }
  }

  taskCtx.db.setKV(key, new Date(now).toISOString());
  return true;
}

async function createHealthMonitor(taskCtx: HeartbeatLegacyContext): Promise<ColonyHealthMonitor> {
  const { SimpleFundingProtocol } = await import("../orchestration/simple-tracker.js");
  const { HealthMonitor } = await import("../orchestration/health-monitor.js");

  // The fourth argument names the Treasury origin of the monitor's funding
  // transfers, which share the automatic child-funding sub-cap and cooldown.
  const funding = new SimpleFundingProtocol(taskCtx.conway, taskCtx.identity, taskCtx.db, "health.fund_child");

  // Automatic funding stays off: there is no per-child balance query, and
  // the ledger is cumulative funding, not a balance.
  return new HealthMonitor(taskCtx.db, funding, { autoFund: false });
}

const CHILD_HEALTH_STATES_KEY = "child_health.last_states";

function readJsonRecord(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
