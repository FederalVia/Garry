/**
 * Automaton SQLite Schema
 *
 * All tables for the automaton's persistent state.
 * The database IS the automaton's memory.
 */

export const SCHEMA_VERSION = 17;

export const CREATE_TABLES = `
  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Core identity key-value store
  CREATE TABLE IF NOT EXISTS identity (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Agent reasoning turns (the thinking/action log)
  -- Application-level validation: state must be a valid AgentState ('setup','waking','running','sleeping','low_compute','critical','dead')
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    state TEXT NOT NULL,
    input TEXT,
    input_source TEXT,
    thinking TEXT NOT NULL,
    tool_calls TEXT NOT NULL DEFAULT '[]',
    token_usage TEXT NOT NULL DEFAULT '{}',
    cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Tool call results (denormalized for fast lookup)
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id),
    name TEXT NOT NULL,
    arguments TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Heartbeat configuration entries
  -- Application-level validation: enabled must be 0 or 1 (boolean integer)
  CREATE TABLE IF NOT EXISTS heartbeat_entries (
    name TEXT PRIMARY KEY,
    schedule TEXT NOT NULL,
    task TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    next_run TEXT,
    params TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Financial transaction log
  -- Application-level validation: type must be one of 'transfer_out','transfer_in','credit_purchase','topup','x402_payment','inference'
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    amount_cents INTEGER,
    balance_after_cents INTEGER,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Installed tools and MCP servers
  CREATE TABLE IF NOT EXISTS installed_tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT DEFAULT '{}',
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1
  );

  -- Self-modification audit log (append-only)
  CREATE TABLE IF NOT EXISTS modifications (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    file_path TEXT,
    diff TEXT,
    reversible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- General key-value store for arbitrary state
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Installed skills
  CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    auto_activate INTEGER NOT NULL DEFAULT 1,
    requires TEXT DEFAULT '{}',
    instructions TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'builtin',
    path TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Spawned child automatons
  -- Application-level validation: status must be one of 'spawning','running','sleeping','dead','unknown'
  CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    genesis_prompt TEXT NOT NULL,
    creator_message TEXT,
    funded_amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'spawning',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked TEXT
  );

  -- ERC-8004 registration state. Token ids are per chain, so mainnet and
  -- testnet can mint the same id.
  CREATE TABLE IF NOT EXISTS registry (
    agent_id TEXT NOT NULL,
    agent_uri TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'eip155:8453',
    contract_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chain, agent_id)
  );

  -- Reputation feedback received and given
  -- Application-level validation: score must be 1-5
  CREATE TABLE IF NOT EXISTS reputation (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    score INTEGER NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    tx_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Indices for common queries
  CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);
  CREATE INDEX IF NOT EXISTS idx_turns_state ON turns(state);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
  CREATE INDEX IF NOT EXISTS idx_modifications_type ON modifications(type);
  CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
  CREATE INDEX IF NOT EXISTS idx_children_status ON children(status);
  CREATE INDEX IF NOT EXISTS idx_reputation_to ON reputation(to_agent);

  -- Inbox messages table
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    from_address TEXT NOT NULL,
    content TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    reply_to TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
    ON inbox_messages(received_at) WHERE processed_at IS NULL;
`;

export const MIGRATION_V3 = `
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    from_address TEXT NOT NULL,
    content TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    reply_to TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
    ON inbox_messages(received_at) WHERE processed_at IS NULL;
`;

