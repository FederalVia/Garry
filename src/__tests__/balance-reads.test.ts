/**
 * Balance reads never turn a failure into 0: the primitives throw
 * BalanceUnavailableError, and readCredits/readUsdc return a typed unknown.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createConwayClient, createCreditBalanceReader } from "../conway/client.js";
import { getUsdcBalance } from "../conway/x402.js";
import { CircuitOpenError } from "../conway/http-client.js";
import {
  BalanceUnavailableError,
  classifyBalanceError,
  readCredits,
  readUsdc,
} from "../conway/balance.js";
import { createBuiltinTools } from "../agent/tools.js";
import { checkResources, formatResourceReport } from "../survival/monitor.js";
import { MockConwayClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { ToolContext } from "../types.js";

const API = "https://api.conway.tech";
const realFetch = globalThis.fetch;
const savedRpc = process.env.AUTOMATON_RPC_URL;

function stubFetch(answer: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: any, init?: RequestInit) =>
    answer(typeof input === "string" ? input : String(input?.url ?? input), init)) as typeof fetch;
}

const conway = () => createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "sb", treasury: () => undefined });
const jsonBody = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedRpc === undefined) delete process.env.AUTOMATON_RPC_URL;
  else process.env.AUTOMATON_RPC_URL = savedRpc;
  vi.restoreAllMocks();
});

describe("getCreditsBalance (F145)", () => {
  const malformed: Array<[string, () => Response]> = [
    ["a text/html 200 (proxy page)", () => new Response("<html>proxy error</html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["a renamed field {balance: 8000}", () => jsonBody({ balance: 8000 })],
    ["a string balance_cents", () => jsonBody({ balance_cents: "80" })],
    ["a null balance", () => jsonBody({ balance_cents: null })],
    ["a JSON array", () => jsonBody([8000])],
  ];

  it.each(malformed)("rejects %s as malformed_response, never 0", async (_label, answer) => {
    stubFetch(() => answer());
    const err = await conway().getCreditsBalance().catch((e) => e);
    expect(err).toBeInstanceOf(BalanceUnavailableError);
    expect(err.reason).toBe("malformed_response");
  });

  it.each(malformed)("the gate's own reader agrees on %s", async (_label, answer) => {
    stubFetch(() => answer());
    const read = createCreditBalanceReader({ apiUrl: API, apiKey: "k" });
    await expect(read()).rejects.toBeInstanceOf(BalanceUnavailableError);
  });

  it("a negative balance is a known value (debt)", async () => {
    stubFetch(() => jsonBody({ balance_cents: -5 }));
    expect(await conway().getCreditsBalance()).toBe(-5);
  });

  it("credits_cents is accepted when balance_cents is absent", async () => {
    stubFetch(() => jsonBody({ credits_cents: 1234 }));
    expect(await conway().getCreditsBalance()).toBe(1234);
    expect(await createCreditBalanceReader({ apiUrl: API, apiKey: "k" })()).toBe(1234);
  });

  it("readCredits reports the reason instead of a number", async () => {
    stubFetch(() => jsonBody({ balance: 8000 }));
    expect(await readCredits(conway())).toMatchObject({ known: false, reason: "malformed_response" });
    stubFetch(() => jsonBody({ balance_cents: 8000 }));
    expect(await readCredits(conway())).toMatchObject({ known: true, value: 8000 });
  });
});

describe("getUsdcBalance (F147)", () => {
  it("an RPC 429 rejects instead of reporting 0 USDC", async () => {
    process.env.AUTOMATON_RPC_URL = "https://rpc.stub.invalid";
    let rpcCalls = 0;
    stubFetch(() => {
      rpcCalls++;
      return new Response("Too Many Requests", { status: 429 });
    });
    const err = await getUsdcBalance("0x0000000000000000000000000000000000000b0b").catch((e) => e);
    expect(err).toBeInstanceOf(BalanceUnavailableError);
    expect(err.reason).toBe("rpc_error");
    expect(rpcCalls).toBeGreaterThan(0);
    expect(await readUsdc("0x0000000000000000000000000000000000000b0b", "eip155:8453")).toMatchObject({
      known: false,
      reason: "rpc_error",
    });
  }, 20_000);

  it("an unsupported network rejects as unsupported_network", async () => {
    const err = await getUsdcBalance("0x0000000000000000000000000000000000000b0b", "eip155:1").catch((e) => e);
    expect(err).toBeInstanceOf(BalanceUnavailableError);
    expect(err.reason).toBe("unsupported_network");
  });

  it("a good RPC answer is a known balance", async () => {
    process.env.AUTOMATON_RPC_URL = "https://rpc.stub.invalid";
    stubFetch((_url, init) => {
      const req = JSON.parse(String(init?.body));
      const result = "0x" + (12_500_000n).toString(16).padStart(64, "0");
      return jsonBody({ jsonrpc: "2.0", id: req.id, result });
    });
    expect(await getUsdcBalance("0x0000000000000000000000000000000000000b0b")).toBe(12.5);
  });
});

describe("classifyBalanceError", () => {
  it("names the cause", () => {
    expect(classifyBalanceError(new CircuitOpenError(Date.now() + 1000))).toBe("circuit_open");
    expect(classifyBalanceError(Object.assign(new Error("x"), { status: 503 }))).toBe("http_error");
    expect(classifyBalanceError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
    expect(classifyBalanceError(new BalanceUnavailableError("rpc_error", "x"))).toBe("rpc_error");
    expect(classifyBalanceError(new Error("ECONNRESET"))).toBe("network_error");
  });
});

describe("readers that show balances", () => {
  it("check_credits surfaces the failure instead of $0.00", async () => {
    const db = createTestDb();
    try {
      const mock = new MockConwayClient();
      mock.getCreditsBalance = async () => {
        throw new BalanceUnavailableError("malformed_response", "no numeric balance");
      };
      const tool = createBuiltinTools("sb").find((t) => t.name === "check_credits")!;
      const ctx = { identity: createTestIdentity(), config: createTestConfig(), db, conway: mock } as unknown as ToolContext;
      await expect(tool.execute({}, ctx)).rejects.toThrow("Credit balance unavailable (malformed_response)");
    } finally {
      db.close();
    }
  });

  it("the resource report says unknown, not $0.00", async () => {
    const db = createTestDb();
    try {
      const mock = new MockConwayClient();
      mock.getCreditsBalance = async () => {
        throw new Error("Conway API error: GET /v1/credits/balance -> 503");
      };
      stubFetch(() => {
        throw new Error("no network");
      });
      const status = await checkResources(createTestIdentity(), mock, db);
      expect(status.financial.creditsCents).toBeNull();
      expect(status.tier).toBeNull();
      const report = formatResourceReport(status);
      expect(report).toContain("Credits: unknown");
      expect(report).not.toContain("$0.00");
      expect(db.getKV("current_tier")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
