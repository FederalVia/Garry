#!/usr/bin/env node
/**
 * Conway Automaton CLI
 *
 * Creator-facing CLI for interacting with an automaton.
 * Usage: automaton-cli <command> [args]
 */

import { escapeForTerminal } from "@conway/automaton/observability/terminal-safe.js";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "status":
      await import("./commands/status.js");
      break;
    case "logs":
      await import("./commands/logs.js");
      break;
    case "fund":
      await import("./commands/fund.js");
      break;
    case "send":
      await import("./commands/send.js");
      break;
    case "budget":
      await import("./commands/budget.js");
      break;
    case "approvals":
      await import("./commands/approvals.js");
      break;
    default:
      console.log(`
Conway Automaton CLI - Creator Tools

Usage:
  automaton-cli status              Show automaton status
  automaton-cli logs [--tail N]     View automaton logs
  automaton-cli budget show [--json]  What the agent's budget has left this period
  automaton-cli budget add <usd> [--note TEXT] [--yes]
                                    Add to the agent's budget (standalone)
  automaton-cli budget remove <usd> [--note TEXT] [--yes]
                                    Take budget back (a negative grant)
  automaton-cli approvals list [--all] [--json]
                                    Transfers waiting for your approval
  automaton-cli approvals approve <id> [--note TEXT] [--yes --amount <usd> --to <address>]
  automaton-cli approvals reject <id> [--note TEXT] [--yes]
  automaton-cli fund <usd> --to <address> [--cents] [--yes]
                                    Transfer Conway credits (Conway mode; dollars, --cents for cents)
  automaton-cli send <to-address> <message> Send a signed social message (EVM or Solana)
`);
  }
}

main().catch((err) => {
  console.error(`Error: ${escapeForTerminal(String(err?.message ?? err), { keepNewlines: false })}`);
  process.exit(1);
});
