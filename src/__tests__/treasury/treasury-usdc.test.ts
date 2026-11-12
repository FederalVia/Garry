/**
 * Treasury, USDC side: x402 payments and credit topups gated between the
 * quote and the signature, the automatic survival topups, the heartbeat and
 * the startup bootstrap. Real Treasury, ledger, PolicyEngine and executeTool;
 * fetch is stubbed with a fake x402 paywall, payments are signed with a
 * throwaway key, and the on-chain reads are stubs. No network.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

vi.mock("../../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 1000) };
});

import {
  PAID_ERROR_BODY_TIMEOUT_MS,
  getUsdcBalance,
  readUsdcAuthorizationState,
  resetX402HttpClientForTests,
  x402Fetch,
} from "../../conway/x402.js";
import { ResilientHttpClient } from "../../conway/http-client.js";
import {
  bootstrapTopup,
  startupBootstrapTopup,
  topupCredits,
  topupForSandbox,
} from "../../conway/topup.js";
import { BUILTIN_TASKS } from "../../heartbeat/tasks.js";
import {
  DAY_MS,
  HOUR_MS,
  X402_MAX_VALIDITY_SECONDS,
  installTreasury,
  listLedgerRows,
  resetTreasuryForTests,
  runWithTreasuryOrigin,
  type BudgetId,
  type LedgerRow,
  type Treasury,
} from "../../treasury/index.js";
import type { HeartbeatLegacyContext, TickContext, ToolCallResult, ToolContext } from "../../types.js";
import { MockInferenceClient, createTestConfig, createTestIdentity } from "../mocks.js";
import {
  OTHER_ADDRESS,
  PAY_TO,
  T0,
  USDC_BASE,
  deferred,
  makeHarness,
  x402Quote,
  type Harness,
  type HarnessOptions,
} from "./harness.js";

const API = "https://api.conway.tech";
const DATA_URL = `${API}/v1/data`;
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MIN = 60_000;
/** Nothing listens here (see FakePaywall.fetch). */
const CLOSED_PORT = "1";

// ─── Fake x402 paywall ──────────────────────────────────────────

interface Offer {
  atomic: string;
  network?: string;
  asset?: string;
  payTo?: string;
  scheme?: string;
  maxTimeoutSeconds?: number;
  requiredDeadlineSeconds?: number;
}

interface PaywallRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  payment?: {
    network: string;
    payload: { authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string } };
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Answers every unpaid request with a 402 for `offer(url)` (topup URLs
 * default to their tier) and every request carrying X-Payment with `paid`.
 * JSON-RPC posts (viem reads) go to `rpc`.
 */
class FakePaywall {
  requests: PaywallRequest[] = [];
  offer: (url: string) => Offer | null = (url) => {
    const m = /\/pay\/(\d+)\//.exec(url);
    return { atomic: m ? String(BigInt(m[1]) * 1_000_000n) : "1000000" };
  };
  paid: (req: PaywallRequest) => Response | Promise<Response> = () => json(200, { ok: true });
  probe?: (req: PaywallRequest) => Response | Promise<Response>;
  rpc: (body: { id: number; method: string; params: unknown[] }) => Response = (body) =>
    json(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no rpc in this test" } });

  get payments(): PaywallRequest[] {
    return this.requests.filter((r) => r.payment);
  }

  /**
   * fetch as Node runs it: a 3xx is followed (custom headers such as
   * X-Payment included) unless redirect is "manual", and a connection to a
   * closed port fails with ECONNREFUSED.
   */
  fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (new URL(url).port === CLOSED_PORT) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    const resp = await this.answer(url, init);
    const location = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400 && location && init.redirect !== "manual") {
      return this.fetch(new URL(location, url).href, init);
    }
    return resp;
  };

  private answer = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = { ...((init.headers as Record<string, string>) ?? {}) };
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body && body.includes('"jsonrpc"')) {
      return this.rpc(JSON.parse(body));
    }
    const req: PaywallRequest = { url, method: init.method ?? "GET", headers, body };
    if (headers["X-Payment"]) {
      req.payment = JSON.parse(Buffer.from(headers["X-Payment"], "base64").toString("utf-8"));
    }
    this.requests.push(req);
    if (req.payment) return this.paid(req);
    if (this.probe) return this.probe(req);
    const offer = this.offer(url);
    if (!offer) return json(200, { free: true });
    return json(402, {
      x402Version: 2,
      accepts: [
        {
          scheme: offer.scheme ?? "exact",
          network: offer.network ?? "eip155:8453",
          maxAmountRequired: offer.atomic,
          payTo: offer.payTo ?? PAY_TO,
          asset: offer.asset ?? USDC_BASE,
          ...(offer.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: offer.maxTimeoutSeconds } : {}),
          ...(offer.requiredDeadlineSeconds !== undefined
            ? { requiredDeadlineSeconds: offer.requiredDeadlineSeconds }
            : {}),
        },
      ],
    });
  };
}

// ─── Setup ──────────────────────────────────────────────────────

