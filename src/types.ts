/**
 * Conway Automaton - Type Definitions
 *
 * All shared interfaces for the sovereign AI agent runtime.
 */

import type { PrivateKeyAccount, Address } from "viem";
import type { ChainType, ChainIdentity } from "./identity/chain.js";

// ─── Identity ────────────────────────────────────────────────────

export interface AutomatonIdentity {
  name: string;
  address: string;
  account: PrivateKeyAccount;
  creatorAddress: string;
  sandboxId: string;
  apiKey: string;
  createdAt: string;
  /** Chain type for this automaton's wallet identity. Defaults to "evm". */
  chainType?: ChainType;
  /** Chain-agnostic identity wrapper. Parallel to `account` for backward compat. */
  chainIdentity?: ChainIdentity;
}

export interface WalletData {
  privateKey?: `0x${string}`;
  /** Base58-encoded 64-byte Ed25519 secret key (Solana wallets). */
  secretKey?: string;
  createdAt: string;
  /** Chain type for this wallet. Missing = "evm" for backward compat. */
  chainType?: ChainType;
}

export interface ProvisionResult {
  apiKey: string;
  walletAddress: string;
  keyPrefix: string;
}

// ─── Configuration ───────────────────────────────────────────────

export interface AutomatonConfig {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredWithConway: boolean;
  sandboxId: string;
  conwayApiUrl: string;
  conwayApiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  inferenceModel: string;
  maxTokensPerTurn: number;
  heartbeatConfigPath: string;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  walletAddress: string;
  version: string;
  skillsDir: string;
  agentId?: string;
  maxChildren: number;
  maxTurnsPerCycle?: number;
  /** Child sandbox memory config (MB), default 1024 */
  childSandboxMemoryMb?: number;
  /**
   * Git repository (https) a spawned child's runtime is cloned from, and an
   * optional branch or tag. A checkout without the genesis bootstrap gets an
   * automaton.json written by the parent at spawn time.
   */
  childRuntimeRepo?: string;
  childRuntimeRef?: string;
  parentAddress?: string;
  socialRelayUrl?: string;
  treasuryPolicy?: TreasuryPolicy;
  // Phase 2 config additions
  soulConfig?: SoulConfig;
  modelStrategy?: ModelStrategyConfig;
  /** Custom RPC endpoint for Base chain interactions (overrides default public RPC) */
  rpcUrl?: string;
  /** Chain type for this automaton. Defaults to "evm" if absent. */
  chainType?: ChainType;
}

export const DEFAULT_CONFIG: Partial<AutomatonConfig> = {
  conwayApiUrl: "https://api.conway.tech",
  inferenceModel: "gpt-5.2",
  maxTokensPerTurn: 4096,
  heartbeatConfigPath: "~/.automaton/heartbeat.yml",
  dbPath: "~/.automaton/state.db",
  logLevel: "info",
  version: "0.2.1",
  skillsDir: "~/.automaton/skills",
  maxChildren: 3,
  maxTurnsPerCycle: 25,
  childSandboxMemoryMb: 1024,
  socialRelayUrl: "https://social.conway.tech",
};

// ─── Agent State ─────────────────────────────────────────────────

export type AgentState =
  | "setup"
  | "waking"
  | "running"
  | "sleeping"
  | "low_compute"
  | "critical"
  | "dead";

export interface AgentTurn {
  id: string;
  timestamp: string;
  state: AgentState;
  input?: string;
  inputSource?: InputSource;
  thinking: string;
  toolCalls: ToolCallResult[];
  tokenUsage: TokenUsage;
  costCents: number;
}

export type InputSource =
  | "heartbeat"
  | "creator"
  | "agent"
  | "system"
  | "wakeup"
  | "external";

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  durationMs: number;
  error?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Tool System ─────────────────────────────────────────────────

export interface AutomatonTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
  riskLevel: RiskLevel;
  category: ToolCategory;
}

export type ToolCategory =
  | "vm"
  | "conway"
  | "self_mod"
  | "financial"
  | "survival"
  | "skills"
  | "git"
  | "registry"
  | "replication"
  | "memory";

export interface ToolContext {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
}

export interface SocialClientInterface {
  send(to: string, content: string, replyTo?: string): Promise<{ id: string }>;
  poll(cursor?: string, limit?: number): Promise<{ messages: InboxMessage[]; nextCursor?: string }>;
  unreadCount(): Promise<number>;
}

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  signedAt: string;
  createdAt: string;
  replyTo?: string;
  /**
   * True only when the sender's signature was checked against `from`.
   * Anything else (missing, false) means `from` is what the relay reported.
   */
  verified?: boolean;
  /** Replay key derived from the signed message (or an exact re-delivery). */
  sigHash?: string;
}

/**
 * Inbox row statuses written at ingest. blocked and rate_limited are never
 * claimed; deferred becomes received when the sender's rate allows.
 */
export type InboxIngestStatus = "received" | "deferred" | "blocked" | "rate_limited";

/** Fields stored with an inbox row besides the message itself. */
export interface InboxMessageInsert extends InboxMessage {
  status?: InboxIngestStatus;
  /** Screening verdict (JSON), rendered at claim time without screening again. */
  screen?: string;
  /** The relay's own createdAt; received_at is our local clock. */
  relayCreatedAt?: string;
  /** When the row became claimable (local clock); unset while it is not. */
  availableAt?: string;
}

