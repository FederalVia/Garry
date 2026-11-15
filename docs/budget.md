# The owner's budget and transfer approvals

In standalone mode (your own AI provider keys, no Conway account) you give the
agent a budget: the most it may spend per period. The budget is its balance:
its survival tier, the inference gate's hard cap and the treasury's reserve
rules all follow what is left of it. You top it up with
`automaton-cli budget add <usd>`; no agent tool can add to it. The
spending side of the sum lives in the agent's own `state.db`, which the agent
can rewrite in every layout, so these limits hold against the agent's tools
and its shell tripwire, not against a script that edits that database: keep a
spending limit at your AI provider as the hard backstop (see
[Who can write what](#who-can-write-what)).

Conway mode ignores the budget (the Conway credit balance is the limit there)
and says so loudly at startup.

## Configuring it

The wizard asks for it (Standalone is the recommended first choice), and
`automaton --configure`, section 5 "Budget and survival", edits or removes
it. In `automaton.json`:

```jsonc
"budget": {
  "allowanceCents": 2500,        // $25.00 per period (monthly) or in total (one-off)
  "period": "monthly",           // or "one-off"
  "resetDay": 1,                 // monthly: 1-28, the period starts at 00:00 UTC that day
  // "startDate": "2026-11-01",  // one-off only (required there), UTC, today or earlier
  "countTreasury": true,         // payments and transfers count against it too (default true)
  "thresholds": { "unit": "percent", "high": 50, "normal": 15, "lowCompute": 5 },
  "dead": true                   // stop an hour after it runs out (default true)
}
```

An invalid block (unknown field, a reset day of 31, thresholds not strictly
descending, and so on) stops the agent from starting: a budget dropped
silently would remove the limit. `ownerDbPath` (default
`~/.automaton/owner/owner.db`) says where grants and approval decisions live.

## What is left

```
remaining = allowance + grants this period - AI spend this period - payments this period
```

- **Periods are UTC.** A monthly period runs from 00:00 UTC on `resetDay` to
  the same time next month; the boundary millisecond belongs to the new
  period. A one-off budget starts on `startDate` and never resets; the date
  must be today or earlier (UTC), so no spending or grant falls before it.
- **Grants** (`automaton-cli budget add`) count in the period they were added
  in; monthly grants do not carry over. A one-off budget counts every grant
  added since `startDate`.
  `budget remove` records a negative grant, for corrections.
- **AI spend** counts every call the inference gate recorded since the period
  started, survival calls included, at what it cost, and calls still in flight
  at their reserved worst case. Ledger rows older than 30 days are rolled up
  per day before they are pruned, so a long one-off period keeps every cent.
- **Payments** (`countTreasury: true`) count every treasury outflow that is
  reserved, sent, of unknown outcome or committed.
- The agent sees the remaining budget as its balance (clamped at $0). Actual
  usage can pass a reservation, so the real figure can go below zero;
  `budget show` prints it.

## Limits that follow from it

- **Hard period cap.** The inference gate refuses any paid call that needs
  more than what is left (`PERIOD_CAP`), inside the same transaction as its
  other caps, for every kind of call. Free local models still run. It counts
  what `state.db` records, so it has the limit described at the top.
- **Daily AI cap.** Defaults to about 1/15 of the budget (`ceil(allowance /
  15)`, $1.67 a day for $25), as the ceiling for
  `treasuryPolicy.maxInferenceDailyCents`. An explicit
  `providers.dailyCapCeilingCents` replaces it. A budget of 0 gets the
  standalone default ($2.00 a day): the period cap still refuses every paid
  call until you add a grant, and then the grant can be spent.
- **Survival allowance.** A critical agent may spend up to 25 cents a day
  above the daily cap to ask for budget, always checked against the period
  cap first: it can never spend past the budget.
- **Treasury.** A payment above what is left is refused (`BUDGET_EXHAUSTED`);
  the reserve floor (`minimumReserveCents`) and the half-balance rule apply
  to the budget for credit outflows.
- **Infrastructure** caps (sandboxes, domains) stay at 0 in standalone until
  you set them.

## Survival tiers and "dead"

Thresholds are percent of allowance plus this period's grants (default 50 /
15 / 5) or fixed dollar amounts (`"unit": "cents"`):

| Remaining | Tier |
|---|---|
| above high | `high` |
| above normal | `normal` |
| above lowCompute | `low_compute` (cheaper model, orchestration paused) |
| $0 up to lowCompute | `critical` (cheapest model, distress) |

The `check_budget` heartbeat task runs every 5 minutes. After an hour at $0
it marks the agent `dead` (its loop stops; the heartbeat keeps running and
the container stays healthy). It revives automatically within 5 minutes when
you add budget or a new period starts, and the agent is told why it woke
("Your owner added $10.00 to your budget", "a new budget period started").
With `"dead": false` the agent never dies: it idles at `critical`, and only
free local models run until money comes back.

The agent cannot change the `check_budget` or `execute_approved_transfers`
heartbeat entries (`modify_heartbeat` refuses them). To change their
schedule, edit `heartbeat.yml` yourself and restart the agent.

The agent's `distress_signal` tool and the heartbeat distress tell you to run
`automaton-cli budget add <usd>`. Its `check_credits` tool reads "Remaining
budget this period: $X of $Y (resets <date> UTC)".

## Owner commands

```sh
automaton-cli budget show [--json]       # period, grants, AI spend (in flight), payments, remaining, tier, daily cap, state
automaton-cli budget add 10 [--note "for March"] [--yes]
automaton-cli budget remove 2.50 [--yes]
```

Amounts are dollars with at most two decimals and no `$` sign (the shell
expands `$10`), at most $10,000 per grant. Every change prints its plan and
needs `--yes` or an interactive `y`. `budget show` opens `state.db`
read-only. These commands write only the owner database and do not wait for
the agent to stop: a top-up reaches a running (or dead) agent within 5
minutes.

## Large-transfer approvals

Transfers have three bands, set in `treasuryPolicy`:

| Amount | What happens |
|---|---|
| up to `requireConfirmationAboveCents` | the agent transfers on its own, within every cap |
| above it, up to `maxSingleTransferCents` | the transfer waits for your approval |
| above `maxSingleTransferCents` | refused outright, no request |

Both default to $10.00, so there is no approval band until you raise
`maxSingleTransferCents` (`automaton --configure`, Treasury). Today only
Conway-mode credit transfers (`transfer_credits`, `fund_child`) can reach
the band: standalone has no credit outflows yet.

When a transfer lands in the band and every other check passes, the agent
records a request (amount, recipient, its stated reason, an expiry 24 hours
out) and is told to wait. You decide:

```sh
automaton-cli approvals list [--all] [--json]
automaton-cli approvals approve apr_01J...            # shows the request, asks y/N
automaton-cli approvals approve apr_01J... --amount 25.00 --to 0x... --yes
automaton-cli approvals reject apr_01J... [--note TEXT] [--yes]
```

- `list` shows each request's state (pending, approved, executing, executed,
  outcome unknown, rejected, expired), amount, recipient and the agent's
  reason, escaped and marked unverified. A row whose id is not `apr_` plus a
  ULID, or whose recipient is not a wallet address, did not come from the
  agent's transfer tools: it is shown as `MALFORMED`, gets no approve
  command, and cannot be decided.