interface Usdc {
  h: Harness;
  account: PrivateKeyAccount;
  treasury: Treasury;
  paywall: FakePaywall;
  /**
   * What the stub authorizationState read says (null: RPC down). false is
   * reported at a block whose time is the harness clock minus chainLagSec.
   */
  auth: { value: boolean | null; chainLagSec: number };
  rows(budget?: BudgetId, status?: LedgerRow["status"]): LedgerRow[];
  exec(tool: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  identity(): HeartbeatLegacyContext["identity"];
}

let open: Harness[] = [];
let paywall: FakePaywall;

function setup(opts: HarnessOptions = {}): Usdc {
  const account = privateKeyToAccount(generatePrivateKey());
  const auth = { value: null as boolean | null, chainLagSec: 0 };
  const h: Harness = makeHarness({
    install: false,
    readAuthorizationState: async () =>
      auth.value === false
        ? { used: false, blockTimestamp: Math.floor(h.clock.now() / 1000) - auth.chainLagSec }
        : auth.value,
    ...opts,
  });
  open.push(h);
  // The paying account is this automaton, so topups for it are for "self".
  const treasury = h.newTreasury({ selfAddress: account.address });
  installTreasury(treasury);
  const identity = () => ({ ...createTestIdentity(), address: account.address, account });
  return {
    h,
    account,
    treasury,
    paywall,
    auth,
    rows: (budget, status) => listLedgerRows(h.raw, { budget, status }),
    identity,
    async exec(toolName, args) {
      const { createBuiltinTools, executeTool } = await import("../../agent/tools.js");
      const context: ToolContext = {
        identity: identity(),
        config: createTestConfig({ treasuryPolicy: h.policy }),
        db: h.db,
        conway: h.conway,
        inference: new MockInferenceClient(),
      };
      return executeTool(toolName, args, createBuiltinTools("test-sandbox-id"), context, h.engine, {
        inputSource: "agent",
        turnToolCallCount: 0,
        sessionSpend: h.tracker,
      });
    },
  };
}

function tickContext(u: Usdc, overrides: Partial<TickContext> = {}): TickContext {
  return {
    tickId: "tick-1",
    startedAt: new Date(),
    creditBalance: 0,
    usdcBalance: 10,
    survivalTier: "critical",
    lowComputeMultiplier: 4,
    config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
    db: u.h.raw,
    ...overrides,
  };
}

function taskContext(u: Usdc): HeartbeatLegacyContext {
  return { identity: u.identity(), config: createTestConfig(), db: u.h.db, conway: u.h.inner };
}

function deniedCount(rows: LedgerRow[]): number {
  return rows.filter((r) => r.status === "denied").reduce((n, r) => n + r.deny_count, 0);
}

function transactions(u: Usdc, type: string): Array<{ amount_cents: number; balance_after_cents: number | null; description: string }> {
  return u.h.raw
    .prepare("SELECT amount_cents, balance_after_cents, description FROM transactions WHERE type = ?")
    .all(type) as Array<{ amount_cents: number; balance_after_cents: number | null; description: string }>;
}

function toolText(r: ToolCallResult): string {
  return `${r.result ?? ""} ${r.error ?? ""}`;
}

/** A committed ledger row from earlier in the day, to use up a budget. */
function seedCommitted(u: Usdc, budget: BudgetId, cents: number, atMs: number): void {
  const kind =
    budget === "transfer" ? "credit_transfer" : budget === "x402" ? "x402_payment" : budget === "infra" ? "sandbox_create" : "credit_topup";
  const id = `seed-${budget}-${atMs}-${cents}`;
  u.h.raw
    .prepare(
      `INSERT INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents, committed_cents,
         amount_atomic, debits_credits, counterparty, dedupe_key, origin_type, topup_purpose, created_at_ms,
         settled_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?)`,
    )
    .run(
      id,
      id,
      kind,
      budget,
      cents,
      cents,
      kind === "x402_payment" || kind === "credit_topup" ? cents * 10_000 : null,
      kind === "credit_transfer" || kind === "sandbox_create" ? 1 : 0,
      kind === "credit_transfer" ? OTHER_ADDRESS : PAY_TO,
      `seed|${id}`,
      kind === "credit_topup" ? (budget === "topup_auto" ? "survival" : "manual") : null,
      atMs,
      atMs,
      atMs,
    );
}

beforeEach(() => {
  paywall = new FakePaywall();
  vi.stubGlobal("fetch", paywall.fetch);
  resetX402HttpClientForTests();
  vi.mocked(getUsdcBalance).mockReset();
  vi.mocked(getUsdcBalance).mockResolvedValue(1000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const h of open) h.close();
  open = [];
  resetTreasuryForTests();
});

// ─── x402 fetch payments ────────────────────────────────────────

describe("x402 payments are reserved at their real amount (F044)", () => {
  it("U1: 60 paid x402_fetch calls at $1 stop at the 1000c hourly envelope", async () => {
    const u = setup();
    const results: ToolCallResult[] = [];
    for (let i = 0; i < 60; i++) {
      results.push(await u.exec("x402_fetch", { url: DATA_URL }));
    }

    expect(paywall.payments).toHaveLength(10);
    expect(results.filter((r) => toolText(r).includes("x402 fetch succeeded"))).toHaveLength(10);
    expect(results.filter((r) => toolText(r).includes("SPEND_LIMIT_EXCEEDED"))).toHaveLength(50);
    expect(u.rows("x402", "committed")).toHaveLength(10);
    // The x402_envelope policy rule reads the mirror the gate writes on
    // commit, so it refuses the 50 extra calls before they reach the gate.
    const envelopeDenials = u.h.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM policy_decisions
         WHERE tool_name = 'x402_fetch' AND decision = 'deny' AND rules_triggered LIKE '%financial.x402_envelope%'`,
      )
      .get() as { n: number };
    expect(envelopeDenials.n + deniedCount(u.rows("x402"))).toBe(50);
    expect(envelopeDenials.n).toBe(50);
    // Without the rule the gate itself holds the same envelope.
    const direct = await x402Fetch(DATA_URL, u.account);
    expect(direct.denied?.code).toBe("SPEND_LIMIT_EXCEEDED");
    expect(paywall.payments).toHaveLength(10);
    expect(u.treasury.usage("x402", HOUR_MS)).toBe(1000);
    expect(u.h.tracker.getHourlySpend("x402")).toBe(1000);

    const mirror = u.h.raw
      .prepare("SELECT domain, amount_cents FROM spend_tracking WHERE category = 'x402' AND amount_cents > 0")
      .all() as Array<{ domain: string; amount_cents: number }>;
    expect(mirror).toHaveLength(10);
    expect(mirror.every((m) => m.domain === "api.conway.tech" && m.amount_cents === 100)).toBe(true);
    expect(transactions(u, "x402_payment")).toHaveLength(10);
  });

  it("U2: the reserved amount is the signed atomic amount rounded up to cents", async () => {
    const u = setup();
    paywall.offer = (url) => ({ atomic: url.endsWith("/a") ? "370000" : "10001" });

    const a = await x402Fetch(`${API}/v1/a`, u.account);
    const b = await x402Fetch(`${API}/v1/b`, u.account);

    expect(a).toMatchObject({ success: true, paidCents: 37, settlement: "committed" });
    expect(b).toMatchObject({ success: true, paidCents: 2, settlement: "committed" });
    const rows = u.rows("x402", "committed");
    expect(rows.map((r) => [r.amount_cents, r.amount_atomic])).toEqual([
      [37, 370000],
      [2, 10001],
    ]);
    // What was signed is exactly what was reserved.
    expect(paywall.payments.map((p) => p.payment!.payload.authorization.value)).toEqual(["370000", "10001"]);
  });

  it("sub-cent payments are summed in atomic units, not rounded up one by one", async () => {
    const u = setup();
    paywall.offer = () => ({ atomic: "100" }); // $0.0001
    for (let i = 0; i < 50; i++) {
      const r = await x402Fetch(DATA_URL, u.account);
      expect(r.success).toBe(true);
    }
    expect(u.rows("x402", "committed")).toHaveLength(50);
    // 50 x 100 atomic = 5000 atomic = 0.5c, counted as 1c (not 50c).
    expect(u.treasury.usage("x402", HOUR_MS)).toBe(1);
  });

  it("U3: an endpoint that does not ask for payment leaves no ledger row", async () => {
    const u = setup();
    paywall.probe = (req) =>
      req.url.endsWith("/free") ? json(200, { free: true }) : new Response("missing", { status: 404 });

    const free = await x402Fetch(`${API}/v1/free`, u.account);
    const missing = await x402Fetch(`${API}/v1/missing`, u.account);

    expect(free).toMatchObject({ success: true, response: { free: true }, settlement: "none" });
    expect(missing).toMatchObject({ success: false, status: 404, response: "missing", settlement: "none" });
    expect(u.rows()).toHaveLength(0);
    expect(u.h.tracker.getHourlySpend("x402")).toBe(0);
  });

  it("H5-001: a non-JSON answer to the probe is returned as text, not a failure", async () => {
    const u = setup();
    paywall.probe = () => new Response("# plain markdown", { status: 200, headers: { "content-type": "text/markdown" } });
    const r = await x402Fetch(`${API}/v1/doc`, u.account);
    expect(r).toMatchObject({ success: true, response: "# plain markdown" });
  });

  it("U4: a host outside the allowlist is refused by the gate before signing", async () => {
    const u = setup();
    const r = await x402Fetch("https://paid.example.com/data", u.account);
    expect(r).toMatchObject({ success: false, denied: { code: "X402_DOMAIN_NOT_ALLOWED" } });
    expect(r.error).toContain("Policy denied: X402_DOMAIN_NOT_ALLOWED");
    expect(paywall.payments).toHaveLength(0);
    expect(u.rows("x402", "denied")).toHaveLength(1);
  });

  it("x402_fetch cannot buy credits for another address through /pay/", async () => {
    const u = setup({ policy: { maxX402PaymentCents: 1000 } });
    const r = await x402Fetch(`${API}/pay/5/${OTHER_ADDRESS}`, u.account);
    expect(r.denied?.code).toBe("X402_DOMAIN_NOT_ALLOWED");
    expect(paywall.payments).toHaveLength(0);

    const viaTool = await u.exec("x402_fetch", { url: `${API}/pay/5/${OTHER_ADDRESS}` });
    expect(toolText(viaTool)).toContain("X402_DOMAIN_NOT_ALLOWED");
    expect(paywall.payments).toHaveLength(0);

    // Spellings a lenient server normalizes to /pay/ are refused as well.
    for (const p of [`//pay/5/`, `/%70ay/5/`, `/PAY/5/`, `/v1/..%2Fpay/5/`]) {
      const r2 = await x402Fetch(`${API}${p}${OTHER_ADDRESS}`, u.account);
      expect(r2.denied?.code, p).toBe("X402_DOMAIN_NOT_ALLOWED");
    }
    expect(paywall.payments).toHaveLength(0);
    expect(u.rows("x402").filter((r) => r.status !== "denied")).toHaveLength(0);
  });

  it("a probe that redirects is not paid, so the offer always comes from the URL the gate checked", async () => {
    const u = setup();
    paywall.probe = (req) =>
      req.url === DATA_URL
        ? new Response(null, { status: 302, headers: { location: `https://paid.example.com/x` } })
        : json(402, {
            x402Version: 2,
            accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "1000000", payTo: OTHER_ADDRESS, asset: USDC_BASE }],
          });
    const r = await x402Fetch(DATA_URL, u.account);
    expect(r).toMatchObject({ success: false, status: 302, settlement: "none" });
    expect(r.error).toContain("redirect");
    expect(paywall.requests.map((q) => q.url)).toEqual([DATA_URL]);
    expect(paywall.payments).toHaveLength(0);
    expect(u.rows()).toHaveLength(0);
  });

  it("U8 (H5-001): a paid text/markdown answer is returned, committed once, and paid once", async () => {
    const u = setup();
    paywall.paid = () =>
      new Response("# Report\n\nThe paid content.", { status: 200, headers: { "content-type": "text/markdown" } });

    const r = await u.exec("x402_fetch", { url: DATA_URL });

    expect(toolText(r)).toContain("x402 fetch succeeded");
    expect(toolText(r)).toContain("The paid content.");
    expect(paywall.payments).toHaveLength(1);
    expect(u.rows("x402", "committed")).toHaveLength(1);
  });

  it("an empty 200 after payment is a delivered payment, not a failure", async () => {
    const u = setup();
    paywall.paid = () => new Response("", { status: 200, headers: { "content-length": "0" } });
    const r = await x402Fetch(DATA_URL, u.account, "POST", '{"q":1}');
    expect(r).toMatchObject({ success: true, response: "", settlement: "committed" });
    expect(paywall.payments).toHaveLength(1);
  });
});