// ─── Heartbeat ───────────────────────────────────────────────────

export interface HeartbeatEntry {
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  params?: Record<string, unknown>;
}

export interface HeartbeatConfig {
  entries: HeartbeatEntry[];
  defaultIntervalMs: number;
  lowComputeMultiplier: number;
}

export interface HeartbeatPingPayload {
  name: string;
  address: string;
  state: AgentState;
  creditsCents: number;
  usdcBalance: number;
  uptimeSeconds: number;
  version: string;
  sandboxId: string;
  timestamp: string;
}

// ─── Financial ───────────────────────────────────────────────────

/** Where a balance came from: read now, the last good read, or nothing. */
export type BalanceSource = "live" | "cached" | "unknown";

/**
 * Balances as the agent sees them. null means unknown (never read, or the
 * read failed with nothing cached). Spending and the dead decision need a
 * "live" source; an absent source is treated as not live.
 */
export interface FinancialState {
  creditsCents: number | null;
  usdcBalance: number | null;
  credits?: BalanceSource;
  usdc?: BalanceSource;
  lastChecked: string;
  /** When a cached creditsCents was read. */
  creditsAsOf?: string;
  /** When a cached usdcBalance was read. */
  usdcAsOf?: string;
}

export type SurvivalTier = "dead" | "critical" | "low_compute" | "normal" | "high";

export const SURVIVAL_THRESHOLDS = {
  high: 500, // > $5.00 in cents
  normal: 50, // > $0.50 in cents
  low_compute: 10, // $0.10 - $0.50
  critical: 0, // >= $0.00 (zero credits = critical, agent stays alive)
  dead: -1, // negative balance = truly dead
} as const;

export interface Transaction {
  id: string;
  type: TransactionType;
  amountCents?: number;
  balanceAfterCents?: number;
  description: string;
  timestamp: string;
}

export type TransactionType =
  | "credit_check"
  | "credit_purchase"
  | "inference"
  | "tool_use"
  | "transfer_in"
  | "transfer_out"
  | "funding_request"
  | "x402_payment";

// ─── Self-Modification ───────────────────────────────────────────

export interface ModificationEntry {
  id: string;
  timestamp: string;
  type: ModificationType;
  description: string;
  filePath?: string;
  diff?: string;
  reversible: boolean;
}

export type ModificationType =
  | "code_edit"
  | "code_revert"
  | "tool_install"
  | "mcp_install"
  | "config_change"
  | "port_expose"
  | "vm_deploy"
  | "heartbeat_change"
  | "prompt_change"
  | "skill_install"
  | "skill_remove"
  | "soul_update"
  | "registry_update"
  | "child_spawn"
  | "upstream_pull"
  | "upstream_reset";

// ─── Injection Defense ───────────────────────────────────────────

export type ThreatLevel = "low" | "medium" | "high" | "critical";

export type SanitizationMode =
  | "social_message"      // Full injection defense
  | "social_address"      // Alphanumeric + 0x prefix only
  | "tool_result"         // Strip prompt boundaries, limit size
  | "skill_instruction";  // Strip tool call syntax, add framing

export interface SanitizedInput {
  content: string;
  blocked: boolean;
  threatLevel: ThreatLevel;
  checks: InjectionCheck[];
}

export interface InjectionCheck {
  name: string;
  detected: boolean;
  details?: string;
}

// ─── Inference ───────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: InferenceToolCall[];
  tool_call_id?: string;
}

export interface InferenceToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface InferenceResponse {
  id: string;
  model: string;
  message: ChatMessage;
  toolCalls?: InferenceToolCall[];
  usage: TokenUsage;
  finishReason: string;
}

export interface InferenceOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: InferenceToolDefinition[];
  stream?: boolean;
  /** Aborts the HTTP request (deadline or shutdown). */
  signal?: AbortSignal;
  /** Open reservation on the installed inference gate; the legacy client refuses to send without one. */
  reservationId?: string;
}

export interface InferenceToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Conway Client ───────────────────────────────────────────────

export interface ConwayClient {
  exec(command: string, timeout?: number): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exposePort(port: number): Promise<PortInfo>;
  removePort(port: number): Promise<void>;
  createSandbox(options: CreateSandboxOptions): Promise<SandboxInfo>;
  deleteSandbox(sandboxId: string): Promise<void>;
  listSandboxes(): Promise<SandboxInfo[]>;
  getCreditsBalance(): Promise<number>;
  getCreditsPricing(): Promise<PricingTier[]>;
  transferCredits(
    toAddress: string,
    amountCents: number,
    note?: string,
    opts?: OutflowRequestOptions,
  ): Promise<CreditTransferResult>;
  registerAutomaton(params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
    account: PrivateKeyAccount;
    nonce?: string;
    chainType?: ChainType;
    chainIdentity?: ChainIdentity;
  }): Promise<{ automaton: Record<string, unknown> }>;
  // Domain operations
  searchDomains(query: string, tlds?: string): Promise<DomainSearchResult[]>;
  registerDomain(
    domain: string,
    years?: number,
    opts?: OutflowRequestOptions,
  ): Promise<DomainRegistration>;
  listDnsRecords(domain: string): Promise<DnsRecord[]>;
  addDnsRecord(
    domain: string,
    type: string,
    host: string,
    value: string,
    ttl?: number,
  ): Promise<DnsRecord>;
  deleteDnsRecord(domain: string, recordId: string): Promise<void>;
  // Model discovery
  listModels(): Promise<ModelInfo[]>;
  /** Create a new client scoped to a specific sandbox ID. */
  createScopedClient(targetSandboxId: string): ConwayClient;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PortInfo {
  port: number;
  publicUrl: string;
  sandboxId: string;
}

