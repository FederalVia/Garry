/**
 * x402 amounts are atomic USDC units in every protocol version, topups
 * quote exactly their tier, signatures use the canonical contract's EIP-712
 * domain, and the payload echoes the server's own network string. Also the
 * sandbox-402 topup tier choice. Real Treasury and ledger; fetch is a stub
 * paywall; payments are signed with a throwaway key. No network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { parseAtomicAmount, resetX402HttpClientForTests, x402Fetch } from "../conway/x402.js";
import { topupCredits, topupForSandbox } from "../conway/topup.js";
import { installTreasury, resetTreasuryForTests } from "../treasury/index.js";
import { PAY_TO, USDC_BASE, makeHarness, type Harness } from "./treasury/harness.js";

const API = "https://api.conway.tech";
const DATA_URL = `${API}/v1/data`;
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const realFetch = globalThis.fetch;
const savedRpc = process.env.AUTOMATON_RPC_URL;

interface SignedPayment {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` };
  };
}

let offer: (url: string) => Record<string, unknown> | null;
let payments: SignedPayment[];
let paidUrls: string[];
let probes: string[];
let h: Harness;
let account: PrivateKeyAccount;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  payments = [];
  paidUrls = [];
  probes = [];
  offer = () => null;
  account = privateKeyToAccount(generatePrivateKey());
  h = makeHarness({ install: false, readAuthorizationState: async () => null });
  installTreasury(h.newTreasury({ selfAddress: account.address }));
  process.env.AUTOMATON_RPC_URL = "https://rpc.stub.invalid";
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const body = typeof init.body === "string" ? init.body : "";
    if (body.includes('"jsonrpc"')) {
      const req = JSON.parse(body);
      if (req.method === "eth_call") {
        const result = "0x" + (1_000_000n * 1_000_000n).toString(16).padStart(64, "0");
        return json(200, { jsonrpc: "2.0", id: req.id, result });
      }
      return json(200, { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no rpc in this test" } });
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers["X-Payment"]) {
      payments.push(JSON.parse(Buffer.from(headers["X-Payment"], "base64").toString("utf-8")));
      paidUrls.push(url);
      return json(200, { ok: true });
    }
    probes.push(url);
    const o = offer(url);
    return o ? json(402, o) : json(200, { free: true });
  }) as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedRpc === undefined) delete process.env.AUTOMATON_RPC_URL;
  else process.env.AUTOMATON_RPC_URL = savedRpc;
  resetX402HttpClientForTests();
  resetTreasuryForTests();
  h.close();
  vi.restoreAllMocks();
});

/** A spec v1 offer (no x402Version, so the version defaults to 1). */
function v1(amount: unknown, extra: Record<string, unknown> = {}) {
  return { accepts: [{ scheme: "exact", network: "base", maxAmountRequired: amount, payTo: PAY_TO, asset: USDC_BASE, ...extra }] };
}

describe("atomic units in every version (F140)", () => {
  it("a v1 '10000' is one cent, and 10000 is what gets signed", async () => {
    offer = () => v1("10000");
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.paidCents).toBe(1);
    expect(payments).toHaveLength(1);
    expect(payments[0].payload.authorization.value).toBe("10000");
  });

  it("is monotonic: '999999' is less than '1000000', and both are about a dollar", async () => {
    expect(parseAtomicAmount("999999") < parseAtomicAmount("1000000")).toBe(true);
    offer = () => v1("999999");
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(r.success).toBe(true);
    expect(payments[0].payload.authorization.value).toBe("999999");
  });

  it.each([["0.01"], ["1e6"], ["-1"], [""], [" "], ["0x10"], [1.5], [-3], [Number.MAX_SAFE_INTEGER + 2]])(
    "refuses %j before anything is signed",
    async (amount) => {
      offer = () => v1(amount);
      const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
      expect(r.success).toBe(false);
      expect(r.denied?.code).toBe("INVALID_QUOTE");
      expect(payments).toEqual([]);
    },
  );

  it("accepts a safe JSON integer", async () => {
    offer = () => v1(10000);
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(r.success).toBe(true);
    expect(payments[0].payload.authorization.value).toBe("10000");
  });

  it("reads the spec v2 amount field", async () => {
    offer = () => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", payTo: PAY_TO, asset: USDC_BASE }] });
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(r.success).toBe(true);
    expect(payments[0].payload.authorization.value).toBe("10000");
  });

  it("reads maxAmountRequired under x402Version 2 too (Conway's /pay sends that)", async () => {
    offer = () => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", payTo: PAY_TO, asset: USDC_BASE }] });
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(r.success).toBe(true);
    expect(payments[0].payload.authorization.value).toBe("10000");
  });

  it("refuses an offer whose amount and maxAmountRequired disagree", async () => {
    offer = () => v1("10000", { amount: "20000" });
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(r.denied?.code).toBe("INVALID_QUOTE");
    expect(payments).toEqual([]);
  });

  it("rounds the cent check up like the gate", async () => {
    offer = () => v1("1000001"); // 100.0001 cents
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(r.success).toBe(false);
    expect(r.error).toContain("101 cents");
    expect(payments).toEqual([]);
  });
});