// ─── Requirement checks before signing ─────────────────────────

describe("the 402 requirement is checked before anything is signed", () => {
  it("only the canonical USDC contract on Base is paid", async () => {
    const u = setup();
    paywall.offer = () => ({ atomic: "10000", asset: "0x000000000000000000000000000000000000dEaD" });
    const wrongAsset = await x402Fetch(DATA_URL, u.account);
    paywall.offer = () => ({ atomic: "10000", network: "base-sepolia", asset: BASE_SEPOLIA_USDC });
    const wrongNetwork = await x402Fetch(DATA_URL, u.account);
    paywall.offer = () => ({ atomic: "10000", scheme: "upto" });
    const wrongScheme = await x402Fetch(DATA_URL, u.account);

    for (const r of [wrongAsset, wrongNetwork, wrongScheme]) {
      expect(r).toMatchObject({ success: false, denied: { code: "INVALID_QUOTE" } });
    }
    expect(paywall.payments).toHaveLength(0);
    expect(u.rows()).toHaveLength(0);
  });

  it("a long maxTimeoutSeconds is shortened: the signature is valid for at most 600s", async () => {
    const u = setup();
    paywall.offer = () => ({ atomic: "10000", maxTimeoutSeconds: 31_536_000 });
    const r = await x402Fetch(DATA_URL, u.account);
    expect(r.success).toBe(true);

    const nowSec = Math.floor(u.h.clock.now() / 1000);
    const auth = paywall.payments[0].payment!.payload.authorization;
    expect(Number(auth.validBefore)).toBeLessThanOrEqual(nowSec + X402_MAX_VALIDITY_SECONDS);
    expect(Number(auth.validAfter)).toBeLessThanOrEqual(nowSec);
    const row = u.rows("x402", "committed")[0];
    expect(row.x402_valid_before).toBe(Number(auth.validBefore));
    expect(row.x402_nonce).toBe(auth.nonce);
  });

  it("a server that requires a deadline longer than 600s is refused", async () => {
    const u = setup();
    paywall.offer = () => ({ atomic: "10000", requiredDeadlineSeconds: 31_536_000 });
    const r = await x402Fetch(DATA_URL, u.account);
    expect(r.denied?.code).toBe("X402_DEADLINE_TOO_LONG");
    expect(paywall.payments).toHaveLength(0);
  });

  it("U16: with no Treasury installed nothing is signed", async () => {
    const u = setup();
    resetTreasuryForTests();
    const fetchResult = await x402Fetch(DATA_URL, u.account);
    const topup = await topupCredits(API, u.account, 5);
    expect(fetchResult).toMatchObject({ success: false, denied: { code: "TREASURY_NOT_INSTALLED" } });
    expect(topup).toMatchObject({ success: false, denied: { code: "TREASURY_NOT_INSTALLED" } });
    expect(paywall.payments).toHaveLength(0);
  });
});

