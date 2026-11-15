/**
 * automaton-cli budget add <usd> | remove <usd> | show [--json] [--init]
 *
 * The owner's budget. Grants are written to the owner database, never to
 * state.db, and need --yes or an interactive y. Runs while the agent runs:
 * a top-up revives a dead agent within minutes. The logic is in
 * src/operator/budget.ts.
 */

import { loadConfig } from "@conway/automaton/config.js";
import { confirmOnTty } from "@conway/automaton/operator/fund.js";
import { runBudgetCli } from "@conway/automaton/operator/budget.js";

if (!loadConfig()) {
  console.log("No automaton configuration found (automaton --setup).");
  process.exit(1);
}
const code = await runBudgetCli(process.argv.slice(3), { log: (l) => console.log(l), confirm: confirmOnTty });
process.exit(code);