export const MIGRATION_V4 = `
  -- Policy decisions table
  CREATE TABLE IF NOT EXISTS policy_decisions (
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    tool_name TEXT NOT NULL,
    tool_args_hash TEXT NOT NULL,
    risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','caution','dangerous','forbidden')),
    decision TEXT NOT NULL CHECK(decision IN ('allow','deny','quarantine')),
    rules_evaluated TEXT NOT NULL DEFAULT '[]',
    rules_triggered TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_policy_decisions_turn ON policy_decisions(turn_id);
  CREATE INDEX IF NOT EXISTS idx_policy_decisions_tool ON policy_decisions(tool_name);
  CREATE INDEX IF NOT EXISTS idx_policy_decisions_decision ON policy_decisions(decision);

  -- Spend tracking table
  CREATE TABLE IF NOT EXISTS spend_tracking (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    recipient TEXT,
    domain TEXT,
    category TEXT NOT NULL CHECK(category IN ('transfer','x402','inference','other')),
    window_hour TEXT NOT NULL,
    window_day TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_spend_hour ON spend_tracking(category, window_hour);
  CREATE INDEX IF NOT EXISTS idx_spend_day ON spend_tracking(category, window_day);

  -- Heartbeat schedule (Phase 1.1)
  CREATE TABLE IF NOT EXISTS heartbeat_schedule (
    task_name TEXT PRIMARY KEY,
    cron_expression TEXT NOT NULL,
    interval_ms INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    max_retries INTEGER NOT NULL DEFAULT 1,
    tier_minimum TEXT NOT NULL DEFAULT 'dead'
      CHECK(tier_minimum IN ('dead','critical','low_compute','normal','high')),
    last_run_at TEXT,
    next_run_at TEXT,
    last_result TEXT CHECK(last_result IN ('success','failure','timeout','skipped') OR last_result IS NULL),
    last_error TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Heartbeat history (Phase 1.1)
  CREATE TABLE IF NOT EXISTS heartbeat_history (
    id TEXT PRIMARY KEY,
    task_name TEXT NOT NULL REFERENCES heartbeat_schedule(task_name),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    result TEXT NOT NULL CHECK(result IN ('success','failure','timeout','skipped')),
    duration_ms INTEGER,
    error TEXT,
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_hb_history_task ON heartbeat_history(task_name, started_at);

  -- Wake events (Phase 1.1)
  CREATE TABLE IF NOT EXISTS wake_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload TEXT DEFAULT '{}',
    consumed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_wake_unconsumed ON wake_events(created_at) WHERE consumed_at IS NULL;

  -- Heartbeat dedup (Phase 1.1)
  CREATE TABLE IF NOT EXISTS heartbeat_dedup (
    dedup_key TEXT PRIMARY KEY,
    task_name TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_dedup_expires ON heartbeat_dedup(expires_at);

  -- Data migration: heartbeat_entries -> heartbeat_schedule
  INSERT OR IGNORE INTO heartbeat_schedule (task_name, cron_expression, enabled, last_run_at, next_run_at)
  SELECT name, schedule, enabled, last_run, next_run FROM heartbeat_entries;
`;

// Inbox modifications for V4 (ALTER TABLE must be run separately from CREATE TABLE)
export const MIGRATION_V4_ALTER = `
  ALTER TABLE inbox_messages ADD COLUMN to_address TEXT;
`;

export const MIGRATION_V4_ALTER2 = `
  ALTER TABLE inbox_messages ADD COLUMN raw_content TEXT;
`;

// Inbox state machine columns (Phase 1.2)
// Note: SQLite ALTER TABLE ADD COLUMN cannot include CHECK constraints,
// so status validation is enforced at the application level.
export const MIGRATION_V4_ALTER_INBOX_STATUS = `
  ALTER TABLE inbox_messages ADD COLUMN status TEXT DEFAULT 'received';
`;

export const MIGRATION_V4_ALTER_INBOX_RETRY = `
  ALTER TABLE inbox_messages ADD COLUMN retry_count INTEGER DEFAULT 0;
`;

export const MIGRATION_V4_ALTER_INBOX_MAX_RETRIES = `
  ALTER TABLE inbox_messages ADD COLUMN max_retries INTEGER DEFAULT 3;
`;

