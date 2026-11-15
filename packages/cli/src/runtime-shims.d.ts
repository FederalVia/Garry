declare module "@conway/automaton/config.js" {
  export interface AutomatonCliConfig {
    name: string;
    walletAddress: string;
    creatorAddress: string;
    sandboxId: string;
    dbPath: string;
    inferenceModel: string;
    conwayApiUrl: string;
    conwayApiKey: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    socialRelayUrl?: string;
    relay?: { conwayCompat?: boolean };
    chainType?: "evm" | "solana";
  }

  export function loadConfig(): AutomatonCliConfig | null;
  export function resolvePath(p: string): string;
}

declare module "@conway/automaton/state/database.js" {
  export interface CliToolCall {
    name: string;
    result: string;
    error?: string;
  }

  export interface CliTurn {
    id: string;
    timestamp: string;
    state: string;
    input?: string;
    inputSource?: string;
    thinking: string;
    toolCalls: CliToolCall[];
    tokenUsage: { totalTokens: number };
    costCents: number;
  }

  export interface CliHeartbeatEntry {
    enabled: boolean;
  }

  export interface CliInstalledTool {
    id: string;
    name: string;
  }

  export interface AutomatonCliDatabase {
    getAgentState(): string;
    getTurnCount(): number;
    getInstalledTools(): CliInstalledTool[];
    getHeartbeatEntries(): CliHeartbeatEntry[];
    getRecentTurns(limit: number): CliTurn[];
    close(): void;
  }

  export function createDatabase(path: string): AutomatonCliDatabase;
}

declare module "@conway/automaton/operator/fund.js" {
  import type { AutomatonCliConfig } from "@conway/automaton/config.js";

  export type ParseAmountResult =
    | { ok: true; cents: number }
    | { ok: false; error: string };

  export interface FundPlan {
    apiUrl: string;
    apiKey: string;
    chainType: "evm" | "solana";
    from: string;
    to: string;
    amountCents: number;
    note: string;
    description: string;
  }

  export type FundResult =
    | {
        status: "ok";
        idempotencyKey: string;
        path: string;
        transferId: string;
        transferStatus: string;
        balanceAfterCents?: number;
      }
    | { status: "failed"; idempotencyKey: string; error: string }
    | { status: "unknown"; idempotencyKey: string; error: string };

  export function parseUsdAmount(raw: string, opts: { cents: boolean }): ParseAmountResult;
  export function planFund(input: {
    config: Partial<AutomatonCliConfig>;
    to: string | undefined;
    amountCents: number;
  }): { ok: true; plan: FundPlan } | { ok: false; error: string };
  export function executeFund(
    plan: FundPlan,
    opts: { paths: readonly string[]; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<FundResult>;
  export function formatUsd(cents: number): string;
  export function formatFundResult(plan: FundPlan, result: FundResult): string;
  export function formatFundError(err: unknown): string;
  export function confirmOnTty(question: string): Promise<boolean | null>;
  export const FUND_USAGE: string;
}

declare module "@conway/automaton/operator/send.js" {
  export interface RelayClientOptions {
    conwayCompat: boolean;
  }
  export type SendOperatorResult =
    | {
        ok: true;
        id: string;
        from: string;
        to: string;
        relayUrl: string;
        chainType: "evm" | "solana";
        protocol: "automaton/1" | "conway";
      }
    | { ok: false; error: string };
  export type RelayTarget =
    | { ok: true; relayUrl: string; options: RelayClientOptions }
    | { ok: false; error: string };

  export const CONWAY_SOCIAL_RELAY_URL: string;
  export function resolveRelayTarget(
    config: { socialRelayUrl?: string; relay?: { conwayCompat?: unknown } } | null | undefined,
    env?: NodeJS.ProcessEnv,
    opts?: { fileSetsRelayUrl?: boolean },
  ): RelayTarget;
  export function loadRelayTarget(env?: NodeJS.ProcessEnv): RelayTarget;
  export function resolveRelayUrl(
    config: { socialRelayUrl?: string; relay?: { conwayCompat?: unknown } } | null | undefined,
  ): string;
  export function sendOperatorMessage(input: {
    relayUrl: string;
    to: string;
    content: string;
    options?: RelayClientOptions;
  }): Promise<SendOperatorResult>;
  export function formatSendResult(result: SendOperatorResult): { ok: boolean; lines: string[] };
}

declare module "@conway/automaton/observability/terminal-safe.js" {
  export function escapeForTerminal(text: string, opts?: { keepNewlines?: boolean }): string;
}

declare module "@conway/automaton/operator/turn-log.js" {
  import type { CliTurn } from "@conway/automaton/state/database.js";

  export function formatTurnLines(turn: CliTurn): string[];
  export function formatActivityLine(turn: Pick<CliTurn, "timestamp" | "thinking" | "toolCalls">): string;
}

declare module "@conway/automaton/operator/budget.js" {
  export interface CliIo {
    log: (line: string) => void;
    confirm: (question: string) => Promise<boolean | null>;
  }
  // Opaque here: the CLI only passes these between runtime calls.
  export type BudgetContext = { readonly __budgetContext: unique symbol };
  export type BudgetReport = { readonly __budgetReport: unique symbol };

  export function budgetContext(): BudgetContext;
  export function budgetReport(ctx: BudgetContext, nowMs?: number): BudgetReport;
  export function budgetStatusLine(r: BudgetReport): string;
  export function standaloneFundRefusal(): string | null;
  export function runBudgetCli(args: string[], io: CliIo): Promise<number>;
}

declare module "@conway/automaton/operator/approvals.js" {
  import type { CliIo } from "@conway/automaton/operator/budget.js";

  export type ApprovalsContext = { readonly __approvalsContext: unique symbol };

  export function approvalsContext(): ApprovalsContext;
  export function pendingApprovalCount(ctx: ApprovalsContext, nowMs?: number): number;
  export function runApprovalsCli(args: string[], io: CliIo): Promise<number>;
}
