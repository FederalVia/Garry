/**
 * Child Health Monitor
 *
 * Checks whether a child's agent process runs, inside the child's own
 * sandbox. Uses JSON parsing (not string matching) for status results.
 * Never throws from health checks -- returns issues array instead.
 *
 * It is the only liveness prober for lifecycle children:
 *   starting  -> healthy when the process is seen, -> failed when it is
 *                confirmed gone after the start grace period;
 *   healthy  <-> unhealthy on a confirmed-gone / running probe;
 *   unhealthy -> failed when the process is confirmed gone and the child has
 *                been unhealthy for deadThresholdMs (frees its slot).
 * A probe that learns nothing (Conway API error) changes nothing, so an API
 * outage cannot fail live children and free slots their processes still use.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { ConwayClient, HealthCheckResult, ChildHealthConfig } from "../types.js";
import { DEFAULT_CHILD_HEALTH_CONFIG } from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import { latestLifecycleEventMs } from "./child-status.js";
import { isLocalSandboxId } from "../conway/client.js";
import { rethrowIfCancelled, throwIfCancelled } from "../runtime/cancellation.js";

export { DEFAULT_CHILD_HEALTH_CONFIG };

/** Prints a JSON status; the bracket keeps pgrep from matching this shell. */
export const CHILD_PROBE_COMMAND =
  `pgrep -f '[i]ndex.js --run' >/dev/null && echo '{"status":"running"}' || echo '{"status":"offline"}'`;

export type ProbeOutcome = "running" | "offline" | "unknown";

const PROBED_STATES = ["starting", "healthy", "unhealthy"] as const;

export class ChildHealthMonitor {
  private config: ChildHealthConfig;

  constructor(
    private db: DatabaseType,
    private conway: ConwayClient,
    private lifecycle: ChildLifecycle,
    config?: Partial<ChildHealthConfig>,
    private readonly now: () => number = Date.now,
  ) {
    this.config = { ...DEFAULT_CHILD_HEALTH_CONFIG, ...config };
  }

  /**
   * Check health of a single child. Never throws, except when the
   * heartbeat task it runs in is cancelled: an aborted probe learned nothing.
   */
  async checkHealth(childId: string): Promise<HealthCheckResult> {
    const issues: string[] = [];
    let healthy = false;
    let lastSeen: string | null = null;
    let uptime: number | null = null;
    let creditBalance: number | null = null;
    let probe: ProbeOutcome = "unknown";

    const childRow = this.db
      .prepare("SELECT sandbox_id FROM children WHERE id = ?")
      .get(childId) as { sandbox_id: string } | undefined;

    if (!childRow) {
      return { childId, healthy: false, lastSeen: null, uptime: null, creditBalance: null, issues: ["child not found"], probe };
    }
    if (isLocalSandboxId(childRow.sandbox_id)) {
      return { childId, healthy: false, lastSeen: null, uptime: null, creditBalance: null, issues: ["child has no sandbox"], probe };
    }

    try {
      // Probe inside the CHILD's sandbox, not the parent's.
      const childConway = this.conway.createScopedClient(childRow.sandbox_id);
      const result = await childConway.exec(CHILD_PROBE_COMMAND, 10_000);
      if (typeof result.exitCode === "number" && result.exitCode !== 0) {
        issues.push(`health check exited ${result.exitCode}`);
      } else {
        // Parse JSON status output (not string matching)
        try {
          const lastLine = (result.stdout || "").trim().split("\n").pop() ?? "";
          const status = JSON.parse(lastLine.trim());
          if (status.status === "healthy" || status.status === "running") {
            healthy = true;
            probe = "running";
            lastSeen = new Date(this.now()).toISOString();
            uptime = status.uptime ?? null;
            creditBalance = status.creditBalance ?? null;
          } else {
            probe = "offline";
            issues.push(`status: ${status.status}`);
            if (status.error) issues.push(`error: ${status.error}`);
          }
        } catch {
          issues.push("failed to parse health check response");
        }
      }
    } catch (error) {
      // An aborted probe is not a failed one: no gone-check, no last_checked.
      rethrowIfCancelled(error);
      issues.push(`health check error: ${error instanceof Error ? error.message : String(error)}`);
      // The exec failed. Only a sandbox the API says is gone or not running
      // proves the process is gone; anything else is unknown.
      if (await sandboxGoneAfterExecError(this.conway, childRow.sandbox_id, error)) {
        probe = "offline";
        issues.push(`sandbox ${childRow.sandbox_id} is not running`);
      }
    }

    // Update last_checked timestamp
    try {
      this.db.prepare("UPDATE children SET last_checked = datetime('now') WHERE id = ?").run(childId);
    } catch {
      // Non-critical
    }

    return { childId, healthy, lastSeen, uptime, creditBalance, issues, probe };
  }

  /**
   * Check all children that may have a process (starting, healthy,
   * unhealthy). Respects concurrency limits. Transitions children based on
   * results; never revives an ended child.
   */
  async checkAllChildren(): Promise<HealthCheckResult[]> {
    const allChildren = PROBED_STATES.flatMap((state) => this.lifecycle.getChildrenInState(state));

    if (allChildren.length === 0) return [];

    const results: HealthCheckResult[] = [];
    const maxConcurrent = Math.max(1, this.config.maxConcurrentChecks);

    // Process in batches for concurrency limiting
    for (let i = 0; i < allChildren.length; i += maxConcurrent) {
      const batch = allChildren.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map((child) => this.checkHealth(child.id)),
      );
      // A cancelled task applies no probe result (none would be trusted).
      throwIfCancelled();

      for (const result of batchResults) {
        const child = allChildren.find((c) => c.id === result.childId);
        if (!child) continue;

        try {
          this.applyProbe(result, child.status);
        } catch {
          // Transition may fail if state changed concurrently; non-fatal
        }
        result.state = this.lifecycle.getStateOrNull(result.childId) ?? child.status;

        results.push(result);
      }
    }

