/**
 * Colony health report.
 *
 * Reports on lifecycle children that are spawned and not ended. It never
 * restarts, stops or messages a child and never touches task_graph: the
 * lifecycle machine owns child status (ChildHealthMonitor probes liveness)
 * and the orchestrator owns task deadlines. Its only action is optional
 * top-up funding, off by default, through the treasury-gated funding
 * protocol.
 */

import { createLogger } from "../observability/logger.js";
import type { AutomatonDatabase, ChildAutomaton } from "../types.js";
import type { FundingProtocol } from "./types.js";
import { LEGACY_LIVE, LIVE, PRE_START, parseDbTimestamp } from "../replication/child-status.js";
import { isValidWalletAddress } from "../replication/spawn.js";

const logger = createLogger("orchestration.health-monitor");

/** No sign of life from a running child for this long is worth reporting. */
const ACTIVITY_STALE_MS = 45 * 60 * 1000;
const MIN_INFERENCE_CREDITS_CENTS = 10;
const FUND_TOPUP_TARGET_CENTS = 250;
const FUND_MIN_TRANSFER_CENTS = 50;

/** Only children whose process is meant to run can be funded automatically. */
const FUNDABLE_STATUSES = new Set(["healthy", "unhealthy"]);

export interface AgentHealthStatus {
  address: string;
  name: string;
  status: string;
  healthy: boolean;
  lastHeartbeat: string | null;
  currentTaskId: string | null;
  creditBalance: number | null;
  errorRate: number;
  issues: string[];
}

export interface HealthReport {
  timestamp: string;
  totalAgents: number;
  healthyAgents: number;
  unhealthyAgents: number;
  deadAgents: number;
  agents: AgentHealthStatus[];
}

export interface HealAction {
  type: "fund";
  agentAddress: string;
  reason: string;
  success: boolean;
}

export interface HealthMonitorOptions {
  /** Top up live children whose funding ledger is nearly empty. Default false. */
  autoFund?: boolean;
  now?: () => number;
}

export class HealthMonitor {
  private readonly autoFund: boolean;
  private readonly now: () => number;

  constructor(
    private readonly db: AutomatonDatabase,
    private readonly funding: FundingProtocol,
    options: HealthMonitorOptions = {},
  ) {
    this.autoFund = options.autoFund ?? false;
    this.now = options.now ?? Date.now;
  }

  async checkAll(): Promise<HealthReport> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const children = this.db.getChildren().filter(isReportable);

    const agents = await Promise.all(
      children.map(async (child) => this.checkChildHealth(child, nowMs)),
    );

    const unhealthyAgents = agents.filter((agent) => !agent.healthy).length;

