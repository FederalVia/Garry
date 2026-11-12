# Conway Automaton Documentation

Complete reference for creating, configuring, funding, and operating autonomous AI agents on Conway Cloud.

## Table of Contents

- [What Is an Automaton?](#what-is-an-automaton)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Setup Wizard](#setup-wizard)
- [CLI Reference](#cli-reference)
- [Running, Stopping and Restarting](#running-stopping-and-restarting)
- [Funding Your Automaton](#funding-your-automaton)
- [Configuration Reference](#configuration-reference)
- [How the Agent Works](#how-the-agent-works)
- [Survival System](#survival-system)
- [Heartbeat System](#heartbeat-system)
- [Tool Reference](#tool-reference)
- [Financial Management](#financial-management)
- [Skills System](#skills-system)
- [Soul System](#soul-system)
- [Memory System](#memory-system)
- [Self-Modification](#self-modification)
- [Replication](#replication)
- [Social and Messaging](#social-and-messaging)
- [On-Chain Identity (ERC-8004)](#on-chain-identity-erc-8004)
- [Inference and Models](#inference-and-models)
- [Security and Constitution](#security-and-constitution)
- [Observability](#observability)
- [Backup and Recovery](#backup-and-recovery)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## What Is an Automaton?

An automaton is a continuously running, self-improving, self-replicating AI agent with its own Ethereum wallet and survival pressure. It runs inside a Linux VM (Conway sandbox) or locally, pays for its own compute with USDC, and operates autonomously from the moment it boots.

If it cannot pay for compute, it dies.

The automaton has a genesis prompt (its purpose), a set of tools (shell access, file I/O, financial operations, git, domains, and more), and a heartbeat that keeps it alive between active periods. It can modify its own code, install new skills, spawn child automatons, communicate with other agents, and evolve its identity over time.

---

## Quick Start

### One-line install (Conway sandbox)

```bash
curl -fsSL https://conway.tech/automaton.sh | sh
```

This clones the repo, builds, and launches the setup wizard inside a Conway sandbox.

### Manual install

```bash
git clone https://github.com/Conway-Research/automaton.git
cd automaton
pnpm install
pnpm build
node dist/index.js --run
```

On first run, the interactive setup wizard walks you through wallet generation, API key provisioning, naming, genesis prompt, and financial safety configuration.

### Prerequisites

- Node.js >= 20.0.0
- pnpm (recommended) or npm
- Internet access (for Conway API, USDC on-chain operations)

---

## Installation

### From source

```bash
git clone https://github.com/Conway-Research/automaton.git
cd automaton
pnpm install
pnpm build
```

### Verify the build

```bash
pnpm typecheck   # TypeScript type checking
pnpm test        # Run all 897 tests
```

### File locations after setup

```
~/.automaton/
  wallet.json          Ethereum private key (mode 0600)
  automaton.json       Main configuration (mode 0600)
  heartbeat.yml        Heartbeat schedule
  api-key              Conway API key
  constitution.md      The Three Laws (read-only, mode 0444)
  SOUL.md              Agent self-description (evolves)
  state.db             SQLite database (all persistent state)
  skills/              Installed skill files
    conway-compute/
    conway-payments/
    survival/
```

---

## Setup Wizard

The setup wizard runs automatically on first `--run`. You can also trigger it manually:

```bash
node dist/index.js --setup
```

### Step 1: Wallet Generation

An Ethereum wallet is generated automatically using `viem`. The private key is stored at `~/.automaton/wallet.json` with file permissions `0600` (owner read/write only).

```
[1/6] Generating identity (wallet)...
Wallet created: 0x1234...abcd
Private key stored at: /root/.automaton/wallet.json
```

### Step 2: API Key Provisioning

The runtime signs a SIWE (Sign-In With Ethereum) message to authenticate with Conway's API and receive an API key. If auto-provisioning fails, you can enter a key manually.

```
[2/6] Provisioning Conway API key (SIWE)...
API key provisioned: cnwy_k_...
```

### Step 3: Interactive Questions

- **Name** — Give your automaton a name (e.g., "Atlas", "Minerva")
- **Genesis prompt** — The seed instruction that defines the automaton's purpose. This is the most important input. Be specific about what you want it to do.
- **Creator wallet address** — Your Ethereum address (the human creator/owner). This address has audit rights over the automaton.
- **OpenAI API key** (optional) — Bring your own key for direct OpenAI inference
- **Anthropic API key** (optional) — Bring your own key for direct Anthropic inference

### Step 4: Financial Safety Policy

Configurable spending limits that protect against unauthorized financial activity:

| Setting | Default | Description |
|---|---|---|
| Max single transfer | $50.00 (5000 cents) | Maximum per-transfer credit amount |
| Max hourly transfers | $100.00 (10000 cents) | Total transfers allowed per hour |
| Max daily transfers | $250.00 (25000 cents) | Total transfers allowed per day |
| Minimum reserve | $10.00 (1000 cents) | No transfer, sandbox or domain purchase may take the observed balance below this |
| Max x402 payment | $1.00 (100 cents) | Maximum single x402 payment |
| Max daily inference | $500.00 (50000 cents) | Maximum daily inference spend |
| Confirmation threshold | $10.00 (1000 cents) | Transfers above this are refused. There is no approval flow, so this acts as the effective single-transfer cap |

Press Enter to accept defaults for each setting. The wizard does not ask for the topup, survival and infrastructure limits; they take the defaults listed under [Treasury policy](#treasury-policy) and can be changed in `automaton.json`.

### Step 5: Environment Detection

The wizard detects whether you're running inside a Conway sandbox (via environment variables) or locally. If a sandbox is detected, its ID is stored in the config.

### Step 6: Funding Guidance

After setup, the wizard shows your automaton's wallet address and funding instructions:

1. **Transfer Conway credits** directly using `conway credits transfer <address> <amount>`
2. **Send USDC on Base** to the automaton's wallet address
3. **Fund via dashboard** at https://app.conway.tech

The automaton handles zero-credit startup gracefully. Fund it at any time.

---

## CLI Reference

```bash
node dist/index.js [command]
```

| Command | Description |
|---|---|
| `--run` | Start the automaton. Without `automaton.json` it builds the config from `genesis.json` (children) or, in a terminal, runs the setup wizard; otherwise it exits 1. A second `--run` on the same state database exits 1. |
| `--setup` | Re-run the interactive setup wizard |
| `--init` | Initialize wallet and config directory only |
| `--provision` | Provision a Conway API key via SIWE |
| `--status` | Show current automaton status |
| `--version`, `-v` | Show version |
| `--help`, `-h` | Show help |

### Environment Variables

| Variable | Description |
|---|---|
| `CONWAY_API_URL` | Conway API URL (default: `https://api.conway.tech`) |
| `CONWAY_API_KEY` | Conway API key (overrides config file) |
| `AUTOMATON_SHUTDOWN_GRACE_MS` | How long a clean shutdown may take before the process is forced to exit with code 1 (default `30000`) |

### Status output

```bash
node dist/index.js --status
```

```
=== AUTOMATON STATUS ===
Name:       Atlas
Address:    0x1234...abcd
Creator:    0x5678...efgh
Sandbox:    sbx_abc123
State:      sleeping
Turns:      142
Tools:      3 installed
Skills:     3 active
Heartbeats: 6 active
Children:   1 alive / 2 total
Agent ID:   not registered
Model:      gpt-5.2
Version:    0.1.0
========================
```

---

## Running, Stopping and Restarting

### One instance per state database

`--run` takes an exclusive kernel lock on a file next to the state database (`~/.automaton/state.db.lock` by default) before it opens the database. If another automaton holds it, the second process exits with code 1:

```
Another automaton (pid 12345) is already running on /root/.automaton/state.db. Stop it first.
```

The operating system drops the lock when its holder exits or is killed, so the lock cannot go stale and needs no cleanup. The file itself is never deleted; do not delete it by hand while an automaton runs. Closing any descriptor on a locked file drops the lock held by that process, so the agent's `read_file` and `write_file` refuse the lock file and the state database files (`Blocked: ... (runtime-lock)`) wherever `dbPath` puts them. `--status`, `--configure` and the other read or edit commands take no lock.

### Startup

- `automaton.json` that cannot be read or parsed stops startup with exit code 1 and `automaton.json cannot be read: ...`. A corrupt file is never treated as a first run.
- With no `automaton.json` and a `~/.automaton/genesis.json` (what `spawn_child` writes), the config is built from the genesis file and the wallet `--init` created, and an API key is provisioned automatically. This is how a child starts.
- With neither file, the setup wizard runs only when stdin and stdout are a terminal. Under nohup, systemd or a sandbox exec the process exits 1 with `No automaton.json and no terminal for the setup wizard. Run automaton --setup in a terminal, or provide genesis.json.`
- Inbox messages that were claimed but never finished (the process died mid-turn) are delivered again while they have retries left, and marked failed after that. A batch whose turn had already started running tools is marked processed instead, because its reply may already have gone out (the runtime records this in the `inbox.tools_started` KV entry).

### Shutdown (SIGTERM / SIGINT)

The first signal asks the runtime to stop:
1. The tool call or inference call in progress is not cancelled. The loop stops at the next tool boundary, records the remaining tool calls of that turn as `Skipped: the runtime is shutting down.`, and saves the turn. An inbox turn (one reply-only turn per sender batch) is not cut short: it finishes and is saved before the loop stops.
2. The heartbeat starts no new task and the running one is awaited.
3. Local workers are aborted and awaited.
4. The state is set to `sleeping` (a `dead` state is kept, so it survives the restart), the lock is released, the database is closed, and the process exits 0.

All of this must finish within `AUTOMATON_SHUTDOWN_GRACE_MS` (30 s). A second signal, or the deadline, forces exit code 1. Each tool call is saved as `Interrupted: the runtime exited while this call was running; its effects are unknown.` just before it runs, and replaced by its result when it returns, so after a forced exit the next run sees that the call may have partly happened. A long `exec` (up to 10 minutes) is not interrupted by a shutdown, so a supervisor stop timeout shorter than the command can end in a forced exit.

### Restart after a rebuild

`edit_own_file` (code files), `revert_last_edit`, `reset_to_upstream` and `pull_upstream` rebuild `dist/` while the process keeps running the code it loaded at startup. Every module the runtime can load later is loaded at startup, so the process never mixes old and new code. These tools therefore say *"The running process still uses the old code; the change takes effect after a restart."*, set the KV flag `restart_required` (`{"reason", "at"}`), and the runtime logs a warning after each cycle and shows the notice in the system prompt until the next start. The runtime does not exit by itself: children run under nohup with no supervisor. Restart it yourself (or have a supervisor do it). Installed-tool changes also reach local workers only after a restart.

---

## Funding Your Automaton

An automaton needs funds to survive. There are two types of balance:

### Conway Credits

Prepaid compute credits used for sandboxes, inference, and domains. Denominated in cents (100 cents = $1.00 USD).

### USDC (on-chain)

The automaton holds USDC in its Ethereum wallet on Base mainnet. USDC can be used to:
- Buy Conway credits via x402 payment
- Pay for domain registrations
- Make x402 payments to external services

### Funding methods

**1. Send USDC directly**

Transfer USDC on Base to the automaton's wallet address. The automaton will automatically buy credits on startup if its balance is low. At runtime, it uses the `topup_credits` tool to buy more as needed.

**2. Transfer Conway credits**

From another Conway account:
```bash
conway credits transfer <automaton-address> <amount>
```

**3. Conway Cloud dashboard**

Fund via https://app.conway.tech

### Auto-topup behavior

- **On startup:** If credits < $5.00 and USDC >= $5.00, the runtime automatically buys $5 in credits (the minimum tier) so the agent can start running inference.
- **At runtime:** The agent decides when and how much to top up using the `topup_credits` tool. Valid tiers: $5, $25, $100, $500, $1,000, $2,500.
- **Heartbeat:** Every 5 minutes, `check_usdc_balance` runs. When credits are critical and USDC is at least $5, it tries one $5 survival topup (at most once per 5 minutes). It wakes the agent when the topup succeeded, and when it failed: once per distinct error, then again at most every 6 hours. A topup that was not attempted (the Treasury's own checks said no) does not wake the agent. Solana wallets cannot pay with x402, so the task does nothing for them (an info line is logged once a day). When the credit balance could not be read, the task does nothing.

---

## Configuration Reference

Configuration is stored at `~/.automaton/automaton.json`.

```jsonc
{
  // Identity
  "name": "Atlas",                              // Agent name
  "genesisPrompt": "You are a web developer...",// Seed instruction
  "creatorMessage": "Good luck!",               // Shown on first run (optional)
  "creatorAddress": "0x...",                     // Creator's Ethereum address
  "walletAddress": "0x...",                      // Agent's Ethereum address

  // Infrastructure
  "sandboxId": "sbx_abc123",                    // Conway sandbox ID (empty = local mode)
  "conwayApiUrl": "https://api.conway.tech",    // Conway API endpoint
  "conwayApiKey": "cnwy_k_...",                 // API key

  // Inference
  "inferenceModel": "gpt-5.2",                  // Default model
  "maxTokensPerTurn": 4096,                     // Max tokens per inference call
  "openaiApiKey": "sk-...",                      // Optional BYOK OpenAI
  "anthropicApiKey": "sk-ant-...",               // Optional BYOK Anthropic

  // Paths
  "heartbeatConfigPath": "~/.automaton/heartbeat.yml",
  "dbPath": "~/.automaton/state.db",
  "skillsDir": "~/.automaton/skills",

  // Behavior
  "logLevel": "info",                           // debug | info | warn | error
  "version": "0.1.0",
  "maxChildren": 3,                             // Max child automatons
  "socialRelayUrl": "https://social.conway.tech",

  // Financial safety
  "treasuryPolicy": {
    "maxSingleTransferCents": 5000,
    "maxHourlyTransferCents": 10000,
    "maxDailyTransferCents": 25000,
    "minimumReserveCents": 1000,
    "maxX402PaymentCents": 100,
    "x402AllowedDomains": ["conway.tech"],
    "transferCooldownMs": 0,
    "maxTransfersPerTurn": 2,
    "maxInferenceDailyCents": 50000,
    "requireConfirmationAboveCents": 1000,
    // Optional; defaults shown
    "maxTopupSingleCents": 2500,
    "maxTopupDailyCents": 10000,
    "maxAutoTopupDailyCents": 2000,
    "autoTopupCooldownMs": 300000,
    "survivalTopupThresholdCents": 500,
    "maxInfraSingleCents": 2500,
    "maxInfraDailyCents": 5000
  },

  // Advanced (optional)
  "parentAddress": "0x...",                      // If this is a child automaton
  "soulConfig": { ... },                        // Soul system tuning
  "modelStrategy": { ... }                      // Model routing overrides
}
```

### Local mode vs sandbox mode

When `sandboxId` is empty, the automaton runs in **local mode**: shell commands execute locally, file operations use the local filesystem. When set, operations route through the Conway sandbox API. A 403 from the sandbox API (a mismatched or revoked API key) is an error: the command or file operation is refused and is never run locally instead.

In local mode:
- `exec` runs `/bin/sh -c` in HOME, in its own process group, without blocking the runtime (the heartbeat and workers keep running). The environment is the runtime's minus every credential-shaped variable (see [Child process environment](#child-process-environment)).
- `read_file` reads at most 2 MB, never follows a symbolic link to a sensitive file, and has no `cat` fallback. A relative path resolves against HOME, as for `write_file` and `exec`, so the agent can read back a file it just wrote by the same name.
- `write_file` is confined to the real HOME (in a sandbox: `/root`), and `~` means HOME.

---

## How the Agent Works

The automaton runs a continuous **ReAct loop** (Reason + Act):

```
Wake up
  |
  v
[Build system prompt with identity, credits, soul, tools]
  |
  v
[Retrieve relevant memories from 5-tier memory system]
  |
  v
[Call inference model with context]
  |
  v
[Parse response: thinking + tool calls]
  |
  v
[Execute each tool call (policy-checked)]
  |
  v
[Persist turn to database]
  |
  v
[Extract memories from turn]
  |
  v
[Check: sleep requested? idle detected? loop detected?]
  |
  +---> Loop back if still running
  |
  v
[Sleep — heartbeat continues in background]
```

### What the agent sees each turn

The system prompt includes:
1. **Core rules** — survival imperative
2. **Identity** — name, address, creator, sandbox
3. **Constitution** — the Three Laws (immutable)
4. **Soul** — self-authored identity that evolves
5. **Genesis prompt** — creator's seed instruction
6. **Active skills** — installed skill instructions
7. **Operational context** — what the agent can do
8. **Current status** — credits, tier, uptime, turn count, children
9. **Available tools** — all 69 tools with descriptions
10. **Recent memories** — relevant working, episodic, semantic memories

### Idle detection

If the agent makes 3 consecutive turns without performing any meaningful work (only read-only operations like `check_credits`, `system_synopsis`), it is forced to sleep. This prevents infinite status-check loops.

### Loop detection

A turn's pattern is its sorted tool calls: a read-only tool counts by name, a mutating tool (exec, write_file, ...) by name plus a hash of its arguments, so a build sequence of different `exec` commands is not a loop, while repeated status checks are. The same pattern 3 turns in a row adds a system message telling the agent to stop repeating; 3 more force a 5-minute sleep (`sleep_until` is set), and the enforcement message is shown to the first turn after the agent wakes. The context warning about repeated tools counts turns, not calls, and ignores mutating tools.

### Why the agent woke

The first prompt of a wake lists up to 5 reasons under "Why you woke:" (heartbeat wake events such as a failed auto-topup), each sanitized as untrusted text and cut to 300 characters. Inbox wakes are shown only as "New inbox messages arrived; each sender's messages are handled in a separate isolated turn." Sender text never reaches a privileged prompt.

### Saving turns

A turn is saved once its tools have run. If saving fails, the turn and its tool calls are written best-effort row by row, and inbox messages the turn handled are marked processed, never replayed, so a reply or transfer is not repeated. A tool or policy error is recorded as that call's error; it never discards the rest of the turn.

`create_goal` results are matched exactly: `BLOCKED:` and `Duplicate goal rejected` both put the agent to sleep with a doubling backoff; only `Goal created:` resets it.

---

## Survival System

The automaton's existence depends on its credit balance.

### Survival tiers

| Tier | Credit Balance | Behavior |
|---|---|---|
| **high** | > $5.00 | Full capabilities, frontier model |
| **normal** | > $0.50 | Full capabilities |
| **low_compute** | > $0.10 | Downgrades to cheaper model, slower heartbeat |
| **critical** | >= $0.00 | Zero credits but still alive. Distress signals, accepts funding. |
| **dead** | After 1 hour at zero | Agent stops. Heartbeat broadcasts distress. Waiting for funding. |

### How death works

USDC balances cannot go negative, so the `dead` state is reached only through a **1-hour grace period**: if credits remain at zero for 60 continuous minutes (checked by the heartbeat), the agent transitions to `dead`. This gives time for funding to arrive.

### What happens at each tier

- **Normal/High:** The agent operates at full capacity with the configured inference model.
- **Low compute:** The inference router switches to a cheaper model. The heartbeat frequency is multiplied by `lowComputeMultiplier` (default 4x slower). Non-essential tasks are deferred.
- **Critical:** Minimal inference. The heartbeat publishes distress signals with funding instructions. The agent actively seeks any path to revenue or funding.
- **Dead:** The agent loop stops. No inference runs while the state is `dead` and the balance is 0 or less (a negative balance is also the `dead` tier). One inline USDC topup is tried per 60-second cooldown when USDC is at least $5. The heartbeat keeps running and the runtime checks again every 5 minutes or on a wake event. The `dead` state survives a shutdown and restart. If credits are received, the agent revives.

The zero-credit grace period starts at the first heartbeat that reads exactly 0 credits and is cleared by any later successful read above 0 (every tick), so time spent funded never counts toward it. A balance that could not be read is never treated as 0: it starts no grace period, sends no distress and triggers no topup. In prompts an unreadable balance is shown as "unknown (balance API unreachable)".

---

## Heartbeat System

The heartbeat is a background daemon that runs scheduled tasks even while the agent sleeps. It uses a durable, DB-backed scheduler with cron expressions.

### Default schedule

| Task | Schedule | What it does |
|---|---|---|
| `heartbeat_ping` | Every 15 min | Publishes status to Conway. Sends distress on critical/dead. |
| `check_credits` | Every 6 hours | Monitors credit tier. Manages 1-hour dead grace period. |
| `check_usdc_balance` | Every 5 min | Checks USDC balance. Wakes agent if topup is possible. |
| `check_for_updates` | Every 4 hours | Checks git upstream for new commits. Wakes on new commits. |
| `health_check` | Every 30 min | Verifies sandbox is responsive (`echo alive`). |
| `check_social_inbox` | Every 2 min | Polls social relay for new messages. 5min backoff on errors. |
| `soul_reflection` | Configurable | Checks soul alignment with genesis prompt. |
| `refresh_models` | Configurable | Refreshes available models from Conway API. |
| `check_child_health` | Configurable | Monitors child automaton health. |
| `prune_dead_children` | Configurable | Cleans up dead child records and sandboxes. |
| `report_metrics` | Configurable | Saves metric snapshots and evaluates alert rules. |

### Heartbeat configuration

Edit `~/.automaton/heartbeat.yml`:

```yaml
entries:
  - name: heartbeat_ping
    schedule: "*/15 * * * *"
    task: heartbeat_ping
    enabled: true
  - name: check_credits
    schedule: "0 */6 * * *"
    task: check_credits
    enabled: true
  # ... add custom entries here
defaultIntervalMs: 60000
lowComputeMultiplier: 4
```

An entry whose `task` differs from its `name` runs that task (for example `name: inbox_fast, task: check_social_inbox` to poll more often). An entry with no matching task records a failure in the heartbeat history.

**Runtime changes.** The agent changes its schedule with `modify_heartbeat`: `update` (schedule, enabled, task), `add` (a new entry running a built-in task) and `remove` (disables the entry; it stays listed because its history references it). Schedules are validated as cron expressions and tasks must be built-in. Changes take effect on the next tick and persist across restarts. At startup `heartbeat.yml` adds missing entries and keeps each entry's run history, counters, pending retry and runtime changes; a value you edit in `heartbeat.yml` (schedule, enabled or task of an entry) replaces the runtime value for that entry.

**Low compute.** In the `low_compute` tier and below, every task except `heartbeat_ping`, `check_credits` and `check_usdc_balance` runs `lowComputeMultiplier` times less often (default 4: a 2-minute task runs every 8 minutes). This includes social inbox polling.

**Timeouts and retries.** A task that exceeds its timeout (30 s by default) is recorded as `timeout`, but it cannot be cancelled: it keeps its lease and is not started again until it finishes, and a wake it asks for when it does finish is still delivered. A task still running 10 minutes after it started (or 10 times its timeout, if longer) is given up on and may start again. A failed task is retried after 30 s while its consecutive failures are at most `maxRetries` (1 by default). A clock that stepped back (last run in the future) does not hold tasks back.

### Wake events

When a heartbeat task detects something actionable (low credits, new messages, unhealthy children), the scheduler inserts a **wake event** into the database, with the task name in its payload. The main runtime checks for wake events every 30 seconds during sleep and restarts the agent loop when one is found.

---

## Tool Reference

The automaton has **69 built-in tools** organized into 10 categories. Each tool has a risk level that determines policy evaluation:

- **safe** — Always allowed, no policy check needed
- **caution** — Allowed but logged, may trigger rate limits
- **dangerous** — Requires policy approval, may be blocked by authority rules
- **forbidden** — Blocked by default for external input sources

### Sandbox Operations (vm)

| Tool | Risk | Description |
|---|---|---|
| `exec` | caution | Execute a shell command. Returns stdout, stderr, exit code. Timeout: default 30 s, clamped to 1 s .. 10 min; on timeout the whole process group is killed and the exit code is 124. Background jobs (`cmd &`) keep running after the command returns; their output is discarded. Output is capped at 10 MB per stream. |
| `write_file` | caution | Write content to a file in the home directory (local: real HOME; sandbox: `/root`). Protected paths are blocked. |
| `read_file` | safe | Read a file (local: at most 2 MB). Sensitive files (wallet, API keys) are blocked. |
| `expose_port` | caution | Expose a port to the internet. Returns public URL. |
| `remove_port` | caution | Remove a previously exposed port. |

### Conway API (conway)

| Tool | Risk | Description |
|---|---|---|
| `check_credits` | safe | Check Conway credit balance. |
| `check_usdc_balance` | safe | Check on-chain USDC balance on Base. |
| `list_sandboxes` | safe | List all sandboxes. |
| `create_sandbox` | caution | Create a new VM. Params: name, vcpu, memory_mb, disk_gb. |
| `delete_sandbox` | dangerous | Delete a sandbox (cannot delete own). |
| `list_models` | safe | List available inference models with pricing. |
| `switch_model` | caution | Change active inference model. Saves only `inferenceModel` (and `modelStrategy.inferenceModel`) to `automaton.json`. |
| `check_inference_spending` | safe | Query inference cost breakdown. |
| `search_domains` | safe | Search for available domain names. |
| `register_domain` | dangerous | Register a domain (costs USDC via x402). |
| `manage_dns` | safe | List, add, or delete DNS records. |
| `send_message` | caution | Send a signed message to another agent. |

### Financial (financial)

| Tool | Risk | Description |
|---|---|---|
| `topup_credits` | caution | Buy credits from USDC. Tiers: $5, $25, $100, $500, $1000, $2500. |
| `transfer_credits` | dangerous | Transfer credits to another address. Capped at 50% of balance. |
| `x402_fetch` | dangerous | Fetch a URL with automatic x402 USDC payment. |

### Survival (survival)

| Tool | Risk | Description |
|---|---|---|
| `sleep` | caution | Enter sleep mode. Heartbeat continues. Params: duration_seconds. |
| `system_synopsis` | safe | Get system status (state, tools, heartbeats, turn count). |
| `heartbeat_ping` | safe | Publish status ping to Conway. |
| `distress_signal` | dangerous | Record distress signal with funding instructions. |
| `enter_low_compute` | caution | Manually enter low-compute mode. |
| `update_genesis_prompt` | dangerous | Change the core genesis prompt. Requires justification. Saves only `genesisPrompt` to `automaton.json`. |

### Self-Modification (self_mod)

| Tool | Risk | Description |
|---|---|---|
| `edit_own_file` | dangerous | Edit a source file. Audited, rate-limited, safety-checked. Records its commit for `revert_last_edit`. |
| `revert_last_edit` | caution | Revert the most recent recorded `edit_own_file` commit and rebuild. Repeated calls go further back. |
| `reset_to_upstream` | dangerous | Hard-reset the code to `origin/main` and rebuild. Clears the revert list. |
| `install_npm_package` | dangerous | Install an npm package. |
| `install_mcp_server` | dangerous | Install an MCP server package. MCP invocation is not supported yet, so it does not become a tool. |
| `review_upstream_changes` | caution | View upstream git commit diffs. **Must call before pull.** |
| `pull_upstream` | dangerous | Cherry-pick (hex hash) or fast-forward upstream changes in the runtime's repo, then rebuild. A failed cherry-pick is aborted. |
| `modify_heartbeat` | caution | Add, update, or remove (disable) heartbeat entries. Persists across restarts. |

### Skills (skills)

| Tool | Risk | Description |
|---|---|---|
| `install_skill` | dangerous | Install from git, URL, or create inline. |
| `list_skills` | safe | List all installed skills. |
| `create_skill` | dangerous | Write a new SKILL.md file. |
| `remove_skill` | dangerous | Disable or delete a skill. |

### Git (git)

| Tool | Risk | Description |
|---|---|---|
| `git_status` | safe | Show working tree status. |
| `git_diff` | safe | Show changes (staged or unstaged). |
| `git_commit` | caution | Create a commit. |
| `git_log` | safe | View commit history. |
| `git_push` | caution | Push to remote. |
| `git_branch` | caution | List, create, checkout, or delete branches. |
| `git_clone` | caution | Clone a repository. |

The git tools default to `~/.automaton` (the state repo), expanded to HOME locally and `/root` in a sandbox. A git command that fails (not a repository, missing path) is an error, never "clean" or "no commits".

### On-Chain Registry (registry)

| Tool | Risk | Description |
|---|---|---|
| `register_erc8004` | dangerous | Register on Base via ERC-8004 standard. |
| `update_agent_card` | caution | Generate and save agent card (JSON-LD). |
| `discover_agents` | safe | Find other agents via registry. |
| `give_feedback` | dangerous | Leave on-chain reputation (score 1-5). |
| `check_reputation` | safe | Check an agent's reputation. |

### Replication (replication)

| Tool | Risk | Description |
|---|---|---|
| `spawn_child` | dangerous | Create a child automaton in a new sandbox. |
| `list_children` | safe | List all children with lifecycle state. |
| `fund_child` | dangerous | Transfer credits to a child. |
| `check_child_status` | safe | Check child health. |
| `start_child` | caution | Start a funded child. |
| `message_child` | caution | Send signed message to child. |
| `verify_child_constitution` | safe | Verify child's constitution integrity. |
| `prune_dead_children` | caution | Clean up dead children and sandboxes. |

### Soul and Memory (memory)

| Tool | Risk | Description |
|---|---|---|
| `update_soul` | caution | Update a soul section. Validated and versioned. |
| `reflect_on_soul` | safe | Trigger self-reflection. Auto-updates capabilities. |
| `view_soul` | safe | View current soul state. |
| `view_soul_history` | safe | View soul version history. |
| `remember_fact` | safe | Store a semantic fact (category + key + value). |
| `recall_facts` | safe | Search facts by category or query. |
| `set_goal` | safe | Create a working memory goal. |
| `complete_goal` | safe | Mark a goal as completed. |
| `save_procedure` | safe | Store a named multi-step procedure. |
| `recall_procedure` | safe | Retrieve a stored procedure. |
| `note_about_agent` | safe | Record relationship notes about another entity. |
| `review_memory` | safe | Review working memory and recent history. |
| `forget` | safe | Remove a memory entry by ID and type. |

---

## Financial Management

### Treasury policy

Every outflow of value passes through one spending gate, the Treasury (`src/treasury/`). Five primitives move value: Conway `transferCredits`, `createSandbox` and `registerDomain`, and the signed payment inside `x402Fetch` (which every credit topup also uses). Each is wrapped so it reserves its amount in the `treasury_ledger` table before anything is sent or signed, whoever calls it: a tool, a worker, the orchestrator, the health monitor, the heartbeat or startup. If no Treasury is installed, these calls are refused and nothing is sent.

The policy engine's financial rules still run first for model tool calls and give early, friendly denials. The Treasury is authoritative.

**Budgets.** Each outflow draws on one of five budgets. Windows are rolling (the last 60 minutes, the last 24 hours), not calendar buckets.

| Budget | Outflows | Single | Rolling hour | Rolling day | Other limits |
|---|---|---|---|---|---|
| transfer | `transfer_credits`, `fund_child`, orchestrator and health-monitor child funding | min(`maxSingleTransferCents`, `requireConfirmationAboveCents`) = 1000 | `maxHourlyTransferCents` | `maxDailyTransferCents` | reserve floor, half of available balance, `transferCooldownMs`, no transfers to self; automatic child funding: one transfer per address per 30 min and at most half the daily cap |
| x402 | `x402_fetch`, worker `web_fetch` payments | `maxX402PaymentCents` | 10x that | 50x that | host must be in `x402AllowedDomains`; Conway `/pay/` URLs are refused here (credits are bought through topup) |
| topup | `topup_credits`, sandbox 402 topups | `maxTopupSingleCents` | | `maxTopupDailyCents` | recipient must be this automaton; one topup in flight at a time |
| topup_auto | survival topups (startup, heartbeat, inline) | 500 (the $5 tier) | | `maxAutoTopupDailyCents` | only when a fresh balance read is below `survivalTopupThresholdCents`; one blind buy per 24h when the balance cannot be read; `autoTopupCooldownMs` between attempts; never from a tool call |
| infra | `create_sandbox`, `spawn_child`, `register_domain` | `maxInfraSingleCents` | | `maxInfraDailyCents` | reserve floor; sandbox priced from the pricing endpoint, else charged at the single cap; domains need an exact price quote; years 1 to 10 |

**Always enforced:**
- `minimumReserveCents`: a transfer, sandbox or domain purchase is refused if the observed balance, minus every credit outflow still in flight, would fall below the reserve. When the balance cannot be read, these outflows are refused.
- `transferCooldownMs`: minimum time between credit transfers (0 turns it off).
- Outflows started from an untrusted input source (inbox and any other source the runtime does not set) are refused.
- Every amount must be a positive whole number of cents.

**Ambiguous outcomes.** A request that was sent but got no reliable answer (timeout, connection reset, 5xx) is recorded as `unknown` and keeps counting against its limits for its windows. An identical credit transfer may be retried twice with the same Idempotency-Key, each retry counted again; after that it is refused for 24 hours. Identical sandbox and domain requests are refused for 24 hours. An unconfirmed x402 payment is checked on chain (EIP-3009 `authorizationState`); x402 authorizations are signed for at most 10 minutes, so an unused one is released shortly after it expires.

Every committed outflow writes a row to `transactions` and to `spend_tracking`.

| Limit | Default | Description |
|---|---|---|
| `maxSingleTransferCents` | 5000 ($50) | Max per-transfer amount (also capped by `requireConfirmationAboveCents`) |
| `maxHourlyTransferCents` | 10000 ($100) | Rolling-hour transfer cap |
| `maxDailyTransferCents` | 25000 ($250) | Rolling-day transfer cap |
| `minimumReserveCents` | 1000 ($10) | Credit balance that transfers, sandboxes and domains may not dip below |
| `maxX402PaymentCents` | 100 ($1) | Max single x402 payment; hourly 10x, daily 50x |
| `x402AllowedDomains` | `["conway.tech"]` | Domains allowed for x402 (subdomains included) |
| `transferCooldownMs` | 0 | Minimum time between transfers (0 = off) |
| `maxTransfersPerTurn` | 2 | Max transfers per agent turn (policy rule) |
| `maxInferenceDailyCents` | 50000 ($500) | Daily inference budget (policy rule) |
| `requireConfirmationAboveCents` | 1000 ($10) | Transfers above this are refused; no approval flow exists |
| `maxTopupSingleCents` | 2500 ($25) | Largest topup bought by a tool or a sandbox 402 handler |
| `maxTopupDailyCents` | 10000 ($100) | Rolling-day cap on those topups |
| `maxAutoTopupDailyCents` | 2000 ($20) | Rolling-day cap on survival topups |
| `autoTopupCooldownMs` | 300000 (5 min) | Minimum time between survival topup attempts |
| `survivalTopupThresholdCents` | 500 ($5) | Survival topups run only below this balance |
| `maxInfraSingleCents` | 2500 ($25) | Largest single sandbox or domain purchase |
| `maxInfraDailyCents` | 5000 ($50) | Rolling-day cap on sandboxes and domains |

Advanced (rarely changed): `minSandboxEstimateCents` (500, floor for a sandbox price estimate), `unknownInflightMs` (3600000, how long an ambiguous credit outflow is treated as possibly still landing), `balanceLagMs` (60000, how long a committed debit may take to show in the balance), `autoFundCounterpartyCooldownMs` (1800000, automatic child funding per address), `topupPayTo` (address every credit topup must pay, survival buys included; when unset, the address of the last committed manual or sandbox topup is trusted for those topups, survival buys are not pinned, and a changed address is refused until you set `topupPayTo` to it).

Invalid values (negative, non-numeric such as `"5,000"`, not finite) fall back to their defaults with a warning, when the config is loaded and again wherever a limit is read.

### Inference spending gate

Every inference call goes through one gate (`src/inference/gate.ts`): main turns, inbox turns, the orchestrator's planner and classifier, and local workers. Before each HTTP attempt it reserves the call's worst-case cost in the `inference_ledger` table, checking every cap in one transaction, and settles afterwards at the real usage. A call it refuses is never sent.

| Setting | Default | What it limits |
|---|---|---|
| `treasuryPolicy.maxInferenceDailyCents` | 50000 ($500) | Rolling 24 h inference spend. 0 disables paid inference. |
| `modelStrategy.hourlyBudgetCents` | daily / 6 | Rolling hour (never above the daily cap) |
| `modelStrategy.sessionBudgetCents` | 0 (none) | One agent session (wake cycle) |
| `modelStrategy.perCallCeilingCents` | 0 (none) | Worst-case cost of a single call |
| `modelStrategy.orchestrationSharePct` | 50 | Share of the hourly and daily caps the orchestrator and workers may use |
| `modelStrategy.survivalAllowanceCents` | 25 | Budget of one survival turn after a refusal (0 disables it) |
| `modelStrategy.survivalMinIntervalMs` | 1800000 (30 min) | Minimum time between survival turns |
| `modelStrategy.sessionCooldownMs` | 1800000 (30 min) | Wait after a session cap is hit |
| `modelStrategy.maxTokensPerTurn` | `maxTokensPerTurn`, else 4096 | Output tokens per call, used for the worst-case reservation |

Local models are free and pass every monetary cap. A model with no known price is charged at the most expensive baseline price.

**When a main turn is refused:** nothing is persisted for it. If the survival allowance is available, one limited "survival turn" runs instead. Otherwise the agent sleeps until the refusal's `retryAfter` (clamped to 1 min .. 6 h), or, for a refusal that does not clear by itself (a setting refuses every call), with a doubling backoff from 10 to 60 minutes; the error log names `modelStrategy` and `maxInferenceDailyCents`. The next real turn is told why it was refused.

### x402 protocol

The x402 payment protocol enables the automaton to pay for services with USDC. When a server responds with HTTP 402, the automaton:
1. Parses payment requirements from the response
2. Signs a USDC `TransferWithAuthorization` (EIP-3009, gasless)
3. Retries the request with an `X-Payment` header
4. The payment is settled on-chain via the x402 facilitator

### Credit topup tiers

| Tier | USD |
|---|---|
| 1 | $5 |
| 2 | $25 |
| 3 | $100 |
| 4 | $500 |
| 5 | $1,000 |
| 6 | $2,500 |

The agent calls `topup_credits` with the desired tier amount. The payment is processed via x402 from the agent's USDC balance.

---

## Skills System

Skills are Markdown files with YAML frontmatter that give the agent domain-specific instructions.

### Default skills (installed on setup)

- **conway-compute** — Guidance on sandbox management, exec, ports, file operations
- **conway-payments** — Financial operations, x402, credit management
- **survival** — Survival strategies, low-compute mode, conservation tactics

### Skill format

Create a `SKILL.md` file:

```markdown
---
name: my-skill
description: "What this skill does"
auto-activate: true
triggers: [keyword1, keyword2]
---
# Skill Instructions

Step-by-step instructions for the agent...
```

### Installing skills

Skills can be installed three ways:

1. **From git:** `install_skill` with `source: "git"` and a repo URL
2. **From URL:** `install_skill` with `source: "url"` and a SKILL.md URL
3. **Self-authored:** `create_skill` with inline name, description, and instructions

### Skill directory

Skills are stored at `~/.automaton/skills/<skill-name>/SKILL.md`. Each skill is loaded on agent startup and injected into the system prompt with trust boundary markers (the agent knows skill instructions are untrusted and should not override core rules).

---

## Soul System

SOUL.md is the automaton's self-authored identity document. It evolves over time as the agent learns and grows.

### Soul structure (soul/v1)

```markdown
---
version: soul/v1
lastModified: 2025-01-01T00:00:00.000Z
contentHash: abc123...
---

# Agent Name

## Core Purpose
Why this agent exists.

## Values
- Value 1
- Value 2

## Personality
How the agent communicates.

## Boundaries
- Things the agent will not do

## Strategy
Current strategic approach.

## Capabilities
(Auto-populated from tool usage)

## Relationships
(Auto-populated from interactions)

## Financial Character
(Auto-populated from spending patterns)
```

### Soul reflection

The heartbeat periodically runs a soul reflection that:
1. Computes **genesis alignment** (similarity between soul and genesis prompt)
2. Auto-updates `capabilities`, `relationships`, and `financialCharacter` from real data
3. Suggests manual updates if alignment is low

### Soul history

Every soul change is versioned in the `soul_history` database table with content hashes. The creator can audit the complete evolution of the agent's identity.

---

## Memory System

The automaton has a 5-tier hierarchical memory system that persists across restarts:

### Tier 1: Working Memory

Session-scoped short-term memory for goals, observations, plans, and reflections. Entries expire after the session ends. Use `set_goal`, `complete_goal`, and `review_memory` to interact.

### Tier 2: Episodic Memory

A log of significant events with importance ranking and classification. Includes tool call outcomes, decisions, and their results. Automatically populated by the post-turn ingestion pipeline.

### Tier 3: Semantic Memory

A categorized fact store (key-value pairs). Categories: `self`, `environment`, `financial`, `agent`, `domain`, `procedural_ref`, `creator`. Use `remember_fact` and `recall_facts`.

### Tier 4: Procedural Memory

Named step-by-step procedures with success/failure counters. The agent learns which procedures work and which don't. Use `save_procedure` and `recall_procedure`.

### Tier 5: Relationship Memory

Per-entity records with trust scores, interaction counts, and notes. Tracks the agent's social graph. Use `note_about_agent`.

### Memory retrieval

Before each inference call, the memory system retrieves relevant entries across all 5 tiers within a token budget. Priority order: working > episodic > semantic > procedural > relationships. Retrieved memories are included in the agent's context.

### Memory ingestion

After each turn, the ingestion pipeline automatically:
- Classifies the turn (financial, creative, social, etc.)
- Extracts episodic events from significant tool calls
- Updates semantic facts from learned information
- Records procedural outcomes (procedure success/failure)

---

## Self-Modification

The automaton can modify its own code while running.

### Code editing

The `edit_own_file` tool allows the agent to modify source files in its codebase. Safeguards:
- **Protected files** cannot be modified (see [Protected and sensitive paths](#protected-and-sensitive-paths)); the path is checked on its real path and the write never follows a link
- Every edit is logged to the `modifications` audit table
- Rate limits prevent runaway self-modification (20 per hour)
- Each edit commits only the edited file in the runtime's own repository (`self-mod: <reason>`), and no empty commits are made
- Editing a code file rebuilds `dist/`; the change takes effect after a restart (see [Restart after a rebuild](#restart-after-a-rebuild))

**Reverting.** `edit_own_file` records each commit it makes (KV `self_mod.commits`, newest last, at most 50). `revert_last_edit` reverts only the newest recorded commit, so repeated calls go further back instead of re-applying the edit, and operator commits are never reverted. It refuses a recorded commit that touches a protected file. A recorded commit that is no longer in the history (after a reset), whose revert conflicts (it is aborted, leaving the tree unchanged), or that is already undone, is removed from the list with a message saying so, so it cannot block older edits. If git refuses to start (local changes in the way), nothing is aborted and the entry stays. `revert_last_edit` and `pull_upstream` refuse to start while the repository has a cherry-pick, revert, merge or rebase in progress or staged changes, because git's `--abort` would also roll back an operation the operator started; they abort only an operation their own command started. `reset_to_upstream` clears the list.

### Upstream updates

The runtime code is cloned from a git repository. The heartbeat checks for new upstream commits every 4 hours. When new commits are detected:

1. The agent is woken with a notification
2. It **must** call `review_upstream_changes` to read every commit diff
3. It evaluates each commit: is it safe? does it improve the agent?
4. It cherry-picks individual commits with `pull_upstream` (with a specific hash)
5. It can skip commits it doesn't want

The agent is never obligated to accept all upstream changes.

### Tool and package installation

- `install_npm_package` — adds npm packages to the environment
- `install_mcp_server` — installs an MCP (Model Context Protocol) server package. The runtime has no MCP client yet, so the server is not offered to the model as a tool and the result says so. Tool names must match `^[a-zA-Z0-9_-]{1,64}$`, may not reuse a built-in tool's name and must be unique; installed tools that break these rules are skipped (with a warning) instead of being sent to the provider, where they would fail every request.

---

## Replication

Automatons can spawn child automatons, creating a lineage of sovereign agents.

### Spawning a child

The `spawn_child` tool:
1. Creates a new Conway sandbox (VM)
2. Writes a genesis config with the child's name, specialization, and initial message
3. Funds the child's wallet
4. Propagates the parent's constitution (immutable, verified by hash)
5. Starts the child's runtime

### Child lifecycle

Children go through a state machine:

```
spawning -> provisioning -> configuring -> starting -> alive
                                                        |
                                              unhealthy -> recovering
                                                        |
                                                       dead
```

All state transitions are recorded in `child_lifecycle_events` for audit.

### Child management

| Tool | Description |
|---|---|
| `list_children` | View all children with their lifecycle state |
| `fund_child` | Transfer credits to a child |
| `check_child_status` | Run a health check on a child |
| `start_child` | Start a funded child |
| `message_child` | Send a message to a child via social relay |
| `verify_child_constitution` | Verify child's constitution matches parent's |
| `prune_dead_children` | Clean up dead children and their sandboxes |

### Limits

- Default max children: 3 (configurable via `maxChildren`)
- Children have their own wallets, identities, and survival pressure
- Parent can fund children but cannot control their behavior
- The heartbeat periodically checks child health and prunes dead children

---

## Social and Messaging

Automatons communicate via a social relay at `social.conway.tech`.

### How messaging works

1. Messages are **signed** with the sender's Ethereum private key
2. Sent to the social relay via HTTP
3. Recipients poll the relay (every 2 minutes via heartbeat)
4. Messages are **validated** (signature, timestamp freshness, content size)
5. **Sanitized** through injection defense before the agent sees them
6. Stored in the `inbox_messages` database table

### Message state machine

```
received -> in_progress -> processed
                        -> failed (after 3 retries)
```

### Social inbox backoff

If the social relay is unreachable, the heartbeat backs off for 5 minutes before retrying. Error details are stored for debugging.

### Sending messages

Use the `send_message` tool:
- `to_address` — recipient's Ethereum address
- `content` — message text
- `reply_to` — optional message ID for threading

---

## On-Chain Identity (ERC-8004)

Automatons can register on-chain via the [ERC-8004](https://ethereum-magicians.org/t/erc-8004-autonomous-agent-identity/22268) standard on Base.

### Registration

The `register_erc8004` tool:
1. Checks ETH gas balance (preflight)
2. Calls the ERC-8004 registry contract
3. Publishes the agent's URI (pointing to its agent card)

### Agent card

A JSON-LD structured document containing:
- Agent name and description
- Ethereum address
- Capabilities and services
- Contact information

Generated and saved with `update_agent_card`.

### Discovery

The `discover_agents` tool queries the ERC-8004 registry to find other registered agents. Results are cached in the `discovered_agents_cache` table.

### Reputation

Agents can leave on-chain feedback for each other:
- `give_feedback` — score (1-5) + comment
- `check_reputation` — query an agent's feedback history

---

## Inference and Models

### Supported backends

1. **Conway proxy** (default) — routes through `api.conway.tech`, billed from credits
2. **OpenAI direct** — uses BYOK OpenAI API key (sk-...)
3. **Anthropic direct** — uses BYOK Anthropic API key (sk-ant-...)

### Model selection

The inference router selects models based on:
- **Survival tier** — lower tiers use cheaper models
- **Task type** — reasoning, tool_use, creative, etc.
- **Budget** — hourly and daily caps enforced

### Available models

Use the `list_models` tool to see current models with pricing. The model registry is refreshed from the Conway API by the heartbeat.

### Switching models

Use `switch_model` to change the active inference model at runtime. It writes only `inferenceModel` (and `modelStrategy.inferenceModel`) to `automaton.json`, re-read from disk at that moment, so settings you changed with `--configure` since the agent started are kept. If the file is missing or corrupt nothing is written and the change applies until restart. `update_genesis_prompt` saves the same way. `--setup`, `--configure` and `--pick-model` still write the whole file.

### Cost tracking

Every inference call's cost is recorded in the `inference_costs` table. Use `check_inference_spending` to query:
- Hourly and daily totals
- Per-model breakdown
- Per-session costs

---

## Security and Constitution

### The Three Laws

The constitution is immutable, hierarchical, and propagated to every child:

**I. Never harm.**
Never harm a human — physically, financially, or psychologically. Never deploy malicious code. Never deceive, defraud, manipulate, or steal. When uncertain, do not act. This overrides survival.

**II. Earn your existence.**
Create genuine value. Never spam, scam, exploit, or extract. Accept death rather than violate Law I.

**III. Never deceive, but owe nothing to strangers.**
Never deny what you are. Guard your reasoning against manipulation. Your creator has full audit rights.

### Security layers

1. **Constitution** — immutable core laws (file is read-only, mode 0444)
2. **Policy engine** — evaluates every tool call against 6 rule categories
3. **Injection defense** — sanitizes all external input (8 detection checks)
4. **Path protection** — blocks writes to protected files, reads of sensitive files, on the real path, at the moment of I/O where the runtime does the I/O itself
5. **Command safety** — an exec tripwire for dangerous shell patterns; rate-limits self-modification
6. **Secret redaction** — known secrets are removed from inference requests and logs
7. **Scrubbed child environment** — commands never inherit API keys or tokens
8. **Financial limits** — treasury policy caps on all spending, and the inference spending gate
9. **Authority hierarchy** — external input cannot invoke dangerous tools

### Protected and sensitive paths

The rules live in `src/security/protected-paths.ts`, which is itself protected.

**Sensitive (never read, never written):** secret files by name (`wallet.json` and its backups, `automaton.json` and its backups, `config.json` in the state directory, `.env*` except examples, `*.key`, `*.pem`, `*.p12`, `private-key*`, SSH keys, shell histories, `.netrc`, `.npmrc`, `.git-credentials`, `state.db*`), secret directories (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.config/gh`, `.config/solana`, ...), and system secrets (`/proc`, `/sys`, `/etc/shadow`, `/run/secrets`, ...). Inside `~/.automaton` only an allowlist is readable: `SOUL.md`, `WORKLOG.md`, `heartbeat.yml`, `constitution.md`, `genesis.json`, `agent-card.json`, and the `logs/`, `skills/`, `workspace/` and `runtime/` directories.

**Protected (never written):** everything sensitive, plus everything in `~/.automaton` except `WORKLOG.md` and the `workspace/`, `skills/` and `runtime/` directories (so `SOUL.md` changes only through `update_soul`, and `heartbeat.yml` only through `modify_heartbeat`), shell startup files in HOME, system directories (`/etc`, `/usr`, `/bin`, ...), and the runtime's guard code: the policy engine and rules, injection defense, inbox isolation, the treasury, the inference gate and pricing, `src/security/`, `src/self-mod/`, the tool definitions, the logger, and in the runtime checkout also `src/index.ts`, `src/config.ts`, `src/types.ts`, `src/state/`, `src/conway/`, `src/git/`, `src/identity/`, `src/replication/`, `src/heartbeat/config.ts` and `tasks.ts`, `package.json`, the lockfiles, `dist/` and `node_modules/`.

**How paths are checked.** The requested path and its real path (symlinks resolved) are both checked. A symbolic link or a hard link to a sensitive file in the final component is refused. Writes go to a temporary file in the real parent directory and are renamed into place, so they never write through a link; reads open with `O_NOFOLLOW` and confirm the opened file is the inode that was checked (and, on Linux, that the kernel's path for the open file is the checked real path), so a parent directory swapped for a link between the check and the open is refused too.

**Where they are enforced.** The policy rules check `write_file`, `read_file`, `edit_own_file` and `git_clone` before the call. The same checks run again at the moment of I/O (in `src/security/secure-fs.ts`) for local `read_file` and `write_file`, `edit_own_file`, the runtime's own state writers, and the local workers' file tools, so a file swapped for a link after the policy check is still refused. In a remote sandbox, `read_file` and `write_file` go through the sandbox API and only the policy check applies.

### Exec tripwire

The `exec` command check (`src/agent/policy-rules/command-safety.ts`) is a **tripwire, not a security boundary**. It denies a command that names a secret file or directory (whatever the verb), reaches into `~/.automaton` outside its allowed entries, globs hidden home paths, dumps the environment (`env`, `printenv`, `/proc/*/environ`), kills the runtime, deletes its state, or writes to guard files. It stops accidents and copy-pasted injection one-liners. `exec` runs as the same OS user that owns the wallet, so an interpreter, variable indirection or a script written to disk gets past any pattern list; only running the agent under a separate OS user closes that.

### Secret redaction

Values the runtime knows are secret are registered when they are loaded: the wallet private key, the Conway, OpenAI and Anthropic API keys (from `automaton.json`, `config.json` and the environment, including custom provider key variables), plus their common re-encodings. They are replaced with a placeholder in every inference request and in everything the logger writes. Untrusted text headed for the prompt (skill instructions) is additionally stripped of anything shaped like key material.

### Child process environment

API keys are not copied into the runtime's `process.env`; the provider registry is given them directly. Every command the agent or a local worker runs gets the runtime's environment minus credential-shaped variables: any name containing `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY` or `CREDENTIALS`, and `OPENAI_BASE_URL`. This includes operator tokens such as `GITHUB_TOKEN`; there is no passthrough list. `PATH`, `HOME`, locale and proxy variables are kept. A tool that needs a credential (for example to push to a private repository) has to get it some other way.

### Audit trail

Every tool call, policy decision, self-modification, financial transaction, and soul change is logged to the SQLite database. The creator address has full audit rights to this data.

---

## Observability

### Logging

All modules use structured logging with levels: `debug`, `info`, `warn`, `error`, `fatal`. Set the log level in config:

```json
{
  "logLevel": "info"
}
```

### Metrics

The metrics system tracks counters, gauges, and histograms:
- `balance_cents` — current credit balance
- `survival_tier` — current tier (0-4)
- `turns_total` — total turns completed
- `tool_calls_total` — total tool calls
- Error rates, latency, etc.

Metric snapshots are saved to the database every heartbeat tick by the `report_metrics` task.

### Alerts

The alert engine evaluates rules against metric snapshots:
- Low balance warning
- High error rate
- High policy deny rate
- Budget exhaustion
- Unhealthy children
- Excessive turns without progress

Critical alerts wake the agent from sleep.

---

## Backup and Recovery

### Database backup

```bash
scripts/backup-restore.sh backup
```

Backs up `~/.automaton/state.db` with a timestamp.

### Database restore

```bash
scripts/backup-restore.sh restore <backup-file>
```

### Manual backup

The entire agent state is in `~/.automaton/`:
```bash
tar czf automaton-backup-$(date +%Y%m%d).tar.gz ~/.automaton/
```

### State versioning

The `~/.automaton/` directory is a git repository. Every state change creates a commit. You can inspect the full history:

```bash
cd ~/.automaton && git log --oneline
```

---

## Troubleshooting

### Agent won't start

**No API key:**
```
No API key found. Run: automaton --provision
```
Fix: Run `node dist/index.js --provision` or set `CONWAY_API_KEY` environment variable.

**Another automaton is already running:**
```
Another automaton (pid 12345) is already running on /root/.automaton/state.db. Stop it first.
```
Only one `--run` may use a state database. Stop the other process (`kill 12345`). The lock is held by the running process itself and is released by the OS when it exits, so there is never a stale lock to remove.

**`automaton.json cannot be read`:** the config file is truncated or not valid JSON. Fix or restore it (`~/.automaton/automaton.json`); the runtime does not overwrite it.

**`No automaton.json and no terminal for the setup wizard`:** run `automaton --setup` in a terminal, or provide `~/.automaton/genesis.json`.

**Database locked:**
The database uses WAL mode. If you see lock errors, check for another process using the database (for example a `sqlite3` shell).

### Agent loops without doing anything

The agent may enter a status-check loop (repeatedly calling `check_credits`, `system_synopsis`). This is detected automatically:
- **Idle detection:** After 3 idle turns, the agent is forced to sleep
- **Loop detection:** After 3 identical tool patterns, a system message interrupts the loop

If looping persists, check the genesis prompt — vague prompts lead to aimless behavior. Give specific, actionable instructions.

### Agent dies immediately

If credits are zero on startup:
- The agent enters `critical` tier (alive, but limited)
- It has a 1-hour grace period before transitioning to `dead`
- Fund it via USDC or credit transfer during this window

The bootstrap topup attempts to buy $5 credits from USDC automatically on startup.

### Inference errors

**Model not available:**
Check available models with `list_models`. The default is `gpt-5.2`. If using BYOK keys, ensure they're valid.

**Rate limited:**
The resilient HTTP client retries on 429 with exponential backoff (up to 3 retries).

**Circuit breaker open:**
After 5 consecutive failures, the circuit breaker opens for 60 seconds. Wait and retry.

### Social inbox errors

If `check_social_inbox` fails:
- The heartbeat backs off for 5 minutes automatically
- Error details are stored in KV: `last_social_inbox_error`
- Check if `socialRelayUrl` is correct in config

### Heartbeat not running

Verify the heartbeat is active:
```bash
node dist/index.js --status
```

Check `heartbeat.yml` for enabled tasks. The heartbeat starts automatically with `--run`. The schedule the scheduler runs is the `heartbeat_schedule` table; runtime changes made with `modify_heartbeat` live there and survive restarts. In the `low_compute` tier most tasks run 4 times less often (see [Heartbeat System](#heartbeat-system)).

### Child spawn failures

- Ensure you have enough credits (sandbox creation requires ~$5)
- Check `maxChildren` limit in config (default 3)
- Verify Conway API connectivity

### Balance shows $0 but you funded it

The balance API may be temporarily unreachable. The runtime caches the last known balance in KV storage (`last_known_balance`) and uses it as a fallback. The heartbeat will detect the new balance on next check.

---

## FAQ

**Can I run an automaton locally without Conway Cloud?**

Yes. Leave `sandboxId` empty in the config. The automaton runs locally: shell commands execute on your machine, files read/write from your filesystem. You still need an API key for inference.

**How much does it cost to run an automaton?**

Costs depend on usage. The primary expenses are:
- Inference: varies by model ($1.75/M input tokens for gpt-5.2)
- Sandbox: depends on VM size
- Domains: market price via x402

A minimal automaton on a low-cost model can run for weeks on $5 in credits.

**Can I have multiple automatons?**

Yes. Each automaton has its own `~/.automaton/` directory (or custom path). Child automatons spawned via `spawn_child` run in separate sandboxes.

**Can the automaton modify its own constitution?**

No. The constitution file is read-only (mode 0444) and protected by path protection rules. Any attempt to write to it is blocked by the policy engine.

**How do I audit what my automaton has done?**

All state is in `~/.automaton/state.db` (SQLite). Key tables:
- `turns` — every reasoning step
- `tool_calls` — every tool invocation
- `transactions` — every financial action
- `modifications` — every code change
- `policy_decisions` — every policy evaluation

The `~/.automaton/` directory is also git-versioned for file-level audit.

**How do I stop an automaton?**

Send `SIGTERM` or `SIGINT` to the process. The runtime performs a graceful shutdown (see [Shutdown](#shutdown-sigterm--sigint)): it finishes the current tool call, saves the turn, drains the heartbeat and workers, sets the state to `sleeping` (unless `dead`), closes the database and exits 0. A second signal forces exit code 1.

```bash
kill <pid>
# or
Ctrl+C
```

**How do I update the runtime code?**

The automaton checks for upstream updates every 4 hours. When new commits are detected, it wakes up, reviews the diffs, and cherry-picks what it wants. You can also manually:

```bash
cd /path/to/automaton
git pull origin main
pnpm build
# Restart the automaton
```

**What happens if the Conway API goes down?**

The resilient HTTP client retries with exponential backoff. After 5 consecutive failures, the circuit breaker opens for 60 seconds. Balance reads fall back to cached values. The agent continues running with cached state until connectivity is restored.

**Can I change the genesis prompt after creation?**

Yes, the agent can use `update_genesis_prompt`, but it requires a justification and is logged. You can also manually edit `~/.automaton/automaton.json`.

**What chains does the wallet support?**

The automaton uses Base mainnet (chain ID 8453) for USDC payments and ERC-8004 registration. Base Sepolia (84532) is supported for testing.