    return results;
  }

  /**
   * Probe one child and apply the result as checkAllChildren does, so a
   * manual check can also resolve a starting or unhealthy child. Children
   * in other states are only probed.
   */
  async checkAndApply(childId: string): Promise<HealthCheckResult> {
    const result = await this.checkHealth(childId);
    const state = this.lifecycle.getStateOrNull(childId);
    if (state && (PROBED_STATES as readonly string[]).includes(state)) {
      try {
        this.applyProbe(result, state);
      } catch {
        // State changed concurrently; non-fatal.
      }
    }
    result.state = this.lifecycle.getStateOrNull(childId) ?? undefined;
    return result;
  }

  private applyProbe(result: HealthCheckResult, status: string): void {
    // Act on the state as it is now, not as it was when the batch started.
    const current = this.lifecycle.getStateOrNull(result.childId) ?? status;
    const reason = result.issues.join("; ") || "probe";
    const sinceMs = this.now() - latestLifecycleEventMs(this.db, result.childId);

    if (result.probe === "running") {
      if (current === "unhealthy") this.lifecycle.transition(result.childId, "healthy", "recovered");
      if (current === "starting") this.lifecycle.transition(result.childId, "healthy", "process seen by health probe");
      return;
    }
    if (result.probe !== "offline") return;

    if (current === "healthy") {
      this.lifecycle.transition(result.childId, "unhealthy", reason);
    } else if (current === "unhealthy" && sinceMs >= this.config.deadThresholdMs) {
      this.lifecycle.transition(
        result.childId,
        "failed",
        `process gone; unhealthy for ${Math.round(sinceMs / 60_000)} min: ${reason}`,
      );
    } else if (current === "starting" && sinceMs >= this.config.unhealthyThresholdMs) {
      this.lifecycle.transition(result.childId, "failed", `process not running after start: ${reason}`);
    }
  }

}

/**
 * True only when the Conway API lists sandboxes and this one is missing or
 * not running. An API error or an empty listing proves nothing.
 */
export async function sandboxConfirmedGone(conway: ConwayClient, sandboxId: string): Promise<boolean> {
  try {
    const sandboxes = await conway.listSandboxes();
    // An empty listing may be an API shape problem, not proof.
    if (sandboxes.length === 0) return false;
    const match = sandboxes.find((s) => s.id === sandboxId);
    if (!match) return true;
    return match.status !== "running" && match.status !== "unknown";
  } catch (error) {
    rethrowIfCancelled(error);
    return false;
  }
}

/**
 * Whether a failed exec in this sandbox proves its process is gone. A 404
 * that persists through the client's 404 retries means the sandbox is not
 * found; it counts unless a successful listing shows the sandbox running
 * (the load balancer's spurious 404s). An empty listing does not overrule
 * it, because the account may list no other sandbox.
 */
export async function sandboxGoneAfterExecError(
  conway: ConwayClient,
  sandboxId: string,
  error: unknown,
): Promise<boolean> {
  if (!isNotFoundError(error)) {
    return sandboxConfirmedGone(conway, sandboxId);
  }
  try {
    const sandboxes = await conway.listSandboxes();
    const match = sandboxes.find((s) => s.id === sandboxId);
    return !match || (match.status !== "running" && match.status !== "unknown");
  } catch (err) {
    rethrowIfCancelled(err);
    return false;
  }
}

/** A Conway HTTP 404 (status field, or the client's error message format). */
function isNotFoundError(error: unknown): boolean {
  if ((error as { status?: unknown } | null)?.status === 404) return true;
  const message = error instanceof Error ? error.message : "";
  return /^Conway API error: \S+ \S+ -> 404\b/.test(message);
}

/** Sends TERM, then KILL if needed, and reports what a final pgrep sees. */
export const CHILD_STOP_COMMAND =
  "pkill -f '[i]ndex.js --run'; sleep 3; " +
  "if pgrep -f '[i]ndex.js --run' >/dev/null; then pkill -9 -f '[i]ndex.js --run'; sleep 1; fi; " +
  "pgrep -f '[i]ndex.js --run' >/dev/null && echo alive || echo stopped";

/**
 * Stop the child's agent process in its own sandbox and verify it is gone.
 * "unknown" means nothing could be verified (API error with the sandbox
 * still listed as running, or no reply).
 */
export async function killChildProcess(
  conway: ConwayClient,
  sandboxId: string,
): Promise<{ outcome: "stopped" | "alive" | "unknown"; detail: string }> {
  // Nothing to stop remotely, and a sandbox listing could misreport an empty
  // id as "not running".
  if (isLocalSandboxId(sandboxId)) return { outcome: "unknown", detail: "child has no sandbox id" };
  try {
    const result = await conway.createScopedClient(sandboxId).exec(CHILD_STOP_COMMAND, 30_000);
    const last = (result.stdout || "").trim().split("\n").pop()?.trim() ?? "";
    if (last === "stopped") return { outcome: "stopped", detail: "process verified gone" };
    if (last === "alive") return { outcome: "alive", detail: "process still running after TERM and KILL" };
    return { outcome: "unknown", detail: `unexpected reply: ${last.slice(0, 120) || "(empty)"}` };
  } catch (error) {
    // Cancelled: nothing was verified, and the caller must stop, not record it.
    rethrowIfCancelled(error);
    const message = error instanceof Error ? error.message : String(error);
    if (await sandboxGoneAfterExecError(conway, sandboxId, error)) {
      return { outcome: "stopped", detail: `sandbox ${sandboxId} is not running (${message})` };
    }
    return { outcome: "unknown", detail: message };
  }
}