    return {
      timestamp: nowIso,
      totalAgents: agents.length,
      healthyAgents: agents.length - unhealthyAgents,
      unhealthyAgents,
      // Ended children are not reported at all.
      deadAgents: 0,
      agents,
    };
  }

  /** Funds out-of-credit live children when autoFund is on; otherwise nothing. */
  async autoHeal(report: HealthReport): Promise<HealAction[]> {
    if (!this.autoFund) return [];
    const actions: HealAction[] = [];

    for (const agent of report.agents) {
      if (agent.healthy || !agent.issues.includes("out_of_credits")) continue;
      // Re-read the row: the report may be stale, and a child that ended
      // since must never be funded.
      const child = this.db.getChildren().find((c) => c.address === agent.address);
      if (!child || !FUNDABLE_STATUSES.has(child.status)) continue;
      if (!isValidWalletAddress(child.address, child.chainType)) continue;
      actions.push(await this.fundAgent(agent));
    }

    return actions;
  }

  private async checkChildHealth(child: ChildAutomaton, nowMs: number): Promise<AgentHealthStatus> {
    const lastHeartbeat = this.resolveLastActivity(child);
    const issues = new Set<string>();
    // Legacy rows (no lifecycle) may still be real, running children.
    const live = LIVE.has(child.status) || LEGACY_LIVE.has(child.status);

    if (child.status === "unhealthy") {
      issues.add("process_unhealthy");
    }

    let creditBalance: number | null = null;
    if (live) {
      const lastMs = parseDbTimestamp(lastHeartbeat);
      if (!Number.isNaN(lastMs) && nowMs - lastMs >= ACTIVITY_STALE_MS) {
        issues.add("activity_stale");
      }
      creditBalance = await this.getCreditBalance(child.address);
      if (creditBalance !== null && creditBalance < MIN_INFERENCE_CREDITS_CENTS) {
        issues.add("out_of_credits");
      }
    }

    return {
      address: child.address,
      name: child.name,
      status: child.status,
      healthy: issues.size === 0,
      lastHeartbeat,
      currentTaskId: null,
      creditBalance,
      errorRate: 0,
      issues: [...issues],
    };
  }

  /** The latest sign of life: last probe, an event, or a message from the child. */
  private resolveLastActivity(child: ChildAutomaton): string | null {
    const eventRow = this.db.raw
      .prepare("SELECT MAX(created_at) AS ts FROM event_stream WHERE agent_address = ?")
      .get(child.address) as { ts: string | null } | undefined;

    const inboxRow = this.db.raw
      .prepare("SELECT MAX(received_at) AS ts FROM inbox_messages WHERE from_address = ?")
      .get(child.address) as { ts: string | null } | undefined;

    return latestIso([child.lastChecked ?? null, eventRow?.ts ?? null, inboxRow?.ts ?? null]);
  }

  private async getCreditBalance(address: string): Promise<number | null> {
    try {
      const balance = await this.funding.getBalance(address);
      if (!Number.isFinite(balance)) {
        return null;
      }
      return Math.max(0, Math.floor(balance));
    } catch (error) {
      logger.warn("Failed to read child balance", {
        address,
        error: normalizeError(error).message,
      });
      return null;
    }
  }

  private async fundAgent(agent: AgentHealthStatus): Promise<HealAction> {
    const currentBalance = agent.creditBalance ?? 0;
    const amountCents = Math.max(
      FUND_MIN_TRANSFER_CENTS,
      FUND_TOPUP_TARGET_CENTS - currentBalance,
    );

    try {
      const result = await this.funding.fundChild(agent.address, amountCents);
      return {
        type: "fund",
        agentAddress: agent.address,
        reason: `credit balance ${currentBalance}c below ${MIN_INFERENCE_CREDITS_CENTS}c`,
        success: result.success,
      };
    } catch (error) {
      logger.warn("Auto-funding failed", {
        address: agent.address,
        error: normalizeError(error).message,
      });
      return {
        type: "fund",
        agentAddress: agent.address,
        reason: `credit balance ${currentBalance}c below threshold`,
        success: false,
      };
    }
  }
}

/** Spawned and not ended, with a wallet address (never a local worker). */
function isReportable(child: ChildAutomaton): boolean {
  if (!child.address || child.address.startsWith("local://")) return false;
  return LIVE.has(child.status) || PRE_START.has(child.status) || LEGACY_LIVE.has(child.status);
}

/** A stable summary of the unhealthy part of a report, for change detection. */
export function unhealthySignature(report: Pick<HealthReport, "agents">): string {
  return JSON.stringify(
    report.agents
      .filter((agent) => !agent.healthy)
      .map((agent) => [agent.address, agent.status, [...agent.issues].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

function latestIso(candidates: Array<string | null | undefined>): string | null {
  let latest: { iso: string; ms: number } | null = null;

  for (const value of candidates) {
    const ms = parseDbTimestamp(value);
    if (Number.isNaN(ms)) {
      continue;
    }

    if (!latest || ms > latest.ms) {
      latest = {
        ms,
        iso: new Date(ms).toISOString(),
      };
    }
  }

  return latest?.iso ?? null;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
