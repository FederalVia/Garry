/**
 * automaton-cli status
 *
 * Show the current status of an automaton.
 */

import chalk from "chalk";
import { loadConfig, resolvePath } from "@conway/automaton/config.js";
import { createDatabase } from "@conway/automaton/state/database.js";
import { formatActivityLine } from "@conway/automaton/operator/turn-log.js";
import { budgetContext, budgetReport, budgetStatusLine } from "@conway/automaton/operator/budget.js";
import { approvalsContext, pendingApprovalCount } from "@conway/automaton/operator/approvals.js";

const accent = chalk.rgb(131, 127, 255);

const config = loadConfig();
if (!config) {
  console.log(chalk.red("No automaton configuration found."));
  process.exit(1);
}

const dbPath = resolvePath(config.dbPath);
const db = createDatabase(dbPath);

const state = db.getAgentState();
const turnCount = db.getTurnCount();
const tools = db.getInstalledTools();
const heartbeats = db.getHeartbeatEntries();
const recentTurns = db.getRecentTurns(5);

function stateColor(s: string): string {
  switch (s) {
    case "normal": return chalk.green.bold(s);
    case "low_compute": return chalk.yellow.bold(s);
    case "critical": return chalk.red.bold(s);
    case "dead": return chalk.gray.bold(s);
    default: return chalk.white.bold(s);
  }
}

const divider = chalk.dim("─".repeat(52));
const label = (s: string) => chalk.dim(s.padEnd(12));

console.log("\n" + accent.bold(`  ◈ ${config.name}`) + "\n" + divider);
console.log(label("Address")  + chalk.white(config.walletAddress));
console.log(label("Creator")  + chalk.white(config.creatorAddress));
console.log(label("Sandbox")  + chalk.white(config.sandboxId));
console.log(label("State")    + stateColor(state));
console.log(label("Turns")    + chalk.yellow(String(turnCount)));
console.log(label("Tools")    + chalk.yellow(`${tools.length} installed`));
console.log(label("Heartbeat") + chalk.yellow(`${heartbeats.filter((h) => h.enabled).length} active`));
console.log(label("Model")    + chalk.white(config.inferenceModel));
// Read-only: neither line writes state.db or the owner database.
try {
  console.log(label("Budget")   + chalk.white(budgetStatusLine(budgetReport(budgetContext()))));
} catch (err: any) {
  console.log(label("Budget")   + chalk.yellow(`unavailable (${String(err?.message ?? err)})`));
}
try {
  const pending = pendingApprovalCount(approvalsContext());
  console.log(label("Approvals") + (pending > 0 ? chalk.yellow.bold(`${pending} pending (automaton-cli approvals list)`) : chalk.white("0 pending")));
} catch (err: any) {
  console.log(label("Approvals") + chalk.yellow(`unavailable (${String(err?.message ?? err)})`));
}
console.log(divider);

if (recentTurns.length > 0) {
  console.log(chalk.bold("\nRecent activity"));
  for (const turn of recentTurns) {
    console.log(formatActivityLine(turn));
  }
}

console.log();
db.close();
