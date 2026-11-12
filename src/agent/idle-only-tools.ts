const IDLE_ONLY_TOOL_NAMES = [
  "check_credits",
  "check_usdc_balance",
  "system_synopsis",
  "review_memory",
  "list_children",
  "check_child_status",
  "list_sandboxes",
  "list_models",
  "list_skills",
  "git_status",
  "git_log",
  "check_reputation",
  "recall_facts",
  "recall_procedure",
  "heartbeat_ping",
  "check_inference_spending",
  "orchestrator_status",
  "list_goals",
  "get_plan",
] as const;

export const IDLE_ONLY_TOOLS = new Set<string>(IDLE_ONLY_TOOL_NAMES);

export function isIdleOnlyTool(name: string): boolean {
  return IDLE_ONLY_TOOLS.has(name);
}

/**
 * Tools that change something. A turn using one is real work for idle
 * detection, and loop detection compares their arguments, not just names.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "exec", "write_file", "edit_own_file", "transfer_credits", "topup_credits", "fund_child",
  "spawn_child", "start_child", "delete_sandbox", "create_sandbox",
  "install_npm_package", "install_mcp_server", "install_skill",
  "create_skill", "remove_skill", "install_skill_from_git",
  "install_skill_from_url", "pull_upstream", "git_commit", "git_push",
  "git_branch", "git_clone", "send_message", "message_child",
  "register_domain", "register_erc8004", "give_feedback",
  "update_genesis_prompt", "update_agent_card", "modify_heartbeat",
  "expose_port", "remove_port", "x402_fetch", "manage_dns",
  "distress_signal", "prune_dead_children", "sleep",
  "update_soul", "remember_fact", "set_goal", "complete_goal",
  "save_procedure", "note_about_agent", "forget",
  "enter_low_compute", "switch_model", "review_upstream_changes",
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}
