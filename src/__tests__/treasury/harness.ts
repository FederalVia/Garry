/**
 * Shared treasury test harness.
 *
 * makeHarness() builds a real database, a fake clock, a mock Conway client
 * that behaves like the raw primitives (calls onSend before "sending",
 * records idempotency keys, can fail on demand), an installed Treasury, the
 * default policy engine and a SpendTracker. No network.
 */

import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import type {
  AutomatonDatabase,
  ConwayClient,
  CreateSandboxOptions,
  CreditTransferResult,
  DomainRegistration,
  DomainSearchResult,
  OutflowRequestOptions,
  PricingTier,
  SandboxInfo,
  ToolCallResult,
  ToolContext,
  TreasuryPolicy,
} from "../../types.js";
import {
  Treasury,
  centsFromAtomic,
  guardConwayClient,
  installTreasury,
  listLedgerRows,
  normalizeTreasuryPolicy,
  resetTreasuryForTests,
  type BudgetId,
  type LedgerRow,
  type LedgerStatus,
  type OutflowQuote,
  type ResolvedTreasuryPolicy,
  type TopupPurpose,
  type TreasuryDeps,
} from "../../treasury/index.js";

/** The audit policy: single 5000, hourly 10000, daily 25000, reserve 1000, 2 per turn, confirmation 1000. */
export const AUDIT_POLICY: Partial<TreasuryPolicy> = {
  maxSingleTransferCents: 5000,
  maxHourlyTransferCents: 10000,
  maxDailyTransferCents: 25000,
  minimumReserveCents: 1000,
  maxTransfersPerTurn: 2,
  requireConfirmationAboveCents: 1000,
};

/** Address the harness treasury treats as its own. */
export const SELF_ADDRESS = createTestIdentity().address;
export const CHILD_ADDRESS = "0x00000000000000000000000000000000000c41d1";
export const OTHER_ADDRESS = "0x0000000000000000000000000000000000000b0b";
export const PAY_TO = "0x00000000000000000000000000000000000fee01";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Default fake time: 2026-03-01T12:00:00Z. */
export const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

export interface FakeClock {
  now(): number;
  advance(ms: number): number;
  set(ms: number): void;
}

export function makeClock(start = T0): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => (t += ms),
    set: (ms) => {
      t = ms;
    },
  };
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** How the next call to a mocked primitive fails after it has "sent". */
export type FailSpec =
  | { status: number; body?: string }
  | "timeout"
  | "reset"
  | "refused"
  | "circuit"
  | Error;

function makeFailure(spec: FailSpec, path: string): Error {
  if (spec instanceof Error) return spec;
  if (spec === "timeout") {
    const e = new Error("This operation was aborted");
    e.name = "AbortError";
    return e;
  }
  if (spec === "reset") {
    return Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
  }
  if (spec === "refused") {
    return Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }
  if (spec === "circuit") {
    const e = new Error("Circuit breaker is open");
    e.name = "CircuitOpenError";
    return e;
  }
  const text = spec.body ?? "error";
  return Object.assign(new Error(`Conway API error: POST ${path} -> ${spec.status}: ${text}`), {
    status: spec.status,
    responseText: text,
  });
}

export interface PrimitiveCall {
  args: unknown[];
  idempotencyKey?: string;
}

/**
 * MockConwayClient that behaves like the raw primitives: onSend runs once
 * before "sending", the idempotency key is recorded, and failures can be
 * injected per method. Optional gates hold a call until resolved.
 */
export class TestConwayClient extends MockConwayClient {
  pricing: PricingTier[] = [];
  domains: DomainSearchResult[] = [
    { domain: "test.com", available: true, registrationPrice: 1200, currency: "USD" },
  ];
  balanceError: Error | null = null;
  balanceReads = 0;
  transferResult: Partial<CreditTransferResult> | null = null;
  calls: { transferCredits: PrimitiveCall[]; createSandbox: PrimitiveCall[]; registerDomain: PrimitiveCall[] } = {
    transferCredits: [],
    createSandbox: [],
    registerDomain: [],
  };
  gates: { balance?: Promise<void>; transferCredits?: Promise<void>; createSandbox?: Promise<void>; registerDomain?: Promise<void> } = {};
  private failures: Record<string, FailSpec[]> = {};

  failNext(method: "transferCredits" | "createSandbox" | "registerDomain", spec: FailSpec): void {
    (this.failures[method] ??= []).push(spec);
  }

  private takeFailure(method: string): FailSpec | undefined {
    return this.failures[method]?.shift();
  }

  async getCreditsBalance(): Promise<number> {
    this.balanceReads++;
    if (this.gates.balance) await this.gates.balance;
    if (this.balanceError) throw this.balanceError;
    return this.creditsCents;
  }