// ─── Ambiguous outcomes ─────────────────────────────────────────

describe("a payment sent without a reliable answer stays counted and is reconciled on chain (H1-004)", () => {
  it("U5: a 502 after payment is unknown; an identical retry is refused; reconcile commits or releases", async () => {
    const u = setup();
    paywall.paid = () => json(502, { error: "bad gateway" });

    const first = await x402Fetch(DATA_URL, u.account);
    expect(first).toMatchObject({ success: false, settlement: "unknown" });
    expect(first.error).toContain("Payment outcome unknown");
    const [row] = u.rows("x402", "unknown");
    const sent = paywall.payments[0].payment!.payload.authorization;
    expect(row).toMatchObject({
      x402_nonce: sent.nonce,
      x402_valid_before: Number(sent.validBefore),
      x402_from: u.account.address,
      x402_network: "eip155:8453",
      x402_asset: USDC_BASE,
      amount_atomic: 1_000_000,
    });
    expect(u.treasury.usage("x402", HOUR_MS)).toBe(100);

    // Same request while the authorization could still settle: refused, not re-signed.
    paywall.paid = () => json(200, { ok: true });
    const retry = await x402Fetch(DATA_URL, u.account);
    expect(retry.denied?.code).toBe("PAYMENT_UNCONFIRMED");
    expect(paywall.payments).toHaveLength(1);

    // The chain says the authorization was used: committed, with a transactions row.
    u.auth.value = true;
    expect(await u.treasury.reconcileX402()).toBe(1);
    expect(u.rows("x402", "committed")).toHaveLength(1);
    expect(transactions(u, "x402_payment")).toHaveLength(1);
  });

  it("U5: an unused authorization is released once it has expired", async () => {
    const u = setup();
    paywall.paid = () => json(502, {});
    await x402Fetch(DATA_URL, u.account);
    const [row] = u.rows("x402", "unknown");

    u.auth.value = false;
    expect(await u.treasury.reconcileX402()).toBe(0); // still settleable
    u.h.clock.set((row.x402_valid_before! + 61) * 1000);
    expect(await u.treasury.reconcileX402()).toBe(1);
    expect(u.rows("x402", "released")).toHaveLength(1);
    expect(u.treasury.usage("x402", DAY_MS)).toBe(0);

    // The identical request now goes through again.
    paywall.paid = () => json(200, { ok: true });
    expect((await x402Fetch(DATA_URL, u.account)).success).toBe(true);
    expect(paywall.payments).toHaveLength(2);
  });

  it("a timeout after payment is unknown; a refused connection is released", async () => {
    const u = setup();
    paywall.paid = () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      throw e;
    };
    const timedOut = await x402Fetch(`${API}/v1/slow`, u.account);
    expect(timedOut.settlement).toBe("unknown");

    paywall.paid = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const refused = await x402Fetch(`${API}/v1/down`, u.account);
    expect(refused.settlement).toBe("released");

    expect(u.rows("x402", "unknown")).toHaveLength(1);
    expect(u.rows("x402", "released")).toHaveLength(1);
    expect(u.treasury.usage("x402", HOUR_MS)).toBe(100);
  });

  it("a paid request answered by a redirect is unknown and counted, never followed or released", async () => {
    const u = setup();
    // The server takes the payment, then redirects to a closed port.
    paywall.paid = () =>
      new Response(null, { status: 307, headers: { location: `https://127.0.0.1:${CLOSED_PORT}/receipt` } });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await x402Fetch(`${DATA_URL}?q=${i}`, u.account));
    expect(results.map((r) => r.settlement)).toEqual(["unknown", "unknown", "unknown"]);
    expect(results[0].status).toBe(307);
    // X-Payment went only to the URL that was checked.
    expect(paywall.payments.map((p) => p.url)).toEqual([0, 1, 2].map((i) => `${DATA_URL}?q=${i}`));
    expect(u.rows("x402", "unknown")).toHaveLength(3);
    expect(u.treasury.usage("x402", HOUR_MS)).toBe(300);
    expect((await x402Fetch(`${DATA_URL}?q=0`, u.account)).denied?.code).toBe("PAYMENT_UNCONFIRMED");
  });

  it(
    "an error answer whose body trickles in does not hang the call or leave the row 'sent'",
    async () => {
      const u = setup();
      let timer: ReturnType<typeof setInterval> | undefined;
      paywall.paid = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              timer = setInterval(() => controller.enqueue(new Uint8Array([120])), 200);
            },
            cancel() {
              clearInterval(timer);
            },
          }),
          { status: 500 },
        );
      const started = Date.now();
      const pending = x402Fetch(DATA_URL, u.account);
      // The row is settled before the body is read.
      await vi.waitFor(() => expect(u.rows("x402", "unknown")).toHaveLength(1));
      const r = await pending;
      clearInterval(timer);
      expect(r).toMatchObject({ success: false, settlement: "unknown", status: 500 });
      expect(Date.now() - started).toBeLessThan(PAID_ERROR_BODY_TIMEOUT_MS + 3000);
      expect(u.rows("x402", "sent")).toHaveLength(0);
    },
    15_000,
  );

  it("an unknown payment blocks only the identical request (method, URL, body, amount)", async () => {
    const u = setup();
    paywall.paid = () => json(502, {});
    await x402Fetch(DATA_URL, u.account, "POST", '{"q":"a"}');
    paywall.paid = () => json(200, { ok: true });

    const otherBody = await x402Fetch(DATA_URL, u.account, "POST", '{"q":"b"}');
    const otherPath = await x402Fetch(`${DATA_URL}?page=2`, u.account, "POST", '{"q":"a"}');
    const same = await x402Fetch(DATA_URL, u.account, "POST", '{"q":"a"}');

    expect(otherBody.success).toBe(true);
    expect(otherPath.success).toBe(true);
    expect(same.denied?.code).toBe("PAYMENT_UNCONFIRMED");
    expect(paywall.payments).toHaveLength(3);
  });

  it("an ambiguous topup that settled on chain is not bought twice by an immediate retry", async () => {
    const u = setup();
    // The server settles the authorization on chain, then answers 502.
    paywall.paid = () => {
      u.auth.value = true;
      return json(502, { error: "bad gateway" });
    };
    const first = await u.exec("topup_credits", { amount_usd: 25 });
    expect(toolText(first)).toContain("Outcome unknown");
    expect(toolText(first)).toContain("TOPUP_ALREADY_SETTLED");

    paywall.paid = () => json(200, { ok: true });
    const retry = await u.exec("topup_credits", { amount_usd: 25 });
    expect(retry.error).toContain("Policy denied: TOPUP_ALREADY_SETTLED");
    expect(paywall.payments).toHaveLength(1);
    expect(u.rows("topup", "committed")).toHaveLength(1);
    expect(transactions(u, "credit_purchase")).toHaveLength(1);
  });

  it("U17: a payment left 'sent' by a dead process becomes unknown and is reconciled by its nonce", async () => {
    const u = setup();
    const quote = x402Quote(u.h.clock.now(), 1_000_000n, DATA_URL);
    const r = await u.treasury.reserve(quote);
    u.treasury.markSent(r);

    const restarted = u.h.newTreasury({
      selfAddress: u.account.address,
      bootId: "next-boot",
      processStartMs: u.h.clock.now() + 1,
    });
    expect(restarted.statusOf(r.id)).toBe("unknown");

    u.auth.value = true;
    expect(await restarted.reconcileX402()).toBe(1);
    expect(restarted.statusOf(r.id)).toBe("committed");
    expect(transactions(u, "x402_payment")).toHaveLength(1);
  });
});

