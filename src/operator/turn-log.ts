/**
 * Turn rendering for the operator CLI (`automaton-cli logs` and `status`).
 *
 * Turns hold text from other agents, web pages and command output. Every
 * field from the database is escaped before it reaches the terminal.
 */

import chalk from "chalk";
import { escapeForTerminal } from "../observability/terminal-safe.js";

export interface TurnLogToolCall {
  name: string;
  result: string;
  error?: string;
}

export interface TurnLogTurn {
  id: string;
  timestamp: string;
  state: string;
  input?: string;
  inputSource?: string;
  thinking: string;
  toolCalls: TurnLogToolCall[];
  tokenUsage: { totalTokens: number };
  costCents: number;
}

const accent = chalk.rgb(131, 127, 255);

/** One field, cut to `max` characters, escaped, on one line. */
function field(text: unknown, max: number): string {
  return escapeForTerminal(String(text ?? "").slice(0, max), { keepNewlines: false });
}

function stateColor(state: string): string {
  const s = field(state, 40);
  switch (state) {
    case "normal": return chalk.green(s);
    case "low_compute": return chalk.yellow(s);
    case "critical": return chalk.red(s);
    case "dead": return chalk.gray(s);
    default: return chalk.white(s);
  }
}

/** The lines `automaton-cli logs` prints for one turn. */
export function formatTurnLines(turn: TurnLogTurn): string[] {
  const lines: string[] = [];
  lines.push(accent.bold(`Turn #${field(turn.id, 64)}`) + chalk.dim(`  ${field(turn.timestamp, 40)}  `) + stateColor(turn.state));
  if (turn.input) {
    lines.push(accent("▸ Input") + chalk.dim(` [${field(turn.inputSource, 40)}]`) + "  " + field(turn.input, 200));
  }
  lines.push(chalk.dim("▸ Thinking  ") + chalk.white(field(turn.thinking, 500)));
  if (turn.toolCalls.length > 0) {
    lines.push(accent("▸ Tools"));
    for (const tc of turn.toolCalls) {
      const name = field(tc.name, 64);
      if (tc.error) {
        lines.push("  " + chalk.red(`✗ ${name}`) + "  " + chalk.red(field(tc.error, 100)));
      } else {
        lines.push("  " + chalk.green(`✓ ${name}`) + "  " + chalk.dim(field(tc.result, 100)));
      }
    }
  }
  const tokens = Number(turn.tokenUsage?.totalTokens) || 0;
  const cost = (Number(turn.costCents) || 0) / 100;
  lines.push(chalk.yellow(`tokens: ${tokens}`) + chalk.dim("  |  ") + chalk.yellow(`cost: $${cost.toFixed(4)}`));
  return lines;
}

/** The one-line summary `automaton-cli status` prints under "Recent activity". */
export function formatActivityLine(turn: Pick<TurnLogTurn, "timestamp" | "thinking" | "toolCalls">): string {
  const toolNames = turn.toolCalls.map((t) => field(t.name, 64)).join(", ");
  return (
    "  " + chalk.dim(field(turn.timestamp, 40)) + "  " +
    chalk.white(field(turn.thinking, 80)) + chalk.dim("...") +
    (toolNames ? chalk.magenta(`  [${toolNames}]`) : "")
  );
}