  async getCreditsPricing(): Promise<PricingTier[]> {
    return this.pricing;
  }

  async searchDomains(_query: string, _tlds?: string): Promise<DomainSearchResult[]> {
    return this.domains;
  }

  async transferCredits(
    toAddress: string,
    amountCents: number,
    note?: string,
    opts?: OutflowRequestOptions,
  ): Promise<CreditTransferResult> {
    if (this.gates.transferCredits) await this.gates.transferCredits;
    opts?.onSend?.();
    this.calls.transferCredits.push({ args: [toAddress, amountCents, note], idempotencyKey: opts?.idempotencyKey });
    const failure = this.takeFailure("transferCredits");
    if (failure) throw makeFailure(failure, "/v1/credits/transfer");
    this.creditsCents -= amountCents;
    return {
      transferId: `txn_${this.calls.transferCredits.length}`,
      status: "completed",
      toAddress,
      amountCents,
      balanceAfterCents: this.creditsCents,
      ...(this.transferResult ?? {}),
    };
  }

  async createSandbox(options: CreateSandboxOptions): Promise<SandboxInfo> {
    if (this.gates.createSandbox) await this.gates.createSandbox;
    options.onSend?.();
    const { onSend: _onSend, ...rest } = options;
    this.calls.createSandbox.push({ args: [rest], idempotencyKey: options.idempotencyKey });
    const failure = this.takeFailure("createSandbox");
    if (failure) throw makeFailure(failure, "/v1/sandboxes");
    return super.createSandbox(options);
  }

  async registerDomain(domain: string, years?: number, opts?: OutflowRequestOptions): Promise<DomainRegistration> {
    if (this.gates.registerDomain) await this.gates.registerDomain;
    opts?.onSend?.();
    this.calls.registerDomain.push({ args: [domain, years], idempotencyKey: opts?.idempotencyKey });
    const failure = this.takeFailure("registerDomain");
    if (failure) throw makeFailure(failure, "/v1/domains/register");
    return { domain, status: "registered", transactionId: `dom_${this.calls.registerDomain.length}` };
  }
}

export interface HarnessOptions {
  policy?: Partial<TreasuryPolicy>;
  balance?: number;
  pricing?: PricingTier[];
  now?: number;
  /** Install the treasury as the process-wide instance (default true). */
  install?: boolean;
  readAuthorizationState?: TreasuryDeps["readAuthorizationState"];
  conwayApiUrl?: string;
  /** Run before the Treasury is constructed (seed legacy or crashed rows). */
  beforeTreasury?: (raw: Database.Database) => void;
}

export interface ExecOptions {
  source?: string;
  turnCount?: number;
  /** Pass the policy engine and a turn context (default true). */
  engine?: boolean;
}

