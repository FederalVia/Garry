/**
 * Which Conway-backed features this runtime has, and the tools and heartbeat
 * tasks that need them. One table, so the model never sees a tool that can
 * only fail, and the heartbeat never runs a task that can only fail.
 */

export interface FeatureSet {
  /** Sandboxes on Conway Cloud. */
  conwayCompute: boolean;
  /** Child automatons (each needs a Conway sandbox). */
  children: boolean;
  /** A Conway credit balance (reads and transfers). */
  conwayCredits: boolean;
  /** Buying Conway credits with USDC. */
  topups: boolean;
  /** Domains and DNS through Conway. */
  domains: boolean;
  /** Model discovery through Conway's /v1/models. */
  conwayModels: boolean;
  /** The social relay (inbox and send_message). */
  relay: boolean;
  /** x402 payments and USDC balance reads (chain RPC). */
  payments: boolean;
  /** ERC-8004 registration, feedback and discovery (chain RPC, and gas for writes). */
  onchainIdentity: boolean;
  /**
   * Goals planned and run by local workers. Standalone turns it off when no
   * configured provider can serve the planner and workers.
   */
  orchestration: boolean;
}

/** Conway mode: nothing is hidden. */
export const ALL_FEATURES: Readonly<FeatureSet> = Object.freeze({
  conwayCompute: true,
  children: true,
  conwayCredits: true,
  topups: true,
  domains: true,
  conwayModels: true,
  relay: true,
  payments: true,
  onchainIdentity: true,
  orchestration: true,
});

/** Standalone mode: only the relay and payments can be switched on. */
export function standaloneFeatures(opts: { relay: boolean; payments: boolean; orchestration?: boolean }): FeatureSet {
  return {
    conwayCompute: false,
    children: false,
    conwayCredits: false,
    topups: false,
    domains: false,
    conwayModels: false,
    relay: opts.relay,
    payments: opts.payments,
    onchainIdentity: opts.payments,
    orchestration: opts.orchestration ?? true,
  };
}

/** Every feature a tool needs. Tools not listed are always offered. */
export const TOOL_FEATURES: Readonly<Record<string, readonly (keyof FeatureSet)[]>> = Object.freeze({
  create_sandbox: ["conwayCompute"],
  delete_sandbox: ["conwayCompute"],
  list_sandboxes: ["conwayCompute"],
  spawn_child: ["children"],
  list_children: ["children"],
  fund_child: ["children"],
  check_child_status: ["children"],
  start_child: ["children"],
  stop_child: ["children"],
  verify_child_constitution: ["children"],
  prune_dead_children: ["children"],
  message_child: ["children", "relay"],
  // These read the Conway balance and point the agent at Conway.
  check_credits: ["conwayCredits"],
  transfer_credits: ["conwayCredits"],
  heartbeat_ping: ["conwayCredits"],
  distress_signal: ["conwayCredits"],
  topup_credits: ["topups", "payments"],
  search_domains: ["domains"],
  register_domain: ["domains"],
  manage_dns: ["domains"],
  send_message: ["relay"],
  x402_fetch: ["payments"],
  check_usdc_balance: ["payments"],
  register_erc8004: ["onchainIdentity"],
  give_feedback: ["onchainIdentity"],
  // Read-only, but each uncached call is Base chain JSON-RPC: standalone with
  // defaults makes no chain calls at all.
  discover_agents: ["onchainIdentity"],
  create_goal: ["orchestration"],
  list_goals: ["orchestration"],
  cancel_goal: ["orchestration"],
  get_plan: ["orchestration"],
  complete_task: ["orchestration"],
  orchestrator_status: ["orchestration"],
});

/** Every feature a heartbeat task function needs, keyed on the resolved function name. */
export const TASK_FEATURES: Readonly<Record<string, readonly (keyof FeatureSet)[]>> = Object.freeze({
  check_credits: ["conwayCredits"],
  check_usdc_balance: ["topups", "payments"],
  check_social_inbox: ["relay"],
  refresh_models: ["conwayModels"],
  check_child_health: ["children"],
  prune_dead_children: ["children"],
  dead_agent_cleanup: ["children"],
  colony_health_check: ["children"],
});

function allowed(needs: readonly (keyof FeatureSet)[] | undefined, f: FeatureSet): boolean {
  return !needs || needs.every((k) => f[k]);
}

/**
 * The tools this runtime offers. Applies to installed tools too, so an
 * installed tool cannot bring back a hidden built-in name.
 */
export function visibleTools<T extends { name: string }>(tools: T[], f: FeatureSet): T[] {
  return tools.filter((t) => allowed(TOOL_FEATURES[t.name], f));
}

export function toolAllowed(name: string, f: FeatureSet): boolean {
  return allowed(TOOL_FEATURES[name], f);
}

export function taskAllowed(taskFnName: string, f: FeatureSet): boolean {
  return allowed(TASK_FEATURES[taskFnName], f);
}

/** A Conway-only feature was used in standalone mode. Thrown before any I/O. */
export class FeatureDisabledError extends Error {
  readonly code = "FEATURE_DISABLED";
  constructor(
    readonly feature: string,
    readonly setting: string,
  ) {
    super(`FEATURE_DISABLED: ${feature} needs ${setting} (standalone mode has no Conway account)`);
    this.name = "FeatureDisabledError";
  }
}

export function isFeatureDisabledError(err: unknown): err is FeatureDisabledError {
  return err instanceof FeatureDisabledError || (err as { code?: unknown } | null)?.code === "FEATURE_DISABLED";
}