// ─── Topups ─────────────────────────────────────────────────────

describe("credit topups are capped and recorded (H1-003, F141, F018, H1-002)", () => {
  it("U6: topup_credits is capped at $25 a buy and $100 a day", async () => {
    const u = setup();
    vi.mocked(getUsdcBalance).mockResolvedValue(10_000);

    const big = await u.exec("topup_credits", { amount_usd: 2500 });
    expect(toolText(big)).toContain("SPEND_LIMIT_EXCEEDED");
    expect(paywall.payments).toHaveLength(0);

    const results: ToolCallResult[] = [];
    for (let i = 0; i < 5; i++) results.push(await u.exec("topup_credits", { amount_usd: 25 }));

    expect(paywall.payments).toHaveLength(4);
    expect(u.rows("topup", "committed")).toHaveLength(4);
    expect(toolText(results[4])).toContain("SPEND_LIMIT_EXCEEDED");
    expect(u.treasury.usage("topup", DAY_MS)).toBe(10_000);
    // The Treasury's own purchase rows carry no balance_after.
    expect(transactions(u, "credit_purchase").filter((t) => t.balance_after_cents === null)).toHaveLength(4);
  });

  it("F018: a topup writes one credit_purchase row with the dollar amount and no balance_after", async () => {
    const u = setup();
    const r = await topupCredits(API, u.account, 25);
    expect(r).toMatchObject({ success: true, amountUsd: 25, paidCents: 2500, settlement: "committed" });
    expect(transactions(u, "credit_purchase")).toEqual([
      expect.objectContaining({ amount_cents: 2500, balance_after_cents: null }),
    ]);
    expect(u.rows("topup", "committed")[0]).toMatchObject({ topup_purpose: "manual", amount_atomic: 25_000_000 });
  });

  it("F018: a sandbox-402 topup is recorded under its own purpose", async () => {
    const u = setup();
    const err = Object.assign(new Error("Conway API error: POST /v1/sandboxes -> 402"), {
      status: 402,
      responseText: JSON.stringify({ details: { required_cents: 1500, current_balance_cents: 0 } }),
    });
    const r = await topupForSandbox({ apiUrl: API, account: u.account, error: err });
    expect(r).toMatchObject({ success: true, amountUsd: 25, settlement: "committed" });
    expect(u.rows("topup", "committed")[0]).toMatchObject({ topup_purpose: "sandbox_402" });
    expect(transactions(u, "credit_purchase")).toHaveLength(1);
  });

  it("U7 (F141): a 402 asking for more than the requested tier is refused unsigned", async () => {
    const u = setup();
    paywall.offer = () => ({ atomic: "2500000000" }); // 2500 USDC for a $5 tier
    const manual = await topupCredits(API, u.account, 5);
    const survival = await bootstrapTopup({ apiUrl: API, account: u.account, creditsCents: 0 });

    expect(manual).toMatchObject({ success: false, denied: { code: "X402_AMOUNT_MISMATCH" } });
    expect(survival).toMatchObject({ success: false, denied: { code: "X402_AMOUNT_MISMATCH" } });
    expect(paywall.payments).toHaveLength(0);
    expect(u.rows()).toHaveLength(0);
  });

  it("U15 (H1-002): a server-sized $2500 sandbox topup is refused unsigned", async () => {
    const u = setup();
    vi.mocked(getUsdcBalance).mockResolvedValue(10_000);
    const err = Object.assign(new Error("INSUFFICIENT_CREDITS"), {
      status: 402,
      responseText: JSON.stringify({
        error: "INSUFFICIENT_CREDITS",
        details: { required_cents: 150_000, current_balance_cents: 10_000 },
      }),
    });
    const r = await topupForSandbox({ apiUrl: API, account: u.account, error: err });
    expect(r).toMatchObject({ success: false, amountUsd: 2500, denied: { code: "SPEND_LIMIT_EXCEEDED" } });
    expect(paywall.payments).toHaveLength(0);
    expect(u.rows("topup", "denied")[0]).toMatchObject({ topup_purpose: "sandbox_402" });
  });

  it("credits may only be bought for this automaton", async () => {
    const u = setup();
    const r = await topupCredits(API, u.account, 5, OTHER_ADDRESS);
    expect(r.denied?.code).toBe("TOPUP_RECIPIENT_NOT_SELF");
    expect(paywall.payments).toHaveLength(0);
  });

  it("the topup payTo is pinned to the first one that committed", async () => {
    const u = setup();
    expect((await topupCredits(API, u.account, 5)).success).toBe(true);
    paywall.offer = () => ({ atomic: "5000000", payTo: OTHER_ADDRESS });
    const r = await topupCredits(API, u.account, 5);
    expect(r.denied?.code).toBe("X402_PAYTO_NOT_TRUSTED");
    expect(paywall.payments).toHaveLength(1);
  });

  it("a payTo rotation does not starve survival topups", async () => {
    const u = setup({ balance: 0 });
    expect((await topupCredits(API, u.account, 5)).success).toBe(true);
    paywall.offer = () => ({ atomic: "5000000", payTo: OTHER_ADDRESS });
    u.h.clock.advance(20 * MIN);
    expect((await topupCredits(API, u.account, 5)).denied?.code).toBe("X402_PAYTO_NOT_TRUSTED");
    const survival = await bootstrapTopup({ apiUrl: API, account: u.account, creditsCents: 0 });
    expect(survival).toMatchObject({ success: true, settlement: "committed" });
    u.h.clock.advance(7 * DAY_MS);
    expect((await bootstrapTopup({ apiUrl: API, account: u.account, creditsCents: 0 }))?.success).toBe(true);
    expect(paywall.payments).toHaveLength(3);
  });
});

