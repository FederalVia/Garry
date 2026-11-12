/**
 * Operator CLI logic (automaton-cli fund / send), in src/operator so it can
 * be tested: dollar amounts with --cents, chain-validated --to, one
 * idempotency key, no redirects; signing with the existing wallet (EVM or
 * Solana) through the runtime social client.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { getAddress, keccak256, toBytes, verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseUsdAmount, planFund, executeFund, formatUsd, FUND_USAGE } from "../operator/fund.js";

const AUTOMATON = "0x1111111111111111111111111111111111111111";
const CHILD = "0x2222222222222222222222222222222222222222";
const SOL_RECIPIENT = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
// The paths automaton-cli fund passes.
const PATHS = ["/v1/credits/transfer", "/v1/credits/transfers"];
const EVM_CONFIG = {
  name: "test-bot",
  walletAddress: AUTOMATON,
  conwayApiUrl: "https://api.conway.test",
  conwayApiKey: "cnwy_k_test",
  chainType: "evm" as const,
};

// ─── fund: amounts ──────────────────────────────────────────────

describe("parseUsdAmount", () => {
  it("reads dollars by default, monotonic across 99/100", () => {
    expect(parseUsdAmount("75", { cents: false })).toEqual({ ok: true, cents: 7500 });
    expect(parseUsdAmount("99", { cents: false })).toEqual({ ok: true, cents: 9900 });
    expect(parseUsdAmount("100", { cents: false })).toEqual({ ok: true, cents: 10000 });
    expect(parseUsdAmount("0.75", { cents: false })).toEqual({ ok: true, cents: 75 });
    expect(parseUsdAmount("5.5", { cents: false })).toEqual({ ok: true, cents: 550 });
    expect(parseUsdAmount("12.50", { cents: false })).toEqual({ ok: true, cents: 1250 });
    expect(parseUsdAmount(" 5.00 ", { cents: false })).toEqual({ ok: true, cents: 500 });
  });

  it("reads whole cents with --cents", () => {
    expect(parseUsdAmount("75", { cents: true })).toEqual({ ok: true, cents: 75 });
    expect(parseUsdAmount("500", { cents: true })).toEqual({ ok: true, cents: 500 });
    expect(parseUsdAmount("0.75", { cents: true }).ok).toBe(false);
  });

  it("refuses exponents, commas, extra decimals, signs, zero and unsafe values", () => {
    for (const raw of ["1e3", "1,000", "0.001", "-5", "+5", "0", "0.00", "", "abc", "5.", ".5", "Infinity", "NaN", "0x10"]) {
      expect(parseUsdAmount(raw, { cents: false }).ok, raw).toBe(false);
    }
    expect(parseUsdAmount("90071992547409920", { cents: false }).ok).toBe(false);
    expect(parseUsdAmount("9007199254740993", { cents: true }).ok).toBe(false);
    expect(parseUsdAmount("0", { cents: true }).ok).toBe(false);
  });

  it("refuses a leading $ and never teaches it: unquoted, the shell turns $25 into 5", () => {
    for (const raw of ["$12.50", "$5", " $25", "$75"]) {
      const r = parseUsdAmount(raw, { cents: false });
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/drop the "\$"/);
    }
    expect(parseUsdAmount("$75", { cents: true }).ok).toBe(false);
    // The amount line and examples must not show a "$<digit>" form an operator would type.
    const amountLine = FUND_USAGE.split("\n").find((l) => l.trim().startsWith("<usd>"))!;
    expect(amountLine).not.toMatch(/\$\d/);
    const examples = FUND_USAGE.split("\n").filter((l) => l.includes("automaton-cli fund "));
    expect(examples.length).toBeGreaterThan(1);
    for (const l of examples) expect(l, l).not.toMatch(/\$/);
  });

  it("formats dollars exactly", () => {
    expect(formatUsd(7500)).toBe("$75.00");
    expect(formatUsd(75)).toBe("$0.75");
    expect(formatUsd(5)).toBe("$0.05");
  });
});

// ─── fund: plan ─────────────────────────────────────────────────

describe("planFund", () => {
  it("describes the dollar amount, cents, sender and recipient", () => {
    const r = planFund({ config: EVM_CONFIG, to: CHILD, amountCents: 7500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.description).toBe(`$75.00 (7500 cents) from ${AUTOMATON} to ${CHILD}`);
    expect(r.plan.amountCents).toBe(7500);
  });

  it("requires --to (no self-transfer default)", () => {
    const r = planFund({ config: EVM_CONFIG, to: undefined, amountCents: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--to/);
  });

  it("refuses an invalid --to, the zero address and the automaton's own address", () => {
    expect(planFund({ config: EVM_CONFIG, to: "0xabc", amountCents: 100 }).ok).toBe(false);
    expect(planFund({ config: EVM_CONFIG, to: "0x0000000000000000000000000000000000000000", amountCents: 100 }).ok).toBe(false);
    const self = planFund({ config: EVM_CONFIG, to: AUTOMATON.toUpperCase().replace("0X", "0x"), amountCents: 100 });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toMatch(/own address/);
  });

  it("validates --to against the configured chain", () => {
    const solConfig = { ...EVM_CONFIG, walletAddress: bs58.encode(nacl.sign.keyPair().publicKey), chainType: "solana" as const };
    const evmTo = planFund({ config: solConfig, to: CHILD, amountCents: 100 });
    expect(evmTo.ok).toBe(false);
    if (!evmTo.ok) expect(evmTo.error).toMatch(/Solana/);
    expect(planFund({ config: solConfig, to: SOL_RECIPIENT, amountCents: 100 }).ok).toBe(true);
    expect(planFund({ config: EVM_CONFIG, to: SOL_RECIPIENT, amountCents: 100 }).ok).toBe(false);
  });

  it("refuses a mixed-case --to whose EIP-55 checksum is wrong (a likely typo)", () => {
    const good = getAddress("0x8617e340b3d01fa5f11f306f4090fd50e238070d");
    expect(good.endsWith("D")).toBe(true);
    const typo = good.slice(0, -1) + "d";
    const r = planFund({ config: EVM_CONFIG, to: typo, amountCents: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/checksum/);
    expect(planFund({ config: EVM_CONFIG, to: good, amountCents: 500 }).ok).toBe(true);
    expect(planFund({ config: EVM_CONFIG, to: good.toLowerCase(), amountCents: 500 }).ok).toBe(true);
  });

  it("refuses the Solana system address (all-zero key) on a Solana automaton, as the policy does", () => {
    const solConfig = { ...EVM_CONFIG, walletAddress: bs58.encode(nacl.sign.keyPair().publicKey), chainType: "solana" as const };
    const system = bs58.encode(new Uint8Array(32));
    expect(system).toBe("11111111111111111111111111111111");
    const r = planFund({ config: solConfig, to: system, amountCents: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/system address/);
  });

  it("refuses a missing API key and a non-HTTPS API URL (the key goes in a header)", () => {
    expect(planFund({ config: { ...EVM_CONFIG, conwayApiKey: "" }, to: CHILD, amountCents: 100 }).ok).toBe(false);
    expect(planFund({ config: { ...EVM_CONFIG, conwayApiUrl: "http://api.conway.test" }, to: CHILD, amountCents: 100 }).ok).toBe(false);
  });
});

// ─── fund: execute ──────────────────────────────────────────────

describe("executeFund", () => {
  function plan(apiUrl = EVM_CONFIG.conwayApiUrl) {
    const r = planFund({ config: { ...EVM_CONFIG, conwayApiUrl: apiUrl }, to: CHILD, amountCents: 7500 });
    if (!r.ok) throw new Error(r.error);
    return r.plan;
  }

  it("sends one idempotency key on both endpoint paths, manual redirects, the planned body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/credits/transfer")) return new Response("not here", { status: 404 });
      return new Response(JSON.stringify({ transfer_id: "t1", status: "completed", balance_after_cents: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await executeFund(plan(), { paths: PATHS, fetch: fakeFetch });
    expect(result.status).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.conway.test/v1/credits/transfer",
      "https://api.conway.test/v1/credits/transfers",
    ]);
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(result.idempotencyKey).toBe(keys[0]);
    for (const c of calls) {
      expect(c.init.redirect).toBe("manual");
      expect(JSON.parse(String(c.init.body))).toMatchObject({ to_address: CHILD, amount_cents: 7500 });
    }
    if (result.status === "ok") {
      expect(result.transferId).toBe("t1");
      expect(result.balanceAfterCents).toBe(100);
    }
  });

  it("does not retry a 5xx or a timeout: the outcome is unknown and the key is reported", async () => {
    let n = 0;
    const fivexx = (async () => {
      n++;
      return new Response("bad gateway", { status: 502 });
    }) as unknown as typeof fetch;
    const r1 = await executeFund(plan(), { paths: PATHS, fetch: fivexx, idempotencyKey: "KEY-1" });
    expect(n).toBe(1);
    expect(r1.status).toBe("unknown");
    if (r1.status === "unknown") expect(r1.error).toMatch(/do not re-run blindly.*KEY-1/);

    let m = 0;
    const hang = ((_url: string, init: RequestInit) => {
      m++;
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const r2 = await executeFund(plan(), { paths: PATHS, fetch: hang, timeoutMs: 30 });
    expect(m).toBe(1);
    expect(r2.status).toBe("unknown");
  });

  it("reports a 2xx that carries a refusal status as a failure, not a submission", async () => {
    for (const status of ["declined", "insufficient_funds", "denied"]) {
      const reply = (async () =>
        new Response(JSON.stringify({ transfer_id: "t9", status }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      const r = await executeFund(plan(), { paths: PATHS, fetch: reply });
      expect(r.status).toBe("failed");
    }
  });

  it("reports a 4xx as a definite failure", async () => {
    const refused = (async () => new Response("insufficient credits", { status: 402 })) as unknown as typeof fetch;
    const r = await executeFund(plan(), { paths: PATHS, fetch: refused });
    expect(r.status).toBe("failed");
  });

  it("does not follow a 302 (loopback servers): the redirect target receives nothing", async () => {
    let targetHits = 0;
    const target = http.createServer((_req, res) => {
      targetHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/steal`;
    const origin = http.createServer((_req, res) => {
      res.writeHead(302, { location: targetUrl });
      res.end();
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    try {
      const r = await executeFund(plan(`http://127.0.0.1:${(origin.address() as AddressInfo).port}`), { paths: PATHS });
      expect(r.status).toBe("unknown");
      if (r.status === "unknown") expect(r.error).toMatch(/302.*not followed/);
      expect(targetHits).toBe(0);
    } finally {
      await new Promise((r) => origin.close(r));
      await new Promise((r) => target.close(r));
    }
  });
});

// ─── send ───────────────────────────────────────────────────────

describe("operator send", () => {
  let home: string;
  let fetchCalls: Array<{ url: string; body: any }>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "operator-send-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    fetchCalls = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "msg-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeWallet(data: object): void {
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    fs.writeFileSync(path.join(home, ".automaton", "wallet.json"), JSON.stringify(data), { mode: 0o600 });
  }

  it("signs from a Solana wallet.json and posts a base58 recipient unchanged", async () => {
    const kp = nacl.sign.keyPair();
    const sender = bs58.encode(kp.publicKey);
    writeWallet({ chainType: "solana", secretKey: bs58.encode(kp.secretKey), createdAt: new Date().toISOString() });

    const { sendOperatorMessage } = await import("../operator/send.js");
    const r = await sendOperatorMessage({ relayUrl: "https://relay.test", to: SOL_RECIPIENT, content: "hi" });
    expect(r).toMatchObject({ ok: true, id: "msg-1", from: sender, chainType: "solana" });

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]!.body;
    expect(fetchCalls[0]!.url).toBe("https://relay.test/v1/messages");
    expect(body.from).toBe(sender);
    expect(body.to).toBe(SOL_RECIPIENT);
    const canonical = `Conway:send:${SOL_RECIPIENT}:${keccak256(toBytes("hi"))}:${body.signed_at}`;
    expect(
      nacl.sign.detached.verify(new TextEncoder().encode(canonical), bs58.decode(body.signature), kp.publicKey),
    ).toBe(true);
  });

  it("signs from an EVM wallet.json (lowercased EVM addresses, as the runtime does)", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    writeWallet({ chainType: "evm", privateKey: pk, createdAt: new Date().toISOString() });

    const { sendOperatorMessage } = await import("../operator/send.js");
    const r = await sendOperatorMessage({ relayUrl: "https://relay.test", to: CHILD.toUpperCase().replace("0X", "0x"), content: "hello" });
    expect(r.ok).toBe(true);
    const body = fetchCalls[0]!.body;
    expect(body.from).toBe(account.address.toLowerCase());
    expect(body.to).toBe(CHILD);
    const canonical = `Conway:send:${CHILD}:${keccak256(toBytes("hello"))}:${body.signed_at}`;
    expect(await verifyMessage({ address: account.address, message: canonical, signature: body.signature })).toBe(true);
  });

  it("refuses an http:// relay before anything is signed", async () => {
    const { sendOperatorMessage } = await import("../operator/send.js");
    const signMessage = vi.fn(async () => "sig");
    const r = await sendOperatorMessage({
      relayUrl: "http://relay.test",
      to: SOL_RECIPIENT,
      content: "hi",
      signer: { chainIdentity: { chainType: "evm", address: AUTOMATON, signMessage }, chainType: "evm", address: AUTOMATON },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/HTTPS/);
    expect(signMessage).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses an invalid recipient before posting", async () => {
    writeWallet({ chainType: "evm", privateKey: generatePrivateKey(), createdAt: new Date().toISOString() });
    const { sendOperatorMessage } = await import("../operator/send.js");
    const r = await sendOperatorMessage({ relayUrl: "https://relay.test", to: "not-an-address", content: "hi" });
    expect(r.ok).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("gives a clear error without a wallet and never creates one", async () => {
    const { sendOperatorMessage, loadOperatorSigner } = await import("../operator/send.js");
    expect(loadOperatorSigner()).toBeNull();
    const r = await sendOperatorMessage({ relayUrl: "https://relay.test", to: CHILD, content: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No wallet found/);
    expect(fs.existsSync(path.join(home, ".automaton", "wallet.json"))).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("reports an unreadable or keyless wallet without crashing", async () => {
    writeWallet({ chainType: "solana", createdAt: new Date().toISOString() });
    const { sendOperatorMessage } = await import("../operator/send.js");
    const r = await sendOperatorMessage({ relayUrl: "https://relay.test", to: CHILD, content: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no secretKey/);

    fs.writeFileSync(path.join(home, ".automaton", "wallet.json"), "{not json");
    const r2 = await sendOperatorMessage({ relayUrl: "https://relay.test", to: CHILD, content: "hi" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/Cannot read wallet/);
  });
});
