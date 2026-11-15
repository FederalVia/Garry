/**
 * automaton-cli approvals list [--all] [--json] | approve <id> | reject <id>
 *
 * Transfers above treasuryPolicy.requireConfirmationAboveCents wait for the
 * owner. Decisions are written to the owner database (never state.db) and
 * need --yes or an interactive y. The agent's stated reason is shown escaped
 * and marked unverified. The logic is in src/operator/approvals.ts.
 */

import { loadConfig } from "@conway/automaton/config.js";
import { confirmOnTty } from "@conway/automaton/operator/fund.js";
import { runApprovalsCli } from "@conway/automaton/operator/approvals.js";

if (!loadConfig()) {
  console.log("No automaton configuration found (automaton --setup).");
  process.exit(1);
}
const code = await runApprovalsCli(process.argv.slice(3), { log: (l) => console.log(l), confirm: confirmOnTty });
process.exit(code);