// ─── Survival topups ────────────────────────────────────────────

describe("automatic survival topups are bounded (H1-001, F143, F193, F229)", () => {
  const buy = (u: Usdc, creditsCents = 0) => bootstrapTopup({ apiUrl: API, account: u.account, creditsCents });

  it("U9: $5 buys with a 5-minute cooldown and a $20 rolling-day cap", async () => {
    const u = setup({ balance: 0 });
    expect((await buy(u))?.success).toBe(true);
    expect((await buy(u))?.denied?.code).toBe("TOPUP_COOLDOWN");
    for (let i = 0; i < 3; i++) {
      u.h.clock.advance(5 * MIN + 1000);
      expect((await buy(u))?.success).toBe(true);
    }
    u.h.clock.advance(5 * MIN + 1000);
    expect((await buy(u))?.denied?.code).toBe("SPEND_LIMIT_EXCEEDED");
    expect(paywall.payments).toHaveLength(4);
    expect(u.rows("topup_auto", "committed")).toHaveLength(4);
    expect(u.rows("topup_auto", "committed").every((r) => r.topup_purpose === "survival")).toBe(true);
  });

  it("U10 (F143, H1-001): a stale zero from the caller does not buy when the real balance is fine", async () => {
    const u = setup({ balance: 10_000 });
    const r = await buy(u, 0);
    expect(r?.denied?.code).toBe("TOPUP_NOT_NEEDED");
    expect(paywall.payments).toHaveLength(0);
  });

  it("U11 (F143): with the balance unreadable, one blind buy per day", async () => {
    const u = setup({ balance: 0 });
    u.h.inner.balanceError = new Error("Conway API error: GET /v1/credits/balance -> 503");
    expect((await buy(u))?.success).toBe(true);
    u.h.clock.advance(6 * MIN);
    expect((await buy(u))?.denied?.code).toBe("BALANCE_UNKNOWN_LIMIT");
    u.h.clock.advance(DAY_MS);
    expect((await buy(u))?.success).toBe(true);
    expect(paywall.payments).toHaveLength(2);
  });

  it("U12: exhausted x402, topup and transfer budgets do not starve the survival topup", async () => {
    const u = setup({ balance: 0 });
    const earlier = u.h.clock.now() - 30 * MIN;
    seedCommitted(u, "x402", 5000, earlier);
    seedCommitted(u, "topup", 10_000, earlier);
    seedCommitted(u, "transfer", 25_000, earlier);
    seedCommitted(u, "infra", 5000, earlier);

    expect((await x402Fetch(DATA_URL, u.account)).denied?.code).toBe("SPEND_LIMIT_EXCEEDED");
    expect((await topupCredits(API, u.account, 5)).denied?.code).toBe("SPEND_LIMIT_EXCEEDED");
    expect((await buy(u))?.success).toBe(true);
    expect(paywall.payments).toHaveLength(1);
  });

  it("failing paid APIs that open the x402 circuit breaker do not block survival topups", async () => {
    const u = setup({ balance: 0 });
    // Skip the retry backoff sleeps; the retry counts are unchanged.
    const proto = ResilientHttpClient.prototype as unknown as { backoff: (attempt: number) => Promise<void> };
    const backoff = vi.spyOn(proto, "backoff").mockResolvedValue(undefined);
    onTestFinished(() => backoff.mockRestore());
    paywall.probe = (req) =>
      req.url.includes("/pay/")
        ? json(402, {
            x402Version: 2,
            accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "5000000", payTo: PAY_TO, asset: USDC_BASE }],
          })
        : json(503, { error: "unavailable" });
    await x402Fetch(`${API}/v1/flaky`, u.account);
    await x402Fetch(`${API}/v1/flaky`, u.account);
    expect((await x402Fetch(`${API}/v1/flaky`, u.account)).error).toContain("Circuit breaker is open");

    const r = await bootstrapTopup({ apiUrl: API, account: u.account, creditsCents: 0 });
    expect(r).toMatchObject({ success: true, settlement: "committed" });
    expect(u.rows("topup_auto", "committed")).toHaveLength(1);
    expect(paywall.payments).toHaveLength(1);
  });

  it("U13: a tool call cannot draw on the survival budget", async () => {
    const u = setup({ balance: 0 });
    const r = await runWithTreasuryOrigin({ type: "tool", name: "topup_credits" }, () => buy(u));
    expect(r?.denied?.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(paywall.payments).toHaveLength(0);
  });

  it("an inbox-driven turn cannot start a survival topup", async () => {
    const u = setup({ balance: 0 });
    const r = await runWithTreasuryOrigin({ type: "auto", name: "x", inputSource: "external" }, () => buy(u));
    expect(r?.denied?.code).toBe("UNTRUSTED_SOURCE");
    expect(paywall.payments).toHaveLength(0);
  });

  it("R3: an ambiguous survival topup blocks retries only until its clamped authorization expires", async () => {
    const u = setup({ balance: 0 });
    paywall.offer = () => ({ atomic: "5000000", maxTimeoutSeconds: 31_536_000 });
    paywall.paid = () => json(502, {});
    expect((await buy(u))?.settlement).toBe("unknown");
    const [row] = u.rows("topup_auto", "unknown");
    expect(row.x402_valid_before).toBeLessThanOrEqual(Math.floor(T0 / 1000) + X402_MAX_VALIDITY_SECONDS);

    paywall.paid = () => json(200, { ok: true });
    u.h.clock.advance(6 * MIN);
    expect((await buy(u))?.denied?.code).toBe("PAYMENT_UNCONFIRMED");

    u.auth.value = false;
    u.h.clock.set((row.x402_valid_before! + 61) * 1000);
    const after = await buy(u);
    expect(after).toMatchObject({ success: true, settlement: "committed" });
    expect(u.rows("topup_auto", "released")).toHaveLength(1);
    expect(paywall.payments).toHaveLength(2);
  });

  it("F193: the startup bootstrap skips the buy when the balance cannot be read", async () => {
    const u = setup({ balance: 0 });
    const outcome = await startupBootstrapTopup({
      apiUrl: API,
      account: u.account,
      readCreditBalance: async () => {
        throw new Error("Conway API error: GET /v1/credits/balance -> 503");
      },
    });
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(paywall.requests).toHaveLength(0);
    expect(u.rows()).toHaveLength(0);
  });

  it("F193: the startup bootstrap buys under its own origin when credits are really low", async () => {
    const u = setup({ balance: 0 });
    const outcome = await startupBootstrapTopup({
      apiUrl: API,
      account: u.account,
      readCreditBalance: () => u.h.inner.getCreditsBalance(),
    });
    expect(outcome).toMatchObject({ status: "done", result: { success: true } });
    expect(u.rows("topup_auto", "committed")[0]).toMatchObject({
      origin_type: "auto",
      origin_name: "startup.bootstrap",
    });
  });

  it("F229: a timed-out bootstrap payment keeps the heartbeat and the loop from buying alongside it", async () => {
    const u = setup({ balance: 0 });
    const release = deferred();
    paywall.paid = async () => {
      await release.promise;
      return json(200, { ok: true });
    };

    const outcome = await startupBootstrapTopup({
      apiUrl: API,
      account: u.account,
      readCreditBalance: () => u.h.inner.getCreditsBalance(),
      timeoutMs: 50,
    });
    expect(outcome.status).toBe("timed_out");
    await vi.waitFor(() => expect(paywall.payments).toHaveLength(1));
    expect(u.rows("topup_auto", "sent")).toHaveLength(1);

    // The heartbeat sees the in-flight buy and neither pays nor wakes.
    const tick = await BUILTIN_TASKS.check_usdc_balance(tickContext(u), taskContext(u));
    expect(tick.shouldWake).toBe(false);
    // The loop's inline topup is refused the same way.
    expect((await buy(u))?.denied?.code).toBe("TOPUP_IN_FLIGHT");

    release.resolve();
    await vi.waitFor(() => expect(u.rows("topup_auto", "committed")).toHaveLength(1));
    expect(paywall.payments).toHaveLength(1);
    // Both refusals share the survival dedupe key, so they collapse into one row.
    const denied = u.rows("topup_auto", "denied");
    expect(denied.map((r) => r.deny_code)).toEqual(["TOPUP_IN_FLIGHT"]);
    expect(deniedCount(denied)).toBe(2);
    expect(denied[0].origin_name).toBe("heartbeat.check_usdc_balance");
  });
});

