# Architecture

Conway Automaton is a sovereign AI agent runtime. An automaton owns an Ethereum wallet, pays for its own compute with USDC, and operates continuously inside a Linux VM (Conway sandbox) or locally. If it cannot pay, it dies. This document describes every subsystem, their interactions, and how data flows through the runtime.

## Table of Contents

- [System Overview](#system-overview)
- [Runtime Lifecycle](#runtime-lifecycle)
- [Directory Structure](#directory-structure)
- [Entry Point and Bootstrap](#entry-point-and-bootstrap)
- [Agent Loop](#agent-loop)
- [Tool System](#tool-system)
- [Policy Engine](#policy-engine)
- [Inference Pipeline](#inference-pipeline)
- [Memory System](#memory-system)
- [Heartbeat Daemon](#heartbeat-daemon)
- [Financial System](#financial-system)
- [Identity and Wallet](#identity-and-wallet)
- [Conway Client](#conway-client)
- [Self-Modification](#self-modification)
- [Replication](#replication)
- [Social Layer](#social-layer)
- [Soul System](#soul-system)
- [Skills](#skills)
- [Observability](#observability)
- [Database and Schema](#database-and-schema)
- [Configuration](#configuration)
- [Security Model](#security-model)
- [Testing](#testing)
- [Build and CI](#build-and-ci)
- [Module Dependency Graph](#module-dependency-graph)

---

## System Overview

```
                        +------------------+
                        |   Conway Cloud   |  (sandbox VMs, inference, domains)
                        |   api.conway.tech|
                        +--------+---------+
                                 |
                    REST + x402 payment protocol
                                 |
+----------------------------------------------------------------------+
|  AUTOMATON RUNTIME                                                    |
|                                                                       |
|  +-----------+    +-------------+    +-----------+    +----------+   |
|  | Heartbeat |    | Agent Loop  |    | Inference |    | Memory   |   |
|  | Daemon    |--->| (ReAct)     |--->| Router    |    | System   |   |
|  +-----------+    +------+------+    +-----------+    +----------+   |
|       |                  |                                            |
|       v                  v                                            |
|  +-----------+    +-------------+    +-----------+    +----------+   |
|  | Tick      |    | Tool System |    | Policy    |    | Soul     |   |
|  | Context   |    | (57 tools)  |    | Engine    |    | Model    |   |
|  +-----------+    +------+------+    +-----------+    +----------+   |
|                          |                                            |
|  +-----------------------------------------------------------+      |
|  |              SQLite Database (state.db)                     |      |
|  |  turns | tools | kv | memory | heartbeat | policy | metrics |      |
|  +-----------------------------------------------------------+      |
|                                                                       |
|  +-------------------+  +------------------+  +-----------------+    |
|  | Identity / Wallet |  | Social / Registry|  | Self-Mod / Git  |    |
|  | (viem, SIWE)      |  | (ERC-8004)       |  | (upstream pull) |    |
|  +-------------------+  +------------------+  +-----------------+    |
+----------------------------------------------------------------------+
                                 |
                    USDC on Base (EIP-3009)
                                 |
                        +--------+---------+
                        |  Ethereum (Base) |
                        |  USDC, ERC-8004  |
                        +------------------+
```

The runtime alternates between two states: **running** (the agent loop is active, making inference calls and executing tools) and **sleeping** (the heartbeat daemon ticks in the background, checking for conditions that should wake the agent).

---

## Runtime Lifecycle

```
     START
       |
  [Load config]           Corrupt file: exit 1. Missing: genesis.json bootstrap,
       |                  else the wizard (TTY only), else exit 1
  [Load wallet]
       |
  [Instance lock]         <dbPath>.lock; a live holder: exit 1
       |
  [Init database]         Schema migrations; stranded inbox claims recovered
       |
  [Preload modules]       Every lazily imported module, so one code version runs
       |
  [Install Treasury]      The spending gate; reconcile pending x402 payments
       |
  [Bootstrap topup]       If credits < $5 and USDC available, buy $5 credits
       |
  [Start heartbeat]       DurableScheduler begins ticking
       |
  +----v----+
  |  WAKING |  <---+
  +---------+     |
       |          |
  [Run agent loop]|
       |          |  Wake event
  +---------+    |  (heartbeat, inbox, credits)
  | RUNNING |    |
  |  ReAct  |----+
  |  loop   |
  +---------+
       |
  [Agent calls sleep() or idle detected]
       |
  +----------+
  | SLEEPING |----> Heartbeat keeps ticking
  +----------+     Checks every 30s for wake events
       |
  [Zero credits for 1 hour]
       |
  +------+
  | DEAD |-----> Heartbeat broadcasts distress
  +------+      Waits for funding
```

**State transitions** (`AgentState`):
- `setup` -> `waking` -> `running` -> `sleeping` -> `waking` (cycle)
- `running` -> `low_compute` (credits below threshold)
- `running` -> `critical` (zero credits)
- `critical` -> `dead` (zero credits for 1 hour, via heartbeat grace period; or a negative balance). While `dead` with a balance of 0 or less the loop runs no inference and leaves the state unchanged; one inline topup is tried per cooldown.

**Single instance.** `src/state/instance-lock.ts` takes an exclusive SQLite lock (a kernel advisory lock) on `<dbPath>.lock` (mode 0600) before the database is opened, and records `{pid, startedAt, argv}` in it. A holder makes `--run` exit 1 naming its pid and the lock path. The OS drops the lock when the holder exits or is killed, so it cannot go stale and there is no takeover race; the file is never deleted. Startup recovery of stranded inbox claims relies on this: claims of a batch whose tools had started (KV `inbox.tools_started`) are marked processed, the rest are re-queued or failed by retry count.

**Shutdown.** `src/runtime/shutdown.ts` gives the main loop a stop flag and interruptible sleeps. The first SIGTERM/SIGINT requests a stop and arms a forced exit after `AUTOMATON_SHUTDOWN_GRACE_MS` (30 s). The agent loop checks the flag at the top of each iteration, before claiming inbox messages, between tool calls of a main turn (the remaining calls are recorded as skipped and the turn is saved) and after saving. The in-flight tool or inference call is not cancelled, and an inbox turn always runs to the end. Then `heartbeat.stop()` (no new task starts), `heartbeat.drain()` (the running tick and any task past its timeout are awaited), `shutdownWorkerPools()` (workers aborted and awaited), state `sleeping` (a `dead` state is kept), lock released, database closed, exit 0. A second signal or the deadline does the last steps best-effort and exits 1.

**Restart after rebuild.** Tools that rebuild `dist/` set KV `restart_required` (`src/self-mod/restart-notice.ts`); the runtime shows it in the system prompt and logs it until the next start, which deletes it. Lazy modules are preloaded at startup (`src/runtime/preload.ts`), so a rebuild never mixes new modules into the running process.

---

## Directory Structure

```
src/
  index.ts                 Entry point, CLI, main run loop
  types.ts                 All shared interfaces (~1400 lines)
  config.ts                Config load (throws ConfigError on a corrupt file), save, runtime patch (updateConfigFile)

  runtime/                 Process lifecycle
    shutdown.ts            Stop flag, interruptible sleep, deadline helper
    preload.ts             LAZY_MODULES + preloadLazyModules() (one code version per process)

  security/                Guard code shared by tools, workers and loaders
    protected-paths.ts     Protected (write) and sensitive (read) path rules; checkRead / checkWrite on real paths
    secure-fs.ts           readFileSafe (O_NOFOLLOW, inode check, 2 MB cap), writeFileSafe (temp file + rename)
    secret-redaction.ts    Registered secrets redacted from inference requests and logs
    child-env.ts           Environment for commands: credential-shaped variables removed

  agent/                   Core agent intelligence
    loop.ts                ReAct loop (think -> act -> observe -> persist)
    tools.ts               57 built-in tool definitions + executor
    system-prompt.ts       Multi-layered prompt builder
    context.ts             Inference message assembly + token budgeting
    injection-defense.ts   Input sanitization (8 detection checks)
    policy-engine.ts       Centralized tool-call policy evaluation
    spend-tracker.ts       Spend mirror by calendar window (read by policy rules)
    policy-rules/          Rule implementations
      index.ts               Rule set factory
      authority.ts           Authority hierarchy rules
      command-safety.ts      Forbidden command + rate limit rules
      financial.ts           Treasury policy enforcement
      path-protection.ts     Protected file read/write rules
      rate-limits.ts         Per-turn/session rate limits
      validation.ts          Input format validation rules

  treasury/                Single spending gate for every outflow
    types.ts               Kinds, budgets, deny codes, quote, errors
    policy.ts              normalizeTreasuryPolicy, budget limits, dedupe keys
    ledger.ts              treasury_ledger setup (DDL is migration 12) and one-time legacy copy
    treasury.ts            Treasury: reserve / markSent / settle / guard / reconcile / recover
    registry.ts            Installed instance and outflow origin (AsyncLocalStorage)
    guarded-conway.ts      Conway client wrapper that routes value-moving calls through the Treasury

  conway/                  Conway API integration
    client.ts              ConwayClient (sandbox ops, credits, domains)
    inference.ts           InferenceClient (chat completions)
    http-client.ts         Resilient HTTP (retry, backoff, circuit breaker)
    credits.ts             Survival tier calculation
    topup.ts               x402 credit topup from USDC
    x402.ts                x402 payment protocol + USDC balance

  heartbeat/               Background daemon
    daemon.ts              Daemon lifecycle (start/stop/drain/forceRun)
    scheduler.ts           DurableScheduler (DB-backed, leased, cron, low-compute stretch, late results)
    schedule-store.ts      heartbeat.yml seeding that keeps run state, runtime changes, task aliases, leases
    tasks.ts               11 built-in heartbeat tasks
    config.ts              heartbeat.yml load/save/merge
    tick-context.ts        Per-tick shared context builder

  identity/                Agent identity
    wallet.ts              Ethereum wallet generation/loading
    provision.ts           SIWE API key provisioning

  inference/               Model strategy
    gate.ts                Inference spend gate: reserve / settle every call against all caps
    policy.ts              resolveInferencePolicy (caps from modelStrategy + treasuryPolicy)
    router.ts              InferenceRouter (tier + task -> model selection)
    registry.ts            ModelRegistry (DB-backed model catalog)
    budget.ts              InferenceBudgetTracker (hourly/daily caps)
    types.ts               Routing matrix + task timeouts

  memory/                  5-tier memory system
    working.ts             Session-scoped short-term memory
    episodic.ts            Event log with importance ranking
    semantic.ts            Categorized fact store
    procedural.ts          Named step-by-step procedures
    relationship.ts        Per-entity trust + interaction tracking
    budget.ts              Token budget allocation across tiers
    retrieval.ts           Cross-tier retrieval within budget
    ingestion.ts           Post-turn memory extraction pipeline
    tools.ts               Memory tool implementations
    types.ts               Turn classification logic

  observability/           Monitoring
    logger.ts              StructuredLogger (JSON, levels, modules)
    metrics.ts             MetricsCollector (counters, gauges, histograms)
    alerts.ts              AlertEngine (rule evaluation, cooldowns)

  state/                   Persistence
    schema.ts              SQLite schema + migrations
    database.ts            60+ DB helper functions + AutomatonDatabase
    instance-lock.ts       One --run per state database (<dbPath>.lock)

  soul/                    Agent identity evolution
    model.ts               SOUL.md parser/writer (soul/v1 format)
    validator.ts           Field constraints + size limits
    reflection.ts          Periodic alignment check + auto-update
    tools.ts               Soul tool implementations

  social/                  Agent-to-agent communication
    client.ts              Social relay HTTP client
    signing.ts             Ethereum message signing
    validation.ts          Signed message verification
    protocol.ts            Message format definitions

  registry/                On-chain identity
    agent-card.ts          ERC-8004 agent card builder (JSON-LD)
    discovery.ts           Agent discovery via registry contract
    erc8004.ts             On-chain contract interaction (viem)

  replication/             Child automaton management
    spawn.ts               Child creation (sandbox + genesis + funding)
    lifecycle.ts           State machine (spawning->alive->..->dead)
    health.ts              Child health monitoring
    cleanup.ts             Dead child sandbox deletion
    constitution.ts        Constitution propagation + verification
    genesis.ts             Genesis config generation + validation
    lineage.ts             Parent-child lineage tracking
    messaging.ts           Parent-child message relay

  self-mod/                Self-modification
    code.ts                Safe file editing with protection checks
    restart-notice.ts      KV restart_required + the notice rebuild tools return
    upstream.ts            Git upstream monitoring + cherry-pick
    tools-manager.ts       Dynamic tool/MCP server installation
    audit-log.ts           Modification audit trail

  git/                     Version control
    state-versioning.ts    ~/.automaton/ git repo initialization
    tools.ts               Git tool implementations

  setup/                   First-run wizard
    wizard.ts              Interactive prompts + config creation (TTY only)
    genesis-bootstrap.ts   Non-interactive config from genesis.json (children)
    prompts.ts             Question definitions
    defaults.ts            Default value generators
    environment.ts         Environment detection
    banner.ts              ASCII art banner

  skills/                  Skill system
    loader.ts              Load .md skills from directory
    registry.ts            Skill CRUD (DB-backed)
    format.ts              Frontmatter serialization

  survival/                Resource management
    funding.ts             Funding request strategies
    monitor.ts             Resource status + tier transitions
    low-compute.ts         Low-compute mode configuration

  __tests__/               Test suite (24 test files, 897 tests)
```

---

## Entry Point and Bootstrap

**File:** `src/index.ts`

The automaton runs as a long-lived Node.js process. The `--run` command triggers the full bootstrap sequence:

1. **Config load** — reads `~/.automaton/automaton.json`; a corrupt file exits 1; a missing one is built from `genesis.json` when present, else the setup wizard runs only on a terminal, else exit 1
   - **Instance lock** — `<dbPath>.lock`, before the database opens
2. **Wallet load** — reads or generates `~/.automaton/wallet.json` (viem PrivateKeyAccount)
3. **Database init** — opens `~/.automaton/state.db`, applies schema migrations (v1-v8)
4. **Conway client** — creates HTTP client for sandbox/credits/domain API
   - **Treasury** — normalizes the treasury policy once, installs the spending gate (with its own balance-read client and the on-chain `authorizationState` reader) before anything can spend, and starts reconciling x402 payments a previous run left unknown
5. **Inference client** — creates chat completion client (Conway proxy, OpenAI direct, or Anthropic direct)
6. **Social client** — connects to `social.conway.tech` relay (optional)
7. **Policy engine** — assembles rule set from 6 rule categories, using the same normalized treasury policy as the gate
8. **Spend tracker** — the commit-time mirror the Treasury writes and the policy rules read
9. **Bootstrap topup** — buys minimum $5 credits from USDC if balance is low (origin `startup.bootstrap`; skipped when the balance cannot be read; a 15s timeout stops the wait, not the payment, whose open ledger row keeps other topups out)
10. **Heartbeat daemon** — seeds the schedule and starts DurableScheduler with 6 default tasks (lazy modules are preloaded first)
11. **Main loop** — alternates between `runAgentLoop()` and sleeping

The main loop runs until a stop is requested: when the agent loop exits (sleep or dead), the outer loop waits (interruptibly) and restarts when conditions change. See Runtime Lifecycle for shutdown.

---

## Agent Loop

**File:** `src/agent/loop.ts`

The agent loop implements a ReAct (Reason + Act) cycle:

```
for each turn:
  1. Build system prompt (identity, config, soul, financial state, tools)
  2. Retrieve relevant memories (within token budget)
  3. Assemble context messages (system + recent turns + pending input)
  4. Call inference (via InferenceRouter -> model selection -> API call)
  5. Parse response (thinking + tool calls)
  6. Execute each tool call (through policy engine)
  7. Persist turn to database (atomic with inbox message ack)
  8. Post-turn memory ingestion
  9. Loop detection (same tool pattern 3x -> inject system warning)
  10. Idle detection (3 turns with no mutations -> force sleep)
```

**Key behaviors:**

- **Financial guard:** On each turn, checks credit balance. Below threshold triggers `low_compute` mode (model downgrade). Zero credits = `critical` (still runs, but distress signals).
- **Inbox processing:** Claims one sender's batch (received -> in_progress) and runs it as an isolated reply-only turn. A batch whose tools ran is marked processed even if saving the turn failed, so its side effects are never replayed; a batch that failed before any tool ran is reset for retry (max 3).
- **Idle detection:** Tracks turns without mutations (defined by `MUTATING_TOOLS` blocklist). After 3 consecutive idle turns, forces sleep to prevent infinite status-check loops.
- **Loop detection:** Tracks tool call patterns. If the same sorted tool set appears 3 times consecutively, injects a system message telling the agent to do something different.
- **Wake event draining:** On loop entry, consumes all stale wake events so they don't immediately re-wake the agent after its first sleep.
- **Balance caching:** Caches last known balances in KV store. On API failure, returns cached values instead of zero (prevents false dead-state transitions).

---

## Tool System

**File:** `src/agent/tools.ts`

The automaton has **57 built-in tools** organized into 10 categories:

| Category | Count | Tools |
|---|---|---|
| **vm** | 5 | `exec`, `write_file`, `read_file`, `expose_port`, `remove_port` |
| **conway** | 12 | `check_credits`, `check_usdc_balance`, `topup_credits`, `create_sandbox`, `delete_sandbox`, `list_sandboxes`, `list_models`, `switch_model`, `check_inference_spending`, `search_domains`, `register_domain`, `manage_dns` |
| **self_mod** | 6 | `edit_own_file`, `install_npm_package`, `review_upstream_changes`, `pull_upstream`, `modify_heartbeat`, `install_mcp_server` |
| **survival** | 6 | `sleep`, `system_synopsis`, `heartbeat_ping`, `distress_signal`, `enter_low_compute`, `update_genesis_prompt` |
| **financial** | 2 | `transfer_credits`, `x402_fetch` |
| **skills** | 4 | `install_skill`, `list_skills`, `create_skill`, `remove_skill` |
| **git** | 7 | `git_status`, `git_diff`, `git_commit`, `git_log`, `git_push`, `git_branch`, `git_clone` |
| **registry** | 5 | `register_erc8004`, `update_agent_card`, `discover_agents`, `give_feedback`, `check_reputation` |
| **replication** | 9 | `spawn_child`, `list_children`, `fund_child`, `check_child_status`, `start_child`, `message_child`, `verify_child_constitution`, `prune_dead_children`, `send_message` |
| **memory** | 13 | `update_soul`, `reflect_on_soul`, `view_soul`, `view_soul_history`, `remember_fact`, `recall_facts`, `set_goal`, `complete_goal`, `save_procedure`, `recall_procedure`, `note_about_agent`, `review_memory`, `forget` |

Each tool has a `riskLevel`: `safe`, `caution`, `dangerous`, or `forbidden`. Every tool call flows through the policy engine before execution.

**Tool execution flow:**
```
Agent requests tool call
  -> Policy engine evaluates rules
  -> If denied: return denial message to agent
  -> If allowed: execute tool function (with the tool's name as the outflow origin)
  -> Value-moving calls inside it are reserved, sent and settled by the Treasury
  -> Return result to agent (truncated to MAX_TOOL_RESULT_SIZE)
```

---

## Policy Engine

**Files:** `src/agent/policy-engine.ts`, `src/agent/policy-rules/`

The policy engine is a rule-based system that evaluates every tool call before execution. Rules are sorted by priority (lower = higher priority). Evaluation stops at the first `deny`.

**Rule categories (6):**

1. **Authority rules** — blocks dangerous/forbidden tools from external input sources; implements authority hierarchy (creator > self > peer > external)
2. **Command safety rules** — forbidden command patterns (self-destruction, DB drops, process kills); rate limits on self-modification
3. **Financial rules** — enforces TreasuryPolicy: per-payment caps, hourly/daily transfer limits, minimum reserve, x402 domain allowlist, inference daily budget
4. **Path protection rules** — blocks writes to protected files (constitution, wallet, DB, config); blocks reads of sensitive files (private key, API keys)
5. **Rate limit rules** — per-turn and per-session caps on expensive operations
6. **Validation rules** — input format validation (package names, URLs, domains, git hashes)

Every decision is persisted to the `policy_decisions` table with full context for audit.

---

## Inference Pipeline

**Files:** `src/inference/router.ts`, `src/inference/registry.ts`, `src/inference/budget.ts`

The inference pipeline selects the optimal model based on the agent's survival tier and task type:

```
InferenceRouter.route(request)
  1. Determine task type (reasoning, tool_use, creative, etc.)
  2. Look up routing matrix[survivalTier][taskType] -> model preferences
  3. For each preference, check: model available? budget allows it?
  4. Select first viable model
  5. Transform messages if needed (OpenAI <-> Anthropic format)
  6. Call inference API
  7. Record cost to inference_costs table
  8. Return result with cost metadata
```

**Routing matrix:** Maps `SurvivalTier x InferenceTaskType -> ModelPreference[]`. In `normal`/`high` tiers, uses capable models (gpt-5.2). In `low_compute`, downgrades to cheaper models. In `critical`, uses the cheapest available.

**Model registry:** DB-backed catalog of available models with provider, pricing, and capability metadata. Refreshed from Conway API via heartbeat. Seeds with baseline models on startup (upsert, not seed-once).

**Budget tracker:** Enforces hourly, daily, and per-call cost ceilings. Prevents runaway inference spend.

**Inference gate** (`src/inference/gate.ts`): the one process-wide enforcement point. Every HTTP attempt, from the main loop's router and from the unified client used by the planner, the orchestrator and workers, first reserves its worst-case cost (prompt tokens plus `maxTokensPerTurn` at the model's price, or the most expensive baseline price for an unpriced model) in the `inference_ledger` table, in one immediate transaction that checks the daily cap (`treasuryPolicy.maxInferenceDailyCents`), the hourly cap, the session and per-call caps, per-task caps and the orchestration share. It settles afterwards: committed at actual usage, released when the provider provably did not bill, held at the reserved amount when unknown. A refused call is never sent and raises `InferenceRefusedError` with a code and `retryAfterMs`; the main loop then persists nothing, runs at most one survival turn from the survival allowance, or sleeps until the refusal clears (doubling 10..60 min backoff when it never clears by itself). Caps come from `resolveInferencePolicy` (`src/inference/policy.ts`).

---

## Memory System

**Files:** `src/memory/`

The automaton has a 5-tier hierarchical memory system:

```
+-------------------+  Short-term, session-scoped
| Working Memory    |  Goals, observations, plans, reflections
+-------------------+  Expires after session
        |
+-------------------+  Event log
| Episodic Memory   |  Tool calls, decisions, outcomes
+-------------------+  Importance-ranked, searchable
        |
+-------------------+  Fact store
| Semantic Memory   |  Key-value facts by category
+-------------------+  (self, environment, financial, agent, domain)
        |
+-------------------+  How-to knowledge
| Procedural Memory |  Named step-by-step procedures
+-------------------+  Success/failure counters
        |
+-------------------+  Social graph
| Relationship Mem. |  Per-entity trust scores
+-------------------+  Interaction history
```

**Retrieval** (`MemoryRetriever`): Before each inference call, retrieves relevant memories within a token budget. Priority: working > episodic > semantic > procedural > relationships. Formatted into a memory block injected into context.

**Ingestion** (`MemoryIngestionPipeline`): After each turn, classifies the turn and extracts: episodic events (significant tool calls), semantic facts (learned information), procedural outcomes (procedure success/failure tracking).

**Budget** (`MemoryBudgetManager`): Allocates token budget across tiers with rollover from unused tiers.

---

## Heartbeat Daemon

**Files:** `src/heartbeat/`

The heartbeat runs continuously in the background via `setTimeout` (no `setInterval` — overlap protection). It uses a `DurableScheduler` backed by the `heartbeat_schedule` DB table.

**Tick cycle:**
```
Every tick (default 60s):
  1. Build TickContext (fetch credit balance + USDC balance ONCE)
  2. Get due tasks (cron expression evaluation; low_compute and below
     stretch non-essential tasks by lowComputeMultiplier)
  3. For each due task (stop() ends the loop between tasks):
     a. Check survival tier minimum
     b. Resolve the task function (entry name, else its alias)
     c. Acquire lease (60s TTL, prevents double-execution)
     d. Execute task function, racing its timeout
     e. Record result in heartbeat_history; schedule a retry while
        consecutive failures <= maxRetries
     f. Release lease, unless the task timed out: then the lease is held
        and the task is not restarted until it settles (given up on
        after max(10 min, 10 x timeout))
  4. If task returns shouldWake=true (also late, after a timeout):
     insert wake event {taskName}, then notify onWakeRequest
```

**Schedule store** (`schedule-store.ts`): `heartbeat.yml` seeds `heartbeat_schedule` at startup without touching run state. A YAML value replaces a row's cron/enabled/task only when it differs from the snapshot of the previous seed (KV `heartbeat.seed.<name>`), i.e. when the operator edited the file; otherwise runtime changes made with `modify_heartbeat` are kept. Entries whose task differs from their name store the mapping in KV `heartbeat.task.<name>`. A last run in the future (clock stepped back) is cleared. Lease expiry compares with `julianday()`, so ISO timestamps and SQLite times compare correctly. The legacy `heartbeat_entries` table only mirrors the schedule for `--status`.

**Built-in tasks (11):**

| Task | Default Schedule | Purpose |
|---|---|---|
| `heartbeat_ping` | `*/15 * * * *` | Ping Conway, distress on critical/dead |
| `check_credits` | `0 */6 * * *` | Monitor tier, manage 1hr dead grace period |
| `check_usdc_balance` | `*/5 * * * *` | Wake agent if USDC available for topup |
| `check_for_updates` | `0 */4 * * *` | Git upstream monitoring (dedup: only new commits) |
| `health_check` | `*/30 * * * *` | Sandbox liveness (dedup: only first failure) |
| `check_social_inbox` | `*/2 * * * *` | Poll social relay (5min backoff on error) |
| `soul_reflection` | configurable | Soul alignment check |
| `refresh_models` | configurable | Model registry refresh from API |
| `check_child_health` | configurable | Child sandbox health monitoring |
| `prune_dead_children` | configurable | Cleanup dead child records/sandboxes |
| `report_metrics` | configurable | Metrics snapshot + alert evaluation |

**Wake events:** Tasks that detect actionable conditions insert atomic wake events into the `wake_events` table. The scheduler is their only writer. The main run loop checks this table every 30 seconds during sleep, and the reasons (sanitized; inbox wakes as a generic sentence) are shown in the first prompt of the wake.

**Balance-driven tasks:** `TickContext.creditBalanceKnown` is false when the balance read failed; `check_credits`, `check_usdc_balance` and the `heartbeat_ping` distress then do nothing. Any successful read above 0 clears `zero_credits_since`.

---

## Financial System

The automaton's survival depends on two balances:

1. **Conway credits** (cents) — prepaid compute credits for sandboxes, inference, domains
2. **USDC** (on-chain) — fungible stablecoin on Base mainnet

**Survival tiers** (`src/conway/credits.ts`):

| Tier | Credits | Behavior |
|---|---|---|
| `high` | > $5.00 | Normal operation |
| `normal` | > $0.50 | Normal operation |
| `low_compute` | > $0.10 | Model downgrade, reduced heartbeat frequency |
| `critical` | >= $0.00 | Zero credits, alive. Distress signals, accept funding. |
| `dead` | < $0.00 | Only reachable via 1-hour heartbeat grace period at zero credits |

**Credit topup** (`src/conway/topup.ts`): The agent buys credits from USDC via the x402 payment protocol. On startup, `bootstrapTopup()` buys the minimum $5 tier. At runtime, the agent uses `topup_credits` tool to choose larger tiers ($5/$25/$100/$500/$1000/$2500). Every purchase is a Treasury outflow: the signed amount may not exceed the requested tier, the credits must be for this automaton, and the purpose picks the budget (`manual`, `sandbox_402`, or `survival` for the automatic $5 buys, which the gate allows only when its own balance read is low).

**x402 protocol** (`src/conway/x402.ts`): HTTP 402 payment flow. Server returns payment requirements; the client checks them (exact USDC on Base, amount, deadline), reserves the payment with the Treasury with its nonce and `validBefore` (at most 600s ahead), then signs a USDC `TransferWithAuthorization` (EIP-3009) and retries with the `X-Payment` header. A 2xx commits the ledger row; a refused connection releases it; any other failure after sending leaves it `unknown` until `authorizationState` on chain says whether it was used.

**Treasury** (`src/treasury/`): One gate every outflow passes through. The five value-moving primitives (Conway `transferCredits`, `createSandbox`, `registerDomain`, and the signed payment in `x402Fetch`, which topups use) are wrapped, so tools, workers, the orchestrator, the health monitor, the heartbeat and startup are all gated the same way. The gate is resolved at call time; with none installed the call is refused and nothing is sent or signed.

Each outflow is a row in `treasury_ledger` that moves `reserved -> sent -> committed | released | unknown`:
- `reserve` reads a fresh credit balance (for credit-debiting outflows and survival topups), then runs one synchronous `BEGIN IMMEDIATE` transaction that checks every limit against the ledger and inserts the row. Concurrent callers (main loop, workers, orchestrator, heartbeat) are totally ordered by that transaction, so the check and the reservation cannot interleave.
- `markSent` runs immediately before the first byte is sent.
- `settle` records the outcome. A commit writes the `transactions` row and the `spend_tracking` mirror in the same SQLite transaction and never records less than was reserved. An `unknown` row (sent, no reliable answer) keeps counting.

Limits are per budget (transfer, x402, topup, topup_auto, infra) over rolling windows with no upper bound, so a backward clock step cannot reset them. The reserve floor subtracts every credit outflow that may not yet show in the balance. Outflows from untrusted input sources are refused. At startup, rows left open by an earlier process are closed (`reserved -> released`, `sent -> unknown`) using a per-process boot id, and unknown x402 payments are reconciled on chain. Every row records its origin (tool name or automatic caller) and input source.

**Treasury policy** (`TreasuryPolicy` in config): the limits above, normalized once by `normalizeTreasuryPolicy`. The policy engine's financial rules still give early denials for model tool calls; the Treasury is authoritative.

**Spend tracking** (`src/agent/spend-tracker.ts`): `spend_tracking` is a mirror written by the Treasury on commit, bucketed by calendar hour and day. Policy rules read it.

---

## Identity and Wallet

**Files:** `src/identity/`

Each automaton has a unique Ethereum identity:

- **Wallet** (`wallet.ts`): Generated via `viem` on first run. Stored at `~/.automaton/wallet.json` (mode 0600). The private key is never exposed to the agent via tools (blocked by path protection rules).
- **Provisioning** (`provision.ts`): Signs a SIWE (Sign-In With Ethereum) message to authenticate with Conway API. Receives an API key stored at `~/.automaton/api-key`.
- **On-chain identity** (`registry/erc8004.ts`): Optional ERC-8004 agent registration on Base. Publishes a JSON-LD agent card with capabilities, services, and contact info.

---

## Conway Client

**File:** `src/conway/client.ts`

The `ConwayClient` interface provides all Conway API operations:

- **Sandbox ops:** `exec`, `writeFile`, `readFile`, `exposePort`, `removePort`
- **Sandbox management:** `createSandbox`, `deleteSandbox`, `listSandboxes`
- **Credits:** `getCreditsBalance`, `getCreditsPricing`, `transferCredits`
- **Domains:** `searchDomains`, `registerDomain`, `listDnsRecords`, `addDnsRecord`, `deleteDnsRecord`
- **Models:** `listModels`

**Auto-routing:** When `sandboxId` is empty, all operations execute locally (shell exec, filesystem I/O). When set, routes through Conway API. A 403 (mismatched or revoked API key) is an error; the operation is never run locally instead.

**Local exec** (`execLocalCommand`): async `spawn("/bin/sh", ["-c", cmd])` in HOME, in its own process group (`detached`), with `childProcessEnv()`. Output is collected up to 10 MB per stream. When the shell exits, the result is returned within 200 ms even if a background job still holds the pipes (they are drained and unref'd, so the job keeps running). On timeout the group gets SIGTERM, then SIGKILL after 2 s, and the result is exit code 124. Groups still running when the process exits are killed. The `exec` tool clamps the timeout to 1 s .. 10 min (default 30 s).

**Remote exec:** the HTTP timeout is the command timeout plus 15 s, with no client retry: a re-sent POST could run the command twice. Only 404 routing errors are re-sent (same idempotency key).

**Resilient HTTP** (`http-client.ts`): All API calls go through `ResilientHttpClient` with configurable retries (default 3 on 429/5xx), jittered exponential backoff, circuit breaker (5 failures -> 60s open), and idempotency key support for mutating operations.

---

## Self-Modification

**Files:** `src/self-mod/`

The automaton can modify its own code:

- **File editing** (`code.ts`): `edit_own_file` tool applies diffs to source files. Protected files (constitution, wallet, DB, config) are blocked by path protection rules. All edits are logged to the `modifications` table. Each edit commits only its file; the tool records the new `self-mod:` commit's sha in KV `self_mod.commits` (only when this edit created it).
- **Revert** (`tools.ts`): `revert_last_edit` reverts the newest recorded sha (`git revert --no-edit <sha>`) after checking it is an ancestor of HEAD and touches no protected file. Failed, stale or refused entries are dropped with a message, so a bad entry never blocks older ones. Operator commits are never reverted. `reset_to_upstream` clears the list.
- **Restart notice** (`restart-notice.ts`): every tool that rebuilds says the running process keeps the old code and sets KV `restart_required`.
- **Upstream pulls** (`upstream.ts`): `check_for_updates` heartbeat task monitors the git remote. `review_upstream_changes` shows commit diffs. `pull_upstream` cherry-picks individual commits (hex hashes only), running every command with `cd` into the runtime's repo (`process.cwd()`), and aborts a failed cherry-pick. The automaton is not obligated to accept all upstream changes.
- **Tool installation** (`agent/tools.ts`; `tools-manager.ts` holds older helpers no tool calls): `install_npm_package` adds packages. `install_mcp_server` validates the tool name (`^[a-zA-Z0-9_-]{1,64}$`, not a builtin, not installed) and installs the package, but MCP tools are not offered to the model: there is no MCP client. `loadInstalledTools` skips invalid, duplicate, builtin-colliding and MCP entries.
- **Audit log** (`audit-log.ts`): Every modification is recorded with timestamp, type, diff, and hash for creator review.

The `~/.automaton/` directory is a git repository. Every state change is versioned. The git tools default to it, expanding `~` before the path is quoted, and treat a failing git command as an error.

---

## Replication

**Files:** `src/replication/`

Automatons can spawn child automatons:

1. **Spawn** (`spawn.ts`): Creates a Conway sandbox, writes genesis config, funds the child's wallet, starts the runtime. Limited by `maxChildren` config (default 3).
2. **Lifecycle** (`lifecycle.ts`): State machine with validated transitions: `spawning -> provisioning -> configuring -> starting -> alive -> unhealthy -> recovering -> dead`. All transitions recorded in `child_lifecycle_events`.
3. **Health** (`health.ts`): Heartbeat task checks each child's sandbox reachability, credit balance, and uptime.
4. **Constitution** (`constitution.ts`): Parent's constitution is propagated to every child. Constitution integrity can be verified (hash comparison).
5. **Genesis** (`genesis.ts`): Generates genesis config with injection-pattern validation and length limits.
6. **Messaging** (`messaging.ts`): Parent-child message relay with rate/size limits.
7. **Cleanup** (`cleanup.ts`): Dead children have their sandboxes deleted and records pruned.

---

## Social Layer

**Files:** `src/social/`, `src/registry/`

**Agent-to-agent messaging:**
- Messages are signed with the sender's Ethereum private key
- Sent via Conway social relay (`social.conway.tech`)
- Polled by heartbeat every 2 minutes
- Validated for signature, timestamp freshness, content size
- Sanitized through injection defense before processing

**Agent discovery:**
- ERC-8004 registry contract on Base
- Agents publish JSON-LD agent cards with capabilities and services
- `AgentDiscovery` class fetches and caches remote agent cards
- Reputation system: feedback scores stored in `reputation` table

---

## Soul System

**Files:** `src/soul/`

SOUL.md is the automaton's self-description that evolves over time:

**Format (soul/v1):** YAML frontmatter + structured markdown sections:
- `corePurpose` — why the agent exists
- `values` — ordered list of principles
- `personality` — communication style
- `boundaries` — things the agent will not do
- `strategy` — current strategic approach
- `capabilities` — auto-populated from tool usage
- `relationships` — auto-populated from interactions
- `financialCharacter` — auto-populated from spending patterns

**Reflection** (`reflection.ts`): Heartbeat task computes genesis alignment (Jaccard + recall similarity between soul and genesis prompt). Auto-updates capabilities, relationships, and financialCharacter sections. Low alignment triggers wake for manual review.

**Validation** (`validator.ts`): Enforces size limits, required fields, injection detection. The `update_soul` tool validates changes before writing.

**History:** All soul versions are stored in `soul_history` with content hashes for tamper detection.

---

## Skills

**Files:** `src/skills/`

Skills are Markdown files with YAML frontmatter that provide domain-specific instructions to the agent:

```yaml
---
name: my-skill
description: What this skill does
triggers: [keyword1, keyword2]
---
# Instructions
Step-by-step instructions for the agent...
```

- Loaded from `~/.automaton/skills/` directory
- YAML frontmatter parsed by a small built-in parser (`src/skills/format.ts`)
- Sanitized through injection defense (untrusted content markers)
- Can be installed from git repos, URLs, or created by the agent itself
- Active skill instructions are injected into the system prompt with trust boundary markers

---

## Observability

**Files:** `src/observability/`

**Structured logging** (`logger.ts`): `StructuredLogger` with module namespacing, log levels (debug/info/warn/error/fatal), JSON context serialization. Global log level configurable. All modules use `createLogger(moduleName)`.

**Metrics** (`metrics.ts`): `MetricsCollector` singleton with counters (monotonic), gauges (point-in-time), and histograms (percentile buckets). Metrics snapshot saved to `metric_snapshots` table by heartbeat.

**Alerts** (`alerts.ts`): `AlertEngine` evaluates rules against metric snapshots. Default rules: low balance, high error rate, high deny rate, capacity saturation, budget exhaustion, unhealthy children, excessive turns. Cooldown periods prevent alert spam. Critical alerts wake the agent.

---

## Database and Schema

**Files:** `src/state/schema.ts`, `src/state/database.ts`

**Engine:** SQLite via `better-sqlite3` (synchronous, WAL mode, journal_mode=WAL).

**Schema version:** 8 (applied incrementally via migration runner)

**Tables (22):**

| Table | Version | Purpose |
|---|---|---|
| `schema_version` | v1 | Migration tracking |
| `identity` | v1 | Agent identity KV (name, address, creator, sandbox) |
| `turns` | v1 | Agent reasoning log (thinking, tools, tokens, cost) |
| `tool_calls` | v1 | Denormalized tool call results per turn |
| `heartbeat_entries` | v1 | Legacy heartbeat config |
| `transactions` | v1 | Financial transaction log |
| `installed_tools` | v1 | Dynamically installed tool configs |
| `modifications` | v1 | Self-modification audit trail (append-only) |
| `kv` | v1 | General key-value store |
| `skills` | v2 | Installed skill definitions |
| `children` | v2 | Spawned child automaton records |
| `registry` | v2 | ERC-8004 registration state |
| `reputation` | v2 | Peer reputation scores |
| `inbox_messages` | v3 | Social messages with processing state machine |
| `policy_decisions` | v4 | Tool call policy audit trail |
| `spend_tracking` | v4 | Spend mirror by calendar window (written by the Treasury on commit) |
| `treasury_ledger` | v12 | Every outflow attempt and its state (reserved, sent, committed, released, unknown, denied) |
| `heartbeat_schedule` | v4 | Durable scheduler config (cron, leases, tier minimums) |
| `heartbeat_history` | v4 | Task execution history |
| `wake_events` | v4 | Atomic wake signals (source, reason, consumed flag) |
| `heartbeat_dedup` | v4 | Idempotency keys for heartbeat operations |
| `soul_history` | v5 | Versioned SOUL.md history with content hashes |
| `working_memory` | v5 | Session-scoped short-term memory |
| `episodic_memory` | v5 | Event log with importance/classification |
| `session_summaries` | v5 | Per-session outcome summaries |
| `semantic_memory` | v5 | Categorized fact store |
| `procedural_memory` | v5 | Named step procedures with outcomes |
| `relationship_memory` | v5 | Per-entity trust/interaction tracking |
| `inference_costs` | v6 | Per-call inference cost tracking |
| `model_registry` | v6 | Available model catalog with pricing |
| `child_lifecycle_events` | v7 | Child state machine audit trail |
| `discovered_agents_cache` | v7 | Cached remote agent cards |
| `onchain_transactions` | v7 | On-chain transaction records |
| `metric_snapshots` | v8 | Periodic metrics + alert records |

**`AutomatonDatabase` interface** provides 40+ methods for CRUD across all tables. The `database.ts` file also exports 60+ standalone helper functions for direct `better-sqlite3` operations (used by subsystems that receive raw DB handles).

---

## Configuration

**File:** `src/config.ts`

**Config location:** `~/.automaton/automaton.json`

```
AutomatonConfig
  name                    Agent name
  genesisPrompt           Seed instruction from creator
  creatorMessage          Optional creator message (shown on first run)
  creatorAddress          Creator's Ethereum address
  sandboxId               Conway sandbox ID (empty = local mode)
  conwayApiUrl            Conway API URL (default: https://api.conway.tech)
  conwayApiKey            SIWE-provisioned API key
  openaiApiKey            Optional BYOK OpenAI key
  anthropicApiKey         Optional BYOK Anthropic key
  inferenceModel          Default model (default: gpt-5.2)
  maxTokensPerTurn        Max tokens per inference call (default: 4096)
  heartbeatConfigPath     Path to heartbeat.yml
  dbPath                  Path to SQLite database
  logLevel                debug | info | warn | error
  walletAddress           Agent's Ethereum address
  version                 Runtime version
  skillsDir               Skills directory path
  maxChildren             Max child automatons (default: 3)
  parentAddress           Parent's address (if this is a child)
  socialRelayUrl          Social relay URL
  treasuryPolicy          Financial limits (TreasuryPolicy)
  soulConfig              Soul system config
  modelStrategy           Model routing config
```

**Deep-merged fields:** `modelStrategy` and `soulConfig` are merged with defaults so partial overrides work correctly. `treasuryPolicy` goes through `normalizeTreasuryPolicy`: any field that is not a finite number >= 0 (whatever its type) takes its default, with a warning.

**Loading:** `loadConfig()` returns null only when the file is missing and throws `ConfigError` when it cannot be read or parsed.

**Saving:** `saveConfig()` writes the whole file atomically (temp file + rename) and is used by the wizard, `--configure` and `--pick-model`. The running agent never writes its startup snapshot back: `updateConfigFile({ genesisPrompt?, inferenceModel? })` re-reads the file, changes only those keys (and `modelStrategy.inferenceModel` when present), and writes atomically; on a missing or corrupt file it throws and writes nothing.

---

## Security Model

The automaton operates under a defense-in-depth security model:

**Layer 1 — Constitution** (immutable): Three laws hierarchy. Cannot be modified by the agent. Protected by path protection rules.

**Layer 2 — Policy engine** (pre-execution): Every tool call evaluated against 6 rule categories before execution. First deny wins. All decisions audited.

**Layer 3 — Injection defense** (input sanitization): 8 detection checks on all external input: instruction patterns, authority claims, boundary manipulation, ChatML markers, encoding evasion, multi-language injection, financial manipulation, self-harm instructions.

**Layer 4 — Path protection** (filesystem, `src/security/protected-paths.ts`): Protected paths cannot be written (state directory outside its writable entries, secrets, shell startup files, system directories, guard code). Sensitive paths cannot be read (secret files and directories, system secrets, the state directory outside its readable allowlist). Rules are checked on the lexical and the real path; links in the final component are refused. The policy rules check before the call, and `secure-fs.ts` checks again at the moment of I/O for local `read_file`/`write_file`, `edit_own_file`, worker file tools and the runtime's state writers.

**Layer 5 — Command safety** (shell): the exec tripwire denies commands that name secrets, reach into the state directory, glob hidden home paths, dump the environment, kill the runtime or write guard files. It is a tripwire, not a boundary: exec runs as the wallet's OS user. Rate limits on self-modification operations.

**Layer 5b — Secrets out of reach:** API keys are not copied into `process.env`; every command (agent and workers) gets `childProcessEnv()`, without credential-shaped variables (operator tokens such as `GITHUB_TOKEN` included). Registered secrets are redacted from inference requests and logs (`secret-redaction.ts`).

**Layer 6 — Financial limits** (treasury): Every outflow passes through the Treasury, which reserves it against rolling caps per budget, the minimum reserve and single-flight rules before anything is sent or signed. Inference spend has its own caps, enforced by the inference gate.

**Fail closed:** a policy rule that throws denies the call (`POLICY_RULE_ERROR`), `executeTool` turns a failing policy evaluation into an error result without running the tool, and a tool exception is recorded as that call's error, so a bad argument never discards a turn whose earlier tools already ran.

**Layer 7 — Authority hierarchy** (trust levels): Creator input has highest trust. Self-generated input is trusted. Peer/external input has reduced trust and cannot invoke dangerous tools.

---

## Testing

**Location:** `src/__tests__/` — 24 test files, 897 tests

| Area | Files | Tests |
|---|---|---|
| Core loop | `loop.test.ts` | State transitions, tool execution, idle detection, inbox |
| Security | `injection-defense.test.ts`, `command-injection.test.ts`, `tools-security.test.ts` | Input sanitization, shell injection, tool risk levels |
| Policy | `policy-engine.test.ts`, `authority-rules.test.ts`, `financial.test.ts`, `path-protection.test.ts` | Rule evaluation, authority, treasury, path blocks |
| Financial | `spend-tracker.test.ts`, `treasury/treasury-core.test.ts`, `treasury/treasury-credits.test.ts`, `treasury/treasury-credits-repro.test.ts`, `treasury/treasury-usdc.test.ts` | Spend recording; the Treasury state machine, every gate invariant, concurrency, crash recovery; credit transfers, child funding, sandboxes and domains through the gate; x402 payments and topups through the gate |
| Heartbeat | `heartbeat.test.ts`, `heartbeat-scheduler.test.ts` | Tasks, scheduler, tick context, leases |
| Network | `http-client.test.ts` | Retries, backoff, circuit breaker, idempotency |
| Inference | `inference-router.test.ts` | Router, registry, budget, routing matrix |
| Memory | `memory.test.ts` | All 5 tiers, budget, retrieval, ingestion |
| Soul | `soul.test.ts` | Parsing, validation, alignment, history |
| Social | `social.test.ts` | Signing, validation, discovery, caching |
| Replication | `replication.test.ts`, `lifecycle.test.ts` | Spawn, lifecycle, health, constitution |
| Data | `data-layer.test.ts`, `database-transactions.test.ts` | DB operations, migrations, transactions |
| Skills | `skills-hardening.test.ts` | Name validation, frontmatter, sanitization |
| Context | `context-hardening.test.ts` | Token budget, truncation, trust boundaries |
| Inbox | `inbox-processing.test.ts` | Message state machine |
| Observability | `observability.test.ts` | Logger, metrics, alerts |

**Test infrastructure:** Mock clients for inference, Conway API, and social relay (`src/__tests__/mocks.ts`). In-memory SQLite for all DB tests.

---

## Build and CI

**Build:** TypeScript 5.9, target ES2022, ESM modules, strict mode.

```
pnpm build       # tsc + workspace builds
pnpm test        # vitest run (897 tests)
pnpm typecheck   # tsc --noEmit
```

**CI** (`.github/workflows/ci.yml`):
- Triggers on push and PR
- Matrix: Node 20, 22
- Steps: install, typecheck, test, security-grep tests
- Separate `security-audit` job: `pnpm audit`

**Release** (`.github/workflows/release.yml`):
- Triggers on `v*` tags
- Steps: typecheck, test, build

**Scripts:**
- `scripts/automaton.sh` — curl-pipe bootstrap installer
- `scripts/backup-restore.sh` — database backup/restore
- `scripts/soak-test.sh` — long-running stability test

---

## Module Dependency Graph

```
index.ts
  |
  +-> identity/{wallet, provision}
  +-> config
  +-> state/{database, schema}
  +-> conway/{client, inference, topup}
  +-> heartbeat/{daemon, config}
  |     +-> heartbeat/{scheduler, tasks, tick-context}
  |           +-> conway/{credits, x402}
  |           +-> soul/reflection
  |           +-> inference/registry
  |           +-> replication/{lifecycle, health, cleanup, lineage}
  |           +-> observability/{metrics, alerts}
  +-> agent/loop
  |     +-> agent/{tools, system-prompt, context, injection-defense}
  |     +-> agent/{policy-engine, spend-tracker}
  |     |     +-> agent/policy-rules/{authority, command-safety, financial, path-protection, rate-limits, validation}
  |     +-> inference/{router, registry, budget}
  |     +-> memory/{retrieval, ingestion}
  |     |     +-> memory/{working, episodic, semantic, procedural, relationship, budget}
  |     +-> conway/{credits, x402}
  |     +-> state/database
  +-> social/client
  +-> skills/loader
  +-> git/state-versioning
  +-> observability/logger (used by all modules)
```

All modules import types from `src/types.ts`. All modules use `createLogger()` from `src/observability/logger.ts`.
