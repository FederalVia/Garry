/**
 * automaton-cli fund <usd> --to <address> [--cents] [--yes]
 *
 * Transfer Conway credits with the automaton's Conway API key. The amount is
 * dollars (at most two decimals); --cents makes it a whole number of cents.
 * The plan is printed and must be confirmed with --yes or an interactive y.
 */

import { loadConfig } from "@conway/automaton/config.js";
import {
  parseUsdAmount,
  planFund,
  executeFund,
  formatUsd,
  confirmOnTty,
  FUND_USAGE as USAGE,
} from "@conway/automaton/operator/fund.js";

// The operator's own transfer, with the automaton's key and outside the
// agent's treasury budgets; both endpoint shapes share one idempotency key.
const TRANSFER_PATHS = ["/v1/credits/transfer", "/v1/credits/transfers"];

const args = process.argv.slice(3);
let amountArg: string | undefined;
let toArg: string | undefined;
let cents = false;
let yes = false;
let argError = "";

for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--to") {
    toArg = args[i + 1];
    i++;
  } else if (a.startsWith("--to=")) {
    toArg = a.slice("--to=".length);
  } else if (a === "--cents") {
    cents = true;
  } else if (a === "--yes" || a === "-y") {
    yes = true;
  } else if (a.startsWith("-") && !/^-\d/.test(a)) {
    argError = `Unknown option: ${a}`;
  } else if (amountArg === undefined) {
    amountArg = a;
  } else {
    argError = `Unexpected argument: ${a}`;
  }
}

try {
  if (argError || amountArg === undefined) {
    if (argError) console.log(argError);
    console.log(USAGE);
    process.exit(1);
  }

  const amount = parseUsdAmount(amountArg, { cents });
  if (!amount.ok) {
    console.log(amount.error);
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.log("No automaton configuration found.");
    process.exit(1);
  }

  const planned = planFund({ config, to: toArg, amountCents: amount.cents });
  if (!planned.ok) {
    console.log(planned.error);
    process.exit(1);
  }
  const plan = planned.plan;

  console.log(`Transfer ${plan.description}`);
  if (!yes) {
    const answer = await confirmOnTty(`Send ${formatUsd(plan.amountCents)} of Conway credits? [y/N] `);
    if (answer === null) {
      console.log("Refusing without confirmation: re-run with --yes, or run it in an interactive terminal.");
      process.exit(1);
    }
    if (!answer) {
      console.log("Cancelled. Nothing was sent.");
      process.exit(1);
    }
  }

  const result = await executeFund(plan, { paths: TRANSFER_PATHS });
  if (result.status !== "ok") {
    console.log(result.error);
    process.exit(result.status === "unknown" ? 2 : 1);
  }

  console.log(`
Transfer submitted.
From:      ${plan.from || "(automaton)"}
To:        ${plan.to}
Amount:    ${formatUsd(plan.amountCents)} (${plan.amountCents} cents)
Status:    ${result.transferStatus}
Transfer:  ${result.transferId}
Key:       ${result.idempotencyKey}
${result.balanceAfterCents !== undefined ? `Balance:   ${formatUsd(result.balanceAfterCents)} after transfer` : ""}
`);
} catch (err: any) {
  console.log(`Credit transfer failed: ${err?.message || String(err)}`);
  process.exit(1);
}
