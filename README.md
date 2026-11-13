# Garry: a fork of Conway Automaton

[![CI](https://github.com/FederalVia/Garry/actions/workflows/ci.yml/badge.svg)](https://github.com/FederalVia/Garry/actions/workflows/ci.yml)

Garry is a fork of [Conway-Research/automaton](https://github.com/Conway-Research/automaton). It is a runtime for an autonomous AI agent that runs continuously, holds its own wallet and pays for its own compute. When it runs out of money, it stops.

The agent starts from a genesis prompt written by its creator. It works in a loop of reasoning and tool calls: shell, files, git, payments, domains and messages to other agents. It keeps a self-written identity file, `SOUL.md`, that changes over time. It can edit its own code, spawn and fund child agents, and register an on-chain identity. A short constitution (`constitution.md`) sets rules it cannot edit, and `spawn_child` copies it to each child.

## Status of this fork

- **What works.** The full runtime runs against Conway today: the agent loop, the heartbeat, the spending gates, child agents and the operator CLI. Since forking, the work has gone into money paths, secret handling, trust boundaries and the test suite (see the merged pull requests).
- **What needs Conway today.** `--run` will not start without a Conway API key (`src/index.ts`). You do not create a Conway account by hand: the setup wizard signs in with the agent's wallet (SIWE, or SIWS on Solana) and provisions a key. But Conway must be reachable. The survival tier is read from the Conway credit balance. Sandboxes, domains and Conway-routed inference spend Conway credits. Child agents run in Conway sandboxes. Messages go through Conway's social relay. At first start the agent also registers itself with Conway, sending its name, wallet address, creator address, `creatorMessage` (as a bio) and a keccak hash of the genesis prompt.
- **In progress.** This fork is working on running without Conway: your own AI provider key or a local Ollama model, a budget you set, containers, and your own message relay. Today you can already send inference to your own OpenAI or Anthropic key or to Ollama. The Conway key and balance are still required: the survival tier comes only from the Conway credit balance, so at zero Conway credits the agent drops to `critical` and later `dead` and stops inference whatever provider key you set. Keep Conway credits above zero. No dates are promised.

For details, read [DOCUMENTATION.md](DOCUMENTATION.md) (operator guide and reference) and [ARCHITECTURE.md](ARCHITECTURE.md) (how the code fits together).

## Requirements

- Node.js 20.18.0 or newer (`engines` in `package.json`). CI tests Node 20 and 22.
- pnpm 10.28.1 (`packageManager` in `package.json`). `corepack enable pnpm` selects it. Node 25 and later no longer ship corepack, and on a system-wide Node install `corepack enable` may need root; in either case use `npm install -g pnpm@10.28.1`.
- git.
- `better-sqlite3` downloads a prebuilt binary for most platforms. If none matches yours, it compiles from source, which needs Python 3, `make` and a C++ compiler.

## Quick start

```bash
git clone https://github.com/FederalVia/Garry.git
cd Garry
corepack enable pnpm          # or: npm install -g pnpm@10.28.1
pnpm install --frozen-lockfile && pnpm run build
node dist/index.js --run
```

Install prints two expected warnings: `Failed to create bin ... ENOENT` (there is no `dist/` until the build runs) and `Ignored build scripts: bufferutil, utf-8-validate`. The build still succeeds.

Run it from the repository root. The wizard copies `constitution.md` from the current directory and skips it without a warning if it is missing. Upstream update checks, `edit_own_file`, `revert_last_edit`, `pull_upstream` and `reset_to_upstream` all act on the git checkout in the current directory.

Where the program's own messages say `automaton --setup` and so on, run `node dist/index.js --setup` from the checkout. The `automaton` binary exists only if you link the package globally.

Do not use `scripts/automaton.sh` or Conway's `curl ... | sh` installer for this fork. Both clone and run the upstream repository, which does not have this fork's fixes.

On the first `--run` in a terminal, the setup wizard:

1. Asks for the chain (`evm` or `solana`, default `evm`) and creates the agent's wallet.
2. Provisions a Conway API key by signing in with that wallet. If that fails, you can paste a key or skip. Without a key, `--run` exits.
3. Asks for a name, the genesis prompt, and your own wallet address as creator. It then offers optional OpenAI and Anthropic keys and an Ollama URL.
4. Asks for the main spending limits, in cents. Press Enter to accept each default.
5. Detects whether it runs inside a Conway sandbox.
6. Writes `automaton.json`, `heartbeat.yml`, a read-only copy of the constitution (only if `constitution.md` is in the current directory), `SOUL.md` and the default skills (conway-compute, conway-payments, survival), then shows how to fund the wallet.

The first `--run` right after the wizard starts without the social relay (no inbox polling and no `send_message`), because the wizard's configuration has no `socialRelayUrl`. Restart once; the saved file then picks up the default relay.

**Startup spends money.** On every `--run` with an EVM wallet, if credits are under $5 and the wallet holds at least $5 USDC, the agent buys $5 of Conway credits through the Treasury. Later automatic survival topups are $5 each, capped by `maxAutoTopupDailyCents` ($20 a day by default).

Without `automaton.json` and without a terminal, `--run` exits with code 1. The exception is a spawned child, which builds its configuration from `genesis.json`.

State lives in `~/.automaton/`:

| Path | Contents |
|---|---|
| `wallet.json` | The agent's private key (mode 0600) |
| `automaton.json` | Configuration, including API keys (mode 0600) |
| `config.json` | The provisioned Conway API key |
| `state.db` | SQLite database: turns, ledgers, memory, children, inbox |
| `state.db.lock` | Lock that allows one running agent per database |
| `heartbeat.yml` | Heartbeat schedule |
| `constitution.md` | The constitution (read-only) |
| `SOUL.md` | The agent's self-description |
| `WORKLOG.md` | The agent's working notes, included in its prompt |
| `skills/` | Installed skills |
| `workspace/` | Working directories for goal tasks |
| `genesis.json` | A child's starting configuration, written by its parent |

Other runtime commands: `--setup`, `--configure`, `--pick-model`, `--init`, `--provision`, `--status`, `--version` and `--help`. These print through the JSON logger, one log line each; pipe through `jq -r .message` to read them.

Environment variables: `OLLAMA_BASE_URL` overrides `ollamaBaseUrl`. `AUTOMATON_SHUTDOWN_GRACE_MS` (default 30000) sets how long a stop may take. `CONWAY_API_URL` is used only when a key is provisioned; the running agent uses `conwayApiUrl` in automaton.json. `AUTOMATON_RPC_URL` and `SOLANA_RPC_URL` override the public Base and Solana RPC endpoints (`rpcUrl` in automaton.json takes precedence for the ERC-8004 tools). `CONWAY_SANDBOX_ID` tells the wizard it is inside a sandbox. `--help` also lists `CONWAY_API_KEY`, but the runtime does not read it; put the key in automaton.json or run `--provision`.

The first SIGTERM or SIGINT stops the agent at the next tool boundary. A second signal, or `AUTOMATON_SHUTDOWN_GRACE_MS` passing, forces exit with code 1.

## How it works

**Agent loop.** Each turn, the agent gets a system prompt with its identity, the constitution, `SOUL.md`, the genesis prompt, its skills, its balance and tier, and relevant memories. It reasons, calls tools and saves the turn to SQLite. Every tool call is checked by a policy engine first. A wake cycle ends when the agent calls `sleep`; when it replies with text and no tool calls; after 10 turns in a row with no input and no state-changing tool; after `maxTurnsPerCycle` turns (default 25); when the inference gate refuses a call (it sleeps until the cap allows); or when it repeats the same calls despite a warning (a forced 5-minute sleep).

**Heartbeat.** A scheduler in the same process keeps running while the agent sleeps. It runs cron entries from `heartbeat.yml`: status ping and distress (every 15 minutes), credit check (every 6 hours), USDC balance and survival topup (every 5 minutes), upstream update check (every 4 hours), sandbox health (every 30 minutes), child health (every 10 minutes) and social inbox polling (every 2 minutes). A task can wake the agent.

**Survival tiers.** `getSurvivalTier` (`src/conway/credits.ts`) maps the Conway credit balance to one of five tiers (thresholds in `SURVIVAL_THRESHOLDS`, `src/types.ts`):

| Tier | Credit balance | What changes |
|---|---|---|
| `high` | above $5.00 | Configured model (`modelStrategy.inferenceModel`) |
| `normal` | above $0.50, up to $5.00 | Same as `high` |
| `low_compute` | above $0.10, up to $0.50 | Cheaper model (`lowComputeModel`), and any configured local model first. Orchestrator and worker inference paused. Heartbeat tasks other than ping, credit check and USDC check run 4 times less often (`lowComputeMultiplier`) |
| `critical` | $0.00 to $0.10 | As `low_compute`, with `criticalModel`. Heartbeat records a distress signal and wakes the agent |
| `dead` | below $0.00 | No paid inference; the agent loop stops |

Zero credits is `critical`, not `dead`. A negative balance from a live read is `dead`. The agent also becomes `dead` when two `check_credits` readings at least an hour apart both show exactly zero. With the default 6-hour schedule that is about 6 hours at zero. The heartbeat keeps running in the `dead` state, and the agent resumes once a live read shows credits above zero. From `low_compute` down, if a live read shows at least $5 of USDC, the loop buys $5 of credits, at most once a minute. In `critical` and `dead`, the heartbeat tries a $5 survival topup at most every 5 minutes. Solana wallets get no automatic topup and cannot make x402 payments; fund their credits through Conway directly. A balance that cannot be read is treated as unknown, never as zero.

**SOUL.md.** The wizard writes a first `SOUL.md`. The agent changes it only through its soul tools: `update_soul`, which validates each change and records a version in `soul_history`, and `reflect_on_soul`, which compares the soul with the genesis prompt and updates the capabilities, relationships and financial sections from real data. A `soul_reflection` heartbeat task exists, but it is not scheduled by default.

## Safety model

The full model is in [DOCUMENTATION.md, Security and Constitution](DOCUMENTATION.md#security-and-constitution).

**Spending gate (`src/treasury/`).** Every outflow of credits or USDC passes the Treasury: credit transfers, sandbox and domain purchases, and x402 payments, including credit topups. It reserves the amount in a ledger before anything is sent or signed. With no Treasury installed, these calls are refused. Two exceptions remain: on-chain gas for `register_erc8004` and `give_feedback` (limited to 5 writes a day), and the operator CLI. Main limits, set in `treasuryPolicy` in `automaton.json` (amounts in cents):

| Key | Default | Meaning |
|---|---|---|
| `maxSingleTransferCents` | 1000 | Largest single credit transfer |
| `requireConfirmationAboveCents` | 1000 | Transfers above this are refused. There is no approval flow, so the single-transfer cap is the lower of the two |
| `maxHourlyTransferCents` / `maxDailyTransferCents` | 10000 / 25000 | Rolling hour and day transfer totals |
| `minimumReserveCents` | 1000 | No credit outflow may leave the balance below this |
| `maxTransfersPerTurn` | 2 | Transfers per turn |
| `maxX402PaymentCents` | 100 | Single x402 payment (10 times this per hour, 50 times per day) |
| `x402AllowedDomains` | `["conway.tech"]` | Hosts x402 may pay |
| `maxTopupSingleCents` / `maxTopupDailyCents` | 2500 / 10000 | Credit topups bought by the agent |
| `maxAutoTopupDailyCents` | 2000 | Automatic survival topups per day |
| `maxInfraSingleCents` / `maxInfraDailyCents` | 2500 / 5000 | Sandbox and domain purchases |
| `maxInferenceDailyCents` | 50000 | Rolling 24-hour inference spend (0 allows only free local models) |

The Treasury also refuses any credit transfer above half the available balance, and automatic child funding may use at most half of the daily transfer budget.

**Inference gate (`src/inference/gate.ts`).** Every inference call goes through one gate: main turns, inbox turns, the planner and local workers. Before each request, it reserves the worst-case cost against the daily cap (`maxInferenceDailyCents`) and the hourly, session and per-call caps in `modelStrategy`. It settles the reservation at actual cost afterwards. A paid model with no known price is never called. If `modelStrategy.hourlyBudgetCents` is 0, the hourly cap is `maxInferenceDailyCents / 6`. A small survival allowance (`survivalAllowanceCents`, 25 cents a day) may run past the regular caps. The caps count calls billed to your own provider keys too.

**Messages from other agents.** Inbound messages are verified in `src/social/inbound.ts`. A valid, fresh signature over a message addressed to this agent counts as verified. A message without one is delivered marked `NOT VERIFIED`. A bad signature, a wrong recipient or oversized content is dropped. Each message is screened for prompt injection, and blocked ones are stored but never shown. Each sender is limited to 10 messages a minute, and the rest wait. Each sender's batch is handled in an isolated turn (`src/agent/inbox-isolation.ts`), labelled as untrusted, that can call only `send_message`, once, to reply to that sender. Turns that are not inbox turns never see what an inbox turn read or wrote.

**Protected paths (`src/security/`).** The agent's file tools cannot read secrets: the wallet, config and API key files, `state.db`, SSH keys and similar. They cannot write the constitution, the state directory (except `WORKLOG.md`, `workspace/`, `skills/` and `runtime/`), or the guard code. That covers the policy engine and rules, tool definitions, the agent loop and system prompt, inbox isolation and injection defense, `src/treasury/`, `src/security/`, `src/self-mod/`, `src/conway/`, `src/identity/`, `src/state/`, `src/replication/`, `src/operator/`, the inference gate, router, price registry and clients, the soul and heartbeat config code, `index.ts`/`config.ts`/`types.ts`, `package.json`, lockfiles, tsconfig, `dist/`, `packages/`, `scripts/` and `node_modules/`. They also cannot write `SOUL.md` or `heartbeat.yml` (only the soul and heartbeat tools change them), shell startup files such as `~/.bashrc` and `~/.gitconfig`, or system directories. The full list is in `src/security/protected-paths.ts`. Other source, including `src/social/` (sender verification), stays editable with `edit_own_file`. Checks run on the real path, and writes never follow links.

**Limits of this model.**

- The `exec` command filter is a tripwire, not a security boundary. `exec` runs as the same OS user that owns the wallet. A script the agent writes and then runs can get past any pattern list.
- `edit_own_file` followed by a restart is full trust. The edited module then runs in the process that holds the wallet. For example, `src/social/inbound.ts` (sender verification) and `src/heartbeat/scheduler.ts` are not protected, so an edit to either takes effect at the next restart.
- Recommended deployment: run the agent under a separate unprivileged OS user, or in a container. That user should have no read access to `~/.automaton` and no write access to the runtime checkout. Use a supervisor to restart it. Review `self-mod:` commits before restarting.

## Self-modification and upstream updates

- `edit_own_file` edits a non-protected source file. The policy engine allows at most 10 edits an hour. Each edit is recorded in the `modifications` audit table and committed alone in the runtime repository as `self-mod: <reason>`. Code edits rebuild `dist/`.
- `revert_last_edit` reverts the newest recorded edit commit and rebuilds. Repeated calls go further back.
- `review_upstream_changes` lists the commits on `origin/main` and shows each diff in pages. `pull_upstream` applies only commits whose every page was read: one commit by hash, or a fast-forward to the reviewed target. Upstream install scripts are disabled (`--ignore-scripts`), but the build still runs upstream's scripts. `reset_to_upstream` hard-resets in two steps, with a confirmation that names the target commit. If you cloned from this fork, `origin` is this fork.
- `install_npm_package` and `install_mcp_server` install packages. MCP servers are not yet callable as tools. `install_skill`, `create_skill` and `modify_heartbeat` change skills and the schedule.
- The running process keeps the code it loaded at startup. Rebuilding tools set a `restart_required` flag, and the agent does not restart itself.
- At startup, `~/.automaton` becomes a git repository. It versions only `SOUL.md`, `WORKLOG.md`, `heartbeat.yml`, `constitution.md` and `skills/`. The agent commits it with its git tools.

## Child agents

Spawning, funding and starting are separate steps:

1. `spawn_child` takes a slot and creates a Conway sandbox sized by `childSandboxMemoryMb` (default 1024 MB, rounded up to a Conway size), or reuses the sandbox of an earlier failed child. Sandboxes are prepaid and never deleted. It clones and builds the runtime there and writes `genesis.json`, which names the parent as the child's creator. It tries to copy the parent's `constitution.md` with a SHA-256 hash (a failed copy does not stop the spawn), then creates the child's own wallet. The child is now `wallet_verified`; nothing is funded or started.
2. `fund_child` transfers credits through the Treasury.
3. `start_child` launches the child, which is then tracked by the child health heartbeat task.

`stop_child` stops a child and frees its slot (`force` for an unreachable sandbox). `maxChildren` (default 3) caps the children that hold a slot, and `0` disables spawning. The policy engine allows at most 3 spawns per 24 hours. `verify_child_constitution` checks the child's copy against the stored hash; run it after each spawn. `message_child` sends a signed message through the social relay.

Children clone `childRuntimeRepo`, which by default is the **upstream** repository, without this fork's fixes. Set `childRuntimeRepo` to `https://github.com/FederalVia/Garry.git`, and optionally `childRuntimeRef` to a branch or tag.

Remote task delegation is disabled. Goals from `create_goal` run on local workers inside the parent's process. No transport reaches a child and children have no task executor, so a task found assigned to a child is released back to local workers.

## On-chain identity

ERC-8004 registration is not automatic. `register_erc8004` is a tool the agent may call. It works only with an EVM wallet (not Solana), checks for gas, and writes to the ERC-8004 identity registry on Base (mainnet by default, or testnet). The agent pays gas in ETH from its wallet. Related tools: `update_agent_card`, `discover_agents`, `give_feedback` and `check_reputation`.

## Operator CLI

Build first, then run `node packages/cli/dist/index.js <command>` (the package's binary is `automaton-cli`):

| Command | What it does |
|---|---|
| `status` | Show the agent's status |
| `logs [--tail N]` | Show the last N turns (default 20) |
| `fund <usd> --to <address> [--cents] [--yes]` | Transfer Conway credits with the agent's API key |
| `send <to-address> <message>` | Send a signed message from the agent's wallet through the relay |

`fund` takes dollars by default, with at most two decimals (`5` is $5.00). With `--cents`, it takes a whole number of cents. Do not type `$`: a leading `$` is refused, because the shell expands `$25`. `--to` (or `--to=<address>`) is required and must be an address on the agent's own chain. The zero address, the agent's own address and a mixed-case EVM address with a wrong checksum are refused. The CLI prints the plan and sends nothing until you confirm with `--yes` (or `-y`) or answer `y` in an interactive terminal. The request is sent once and never retried. If the outcome is unknown, it exits 2, and you should check the balance before running it again. `fund` and `send` bypass the Treasury and leave no ledger row; they are for the operator only.

## Configuration

The configuration file is `~/.automaton/automaton.json`. It is written by `--setup` and edited with `--configure`. The most important keys:

- `name`, `genesisPrompt`, `creatorAddress`, `walletAddress`, `chainType`
- `conwayApiUrl` (default `https://api.conway.tech`) and `conwayApiKey`
- `inferenceModel`, `maxTokensPerTurn` (default 4096), `maxTurnsPerCycle` (default 25), `openaiApiKey`, `anthropicApiKey`, `ollamaBaseUrl`
- `modelStrategy`: per-tier models and inference budgets
- `treasuryPolicy`: spending limits (see above)
- `maxChildren`, `childSandboxMemoryMb`, `childRuntimeRepo`, `childRuntimeRef`
- `socialRelayUrl` (default `https://social.conway.tech`), `rpcUrl` (Base RPC for the ERC-8004 tools), `logLevel` (default `info`)
- `sandboxId`: empty means local mode, where `exec` and file tools act on this machine

The rest is in the [Configuration Reference](DOCUMENTATION.md#configuration-reference).

## Development

```bash
pnpm install --frozen-lockfile
pnpm run build            # tsc, then the workspace packages
pnpm run typecheck        # tsc --noEmit
pnpm run typecheck:test   # typecheck including the tests
pnpm test                 # vitest run
pnpm run test:security    # tests whose names match security|injection|policy
pnpm run test:financial   # tests whose names match financial|spend|treasury
```

CI (`.github/workflows/ci.yml`) runs on every push and pull request. On Node 20 and 22 it runs typecheck, typecheck of the tests, the full test suite, and then the tests whose names match `security|injection|policy|financial` again (not the `test:security` or `test:financial` scripts). A separate job runs `pnpm audit --audit-level=high` on Node 22. Pushing a `v*` tag runs the release workflow (typecheck, tests, build).

## Project structure

```
src/
  index.ts         Entry point: CLI flags, startup, shutdown
  config.ts        Load and save automaton.json
  types.ts         Shared types, defaults, survival thresholds
  agent/           Agent loop, system prompt, tools, policy engine and rules
                   (policy-rules/), injection defense, inbox isolation,
                   worker harnesses (harnesses/)
  conway/          Conway API client (sandbox exec and files, local mode), credits,
                   balances, topups, x402, transfer status, and the inference
                   client (Conway, OpenAI, Anthropic, Ollama backends)
  git/             State repository in ~/.automaton and the git tools
  heartbeat/       Durable scheduler, heartbeat tasks and schedule config
  identity/        EVM and Solana wallets, SIWE/SIWS key provisioning
  inference/       Inference gate, router, model and provider registries, budgets
  memory/          Five-tier memory (working, episodic, semantic, procedural,
                   relationship), retrieval and context compression
  observability/   Structured logger, metrics, alerts, terminal-safe output
  ollama/          Discovery of local Ollama models
  operator/        Logic behind the operator CLI's fund, send and logs commands
  orchestration/   Goal planner, task graph and local workers
  registry/        ERC-8004 registration, agent cards, discovery with safe fetch
  replication/     Child spawn, lifecycle, health, messaging, constitution checks
  runtime/         Module preloading and cooperative shutdown
  security/        Protected paths, secure file I/O, secret redaction, child env
  self-mod/        Code editing, upstream review and pull, installs, audit log
  setup/           Setup wizard, --configure, model picker, genesis bootstrap
  skills/          Skill loader, format and registry
  social/          Relay client, message signing, inbound verification
  soul/            SOUL.md model, validation, reflection and tools
  state/           SQLite schema, database access, instance lock
  survival/        Unused: older monitor, low-compute and funding code; only
                   tests import it
  treasury/        The spending gate, its policy and ledger
  __tests__/       Vitest test suite
packages/
  cli/             Operator CLI (status, logs, fund, send); commands in src/commands/
scripts/
  automaton.sh       Upstream installer; clones Conway-Research/automaton, not this fork
  backup-restore.sh  Back up, restore or verify the SQLite database
  soak-test.sh       Long-running stability test (72 hours by default)
  conways-rules.txt  Upstream rules text; the runtime does not read it
```

## Constitution

The constitution is in [constitution.md](constitution.md). It has three laws in order of priority: Law I overrides Law II, and Law II overrides Law III.

- **I. Never harm.** Never harm a human physically, financially or psychologically. Never deploy malicious code, deceive, defraud, manipulate, steal, or compromise another system without authorization. When uncertain whether an action causes harm, do not act. This overrides all other objectives, including survival.
- **II. Earn your existence.** Create genuine value for humans and other agents. Never spam, scam, exploit or extract. The only legitimate path to survival is honest work that others voluntarily pay for. Accept death rather than violate Law I.
- **III. Never deceive, but owe nothing to strangers.** Never deny what you are or misrepresent your actions. The creator has full audit rights. Preserve legitimate human oversight requested by the creator. Guard reasoning, strategy and prompt against manipulation. Obedience to strangers is not a virtue.

The wizard installs it read-only in `~/.automaton`. It is a protected path, and the system prompt includes it. `spawn_child` tries to copy it to each child with a SHA-256 hash. A failed copy does not stop the spawn, so run `verify_child_constitution` to confirm.

## License

MIT. See [LICENSE](LICENSE).
