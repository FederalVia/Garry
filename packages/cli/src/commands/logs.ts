/**
 * automaton-cli logs
 *
 * View the automaton's turn log.
 */

import chalk from "chalk";
import { loadConfig, resolvePath } from "@conway/automaton/config.js";
import { createDatabase } from "@conway/automaton/state/database.js";
import { formatTurnLines } from "@conway/automaton/operator/turn-log.js";

const accent = chalk.rgb(131, 127, 255);

const args = process.argv.slice(3);
let limit = 20;
const tailIdx = args.indexOf("--tail");
if (tailIdx !== -1 && args[tailIdx + 1]) {
  limit = parseInt(args[tailIdx + 1], 10) || 20;
}

const config = loadConfig();
if (!config) {
  console.log(chalk.red("No automaton configuration found."));
  process.exit(1);
}

const dbPath = resolvePath(config.dbPath);
const db = createDatabase(dbPath);

const turns = db.getRecentTurns(limit);

const divider = chalk.dim("─".repeat(72));

if (turns.length === 0) {
  console.log(chalk.dim("No turns recorded yet."));
} else {
  console.log(accent.bold(`\nShowing last ${turns.length} turn(s)\n`));
  for (const turn of turns) {
    console.log(divider);
    for (const line of formatTurnLines(turn)) console.log(line);
  }
  console.log(divider);
}

db.close();