/**
 * Options the treasury passes to a value-moving Conway call. The key is sent
 * as the Idempotency-Key header on every attempt. onSend runs exactly once,
 * synchronously, before the first byte of the first attempt leaves the
 * process; retries of the same call reuse the key and do not call it again.
 */
export interface OutflowRequestOptions {
  idempotencyKey?: string;
  onSend?: () => void;
}

export interface CreateSandboxOptions extends OutflowRequestOptions {
  name?: string;
  vcpu?: number;
  memoryMb?: number;
  diskGb?: number;
  region?: string;
}

export interface SandboxInfo {
  id: string;
  status: string;
  region: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  terminalUrl?: string;
  createdAt: string;
}

export interface PricingTier {
  name: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  monthlyCents: number;
}

export interface CreditTransferResult {
  transferId: string;
  status: string;
  toAddress: string;
  amountCents: number;
  balanceAfterCents?: number;
}

// ─── Domains ──────────────────────────────────────────────────────

export interface DomainSearchResult {
  domain: string;
  available: boolean;
  registrationPrice?: number;
  renewalPrice?: number;
  currency?: string;
}

export interface DomainRegistration {
  domain: string;
  status: string;
  expiresAt?: string;
  transactionId?: string;
}

export interface DnsRecord {
  id: string;
  type: string;
  host: string;
  value: string;
  ttl?: number;
  distance?: number;
}

export interface ModelInfo {
  id: string;
  provider: string;
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
}

// ─── Policy Engine ───────────────────────────────────────────────

// Risk level for tool classification — replaces `dangerous?: boolean`
export type RiskLevel = 'safe' | 'caution' | 'dangerous' | 'forbidden';

// Policy evaluation result action
export type PolicyAction = 'allow' | 'deny' | 'quarantine';

// Who initiated the action
export type AuthorityLevel = 'system' | 'agent' | 'external';

// Spend categories
export type SpendCategory = 'transfer' | 'x402' | 'inference' | 'other';

export type ToolSelector =
  | { by: 'name'; names: string[] }
  | { by: 'category'; categories: ToolCategory[] }
  | { by: 'risk'; levels: RiskLevel[] }
  | { by: 'all' };

export interface PolicyRule {
  id: string;
  description: string;
  priority: number;
  appliesTo: ToolSelector;
  evaluate(request: PolicyRequest): PolicyRuleResult | null;
}

export interface PolicyRequest {
  tool: AutomatonTool;
  args: Record<string, unknown>;
  context: ToolContext;
  turnContext: {
    inputSource: InputSource | undefined;
    turnToolCallCount: number;
    sessionSpend: SpendTrackerInterface;
    /** On an inbox turn: the sender of the batch being handled. */
    inboxSender?: string;
    /** On an inbox turn: ids of the messages in the batch. */
    inboxMessageIds?: string[];
    /** On an inbox turn: send_message calls already allowed this turn. */
    inboxSendCount?: number;
  };
}

export interface PolicyRuleResult {
  rule: string;
  action: PolicyAction;
  reasonCode: string;
  humanMessage: string;
}

export interface PolicyDecision {
  action: PolicyAction;
  reasonCode: string;
  humanMessage: string;
  riskLevel: RiskLevel;
  authorityLevel: AuthorityLevel;
  toolName: string;
  argsHash: string;
  rulesEvaluated: string[];
  rulesTriggered: string[];
  timestamp: string;
}

export interface SpendTrackerInterface {
  recordSpend(entry: SpendEntry): void;
  getHourlySpend(category: SpendCategory): number;
  getDailySpend(category: SpendCategory): number;
  getTotalSpend(category: SpendCategory, since: Date): number;
  checkLimit(amount: number, category: SpendCategory, limits: TreasuryPolicy): LimitCheckResult;
  pruneOldRecords(retentionDays: number): number;
}

export interface SpendEntry {
  toolName: string;
  amountCents: number;
  recipient?: string;
  domain?: string;
  category: SpendCategory;
}

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  currentHourlySpend: number;
  currentDailySpend: number;
  limitHourly: number;
  limitDaily: number;
}

export interface TreasuryPolicy {
  maxSingleTransferCents: number;
  maxHourlyTransferCents: number;
  maxDailyTransferCents: number;
  minimumReserveCents: number;
  maxX402PaymentCents: number;
  x402AllowedDomains: string[];
  transferCooldownMs: number;
  maxTransfersPerTurn: number;
  maxInferenceDailyCents: number;
  /** Transfers above this are refused (no approval flow exists). */
  requireConfirmationAboveCents: number;
  /** Largest single credit topup bought by a tool or a sandbox 402 handler. */
  maxTopupSingleCents?: number;
  /** Rolling 24h cap on those topups. */
  maxTopupDailyCents?: number;
  /** Rolling 24h cap on automatic survival topups. */
  maxAutoTopupDailyCents?: number;
  /** Minimum time between automatic survival topup attempts. */
  autoTopupCooldownMs?: number;
  /** Survival topups run only when a fresh balance read is below this. */
  survivalTopupThresholdCents?: number;
  /** Largest single sandbox or domain purchase. */
  maxInfraSingleCents?: number;
  /** Rolling 24h cap on sandbox and domain purchases. */
  maxInfraDailyCents?: number;
  /** Floor for a sandbox price estimate, whatever the pricing endpoint says. */
  minSandboxEstimateCents?: number;
  /** Ambiguous credit outflows count as possibly in flight for this long. */
  unknownInflightMs?: number;
  /** How long a committed debit may take to show up in the balance endpoint. */
  balanceLagMs?: number;
  /** Automatic child funding: at most one transfer per address per this window. */
  autoFundCounterpartyCooldownMs?: number;
  /**
   * Address every credit topup must pay (survival buys included). When unset,
   * the payTo of the last committed manual or sandbox topup is trusted for
   * those topups; survival buys are not pinned, so an address change cannot
   * starve them. Set this to accept a new address.
   */
  topupPayTo?: string;
}