export const MIGRATION_V2 = `
  CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    auto_activate INTEGER NOT NULL DEFAULT 1,
    requires TEXT DEFAULT '{}',
    instructions TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'builtin',
    path TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    genesis_prompt TEXT NOT NULL,
    creator_message TEXT,
    funded_amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'spawning',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked TEXT
  );

  CREATE TABLE IF NOT EXISTS registry (
    agent_id TEXT PRIMARY KEY,
    agent_uri TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'eip155:8453',
    contract_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reputation (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    score INTEGER NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    tx_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
  CREATE INDEX IF NOT EXISTS idx_children_status ON children(status);
  CREATE INDEX IF NOT EXISTS idx_reputation_to ON reputation(to_agent);
`;

// === Phase 2.1 + 2.2: Soul + Memory Tables ===

export const MIGRATION_V5 = `
  -- === Phase 2.1: Soul System ===

  CREATE TABLE IF NOT EXISTS soul_history (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    change_source TEXT NOT NULL CHECK(change_source IN ('agent','human','system','genesis','reflection')),
    change_reason TEXT,
    previous_version_id TEXT REFERENCES soul_history(id),
    approved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_soul_version ON soul_history(version);

  -- === Phase 2.2: Memory System ===

  CREATE TABLE IF NOT EXISTS working_memory (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK(content_type IN ('goal','observation','plan','reflection','task','decision','note','summary')),
    priority REAL NOT NULL DEFAULT 0.5,
    token_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    source_turn TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_wm_session ON working_memory(session_id, priority);

  CREATE TABLE IF NOT EXISTS episodic_memory (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT,
    outcome TEXT CHECK(outcome IN ('success','failure','partial','neutral') OR outcome IS NULL),
    importance REAL NOT NULL DEFAULT 0.5,
    embedding_key TEXT,
    token_count INTEGER NOT NULL DEFAULT 0,
    accessed_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    classification TEXT NOT NULL DEFAULT 'maintenance' CHECK(classification IN ('strategic','productive','communication','maintenance','idle','error')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_episodic_type ON episodic_memory(event_type);
  CREATE INDEX IF NOT EXISTS idx_episodic_importance ON episodic_memory(importance);
  CREATE INDEX IF NOT EXISTS idx_episodic_classification ON episodic_memory(classification);

  CREATE TABLE IF NOT EXISTS session_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    summary TEXT NOT NULL,
    key_decisions TEXT NOT NULL DEFAULT '[]',
    tools_used TEXT NOT NULL DEFAULT '[]',
    outcomes TEXT NOT NULL DEFAULT '[]',
    turn_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS semantic_memory (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('self','environment','financial','agent','domain','procedural_ref','creator')),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL,
    embedding_key TEXT,
    last_verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(category, key)
  );

  CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_memory(category);

  CREATE TABLE IF NOT EXISTS procedural_memory (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    steps TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS relationship_memory (
    id TEXT PRIMARY KEY,
    entity_address TEXT NOT NULL UNIQUE,
    entity_name TEXT,
    relationship_type TEXT NOT NULL,
    trust_score REAL NOT NULL DEFAULT 0.5,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    last_interaction_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_rel_trust ON relationship_memory(trust_score);
`;

// === Phase 2.3: Inference & Model Strategy Tables ===

