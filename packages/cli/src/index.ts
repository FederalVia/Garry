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
    default:
      console.log(`
Conway Automaton CLI - Creator Tools

Usage:
  automaton-cli status              Show automaton status
  automaton-cli logs [--tail N]     View automaton logs
  automaton-cli fund <usd> --to <address> [--cents] [--yes]
                                    Transfer Conway credits (dollars; --cents for cents)
  automaton-cli send <to-address> <message> Send a signed social message (EVM or Solana)
`);
  }
}

main().catch((err) => {
  console.error(`Error: ${escapeForTerminal(String(err?.message ?? err), { keepNewlines: false })}`);
  process.exit(1);
});