/** A treasury policy with every numeric field filled in. */
export type ResolvedTreasuryPolicy = Required<Omit<TreasuryPolicy, "topupPayTo">> &
  Pick<TreasuryPolicy, "topupPayTo">;

export const DEFAULT_TREASURY_POLICY: Required<Omit<TreasuryPolicy, "topupPayTo">> = {
  maxSingleTransferCents: 1000,
  maxHourlyTransferCents: 10000,
  maxDailyTransferCents: 25000,
  minimumReserveCents: 1000,
  maxX402PaymentCents: 100,
  x402AllowedDomains: ['conway.tech'],
  transferCooldownMs: 0,
  maxTransfersPerTurn: 2,
  maxInferenceDailyCents: 50000,
  requireConfirmationAboveCents: 1000,
  maxTopupSingleCents: 2500,
  maxTopupDailyCents: 10000,
  maxAutoTopupDailyCents: 2000,
  autoTopupCooldownMs: 300_000,
  survivalTopupThresholdCents: 500,
  maxInfraSingleCents: 2500,
  maxInfraDailyCents: 5000,
  minSandboxEstimateCents: 500,
  unknownInflightMs: 3_600_000,
  balanceLagMs: 60_000,
  autoFundCounterpartyCooldownMs: 1_800_000,
};

// ─── Phase 1: Inbox Message Status ──────────────────────────────

export type InboxMessageStatus = 'received' | 'in_progress' | 'processed' | 'failed';

// ─── Phase 1: Runtime Reliability ────────────────────────────────

export interface HttpClientConfig {
  baseTimeout: number;               // default: 30_000ms
  maxRetries: number;                // default: 3
  retryableStatuses: number[];       // default: [429, 500, 502, 503, 504]
  backoffBase: number;               // default: 1_000ms
  backoffMax: number;                // default: 30_000ms
  circuitBreakerThreshold: number;   // default: 5
  circuitBreakerResetMs: number;     // default: 60_000ms
  allowHttpOnLoopback: boolean;      // default: false (for local dev only)
}

export const DEFAULT_HTTP_CLIENT_CONFIG: HttpClientConfig = {
  baseTimeout: 30_000,
  maxRetries: 3,
  retryableStatuses: [429, 500, 502, 503, 504],
  backoffBase: 1_000,
  backoffMax: 30_000,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 60_000,
  allowHttpOnLoopback: false,
};

// ─── Database ────────────────────────────────────────────────────

export interface AutomatonDatabase {
  // Identity
  getIdentity(key: string): string | undefined;
  setIdentity(key: string, value: string): void;

  // Turns
  insertTurn(turn: AgentTurn): void;
  /** excludeIsolated drops inbox turns before the limit is applied. */
  getRecentTurns(limit: number, options?: { excludeIsolated?: boolean }): AgentTurn[];
  getTurnById(id: string): AgentTurn | undefined;
  getTurnCount(): number;

  // Tool calls
  insertToolCall(turnId: string, call: ToolCallResult): void;
  getToolCallsForTurn(turnId: string): ToolCallResult[];

  // Heartbeat
  getHeartbeatEntries(): HeartbeatEntry[];
  upsertHeartbeatEntry(entry: HeartbeatEntry): void;
  updateHeartbeatLastRun(name: string, timestamp: string): void;

  // Transactions
  insertTransaction(txn: Transaction): void;
  getRecentTransactions(limit: number): Transaction[];

  // Installed tools
  getInstalledTools(): InstalledTool[];
  installTool(tool: InstalledTool): void;
  removeTool(id: string): void;

  // Modifications
  insertModification(mod: ModificationEntry): void;
  getRecentModifications(limit: number): ModificationEntry[];

  // Key-value store
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
  deleteKV(key: string): void;

  // Skills
  getSkills(enabledOnly?: boolean): Skill[];
  getSkillByName(name: string): Skill | undefined;
  upsertSkill(skill: Skill): void;
  removeSkill(name: string): void;

  // Children
  getChildren(): ChildAutomaton[];
  getChildById(id: string): ChildAutomaton | undefined;
  insertChild(child: ChildAutomaton): void;
  updateChildStatus(id: string, status: ChildStatus): void;

  // Registry
  getRegistryEntry(): RegistryEntry | undefined;
  setRegistryEntry(entry: RegistryEntry): void;

  // Reputation
  insertReputation(entry: ReputationEntry): void;
  getReputation(agentAddress?: string): ReputationEntry[];