- `approve` warns when the amount is above `maxSingleTransferCents` (it would
  never run), above what is left of today's transfer cap, or when an
  identical request (same amount and recipient) already executed, so
  approving pays again. The request row lives in the agent's own database
  and can change after you read it, so `approve --yes` (no prompt) also needs
  the `--amount` and `--to` you reviewed; `list` prints that exact command
  (every value single-quoted) for each pending request, and any difference
  is refused. Your decision
  stores its own copy of the recipient and amount: the treasury executes only
  a transfer that matches that copy, never the agent's request row.
- An approved transfer runs once, through every normal cap (single,
  hourly and daily, cooldown, reserve, budget), on the agent's next retry or
  by the `execute_approved_transfers` heartbeat step within 5 minutes. It
  must run within 2 hours of your approval (`approvalExecuteWindowMs`), or it
  expires. A rejected request blocks an identical one for 24 hours. "Once"
  is enforced by the treasury ledger in `state.db`: a script that deletes the
  ledger row could reuse the approval inside the execute window. Shorten
  `approvalExecuteWindowMs` if that matters for your amounts.
- The agent can have at most 3 open requests and make 10 a day. A turn driven
  by an inbound message cannot create a request at all.

## Who can write what

| Data | Where | Written by |
|---|---|---|
| Grants, approval decisions | `~/.automaton/owner/owner.db` | the owner CLI and setup only |
| Approval requests, ledgers | `~/.automaton/state.db` | the agent |

The runtime opens the owner database read-only, no agent tool grants or
approves, and the agent's shell is refused any command that names
`owner.db`, `automaton-cli budget` or `automaton-cli approvals`.

**The same-user limitation.** When the agent runs as your own user (plain
local mode), those are guards, not a boundary: a process with your user id
can open `owner.db` for writing, edit its own ledgers, or call the provider
with its key, if it gets a command past the tripwire. Run the agent in the
container or as a dedicated user (see [deployment.md](deployment.md))
whenever it holds a budget; there the owner database and config are
read-only mounts it cannot change. In every layout the agent can still
rewrite its own `state.db` (its ledgers, and so the spend that the budget,
the treasury caps and the once-only rule count) and read its keys, so keep a
spending limit at your AI provider.