describe("topups quote exactly their tier", () => {
  it("a $5 topup quoted as '5' (whole dollars) is refused", async () => {
    offer = () => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "5", payTo: PAY_TO, asset: USDC_BASE }] });
    const r = await topupCredits(API, account, 5);
    expect(r.success).toBe(false);
    expect(r.denied?.code).toBe("X402_AMOUNT_MISMATCH");
    expect(payments).toEqual([]);
  });

  it("a quote one atomic unit under the tier is refused too", async () => {
    offer = () => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "4999999", payTo: PAY_TO, asset: USDC_BASE }] });
    const r = await topupCredits(API, account, 5);
    expect(r.denied?.code).toBe("X402_AMOUNT_MISMATCH");
    expect(payments).toEqual([]);
  });

  it("the exact tier in atomic units is paid", async () => {
    offer = () => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "5000000", payTo: PAY_TO, asset: USDC_BASE }] });
    const r = await topupCredits(API, account, 5);
    expect(r.success).toBe(true);
    expect(payments[0].payload.authorization.value).toBe("5000000");
  });

  it("a /pay endpoint that answers the unpaid probe with 200 is a failed topup, not a purchase", async () => {
    offer = () => null; // the stub answers 200 { free: true }
    const r = await topupCredits(API, account, 5);
    expect(r.success).toBe(false);
    expect(r.creditsCentsAdded).toBeUndefined();
    expect(r.error).toMatch(/did not ask for payment \(HTTP 200\)/);
    expect(payments).toEqual([]);
    expect(probes.filter((u) => u.includes("/pay/5/"))).toHaveLength(1);
  });
});

describe("EIP-712 domain and network echo (F151)", () => {
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  async function verifies(p: SignedPayment, name: string, chainId: number, contract: string): Promise<boolean> {
    const a = p.payload.authorization;
    return verifyTypedData({
      address: account.address,
      domain: { name, version: "2", chainId, verifyingContract: contract as `0x${string}` },
      types,
      primaryType: "TransferWithAuthorization",
      message: {
        from: a.from as `0x${string}`,
        to: a.to as `0x${string}`,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
      signature: p.payload.signature,
    });
  }

  it("a Base Sepolia payment is signed for the contract's real name, USDC", async () => {
    offer = () => ({ accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", payTo: PAY_TO, asset: BASE_SEPOLIA_USDC }] });
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100, undefined, {
      purpose: "fetch",
      network: "eip155:84532",
    });
    expect(r.success).toBe(true);
    expect(await verifies(payments[0], "USDC", 84532, BASE_SEPOLIA_USDC)).toBe(true);
    expect(await verifies(payments[0], "USD Coin", 84532, BASE_SEPOLIA_USDC)).toBe(false);
    expect(payments[0].network).toBe("base-sepolia");
  });

  it("a mainnet payment is signed for USD Coin, whatever extra.name the server sends", async () => {
    offer = () => v1("10000", { extra: { name: "USDC", version: "2" } });
    const r = await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(r.success).toBe(true);
    expect(await verifies(payments[0], "USD Coin", 8453, USDC_BASE)).toBe(true);
  });

  it("echoes 'base' when the server said 'base'", async () => {
    offer = () => v1("10000");
    await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(payments[0].network).toBe("base");
    expect(payments[0].x402Version).toBe(1);
  });

  it("echoes 'eip155:8453' when the server said that", async () => {
    offer = () => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", payTo: PAY_TO, asset: USDC_BASE }] });
    await x402Fetch(DATA_URL, account, "GET", undefined, undefined, 100);
    expect(payments[0].network).toBe("eip155:8453");
  });
});

describe("sandbox-402 topups buy only a tier that covers the deficit (F149)", () => {
  function err402(details: unknown): Error & { status: number; responseText: string } {
    return Object.assign(new Error("Conway API error: POST /v1/sandboxes -> 402"), {
      status: 402,
      responseText: JSON.stringify({ details }),
    });
  }
  const payProbes = () => probes.filter((u) => u.includes("/pay/"));

  it("an unparseable deficit buys nothing", async () => {
    const r = await topupForSandbox({ apiUrl: API, account, error: err402({ required_cents: "5 USD", current_balance_cents: 0 }) });
    expect(r).toBeNull();
    expect(payProbes()).toEqual([]);
  });

  it("a deficit larger than every tier buys nothing", async () => {
    const r = await topupForSandbox({ apiUrl: API, account, error: err402({ required_cents: 300_000, current_balance_cents: 0 }) });
    expect(r).toBeNull();
    expect(payProbes()).toEqual([]);
  });

  it("no deficit buys nothing", async () => {
    const r = await topupForSandbox({ apiUrl: API, account, error: err402({ required_cents: 100, current_balance_cents: 500 }) });
    expect(r).toBeNull();
    expect(payProbes()).toEqual([]);
  });

  it("a 1200c deficit buys the $25 tier (digit strings accepted)", async () => {
    offer = (url) => {
      const m = /\/pay\/(\d+)\//.exec(url);
      return m
        ? { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: String(BigInt(m[1]) * 1_000_000n), payTo: PAY_TO, asset: USDC_BASE }] }
        : null;
    };
    const r = await topupForSandbox({ apiUrl: API, account, error: err402({ required_cents: "1500", current_balance_cents: 300 }) });
    expect(payProbes()).toHaveLength(1);
    expect(payProbes()[0]).toContain("/pay/25/");
    expect(r?.success).toBe(true);
    expect(paidUrls[0]).toContain("/pay/25/");
  });

  it("a 402 without details keeps the $5 minimum", async () => {
    offer = () => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "5000000", payTo: PAY_TO, asset: USDC_BASE }] });
    const r = await topupForSandbox({ apiUrl: API, account, error: Object.assign(new Error("402"), { status: 402, responseText: "{}" }) });
    expect(payProbes()[0]).toContain("/pay/5/");
    expect(r?.success).toBe(true);
  });
});