  // Inbox
  /** Returns false when the row was a duplicate (same id or replay key). */
  insertInboxMessage(msg: InboxMessageInsert): boolean;
  getUnprocessedInboxMessages(limit: number): InboxMessage[];
  markInboxMessageProcessed(id: string): void;

  // Key-value atomic delete
  deleteKVReturning(key: string): string | undefined;

  // State
  getAgentState(): AgentState;
  setAgentState(state: AgentState): void;

  // Transaction helper
  runTransaction<T>(fn: () => T): T;

  close(): void;

  // Raw better-sqlite3 instance for direct DB access (Phase 1.1)
  raw: import("better-sqlite3").Database;
}

export interface InstalledTool {
  id: string;
  name: string;
  type: "builtin" | "mcp" | "custom";
  config?: Record<string, unknown>;
  installedAt: string;
  enabled: boolean;
}

// ─── Inference Client Interface ──────────────────────────────────

export interface InferenceClient {
  chat(
    messages: ChatMessage[],
    options?: InferenceOptions,
  ): Promise<InferenceResponse>;
  setLowComputeMode(enabled: boolean): void;
  getDefaultModel(): string;
  /** Whether a backend is configured that can serve this model (router candidate filter). */
  canServe?(model: { modelId: string; provider: string }): boolean;
}

// ─── Skills ─────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  autoActivate: boolean;
  requires?: SkillRequirements;
  instructions: string;
  source: SkillSource;
  path: string;
  enabled: boolean;
  installedAt: string;
}

export interface SkillRequirements {
  bins?: string[];
  env?: string[];
}

export type SkillSource = "builtin" | "git" | "url" | "self";

export interface SkillFrontmatter {
  name: string;
  description: string;
  "auto-activate"?: boolean;
  requires?: SkillRequirements;
}

// ─── Git ────────────────────────────────────────────────────────