export interface Harness {
  db: AutomatonDatabase;
  raw: Database.Database;
  clock: FakeClock;
  inner: TestConwayClient;
  policy: ResolvedTreasuryPolicy;
  treasury: Treasury;
  /** guardConwayClient(inner, treasury). */
  readonly conway: ConwayClient;
  tracker: SpendTracker;
  engine: PolicyEngine;
  deps: TreasuryDeps;
  /** Another Treasury over the same database (same boot id unless overridden). */
  newTreasury(overrides?: Partial<TreasuryDeps>): Treasury;
  exec(tool: string, args: Record<string, unknown>, opts?: ExecOptions): Promise<ToolCallResult>;
  rows(budget?: BudgetId, status?: LedgerStatus): LedgerRow[];
  counted(budget?: BudgetId): LedgerRow[];
  close(): void;
}

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const db = createTestDb();
  const raw = db.raw;
  const clock = makeClock(opts.now ?? T0);
  const inner = new TestConwayClient();
  if (opts.balance !== undefined) inner.creditsCents = opts.balance;
  if (opts.pricing) inner.pricing = opts.pricing;
  const policy = normalizeTreasuryPolicy({ ...opts.policy });
  const tracker = new SpendTracker(raw);
  opts.beforeTreasury?.(raw);

  const deps: TreasuryDeps = {
    db: raw,
    policy,
    selfAddress: SELF_ADDRESS,
    readCreditBalance: () => inner.getCreditsBalance(),
    readAuthorizationState: opts.readAuthorizationState,
    spendTracker: tracker,
    now: clock.now,
    conwayApiUrl: opts.conwayApiUrl ?? "https://api.conway.tech",
  };
  const treasury = new Treasury(deps);
  if (opts.install !== false) installTreasury(treasury);
  const engine = new PolicyEngine(raw, createDefaultRules(policy));
  let conway: ConwayClient | undefined;

  const harness: Harness = {
    db,
    raw,
    clock,
    inner,
    policy,
    treasury,
    get conway() {
      return (conway ??= guardConwayClient(inner, treasury));
    },
    tracker,
    engine,
    deps,
    newTreasury: (overrides = {}) => new Treasury({ ...deps, ...overrides }),
    async exec(toolName, args, execOpts = {}) {
      const { createBuiltinTools, executeTool } = await import("../../agent/tools.js");
      const tools = createBuiltinTools("test-sandbox-id");
      const context: ToolContext = {
        identity: createTestIdentity(),
        config: createTestConfig({ treasuryPolicy: policy }),
        db,
        conway: harness.conway,
        inference: new MockInferenceClient(),
      };
      const useEngine = execOpts.engine !== false;
      return executeTool(
        toolName,
        args,
        tools,
        context,
        useEngine ? engine : undefined,
        useEngine
          ? {
              inputSource: execOpts.source as never,
              turnToolCallCount: execOpts.turnCount ?? 0,
              sessionSpend: tracker,
            }
          : undefined,
      );
    },
    rows: (budget, status) => listLedgerRows(raw, { budget, status }),
    counted: (budget) =>
      listLedgerRows(raw, { budget }).filter((r) =>
        ["reserved", "sent", "unknown", "committed"].includes(r.status),
      ),
    close() {
      resetTreasuryForTests();
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
  return harness;
}

// ─── Quote builders ─────────────────────────────────────────────

let seq = 0;

export function transferQuote(to: string, amountCents: number, extra: Partial<OutflowQuote> = {}): OutflowQuote {
  return {
    kind: "credit_transfer",
    amountCents,
    amountBasis: "exact",
    counterparty: to,
    dedupeKey: `credit_transfer|${to.toLowerCase()}|${amountCents}|`,
    description: `Transfer to ${to}`,
    ...extra,
  };
}

export function sandboxQuote(amountCents: number, name = "box", extra: Partial<OutflowQuote> = {}): OutflowQuote {
  return {
    kind: "sandbox_create",
    amountCents,
    amountBasis: "quote",
    counterparty: "conway:sandbox",
    dedupeKey: `sandbox_create|${name}|1|512|5`,
    description: `Sandbox ${name}`,
    ...extra,
  };
}

export function domainQuote(domain: string, amountCents: number, extra: Partial<OutflowQuote> = {}): OutflowQuote {
  return {
    kind: "domain_register",
    amountCents,
    amountBasis: "quote",
    counterparty: domain,
    dedupeKey: `domain_register|${domain.toLowerCase()}|1`,
    description: `Domain ${domain} (1y)`,
    ...extra,
  };
}

export function randomNonce(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

/** An x402 fetch payment of `atomic` USDC units, valid for validSeconds from clock time. */
export function x402Quote(
  nowMs: number,
  atomic: bigint,
  url = "https://api.conway.tech/v1/data",
  extra: Partial<OutflowQuote> = {},
  validSeconds = 300,
): OutflowQuote {
  return {
    kind: "x402_payment",
    amountCents: centsFromAtomic(atomic),
    amountAtomic: atomic,
    amountBasis: "exact",
    counterparty: PAY_TO,
    dedupeKey: `x402|GET|${url}|${atomic}|${++seq}`,
    description: `x402 ${url}`,
    url,
    x402: {
      nonce: randomNonce(),
      validBefore: Math.floor(nowMs / 1000) + validSeconds,
      from: SELF_ADDRESS,
      network: "eip155:8453",
      asset: USDC_BASE,
    },
    ...extra,
  };
}

/** A credit topup of amountUsd dollars for this automaton. */
export function topupQuote(
  nowMs: number,
  amountUsd: number,
  purpose: TopupPurpose = "manual",
  extra: Partial<OutflowQuote> = {},
  validSeconds = 300,
): OutflowQuote {
  const atomic = BigInt(amountUsd) * 1_000_000n;
  return {
    kind: "credit_topup",
    amountCents: amountUsd * 100,
    amountAtomic: atomic,
    amountBasis: "exact",
    counterparty: PAY_TO,
    dedupeKey: `topup|${purpose}|${amountUsd}`,
    description: `Credit topup $${amountUsd}`,
    topupPurpose: purpose,
    recipient: SELF_ADDRESS,
    url: `https://api.conway.tech/pay/${amountUsd}/${SELF_ADDRESS}`,
    x402: {
      nonce: randomNonce(),
      validBefore: Math.floor(nowMs / 1000) + validSeconds,
      from: SELF_ADDRESS,
      network: "eip155:8453",
      asset: USDC_BASE,
    },
    ...extra,
  };
}