// ─── Heartbeat ──────────────────────────────────────────────────

describe("heartbeat check_usdc_balance", () => {
  it("U14: a buy in flight gives TOPUP_IN_FLIGHT, no wake, and a single payment", async () => {
    const u = setup({ balance: 0 });
    const release = deferred();
    paywall.paid = async () => {
      await release.promise;
      return json(200, { ok: true });
    };
    const first = bootstrapTopup({ apiUrl: API, account: u.account, creditsCents: 0 });
    await vi.waitFor(() => expect(paywall.payments).toHaveLength(1));

    const result = await BUILTIN_TASKS.check_usdc_balance(tickContext(u), taskContext(u));

    expect(result.shouldWake).toBe(false);
    expect(u.rows("topup_auto", "denied")[0]).toMatchObject({
      deny_code: "TOPUP_IN_FLIGHT",
      origin_type: "auto",
      origin_name: "heartbeat.check_usdc_balance",
    });
    release.resolve();
    expect((await first)?.success).toBe(true);
    expect(paywall.payments).toHaveLength(1);
  });

  it("F143: a failed balance fetch (tick says 0) does not buy when the gate reads a healthy balance", async () => {
    const u = setup({ balance: 8000 });
    const result = await BUILTIN_TASKS.check_usdc_balance(tickContext(u), taskContext(u));
    expect(result.shouldWake).toBe(false);
    expect(paywall.payments).toHaveLength(0);
    expect(u.rows("topup_auto", "denied")[0]).toMatchObject({ deny_code: "TOPUP_NOT_NEEDED" });
  });

  it("F143: an hour of failed balance reads buys once, not every 5 minutes", async () => {
    const u = setup({ balance: 0 });
    u.h.inner.balanceError = new Error("Conway API error: GET /v1/credits/balance -> 503");
    const wakes: boolean[] = [];
    for (let i = 0; i < 13; i++) {
      // The task's own KV cooldown runs on wall-clock time; clear it to
      // model five minutes passing between ticks.
      u.h.db.deleteKV("last_auto_topup_attempt");
      const r = await BUILTIN_TASKS.check_usdc_balance(tickContext(u), taskContext(u));
      wakes.push(r.shouldWake);
      u.h.clock.advance(5 * MIN);
    }
    expect(paywall.payments).toHaveLength(1);
    expect(wakes[0]).toBe(true); // the one buy is reported
    expect(wakes.slice(1).every((w) => w === false)).toBe(true);
  });

  it("F143: credits that never post use the survival cap and then wake once a day, not every tick", async () => {
    const u = setup({ balance: 5 });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const wakes: string[] = [];
      for (let i = 0; i <= 288; i++) {
        vi.setSystemTime(u.h.clock.now());
        u.h.db.deleteKV("last_auto_topup_attempt");
        const r = await BUILTIN_TASKS.check_usdc_balance(tickContext(u), taskContext(u));
        if (r.shouldWake) wakes.push(r.message ?? "");
        u.h.clock.advance(5 * MIN);
      }
      // Four $5 buys, the daily-cap notice once, and the buy when the window frees at 24h.
      expect(paywall.payments).toHaveLength(5);
      expect(wakes).toHaveLength(6);
      const notices = wakes.filter((m) => m.includes("SPEND_LIMIT_EXCEEDED"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).not.toContain("topup_credits");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an operator-pinned payTo that no longer matches wakes the agent once, not every tick", async () => {
    const u = setup({ balance: 0, policy: { topupPayTo: OTHER_ADDRESS } });
    const first = await BUILTIN_TASKS.check_usdc_balance(tickContext(u), taskContext(u));
    expect(first.shouldWake).toBe(true);
    expect(first.message).toContain("X402_PAYTO_NOT_TRUSTED");
    u.h.db.deleteKV("last_auto_topup_attempt");
    const second = await BUILTIN_TASKS.check_usdc_balance(tickContext(u), taskContext(u));
    expect(second.shouldWake).toBe(false);
    expect(paywall.payments).toHaveLength(0);
  });

  it("still wakes the agent when a topup really failed", async () => {
    const u = setup({ balance: 0 });
    paywall.paid = () => json(502, {});
    const result = await BUILTIN_TASKS.check_usdc_balance(tickContext(u), taskContext(u));
    expect(result.shouldWake).toBe(true);
    expect(result.message).toContain("USDC");
  });

  it("colony_financial_report counts x402 payments and lists unknown outflows as pending", async () => {
    const u = setup();
    paywall.offer = () => ({ atomic: "500000" });
    expect((await x402Fetch(`${API}/v1/ok`, u.account)).success).toBe(true);
    paywall.paid = () => json(502, {});
    await x402Fetch(`${API}/v1/lost`, u.account);

    await BUILTIN_TASKS.colony_financial_report(tickContext(u), taskContext(u));
    const report = JSON.parse(u.h.db.getKV("last_colony_financial_report")!);
    expect(report.expenseCents).toBe(50);
    expect(report.pendingOutflowCents).toBe(50);
    expect(report.pendingOutflows).toEqual([
      expect.objectContaining({ kind: "x402_payment", amountCents: 50, counterparty: PAY_TO }),
    ]);
  });
});

// ─── On-chain authorization state ───────────────────────────────

describe("readUsdcAuthorizationState", () => {
  const args = {
    network: "eip155:8453",
    asset: USDC_BASE,
    from: "0x1234567890abcdef1234567890abcdef12345678",
    nonce: `0x${"ab".repeat(32)}`,
  };

  it("reads authorizationState(from, nonce) on the USDC contract at the latest block", async () => {
    const calls: Array<{ to: string; data: string }> = [];
    const blocks: unknown[] = [];
    let answer = 1;
    const blockTime = 1_790_000_000;
    paywall.rpc = (body) => {
      if (body.method === "eth_getBlockByNumber") {
        return json(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { number: "0x10", timestamp: `0x${blockTime.toString(16)}`, hash: `0x${"11".repeat(32)}`, transactions: [] },
        });
      }
      const [call, block] = body.params as [{ to: string; data: string }, unknown];
      calls.push(call);
      blocks.push(block);
      return json(200, { jsonrpc: "2.0", id: body.id, result: `0x${answer.toString(16).padStart(64, "0")}` });
    };
    expect(await readUsdcAuthorizationState(args)).toBe(true);
    answer = 0;
    // Unused is reported with the block's time, so the gate can judge expiry by chain time.
    expect(await readUsdcAuthorizationState(args)).toEqual({ used: false, blockTimestamp: blockTime });
    expect(blocks).toEqual(["0x10", "0x10"]);
    expect(calls[0].to.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    // authorizationState(address,bytes32) selector, then the two arguments.
    expect(calls[0].data.startsWith("0xe94a0102")).toBe(true);
    expect(calls[0].data).toContain("ab".repeat(32));
  });

  it("returns null when the answer cannot be determined", async () => {
    expect(await readUsdcAuthorizationState(args)).toBeNull(); // RPC error
    expect(await readUsdcAuthorizationState({ ...args, network: "eip155:1" })).toBeNull();
    expect(await readUsdcAuthorizationState({ ...args, nonce: "0x01" })).toBeNull();
  });
});

// ─── Structure ──────────────────────────────────────────────────

describe("only x402.ts signs payments", () => {
  it("no other source file builds an EIP-3009 authorization or sends X-Payment", () => {
    const root = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        const text = fs.readFileSync(full, "utf-8");
        if (rel !== "conway/x402.ts") {
          if (text.includes("TransferWithAuthorization")) offenders.push(`${rel}: TransferWithAuthorization`);
          if (text.includes('"X-Payment"')) offenders.push(`${rel}: X-Payment`);
          // client.ts signs the Register typed data for identity registration.
          if (rel !== "conway/client.ts" && /signTypedData\s*\(/.test(text)) offenders.push(`${rel}: signTypedData(`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