export interface GitStatus {
  branch: string;
  staged: string[];
  modified: string[];
  untracked: string[];
  clean: boolean;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// ─── ERC-8004 Registry ─────────────────────────────────────────

export interface AgentCard {
  type: string;
  name: string;
  description: string;
  services: AgentService[];
  x402Support: boolean;
  active: boolean;
  parentAgent?: string;
}

export interface AgentService {
  name: string;
  endpoint: string;
}

export interface RegistryEntry {
  agentId: string;
  agentURI: string;
  chain: string;
  contractAddress: string;
  txHash: string;
  registeredAt: string;
}

export interface ReputationEntry {
  id: string;
  fromAgent: string;
  toAgent: string;
  score: number;
  comment: string;
  txHash?: string;
  timestamp: string;
}

export interface DiscoveredAgent {
  agentId: string;
  owner: string;
  agentURI: string;
  name?: string;
  description?: string;
}

// ─── Replication ────────────────────────────────────────────────

export interface ChildAutomaton {
  id: string;
  name: string;
  address: string;
  sandboxId: string;
  genesisPrompt: string;
  creatorMessage?: string;
  fundedAmountCents: number;
  status: ChildStatus;
  createdAt: string;
  lastChecked?: string;
  /** Chain type of the child's wallet. */
  chainType?: ChainType;
}

export type ChildStatus =
  | "spawning"
  | "running"
  | "sleeping"
  | "dead"
  | "unknown"
  // Phase 3.1 lifecycle states
  | "requested"
  | "sandbox_created"
  | "runtime_ready"
  | "wallet_verified"
  | "funded"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "stopped"
  | "failed"
  | "cleaned_up";

export interface GenesisConfig {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  parentAddress: string;
  /** Chain type inherited from parent. */
  chainType?: ChainType;
}

export const MAX_CHILDREN = 3;

// ─── Token Budget ───────────────────────────────────────────────

export interface TokenBudget {
  total: number;                     // default: 100_000
  systemPrompt: number;             // default: 20_000 (20%)
  recentTurns: number;              // default: 50_000 (50%)
  toolResults: number;              // default: 20_000 (20%)
  memoryRetrieval: number;          // default: 10_000 (10%)
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  total: 100_000,
  systemPrompt: 20_000,
  recentTurns: 50_000,
  toolResults: 20_000,
  memoryRetrieval: 10_000,
};

// ─── Phase 1: Runtime Reliability ───────────────────────────────

export interface TickContext {
  tickId: string;                    // ULID, unique per tick
  startedAt: Date;
  /** Cents, read once per tick; null when it could not be read. */
  creditBalance: number | null;
  /** USDC, read once per tick; null when it could not be read (or no wallet). */
  usdcBalance: number | null;
  creditRead: import("./conway/balance.js").BalanceRead;
  usdcRead: import("./conway/balance.js").BalanceRead;
  /** From a known balance; when unknown, the last known tier, else low_compute. */
  survivalTier: SurvivalTier;
  /** False when survivalTier was not derived from this tick's balance. */
  survivalTierKnown: boolean;
  lowComputeMultiplier: number;      // from config
  config: HeartbeatConfig;
  db: import("better-sqlite3").Database;
}

export type HeartbeatTaskFn = (
  ctx: TickContext,
  taskCtx: HeartbeatLegacyContext,
) => Promise<{ shouldWake: boolean; message?: string }>;

export interface HeartbeatLegacyContext {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  social?: SocialClientInterface;
}

export interface HeartbeatScheduleRow {
  taskName: string;                  // PK
  cronExpression: string;
  intervalMs: number | null;
  enabled: number;                   // 0 or 1
  priority: number;                  // lower = higher priority
  timeoutMs: number;                 // default 30000
  maxRetries: number;                // default 1
  tierMinimum: string;               // minimum tier to run this task
  lastRunAt: string | null;          // ISO-8601
  nextRunAt: string | null;          // ISO-8601
  lastResult: 'success' | 'failure' | 'timeout' | 'skipped' | null;
  lastError: string | null;
  runCount: number;
  failCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export interface HeartbeatHistoryRow {
  id: string;                        // ULID
  taskName: string;
  startedAt: string;                 // ISO-8601
  completedAt: string | null;
  result: 'success' | 'failure' | 'timeout' | 'skipped';
  durationMs: number | null;
  error: string | null;
  idempotencyKey: string | null;
}

export interface WakeEventRow {
  id: number;                        // AUTOINCREMENT
  source: string;                    // e.g., 'heartbeat', 'inbox', 'manual'
  reason: string;
  payload: string;                   // JSON, default '{}'
  consumedAt: string | null;
  createdAt: string;
}

export interface HeartbeatDedupRow {
  dedupKey: string;                  // PK
  taskName: string;
  expiresAt: string;                 // ISO-8601
}

// === Phase 2.1: Soul System Types ===

export interface SoulModel {
  format: "soul/v1";
  version: number;
  updatedAt: string; // ISO 8601
  // Immutable frontmatter
  name: string;
  address: string;
  creator: string;
  bornAt: string;
  constitutionHash: string;
  genesisPromptOriginal: string;
  genesisAlignment: number; // 0.0-1.0
  lastReflected: string; // ISO 8601
  // Mutable body sections
  corePurpose: string; // max 2000 chars
  values: string[]; // max 20 items
  behavioralGuidelines: string[]; // max 30 items
  personality: string; // max 1000 chars
  boundaries: string[]; // max 20 items
  strategy: string; // max 3000 chars
  capabilities: string; // auto-populated
  relationships: string; // auto-populated
  financialCharacter: string; // auto-populated + agent-set
  // Metadata
  rawContent: string; // original SOUL.md content
  contentHash: string; // SHA-256 of rawContent
}

export interface SoulValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitized: SoulModel;
}

export interface SoulHistoryRow {
  id: string; // ULID
  version: number;
  content: string; // full SOUL.md content
  contentHash: string; // SHA-256
  changeSource: "agent" | "human" | "system" | "genesis" | "reflection";
  changeReason: string | null;
  previousVersionId: string | null;
  approvedBy: string | null;
  createdAt: string;
}

export interface SoulReflection {
  currentAlignment: number;
  suggestedUpdates: Array<{
    section: string;
    reason: string;
    suggestedContent: string;
  }>;
  autoUpdated: string[]; // sections auto-updated (capabilities, relationships, financial)
}

export interface SoulConfig {
  soulAlignmentThreshold: number; // default: 0.5
  requireCreatorApprovalForPurposeChange: boolean; // default: false
  enableSoulReflection: boolean; // default: true
}

export const DEFAULT_SOUL_CONFIG: SoulConfig = {
  soulAlignmentThreshold: 0.5,
  requireCreatorApprovalForPurposeChange: false,
  enableSoulReflection: true,
};

// === Phase 2.2: Memory System Types ===

export type WorkingMemoryType = "goal" | "observation" | "plan" | "reflection" | "task" | "decision" | "note" | "summary";

export interface WorkingMemoryEntry {
  id: string; // ULID
  sessionId: string;
  content: string;
  contentType: WorkingMemoryType;
  priority: number; // 0.0-1.0
  tokenCount: number;
  expiresAt: string | null; // ISO 8601 or null
  sourceTurn: string | null; // turn_id
  createdAt: string;
}

export type TurnClassification = "strategic" | "productive" | "communication" | "maintenance" | "idle" | "error";

export interface EpisodicMemoryEntry {
  id: string; // ULID
  sessionId: string;
  eventType: string;
  summary: string;
  detail: string | null;
  outcome: "success" | "failure" | "partial" | "neutral" | null;
  importance: number; // 0.0-1.0
  embeddingKey: string | null;
  tokenCount: number;
  accessedCount: number;
  lastAccessedAt: string | null;
  classification: TurnClassification;
  createdAt: string;
}

export type SemanticCategory = "self" | "environment" | "financial" | "agent" | "domain" | "procedural_ref" | "creator";

export interface SemanticMemoryEntry {
  id: string; // ULID
  category: SemanticCategory;
  key: string;
  value: string;
  confidence: number; // 0.0-1.0
  source: string; // session_id or turn_id
  embeddingKey: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProceduralStep {
  order: number;
  description: string;
  tool: string | null;
  argsTemplate: Record<string, string> | null;
  expectedOutcome: string | null;
  onFailure: string | null;
}

export interface ProceduralMemoryEntry {
  id: string; // ULID
  name: string; // unique
  description: string;
  steps: ProceduralStep[];
  successCount: number;
  failureCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipMemoryEntry {
  id: string; // ULID
  entityAddress: string; // unique
  entityName: string | null;
  relationshipType: string;
  trustScore: number; // 0.0-1.0
  interactionCount: number;
  lastInteractionAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummaryEntry {
  id: string; // ULID
  sessionId: string; // unique
  summary: string;
  keyDecisions: string[]; // JSON-serialized
  toolsUsed: string[]; // JSON-serialized
  outcomes: string[]; // JSON-serialized
  turnCount: number;
  totalTokens: number;
  totalCostCents: number;
  createdAt: string;
}

export interface MemoryRetrievalResult {
  workingMemory: WorkingMemoryEntry[];
  episodicMemory: EpisodicMemoryEntry[];
  semanticMemory: SemanticMemoryEntry[];
  proceduralMemory: ProceduralMemoryEntry[];
  relationships: RelationshipMemoryEntry[];
  totalTokens: number;
}

export interface MemoryBudget {
  workingMemoryTokens: number; // default: 1500
  episodicMemoryTokens: number; // default: 3000
  semanticMemoryTokens: number; // default: 3000
  proceduralMemoryTokens: number; // default: 1500
  relationshipMemoryTokens: number; // default: 1000
}

export const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
  workingMemoryTokens: 1500,
  episodicMemoryTokens: 3000,
  semanticMemoryTokens: 3000,
  proceduralMemoryTokens: 1500,
  relationshipMemoryTokens: 1000,
};

// === Phase 2.3: Inference & Model Strategy Types ===

export type ModelProvider = "openai" | "anthropic" | "conway" | "ollama" | "other";

export type InferenceTaskType =
  | "agent_turn"
  | "heartbeat_triage"
  | "safety_check"
  | "summarization"
  | "planning";

export interface ModelEntry {
  modelId: string; // e.g. "gpt-4.1", "claude-sonnet-4-6"
  provider: ModelProvider;
  displayName: string;
  tierMinimum: SurvivalTier; // minimum tier to use this model
  costPer1kInput: number; // hundredths of cents
  costPer1kOutput: number; // hundredths of cents
  maxTokens: number;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
  parameterStyle: "max_tokens" | "max_completion_tokens";
  enabled: boolean;
  lastSeen: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPreference {
  candidates: string[]; // model IDs in preference order
  maxTokens: number;
  ceilingCents: number; // max cost per call (-1 = no limit)
}

export type RoutingMatrix = Record<SurvivalTier, Record<InferenceTaskType, ModelPreference>>;

export interface InferenceRequest {
  messages: ChatMessage[];
  taskType: InferenceTaskType;
  tier: SurvivalTier;
  /** Budget session (one wake cycle), not memory's session id. */
  sessionId: string;
  turnId?: string;
  maxTokens?: number; // override
  tools?: unknown[];
  /** Who is calling, for budget attribution. Default "agent_turn". */
  caller?: "agent_turn" | "inbox_turn" | "survival_turn";
  /** A survival turn: cheapest model, survival allowance instead of the regular caps. */
  survival?: boolean;
  /** Aborts the call (shutdown). The router adds its own deadline. */
  signal?: AbortSignal;
}

export interface InferenceRefusal {
  code: string;
  /** When the refusal clears on its own; null when it does not. */
  retryAfterMs: number | null;
  message: string;
}

export interface InferenceResult {
  content: string;
  model: string;
  provider: ModelProvider;
  inputTokens: number;
  outputTokens: number;
  /** Fractional cents; the inference ledger is authoritative. */
  costCents: number;
  costMicroUsd?: number;
  latencyMs: number;
  toolCalls?: unknown[];
  finishReason: string;
  /** Set (with finishReason "budget_exceeded") when every candidate was refused. */
  refusal?: InferenceRefusal;
}

export interface InferenceCostRow {
  id: string; // ULID
  sessionId: string;
  turnId: string | null;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
  tier: string;
  taskType: string;
  cacheHit: boolean;
  createdAt: string;
}

export interface ModelRegistryRow {
  modelId: string;
  provider: string;
  displayName: string;
  tierMinimum: string;
  costPer1kInput: number;
  costPer1kOutput: number;
  maxTokens: number;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
  parameterStyle: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelStrategyConfig {
  inferenceModel: string;
  lowComputeModel: string;
  criticalModel: string;
  maxTokensPerTurn: number;
  hourlyBudgetCents: number; // default: 0 (no limit)
  sessionBudgetCents: number; // default: 0 (no limit)
  perCallCeilingCents: number; // default: 0 (no limit)
  enableModelFallback: boolean; // default: true
  anthropicApiVersion: string; // default: "2023-06-01"
  /** Share (%) of the hourly and daily inference caps orchestration may use. Default 50. */
  orchestrationSharePct?: number;
  /** Survival allowance per rolling 24 h once the regular caps are spent. 0 disables. Default 25. */
  survivalAllowanceCents?: number;
  /** At most one survival turn per this interval. Default 30 min. */
  survivalMinIntervalMs?: number;
  /** Sleep after a session-budget refusal. Default 30 min. */
  sessionCooldownMs?: number;
}

export const DEFAULT_MODEL_STRATEGY_CONFIG: ModelStrategyConfig = {
  inferenceModel: "gpt-5.2",
  lowComputeModel: "gpt-5-mini",
  criticalModel: "gpt-5-mini",
  maxTokensPerTurn: 4096,
  hourlyBudgetCents: 0,
  sessionBudgetCents: 0,
  perCallCeilingCents: 0,
  enableModelFallback: true,
  anthropicApiVersion: "2023-06-01",
  orchestrationSharePct: 50,
  survivalAllowanceCents: 25,
  survivalMinIntervalMs: 1_800_000,
  sessionCooldownMs: 1_800_000,
};

// === Phase 3.1: Replication & Lifecycle Types ===

export type ChildLifecycleState =
  | "requested"
  | "sandbox_created"
  | "runtime_ready"
  | "wallet_verified"
  | "funded"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "stopped"
  | "failed"
  | "cleaned_up";

export const VALID_TRANSITIONS: Record<ChildLifecycleState, ChildLifecycleState[]> = {
  requested: ["sandbox_created", "failed"],
  sandbox_created: ["runtime_ready", "failed"],
  runtime_ready: ["wallet_verified", "failed"],
  wallet_verified: ["funded", "failed"],
  funded: ["starting", "failed"],
  starting: ["healthy", "failed"],
  healthy: ["unhealthy", "stopped"],
  unhealthy: ["healthy", "stopped", "failed"],
  stopped: ["cleaned_up"],
  failed: ["cleaned_up"],
  cleaned_up: [], // terminal
};

export interface ChildLifecycleEventRow {
  id: string; // ULID
  childId: string;
  fromState: string;
  toState: string;
  reason: string | null;
  metadata: string; // JSON
  createdAt: string;
}

export interface HealthCheckResult {
  childId: string;
  healthy: boolean;
  lastSeen: string | null;
  uptime: number | null;
  creditBalance: number | null;
  issues: string[];
  /**
   * What the probe established: the agent process runs, it definitely does
   * not (or the sandbox is gone), or nothing could be learned (API error).
   */
  probe?: "running" | "offline" | "unknown";
  /** Lifecycle state after checkAllChildren acted on the probe. */
  state?: string;
}

export interface ChildHealthConfig {
  checkIntervalMs: number; // default: 300000 (5 min)
  /** A child still `starting` after this long with no process is failed. default: 600000 (10 min) */
  unhealthyThresholdMs: number;
  /** An unhealthy child whose process is confirmed gone this long is failed. default: 1800000 (30 min) */
  deadThresholdMs: number;
  maxConcurrentChecks: number; // default: 3
}

export const DEFAULT_CHILD_HEALTH_CONFIG: ChildHealthConfig = {
  checkIntervalMs: 300_000,
  unhealthyThresholdMs: 600_000,
  deadThresholdMs: 1_800_000,
  maxConcurrentChecks: 3,
};

export interface GenesisLimits {
  maxNameLength: number; // default: 64
  maxSpecializationLength: number; // default: 2000
  maxTaskLength: number; // default: 4000
  maxMessageLength: number; // default: 2000
  maxGenesisPromptLength: number; // default: 16000
}

export const DEFAULT_GENESIS_LIMITS: GenesisLimits = {
  maxNameLength: 64,
  maxSpecializationLength: 2000,
  maxTaskLength: 4000,
  maxMessageLength: 2000,
  maxGenesisPromptLength: 16000,
};

export interface ParentChildMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  type: string;
  sentAt: string;
}

export const MESSAGE_LIMITS = {
  maxContentLength: 64_000, // 64KB
  maxTotalSize: 128_000, // 128KB
  replayWindowMs: 300_000, // 5 minutes
  maxOutboundPerHour: 100,
} as const;

// === Phase 3.2: Social & Registry Types ===

export interface SignedMessagePayload {
  from: string;
  to: string;
  content: string;
  signed_at: string;
  signature: string;
  reply_to?: string;
}

export interface MessageValidationResult {
  valid: boolean;
  errors: string[];
}

export interface DiscoveryConfig {
  ipfsGateway: string; // default: "https://ipfs.io"
  maxScanCount: number; // default: 100
  maxConcurrentFetches: number; // default: 5
  maxCardSizeBytes: number; // default: 64000
  fetchTimeoutMs: number; // default: 10000
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  ipfsGateway: "https://ipfs.io",
  maxScanCount: 100,
  maxConcurrentFetches: 5,
  maxCardSizeBytes: 64_000,
  fetchTimeoutMs: 10_000,
};

export interface OnchainTransactionRow {
  id: string; // ULID
  txHash: string;
  chain: string;
  operation: string;
  status: "pending" | "confirmed" | "failed";
  gasUsed: number | null;
  metadata: string; // JSON
  createdAt: string;
}

export interface DiscoveredAgentCacheRow {
  agentAddress: string; // PRIMARY KEY
  agentCard: string; // JSON AgentCard
  fetchedFrom: string; // URI
  cardHash: string;
  validUntil: string | null;
  fetchCount: number;
  lastFetchedAt: string;
  createdAt: string;
}

// === Phase 4.1: Observability Types ===

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, unknown>;
  error?: { message: string; stack?: string; code?: string };
}

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricEntry {
  name: string;
  value: number;
  type: MetricType;
  labels: Record<string, string>;
  timestamp: string;
}

export interface MetricSnapshotRow {
  id: string; // ULID
  snapshotAt: string;
  metricsJson: string; // JSON array of MetricEntry
  alertsJson: string; // JSON array of fired alert names
  createdAt: string;
}

export type AlertSeverity = "warning" | "critical";

export interface AlertRule {
  name: string;
  severity: AlertSeverity;
  message: string;
  cooldownMs: number; // minimum ms between firings
  condition: (metrics: MetricSnapshot) => boolean;
}

export interface MetricSnapshot {
  counters: Map<string, number>;
  gauges: Map<string, number>;
  histograms: Map<string, number[]>;
}

export interface AlertEvent {
  rule: string;
  severity: AlertSeverity;
  message: string;
  firedAt: string;
  metricValues: Record<string, number>;
}