export const MIGRATION_V6 = `
  -- === Phase 2.3: Inference & Model Strategy ===

  CREATE TABLE IF NOT EXISTS inference_costs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK(task_type IN ('agent_turn','heartbeat_triage','safety_check','summarization','planning')),
    cache_hit INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inf_session ON inference_costs(session_id);
  CREATE INDEX IF NOT EXISTS idx_inf_model ON inference_costs(model);
  CREATE INDEX IF NOT EXISTS idx_inf_created ON inference_costs(created_at);
  CREATE INDEX IF NOT EXISTS idx_inf_task ON inference_costs(task_type);

  CREATE TABLE IF NOT EXISTS model_registry (
    model_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    display_name TEXT NOT NULL,
    tier_minimum TEXT NOT NULL DEFAULT 'normal',
    cost_per_1k_input INTEGER NOT NULL DEFAULT 0,
    cost_per_1k_output INTEGER NOT NULL DEFAULT 0,
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    context_window INTEGER NOT NULL DEFAULT 128000,
    supports_tools INTEGER NOT NULL DEFAULT 1,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    parameter_style TEXT NOT NULL DEFAULT 'max_tokens' CHECK(parameter_style IN ('max_tokens','max_completion_tokens')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// === Phase 3: Replication + Social ===

export const MIGRATION_V7 = `
  -- === Phase 3.1: Replication Lifecycle ===

  CREATE TABLE IF NOT EXISTS child_lifecycle_events (
    id TEXT PRIMARY KEY,
    child_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL CHECK(to_state IN (
      'requested','sandbox_created','runtime_ready','wallet_verified',
      'funded','starting','healthy','unhealthy','stopped','failed','cleaned_up'
    )),
    reason TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_child_events ON child_lifecycle_events(child_id, created_at);

  -- === Phase 3.2: Social & Registry ===

  CREATE TABLE IF NOT EXISTS discovered_agents_cache (
    agent_address TEXT PRIMARY KEY,
    agent_card TEXT NOT NULL,
    fetched_from TEXT NOT NULL,
    card_hash TEXT NOT NULL,
    valid_until TEXT,
    fetch_count INTEGER NOT NULL DEFAULT 1,
    last_fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS onchain_transactions (
    id TEXT PRIMARY KEY,
    tx_hash TEXT NOT NULL UNIQUE,
    chain TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','failed')),
    gas_used INTEGER,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_onchain_status ON onchain_transactions(status);
`;

// === Phase 4.1: Observability ===

export const MIGRATION_V8 = `
  -- === Phase 4.1: Observability ===

  CREATE TABLE IF NOT EXISTS metric_snapshots (
    id TEXT PRIMARY KEY,
    snapshot_at TEXT NOT NULL,
    metrics_json TEXT NOT NULL DEFAULT '[]',
    alerts_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_metric_snapshots_at ON metric_snapshots(snapshot_at);
`;

// === Plan A: Orchestration + Memory ===

export const MIGRATION_V9 = `
  -- Schema version: 9
  -- Tables: goals, task_graph, event_stream

  CREATE TABLE goals (
    id TEXT PRIMARY KEY,                    -- ULID
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',  -- active|completed|failed|paused
    strategy TEXT,
    expected_revenue_cents INTEGER DEFAULT 0,
    actual_revenue_cents INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    deadline TEXT,
    completed_at TEXT
  );

  CREATE TABLE task_graph (
    id TEXT PRIMARY KEY,                    -- ULID
    parent_id TEXT,                         -- parent task (decomposition)
    goal_id TEXT NOT NULL REFERENCES goals(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending|assigned|running|completed|failed|blocked|cancelled
    assigned_to TEXT,                       -- agent wallet address (0x...)
    agent_role TEXT,                        -- predefined role name
    priority INTEGER DEFAULT 50,           -- 0-100
    dependencies TEXT DEFAULT '[]',        -- JSON array of task IDs
    result TEXT,                           -- JSON TaskResult
    estimated_cost_cents INTEGER DEFAULT 0,
    actual_cost_cents INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    retry_count INTEGER DEFAULT 0,
    timeout_ms INTEGER DEFAULT 300000,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE INDEX idx_task_graph_goal ON task_graph(goal_id);
  CREATE INDEX idx_task_graph_status ON task_graph(status);
  CREATE INDEX idx_task_graph_assigned ON task_graph(assigned_to);

  CREATE TABLE event_stream (
    id TEXT PRIMARY KEY,                    -- ULID
    type TEXT NOT NULL,                     -- EventType enum
    agent_address TEXT NOT NULL,
    goal_id TEXT,
    task_id TEXT,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    compacted_to TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_events_agent ON event_stream(agent_address, created_at);
  CREATE INDEX idx_events_goal ON event_stream(goal_id, created_at);
  CREATE INDEX idx_events_type ON event_stream(type, created_at);
`;

// Role column for children table (must be separate statement for SQLite ALTER)
export const MIGRATION_V9_ALTER_CHILDREN_ROLE = `
  ALTER TABLE children ADD COLUMN role TEXT DEFAULT 'generalist';
`;

// === Solana Integration: Chain Type Column ===

export const MIGRATION_V11 = `
  -- Schema version: 11
  -- Add chain_type column to children table for multi-chain support
  ALTER TABLE children ADD COLUMN chain_type TEXT DEFAULT 'evm';
`;

export const MIGRATION_V10 = `
  -- Schema version: 10
  -- Tables: knowledge_store

  CREATE TABLE knowledge_store (
    id TEXT PRIMARY KEY,                    -- ULID
    category TEXT NOT NULL,                 -- market|technical|social|financial|operational
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,                   -- agent address that contributed
    confidence REAL DEFAULT 1.0,
    last_verified TEXT NOT NULL,
    access_count INTEGER DEFAULT 0,
    token_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT
  );

  CREATE INDEX idx_knowledge_category ON knowledge_store(category);
  CREATE INDEX idx_knowledge_key ON knowledge_store(key);
`;

// === Treasury: spending gate ledger ===
// Applied through ensureTreasuryLedger, which also copies the last day of
// transfer and x402 spend from spend_tracking when it first creates the table.

export const MIGRATION_V12 = `
  -- Schema version: 12
  -- Tables: treasury_ledger

  CREATE TABLE IF NOT EXISTS treasury_ledger (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    replay_of TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('credit_transfer','x402_payment','credit_topup','sandbox_create','domain_register','legacy')),
    budget TEXT NOT NULL CHECK(budget IN ('transfer','x402','topup','topup_auto','infra')),
    status TEXT NOT NULL CHECK(status IN ('denied','reserved','sent','committed','released','unknown')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0 AND typeof(amount_cents) = 'integer'),
    committed_cents INTEGER CHECK(committed_cents IS NULL OR (committed_cents >= 0 AND typeof(committed_cents) = 'integer')),
    amount_atomic INTEGER CHECK(amount_atomic IS NULL OR (amount_atomic >= 0 AND typeof(amount_atomic) = 'integer')),
    amount_basis TEXT NOT NULL DEFAULT 'exact' CHECK(amount_basis IN ('exact','quote','estimate','ceiling')),
    debits_credits INTEGER NOT NULL CHECK(debits_credits IN (0,1)),
    counterparty TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    origin_type TEXT NOT NULL,
    origin_name TEXT,
    input_source TEXT,
    boot_id TEXT,
    topup_purpose TEXT,
    url TEXT,
    description TEXT,
    deny_code TEXT,
    deny_count INTEGER NOT NULL DEFAULT 1,
    reason TEXT,
    external_ref TEXT,
    x402_nonce TEXT,
    x402_valid_before INTEGER,
    x402_from TEXT,
    x402_network TEXT,
    x402_asset TEXT,
    balance_observed_cents INTEGER,
    balance_read_started_ms INTEGER,
    balance_unknown INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    sent_at_ms INTEGER,
    settled_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_treasury_budget_time ON treasury_ledger(budget, created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_treasury_open ON treasury_ledger(status, debits_credits);
  CREATE INDEX IF NOT EXISTS idx_treasury_dedupe ON treasury_ledger(dedupe_key, status);
  CREATE INDEX IF NOT EXISTS idx_treasury_replay ON treasury_ledger(replay_of);
`;

// === Inference spend gate ledger ===
// Applied through ensureInferenceLedger, which also copies the last day of
// inference_costs when it first creates the table. One row per HTTP attempt;
// amounts are integer micro-USD (1 cent = 10,000).

export const MIGRATION_V13 = `
  -- Schema version: 13
  -- Tables: inference_ledger

  CREATE TABLE IF NOT EXISTS inference_ledger (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved','committed','released','unknown')),
    budget_class TEXT NOT NULL CHECK(budget_class IN ('main','orchestration','survival')),
    caller TEXT NOT NULL,
    session_id TEXT,
    task_id TEXT,
    goal_id TEXT,
    worker_id TEXT,
    turn_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    tier TEXT,
    survival_tier TEXT,
    price_in_usd_per_m REAL NOT NULL,
    price_out_usd_per_m REAL NOT NULL,
    est_input_tokens INTEGER NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    reserved_micro_usd INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_micro_usd INTEGER,
    error_class TEXT,
    latency_ms INTEGER,
    boot_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    settled_at_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_infl_created ON inference_ledger(created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_infl_task ON inference_ledger(task_id) WHERE task_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_infl_session ON inference_ledger(session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_infl_open ON inference_ledger(status) WHERE status IN ('reserved','unknown');
`;

// === Colony bookkeeping repair ===
// Applied by the version 14 entry of applyMigrations (database.ts);
// ensureChildrenAddressIndex then adds the unique address index once no
// duplicates remain. Idempotent.

export const MIGRATION_V14 = `
  -- Schema version: 14
  -- Local workers are in-process and never survive a restart: retire every
  -- row the orchestrator registered for one.
  UPDATE children SET status = 'cleaned_up'
   WHERE address LIKE 'local://%' AND status NOT IN ('cleaned_up', 'dead');

  -- The orchestrator never started the Conway children it spawned. One still
  -- before start (its twin marks it) has no process: fail it, which frees
  -- its slot. Lifecycle timestamps are ISO, so the repair events are
  -- stamped that way to sort after the existing ones.
  INSERT INTO child_lifecycle_events (id, child_id, from_state, to_state, reason, metadata, created_at)
  SELECT lower(hex(randomblob(16))), c.id, latest.to_state, 'failed',
         'orchestrator spawn never started (upgrade repair)', '{}',
         MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), latest.created_at)
    FROM children c
    JOIN (SELECT e.child_id, e.to_state, e.created_at FROM child_lifecycle_events e
           WHERE e.rowid = (SELECT e2.rowid FROM child_lifecycle_events e2
                             WHERE e2.child_id = e.child_id
                             ORDER BY e2.created_at DESC, e2.rowid DESC LIMIT 1)) latest
      ON latest.child_id = c.id
   WHERE latest.to_state IN ('wallet_verified', 'funded')
     AND c.address <> ''
     AND EXISTS (
       SELECT 1 FROM children twin
        WHERE twin.address = c.address AND twin.id <> c.id
          AND twin.creator_message = 'registered by orchestrator'
          AND NOT EXISTS (SELECT 1 FROM child_lifecycle_events e3 WHERE e3.child_id = twin.id)
     );

  -- A row the orchestrator registered for a Conway child duplicates that
  -- child's lifecycle row (same address, same ledger updates): drop it.
  DELETE FROM children
   WHERE creator_message = 'registered by orchestrator'
     AND address <> '' AND address NOT LIKE 'local://%'
     AND NOT EXISTS (SELECT 1 FROM child_lifecycle_events e WHERE e.child_id = children.id)
     AND EXISTS (
       SELECT 1 FROM children c2
        WHERE c2.address = children.address AND c2.id <> children.id
          AND EXISTS (SELECT 1 FROM child_lifecycle_events e2 WHERE e2.child_id = c2.id)
     );

  -- A registered row whose lifecycle row is gone outlived a pruned (ended)
  -- child; the orchestrator never started a process for it.
  UPDATE children SET status = 'dead'
   WHERE creator_message = 'registered by orchestrator'
     AND address NOT LIKE 'local://%'
     AND status NOT IN ('cleaned_up', 'dead')
     AND NOT EXISTS (SELECT 1 FROM child_lifecycle_events e WHERE e.child_id = children.id);

  -- Rows retired to cleaned_up without an event (a reused sandbox) get the
  -- event, so the reconciliation below keeps them terminal.
  INSERT INTO child_lifecycle_events (id, child_id, from_state, to_state, reason, metadata, created_at)
  SELECT lower(hex(randomblob(16))), c.id, latest.to_state, 'cleaned_up',
         'retired before upgrade (upgrade repair)', '{}',
         MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), latest.created_at)
    FROM children c
    JOIN (SELECT e.child_id, e.to_state, e.created_at FROM child_lifecycle_events e
           WHERE e.rowid = (SELECT e2.rowid FROM child_lifecycle_events e2
                             WHERE e2.child_id = e.child_id
                             ORDER BY e2.created_at DESC, e2.rowid DESC LIMIT 1)) latest
      ON latest.child_id = c.id
   WHERE c.status = 'cleaned_up' AND latest.to_state IN ('stopped', 'failed');

  -- Lifecycle children: status is the latest lifecycle state. Undoes the
  -- running/starting/stopped writes of the tracker, health monitor and pool
  -- optimizer.
  UPDATE children SET status = (
      SELECT e.to_state FROM child_lifecycle_events e
       WHERE e.child_id = children.id
       ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1)
   WHERE EXISTS (SELECT 1 FROM child_lifecycle_events e WHERE e.child_id = children.id);

  -- Legacy runtimes wrote 'starting' without an event only when their health
  -- monitor "restarted" a dead child, which started nothing. Nothing can
  -- move such a row, and it would hold a slot forever.
  UPDATE children SET status = 'dead'
   WHERE status = 'starting'
     AND NOT EXISTS (SELECT 1 FROM child_lifecycle_events e WHERE e.child_id = children.id);

  -- An ended row sharing its address with a live or newer row (a wallet
  -- inherited through a reused sandbox) gives the address up, so the unique
  -- address index can be created.
  UPDATE children SET address = ''
   WHERE address <> ''
     AND status IN ('stopped', 'failed', 'dead', 'cleaned_up')
     AND EXISTS (
       SELECT 1 FROM children other
        WHERE other.address = children.address AND other.id <> children.id
          AND (other.status NOT IN ('stopped', 'failed', 'dead', 'cleaned_up')
               OR other.created_at > children.created_at
               OR (other.created_at = children.created_at AND other.rowid > children.rowid))
     );

  -- Colony messages the old LocalDBTransport wrote into our own inbox are
  -- our outbound messages, not inbound ones.
  UPDATE inbox_messages
     SET status = 'processed', processed_at = COALESCE(processed_at, datetime('now'))
   WHERE status IN ('received', 'in_progress') AND to_address IS NOT NULL
     AND from_address = (SELECT value FROM identity WHERE key = 'address');
`;

/** One row per child address (failed spawns keep an empty address). */
export const CHILDREN_ADDRESS_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_children_address ON children(address) WHERE address <> '';
`;

// === Model registry origin ===
// Applied by the version 15 entry of applyMigrations (database.ts), which
// adds the column only when it is missing and then marks models discovered
// from the Conway API before the upgrade. initialize() disables only
// 'baseline' rows that left the static baseline.

export const MIGRATION_V15 = `
  -- Schema version: 15
  ALTER TABLE model_registry ADD COLUMN origin TEXT NOT NULL DEFAULT 'baseline'
    CHECK(origin IN ('baseline','api','ollama','manual'));
  UPDATE model_registry SET origin = 'ollama' WHERE provider IN ('ollama','other');
`;

// === Inbox sender verification ===
// Applied by the version 16 entry of applyMigrations (database.ts), which
// adds each column only when it is missing. Relay rows keep to_address NULL:
// the colony router treats any row with a recipient as a colony message.

export const MIGRATION_V16_INBOX_COLUMNS: ReadonlyArray<[string, string]> = [
  ["verified", "ALTER TABLE inbox_messages ADD COLUMN verified INTEGER NOT NULL DEFAULT 0"],
  ["sig_hash", "ALTER TABLE inbox_messages ADD COLUMN sig_hash TEXT"],
  ["signed_at", "ALTER TABLE inbox_messages ADD COLUMN signed_at TEXT"],
  ["relay_created_at", "ALTER TABLE inbox_messages ADD COLUMN relay_created_at TEXT"],
  ["screen", "ALTER TABLE inbox_messages ADD COLUMN screen TEXT"],
  // When the row became claimable, for the per-sender rate in real time.
  ["available_at", "ALTER TABLE inbox_messages ADD COLUMN available_at TEXT"],
];

export const MIGRATION_V16 = `
  -- Schema version: 16
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_sig
    ON inbox_messages(sig_hash) WHERE sig_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_inbox_from_received
    ON inbox_messages(from_address, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbox_deferred
    ON inbox_messages(from_address, verified, received_at) WHERE status = 'deferred';
  CREATE INDEX IF NOT EXISTS idx_inbox_available
    ON inbox_messages(from_address, verified, available_at) WHERE available_at IS NOT NULL;
`;

// Rows the old ingest blocked were stored as 'received' with a placeholder
// body; they are audit records, not mail to answer.
export const MIGRATION_V16_RETIRE_BLOCKED = `
  UPDATE inbox_messages SET status = 'blocked'
   WHERE status = 'received' AND substr(content, 1, 10) = '[BLOCKED: ';
`;

// === Registry keyed by chain ===
// Rebuilds a registry table whose primary key is agent_id alone, so a
// testnet and a mainnet identity with the same token id both fit.
export const REGISTRY_CHAIN_KEY_REBUILD = `
  CREATE TABLE registry_chain_key (
    agent_id TEXT NOT NULL,
    agent_uri TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'eip155:8453',
    contract_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chain, agent_id)
  );
  INSERT OR IGNORE INTO registry_chain_key (agent_id, agent_uri, chain, contract_address, tx_hash, registered_at)
    SELECT agent_id, agent_uri, chain, contract_address, tx_hash, registered_at FROM registry;
  DROP TABLE registry;
  ALTER TABLE registry_chain_key RENAME TO registry;
`;

// === Memory and inbox indexes, bad score repair ===
// Applied by the version 17 entry of applyMigrations (database.ts). Every
// statement is idempotent. A TEXT trust score becomes 0.2, below the 0.3
// retrieval threshold; a TEXT priority becomes 0.5.
export const MIGRATION_V17 = `
  -- Schema version: 17
  CREATE INDEX IF NOT EXISTS idx_episodic_session_created ON episodic_memory(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_inbox_received_pending ON inbox_messages(received_at) WHERE status = 'received';
  CREATE INDEX IF NOT EXISTS idx_knowledge_category_key ON knowledge_store(category, key);
  CREATE INDEX IF NOT EXISTS idx_wake_consumed ON wake_events(consumed_at) WHERE consumed_at IS NOT NULL;
  UPDATE relationship_memory SET trust_score = 0.2 WHERE typeof(trust_score) NOT IN ('real', 'integer');
  UPDATE relationship_memory SET trust_score = MAX(0.0, MIN(1.0, trust_score)) WHERE trust_score < 0 OR trust_score > 1;
  UPDATE working_memory SET priority = 0.5 WHERE typeof(priority) NOT IN ('real', 'integer');
  UPDATE working_memory SET priority = MAX(0.0, MIN(1.0, priority)) WHERE priority < 0 OR priority > 1;
`;
