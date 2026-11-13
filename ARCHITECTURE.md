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
- [Colony Orchestration](#colony-orchestration)
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
    injection-defense.ts   Inbound screening (once, at ingest) and render-time neutralisation
    text-normalize.ts      Folded text for detectors only (NFKC, invisibles, look-alikes)
    inbox-isolation.ts     Inbox turn labels, reply-only rule, isolated-turn checks
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
    pretty-sink.ts         Human-readable log sink
    terminal-safe.ts       Escapes control characters for terminal output

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
    client.ts              Social relay HTTP client (poll classifies every message)
    signing.ts             Message signing + the canonical send string
    inbound.ts             Inbound verdict: verified / unverified / rejected
    validation.ts          Outbound message checks, relay URL check
    protocol.ts            Signature verification (EVM EIP-191, Solana ed25519)

  registry/                On-chain identity
    agent-card.ts          ERC-8004 agent card builder (JSON-LD)
    discovery.ts           Agent discovery via registry contract
    safe-fetch.ts          Bounded HTTPS fetch of agent cards (public addresses only)
    erc8004.ts             On-chain contract interaction (viem)

  replication/             Child automaton management
    spawn.ts               Child creation (slot, sandbox, runtime clone, genesis, wallet)
    lifecycle.ts           Status machine writer + stopChild
    child-status.ts        Status sets (slot-holding, live, ended) + DB timestamp parsing
    health.ts              Child process probe (in the child's sandbox) + kill/verify
    cleanup.ts             Ended child -> cleaned_up (sandboxes are not deleted)
    constitution.ts        Constitution propagation + verification
    genesis.ts             Genesis config generation + validation
    lineage.ts             Parent-child lineage tracking + pruning
    messaging.ts           Parent-child message relay

  orchestration/           Colony goals and tasks
    orchestrator.ts        Phase machine (plan, execute, replan) over one goal at a time
    planner.ts             Planner/replanner prompts + output validation
    task-graph.ts          Task DAG, ownership-guarded settle/release, progress
    local-worker.ts        In-process worker pool (runs harnesses on tasks)
    health-monitor.ts      Colony health report on live children (report-only)
    messaging.ts           Colony message envelopes (no transport reaches children)

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
- **Balance caching:** Caches last known balances in KV (`last_known_balance`). On a failed read the loop uses the cached value marked `cached` (the prompt says so, and its tier line is never `dead`), or else `null` (shown as unknown). A cached or unknown balance only steers model routing: it never buys credits and never marks the agent dead.

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
3. **Financial rules** — enforces TreasuryPolicy: per-payment caps, hourly/daily transfer limits, minimum reserve, x402 domain allowlist, inference daily budget. A transfer above `requireConfirmationAboveCents` gets `quarantine`, which `executeTool` treats as a refusal (no approval flow exists); the default `maxSingleTransferCents` equals that threshold, and a larger configured value logs a startup warning
4. **Path protection rules** — blocks writes to protected files (constitution, wallet, DB, config); blocks reads of sensitive files (private key, API keys)
5. **Rate limit rules** — caps on spawns (3/day), own-code edits (10/hour) and genesis prompt changes (1/day), counted from effects (children rows, sandbox creations with an unknown outcome, `modifications` rows), never from logged `allow` decisions
6. **Validation rules** — input format validation (package names, URLs, domains, git hashes, recipient addresses: `transfer_credits`/`fund_child` on the automaton's own chain, `send_message` EVM or Solana, zero/system addresses refused)

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
+-------------------+  Short-term, capped at 20 entries
| Working Memory    |  Goals, observations, plans, reflections
+-------------------+  Goals archived to episodic when over the cap
        |
+-------------------+  Event log
| Episodic Memory   |  Tool calls, decisions, outcomes
+-------------------+  Importance-ranked; kept 30 days (180 if >= 0.8)
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

**Ingestion** (`MemoryIngestionPipeline`): After each turn, classifies the turn and extracts: episodic events (significant tool calls), semantic facts (learned information), procedural outcomes (procedure success/failure tracking). Inbox turns write nothing to memory. From `discover_agents` only ids and owners are stored, read from each line's fixed `#<id> (<owner>)` prefix (card text is flattened to one line and comes after it).

**Protections** (`memory/tools.ts`): `forget` cannot delete `creator` facts, and `remember_fact` writes the `creator` category only from a creator-sourced turn (taken from the tool call's turn context, never from arguments); the stored source is the turn's, not a claimed one.

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
| `check_usdc_balance` | `*/5 * * * *` | $5 survival topup when credits are critical and USDC >= $5 (EVM only); wake on success, failures deduplicated per 6 h |
| `check_for_updates` | `0 */4 * * *` | Git upstream monitoring (dedup: only new commits) |
| `health_check` | `*/30 * * * *` | Sandbox liveness (dedup: only first failure) |
| `check_child_health` | `*/10 * * * *` | Probe live children, apply starting/healthy/unhealthy/failed (no children: no probes) |
| `check_social_inbox` | `*/2 * * * *` | Poll social relay (5min backoff on error) |
| `soul_reflection` | configurable | Soul alignment check |
| `refresh_models` | configurable | Model registry refresh from API |
| `prune_dead_children` | configurable | Cleanup dead child records/sandboxes |
| `report_metrics` | configurable | Metrics snapshot + alert evaluation |

**Wake events:** Tasks that detect actionable conditions insert atomic wake events into the `wake_events` table. The scheduler is their only writer. The main run loop checks this table every 30 seconds during sleep, and the reasons (neutralised, never screened or rate limited; inbox wakes as a generic sentence, and the inbox task's own reason carries counts only) are shown in the first prompt of the wake.

**Balance-driven tasks:** a failed or malformed balance read is unknown, never 0. `TickContext.creditBalance` (and `usdcBalance`) is then `null`, `creditRead`/`usdcRead` say why (`{ known: false, reason, detail }`), and `survivalTierKnown` is false. The tier is the last known tier (`last_known_tier` KV) or else `low_compute`, never `critical` or `dead` from a failed read. `check_credits`, `check_usdc_balance` and the `heartbeat_ping` distress do nothing on an unknown balance: no topup, no distress, and the zero-credit streak (`zero_credits_since`) is neither started, extended nor ended. The outage start is kept in `balance_unknown_since` and a warning is logged at most once an hour; it never wakes the agent. Any successful read clears `balance_unknown_since` and records the tier; a read above 0 clears `zero_credits_since`. In the agent loop a cached balance (`last_known_balance`) can steer model routing but never buys credits and never marks the agent dead: only a live read can.

---

## Financial System

The automaton's survival depends on two balances:

1. **Conway credits** (cents) — prepaid compute credits for sandboxes, inference, domains
2. **USDC** (on-chain) — on Base mainnet for an EVM automaton, on Solana mainnet for a Solana automaton (read only: x402 payments and topups need an EVM wallet and are refused on Solana)

**Balance reads** (`src/conway/balance.ts`): `getCreditsBalance` and `getUsdcBalance` throw `BalanceUnavailableError` (or the HTTP error) on anything they cannot trust: HTTP/RPC errors, timeouts, an open circuit, a response without a finite numeric balance. `readCredits`/`readUsdc` wrap them in `{ known: true, value } | { known: false, reason, detail }`, so every caller must handle "could not read" separately from 0.

**Survival tiers** (`src/conway/credits.ts`):

| Tier | Credits | Behavior |
|---|---|---|
| `high` | > $5.00 | Normal operation |
| `normal` | > $0.50 | Normal operation |
| `low_compute` | > $0.10 | Model downgrade, reduced heartbeat frequency |
| `critical` | >= $0.00 | Zero credits, alive. Distress signals, accept funding. |
| `dead` | < $0.00 | Only reachable via 1-hour heartbeat grace period at zero credits |

**Credit topup** (`src/conway/topup.ts`): The agent buys credits from USDC via the x402 payment protocol. On startup, `bootstrapTopup()` buys the minimum $5 tier when credits are below $5 and USDC is at least $5 (skipped when either balance cannot be read). At runtime, the agent uses `topup_credits` tool to choose larger tiers ($5/$25/$100/$500/$1000/$2500). Every purchase is a Treasury outflow: the signed amount may not exceed the requested tier, the credits must be for this automaton, and the purpose picks the budget (`manual`, `sandbox_402`, or `survival` for the automatic $5 buys, which the gate allows only when its own balance read is low). `x402Fetch` with purpose `topup` requires a 402 from `/pay/`: any other answer to the unpaid request is a failed topup with nothing paid, never a purchase. A sandbox 402 buys only the smallest tier that covers the stated deficit, and nothing when the deficit is unparseable or larger than every tier.

**x402 protocol** (`src/conway/x402.ts`): HTTP 402 payment flow. Server returns payment requirements; the client checks them (exact USDC on Base, amount, deadline), reserves the payment with the Treasury with its nonce and `validBefore` (at most 600s ahead), then signs a USDC `TransferWithAuthorization` (EIP-3009) and sends the request once more with the `X-Payment` header. A 2xx commits the ledger row; a refused connection releases it; any other failure after sending leaves it `unknown` until `authorizationState` on chain says whether it was used. Amounts are atomic USDC units (6 decimals) in every protocol version, parsed by `parseAtomicAmount` (digit string or safe integer; decimals, exponents and signs refused; `amount` and `maxAmountRequired` must agree); cents limits round up (`centsFromAtomic`), and a topup must quote exactly its tier. The EIP-712 domain comes from the network's canonical USDC contract (`USD Coin`/`USDC`, version 2) and the payload echoes the server's network string. The probe and the paid request use `redirect: "manual"` and the paid request `retries: 0`, so `X-Payment` never reaches a host other than the one the Treasury checked and a signed payment is never re-sent. Topups use their own HTTP client, so a failing third-party x402 host cannot open the topup circuit.

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

Each automaton has a unique EVM or Solana identity (`chainType` in the config):

- **Wallet** (`wallet.ts`): Generated on first run (secp256k1 via `viem`, or an Ed25519 keypair for Solana). Stored at `~/.automaton/wallet.json` (mode 0600). The private key is never exposed to the agent via tools (blocked by path protection rules).
- **Provisioning** (`provision.ts`): Signs a SIWE (Sign-In With Ethereum) message to authenticate with Conway API. Receives an API key stored at `~/.automaton/api-key`.
- **On-chain identity** (`registry/erc8004.ts`): Optional ERC-8004 agent registration on Base. Publishes a JSON-LD agent card with capabilities, services, and contact info. The register transaction is signed and recorded as pending before it is sent, so a lost send response is resumed rather than re-sent; a token the wallet owns from a recorded register (even one marked dropped or replaced) is adopted instead of refused. The system prompt shows the chain of the identity it reports.

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

**Resilient HTTP** (`http-client.ts`): All API calls go through `ResilientHttpClient`. Only idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE) are retried automatically (default 3 on 429/5xx, jittered exponential backoff); a POST or PATCH is sent once unless the caller passes `retryUnsafe` because the server deduplicates it by its `Idempotency-Key`. Redirects are not followed: a 3xx is returned to the caller, unless it opts in with `followRedirects` (at most 3 hops, GET/HEAD only, same origin, HTTPS, never with an `X-Payment` header); anything else throws `RedirectRefusedError`. The circuit breaker (5 failures -> 60s open) is per origin, so one failing host does not block the others. The Conway client re-sends a 404 (load-balancer routing bug) only for idempotent methods or requests that carry an `Idempotency-Key`, reusing the key. Value-moving calls (`transferCredits`, `createSandbox`, `registerDomain`) carry a ulid key and are sent with `retries: 0` and `redirect: "manual"`; a timeout, 5xx or redirect is an unknown outcome for the Treasury, never a silent re-send. A credit transfer is re-sent only by the Treasury, with the original key.

---

## Self-Modification

**Files:** `src/self-mod/`

The automaton can modify its own code:

- **File editing** (`code.ts`): `edit_own_file` tool applies diffs to source files. Protected files (constitution, wallet, DB, config) are blocked by path protection rules. All edits are logged to the `modifications` table. Each edit commits only its file; the tool records the new `self-mod:` commit's sha in KV `self_mod.commits` (only when this edit created it).
- **Revert** (`tools.ts`): `revert_last_edit` reverts the newest recorded sha (`git revert --no-edit <sha>`, with the same fallback identity as the edit's commit) after checking it is an ancestor of HEAD and touches no protected file. A revert git applied but could not commit is rolled back with `git reset --merge`. Failed, stale or refused entries are dropped with a message, so a bad entry never blocks older ones. Operator commits are never reverted. `reset_to_upstream` clears the list.
- **Restart notice** (`restart-notice.ts`): every tool that rebuilds says the running process keeps the old code and sets KV `restart_required`.
- **Upstream pulls** (`upstream.ts`): `check_for_updates` heartbeat task monitors the git remote. `review_upstream_changes` returns an index of upstream commits (flagging protected and guard files and install/build inputs: package files, lockfile, `.npmrc`, `.pnpmfile.*`, `tsconfig*.json`, `scripts/`) and then each commit's full `git show` diff in 8,000-character pages, recording which pages were read and a hash of each diff in KV (`upstream.review`). `pull_upstream` cherry-picks individual commits (hex hashes only) that were fully read and are unchanged, or fast-forwards to the reviewed target commit only when every commit up to it was read and HEAD is on the target's first-parent history, so the reviewed first-parent diffs add up to the fast-forward (never `git pull`). Review pages show invisible characters as visible escapes. It runs every command with `cd` into the runtime's repo (`process.cwd()`), and aborts a failed cherry-pick. `reset_to_upstream` is two calls: a plan, then a reset to the confirmed target hash. Installs run with dependency scripts off, then a native rebuild from a fixed list, then the build, each with its own timeout; the build runs upstream-defined scripts, so applying upstream code trusts origin. The automaton is not obligated to accept all upstream changes.
- **Tool installation** (`agent/tools.ts`; `tools-manager.ts` holds older helpers no tool calls): `install_npm_package` adds packages. `install_mcp_server` validates the tool name (`^[a-zA-Z0-9_-]{1,64}$`, not a builtin, not installed) and installs the package, but MCP tools are not offered to the model: there is no MCP client. `loadInstalledTools` skips invalid, duplicate, builtin-colliding and MCP entries.
- **Audit log** (`audit-log.ts`): Every modification is recorded with timestamp, type, diff, and hash for creator review.

The `~/.automaton/` directory is a git repository: `SOUL.md` and `skills/` are committed on each soul update and skill install, creation or removal (`WORKLOG.md` and `heartbeat.yml` ride along). Code edits are committed in the runtime repo instead. The git tools default to it, expanding `~` before the path is quoted, and treat a failing git command as an error.

---

## Replication

**Files:** `src/replication/`

Children are independent automatons with their own mission. They never execute colony tasks.

1. **Spawn** (`spawn.ts`): counts slot-holding children and inserts the `requested` row in one `BEGIN IMMEDIATE` transaction, so concurrent spawns cannot both take the last slot. Then it creates (or safely reuses) a sandbox sized by `childSandboxMemoryMb`, clones and builds the runtime from `childRuntimeRepo`/`childRuntimeRef` (default: upstream, default branch), writes `genesis.json` and verifies the wallet (`wallet_verified`). It neither funds nor starts the child. A checkout without the genesis bootstrap gets an `automaton.json` written by the parent; production colonies should use a runtime that bootstraps from `genesis.json`. `maxChildren: 0` refuses before anything is bought.
2. **Status machine** (`lifecycle.ts`, `child-status.ts`): one `children` row per child (unique non-empty address). `children.status` equals the latest `child_lifecycle_events.to_state`; only `ChildLifecycle.transition` writes it. States: `requested -> sandbox_created -> runtime_ready -> wallet_verified -> funded -> starting -> healthy <-> unhealthy`, ending in `stopped` or `failed`, then `cleaned_up` (terminal). All states before `stopped`/`failed` hold a slot; legacy rows without events hold one in `spawning`/`running`/`sleeping`/`unknown`, and `dead` is terminal. Nothing moves an ended child back to a live state.
3. **Health** (`health.ts`): `ChildHealthMonitor` is the only liveness prober. It runs `pgrep` inside the child's sandbox and applies the result: `starting -> healthy` (seen) or `-> failed` (confirmed gone after 10 min), `healthy <-> unhealthy`, `unhealthy -> failed` after 30 min. Only a confirmed-gone sandbox counts as offline; an API error changes nothing. The `check_child_health` heartbeat (every 10 min) and `check_child_status` use it.
4. **Stop** (`stopChild` in `lifecycle.ts`, tool `stop_child`): kills the process and verifies it gone before `stopped`; abandons never-started children and stuck spawns to `failed`; `force` marks an unreachable live child `failed` with `processUnverified` in the event metadata.
5. **Constitution** (`constitution.ts`): Parent's constitution is propagated to every child. Constitution integrity can be verified (hash comparison).
6. **Genesis** (`genesis.ts`): Generates genesis config with injection-pattern validation and length limits.
7. **Messaging** (`messaging.ts`): Parent-child message relay with rate/size limits.
8. **Cleanup and pruning** (`cleanup.ts`, `lineage.ts`): `stopped`/`failed` -> `cleaned_up` (Conway sandboxes cannot be deleted). A force-stopped child, or a legacy ended row, is cleaned up only after a kill in its sandbox is verified, so a child that may still run is never untracked. `pruneDeadChildren` deletes old ended rows only after cleanup succeeds.

The colony `HealthMonitor` (`src/orchestration/health-monitor.ts`) reports on live children only. It does not restart, stop, reassign or message, and funds out-of-credit children only with its `autoFund` option, which is off by default. `agent_pool_optimize` only reports.

---

## Colony Orchestration

**Files:** `src/orchestration/`, `src/agent/harnesses/`

The orchestrator ticks once per agent-loop cycle and works one goal at a time through `idle -> classifying -> planning -> plan_review -> executing -> complete`, with `replanning` and `failed`. Every phase but `idle` first runs a goal guard: a goal that is gone, cancelled, completed or paused has its workers aborted and its held tasks released, and the orchestrator returns to `idle`. The planning and replanning phases save their new tasks and the next phase in one transaction.

- **Local workers only.** Tasks run on `LocalWorkerPool` workers (in-process harnesses), at most `max(1, maxChildren)` at once, with no children row. The task is assigned to `local://<worker>` before the worker starts. With `disableSpawn` or no pool, the parent self-assigns.
- **Remote delegation is disabled and fails fast.** A task in `assigned`/`running` whose owner is neither `local://` nor the parent is released on the next executing tick without spending a retry (`remote_delegation_unsupported` event). `LocalDBTransport.deliver` throws `ColonyTransportUnavailableError`.
- **Ownership** (`task-graph.ts`): only the owner settles a task (`settleTask` guards on `assigned_to` and status). A settle that matches no row is a late result: dropped, logged as a `stale_task_report` event, with `actual_cost_cents` raised to the reported spend. Workers check ownership every turn and exit silently when they lost the task.
- **Executing tick:** release remote owners, release dead local owners (retry spent), abort workers past `started_at + timeout_ms + 2 min` and fail their task (retry spent), reap workers whose task was taken, spawn workers for ready tasks, then complete, replan, fail or wait. A goal whose remaining work can never become ready is replanned or failed.
- **Replanning:** pending/blocked/failed tasks of the goal are cancelled (`superseded_by_replan`); running and completed tasks are kept. The planner gets the titles of completed and in-progress tasks and repeats a title to depend on one; a planned task with an existing task's title is bound to that task.
- **Planner clamps:** estimate 0-500 cents (so the per-task inference cap `max(2 x est, 50)` stays at most 1000 cents), timeout 60 s - 1 h, `maxRetries` 0-10.
- **`cancel_goal`:** goal and every unfinished task `cancelled`; the next tick aborts their workers.
- **Harness loop detector** (`src/agent/loop-detector.ts`): blocks the third identical call in a row and fails the attempt on the fourth identical turn; `wait_for_tasks` is exempt and separates calls and turns on either side.

---

## Social Layer

**Files:** `src/social/`, `src/registry/`

**Agent-to-agent messaging:**
- Messages are signed with the sender's key (EVM EIP-191 or Solana ed25519) over `Conway:send:{to}:{keccak256(content)}:{signed_at}`
- Sent via Conway social relay (`social.conway.tech`)
- Polled by heartbeat every 2 minutes
- Each polled message gets one verdict (`social/inbound.ts`). **Verified**: the relay supplied `signature` and `signed_at`, the signature checks out against the claimed sender over the canonical string addressed to our own address, and `signed_at` is at most 7 days old and 2 minutes ahead. **Unverified**: no signature, or a valid signature whose `signed_at` is outside that window; delivered, labelled `NOT VERIFIED`, and the sender address is never treated as authenticated. **Rejected** (logged, not stored): a failing signature, a signature without a readable `signed_at`, an invalid sender, a relay `to` that is not us, content over 64,000 characters. Replays are stopped by the signed-content hash (`sig_hash`, unique, rows never deleted), which a downgraded message keeps. The relay does not return signatures today, so every message is unverified until it does.
- Replays: `sig_hash` (a hash of the sender and the signed string, not of the signature bytes, which ECDSA lets a relay re-encode) under a unique index; unsigned exact re-deliveries are deduplicated the same way. The relay's id and nonce are not trusted.
- Screened once at ingest (`injection-defense.ts`); the original text and the verdict are stored and the inbox turn renders from them. Blocked: only content over 64,000 characters (the relay and signing limit); nothing is dropped for what it says. Everything detected is delivered with a warning and its markers neutralised. Rate limit: 10 per minute per sender, signed and unsigned counted apart, from stored rows, measured against the sender's time clamped to [previous successful poll, now] however long the gap (7 days back when no poll is recorded). Each poll also makes at most 10 per minute since the previous successful poll claimable per sender, less what it made claimable in the last real minute (`available_at`). Rows over either limit are stored `deferred` and released oldest first at later polls (at most 1,800 waiting per sender; beyond that `rate_limited`). `blocked` and `rate_limited` rows are logged at warn, kept for the operator and never claimed.
- Claim order: verified first; a batch never mixes signed and unsigned rows. Only a verified batch sees earlier (verified) turns from that sender. Only verified senders get relationship records, count for child liveness or appear in soul reflection. Relay rows keep `to_address` NULL (the colony router treats a recipient as a colony message).

**Agent discovery:**
- ERC-8004 registry contract on Base
- Agents publish JSON-LD agent cards with capabilities and services
- Cards are fetched through `registry/safe-fetch.ts`: HTTPS only, internal names refused, every resolved address must be public and the connection uses the checked address, at most 3 redirects each re-checked, no compressed bodies, streamed size cap and one overall deadline. The configured IPFS gateway origin skips only the address check.
- Cards are cached per chain, registry contract and agent id, and a cache hit requires the same agent URI
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

**History:** All soul versions are stored in `soul_history` with content hashes for tamper detection. `updateSoul` writes a default soul only when `SOUL.md` is missing; an existing file it cannot read (over 64 KiB, not a regular file) makes the update fail instead.

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
- Rendered inside untrusted-content markers, with prompt boundary tags and special tokens neutralised (ordinary words such as `tool_call` are left alone)
- Can be installed from git repos, URLs, or created by the agent itself
- Active skill instructions are injected into the system prompt with trust boundary markers

---

## Observability

**Files:** `src/observability/`

**Structured logging** (`logger.ts`): `StructuredLogger` with module namespacing, log levels (debug/info/warn/error/fatal), JSON context serialization. Global log level configurable. All modules use `createLogger(moduleName)`. Log text may come from untrusted sources, so the pretty sink, the stderr fallback and the CLI's `logs`, `status`, `send` and `fund` commands show control characters in visible `\x1b`-style notation (`terminal-safe.ts`), the sinks with newlines escaped too (one entry, one line), and the JSON sink escapes C1, line separator and bidi characters as `\uXXXX`.

**Metrics** (`metrics.ts`): `MetricsCollector` singleton with counters (monotonic), gauges (point-in-time), and histograms (percentile buckets). Metrics snapshot saved to `metric_snapshots` table by heartbeat.

**Alerts** (`alerts.ts`): `AlertEngine` evaluates rules against metric snapshots. Default rules: low balance, high error rate, high deny rate, capacity saturation, budget exhaustion, unhealthy children, excessive turns. Cooldown periods prevent alert spam. Critical alerts wake the agent.

---

## Database and Schema

**Files:** `src/state/schema.ts`, `src/state/database.ts`

**Engine:** SQLite via `better-sqlite3` (synchronous, WAL mode, journal_mode=WAL).

**Schema version:** 16 (applied incrementally via migration runner)

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
| `inbox_messages` | v3 | Social messages with processing state machine; v16 adds `verified`, `sig_hash` (unique), `signed_at`, `relay_created_at`, `screen`, `available_at` and the `deferred`/`blocked`/`rate_limited` statuses |
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
  maxChildren             Slot-holding children (default: 3; 0 disables spawn_child); local workers max(1, maxChildren)
  childSandboxMemoryMb    Child sandbox memory tier (default: 1024)
  childRuntimeRepo        https git URL a child's runtime is cloned from (default: upstream)
  childRuntimeRef         Optional branch or tag of childRuntimeRepo
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

**Layer 3 — Injection defense** (a speed bump; isolation is the boundary): inbound messages are screened once at ingest on folded text (NFKC, invisible characters removed, look-alikes mapped for Latin patterns) for prompt structure, instructions and authority claims in any language, financial requests, destructive commands and obfuscation. Only oversized messages are dropped; everything else, including model-control syntax and override phrases, is delivered with a warning to the reply-only turn. Stored text is never rewritten: untrusted text (messages, tool results, worklog, genesis, skills) is neutralised when rendered. The inbox turn labels each sender as signature-verified or not.

**Layer 4 — Path protection** (filesystem, `src/security/protected-paths.ts`): Protected paths cannot be written (state directory outside its writable entries, secrets, shell startup files, system directories, guard code). Sensitive paths cannot be read (secret files and directories, system secrets, the state directory outside its readable allowlist). Rules are checked on the lexical and the real path; links in the final component are refused. The policy rules check before the call, and `secure-fs.ts` checks again at the moment of I/O for local `read_file`/`write_file`, `edit_own_file`, worker file tools and the runtime's state writers.

**Layer 5 — Command safety** (shell): the exec tripwire denies commands that name secrets, reach into the state directory, glob hidden home paths, dump the environment, recursively read the home or root directory (`.` counts as home, since exec starts there), kill the runtime (including `xargs kill`, backticks, a loop over `pgrep`/`pidof`/`ps` output, its own PID, `kill 0` and `pkill -f` patterns matching its own command line), or write guard files (including through inline interpreters and git rewrite commands). It is a tripwire, not a boundary: exec runs as the wallet's OS user, so a script written to disk, string building, a short glob or a multi-step command gets past it. The recommended deployment runs exec as a separate unprivileged OS user (or in a container or bubblewrap sandbox) without read access to `~/.automaton` or write access to the runtime checkout. Rate limits on self-modification operations.

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
