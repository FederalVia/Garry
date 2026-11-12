/**
 * Money-adjacent policy rules: chain-aware recipient addresses, rate limits
 * that count real effects, and the honest confirmation-threshold refusal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { getAddress } from "viem";
import { createDatabase } from "../state/database.js";
import { createValidationRules } from "../agent/policy-rules/validation.js";
import { createRateLimitRules } from "../agent/policy-rules/rate-limits.js";
import { createFinancialRules, transferCapWarning } from "../agent/policy-rules/financial.js";
import { StructuredLogger } from "../observability/logger.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { createBuiltinTools } from "../agent/tools.js";
import type { AutomatonDatabase, LogEntry, PolicyRequest, PolicyRule } from "../types.js";

const SOL_PEER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const EVM_PEER = "0x1234567890abcdef1234567890abcdef12345678";

function request(
  tool: string,
  args: Record<string, unknown>,
  opts: { chainType?: "evm" | "solana"; identityChainType?: "evm" | "solana"; db?: AutomatonDatabase } = {},
): PolicyRequest {
  return {
    tool: { name: tool, description: "", parameters: {}, execute: async () => "", riskLevel: "dangerous", category: "financial" } as any,
    args,
    context: {
      config: opts.chainType ? { chainType: opts.chainType } : {},
      identity: opts.identityChainType ? { chainType: opts.identityChainType } : {},
      db: opts.db ?? ({} as any),
    } as any,
    turnContext: { inputSource: "agent", turnToolCallCount: 0, sessionSpend: null as any },
  };
}

function rule(rules: PolicyRule[], id: string): PolicyRule {
  const r = rules.find((x) => x.id === id);
  if (!r) throw new Error(`rule ${id} missing`);
  return r;
}

// ─── Addresses ──────────────────────────────────────────────────

describe("validate.address_format (chain-aware)", () => {
  const addr = rule(createValidationRules(), "validate.address_format");

  it("lets a Solana automaton message a Solana peer", () => {
    expect(addr.evaluate(request("send_message", { to_address: SOL_PEER, content: "hi" }, { chainType: "solana" }))).toBeNull();
  });

  it("lets an EVM automaton reply to a Solana sender, and a Solana automaton message an EVM peer", () => {
    expect(addr.evaluate(request("send_message", { to_address: SOL_PEER }, { chainType: "evm" }))).toBeNull();
    expect(addr.evaluate(request("send_message", { to_address: SOL_PEER }))).toBeNull();
    expect(addr.evaluate(request("send_message", { to_address: EVM_PEER }, { chainType: "solana" }))).toBeNull();
  });

  it("allows Solana-to-Solana credit transfers and refuses cross-chain ones", () => {
    expect(addr.evaluate(request("transfer_credits", { to_address: SOL_PEER, amount_cents: 1 }, { chainType: "solana" }))).toBeNull();
    // The identity's chain applies when the config does not name one.
    expect(addr.evaluate(request("transfer_credits", { to_address: SOL_PEER, amount_cents: 1 }, { identityChainType: "solana" }))).toBeNull();

    const evmFromSol = addr.evaluate(request("transfer_credits", { to_address: EVM_PEER, amount_cents: 1 }, { chainType: "solana" }));
    expect(evmFromSol?.action).toBe("deny");
    expect(evmFromSol?.humanMessage).toMatch(/Solana/);

    const solFromEvm = addr.evaluate(request("transfer_credits", { to_address: SOL_PEER, amount_cents: 1 }, { chainType: "evm" }));
    expect(solFromEvm?.action).toBe("deny");
    expect(solFromEvm?.humanMessage).toMatch(/0x followed by 40 hex/);

    // Default chain is EVM.
    expect(addr.evaluate(request("transfer_credits", { to_address: SOL_PEER, amount_cents: 1 }))?.action).toBe("deny");
    expect(addr.evaluate(request("transfer_credits", { to_address: EVM_PEER, amount_cents: 1 }))).toBeNull();
  });

  it("refuses the zero and system addresses", () => {
    const zeroEvm = "0x0000000000000000000000000000000000000000";
    const systemSol = "11111111111111111111111111111111";
    expect(addr.evaluate(request("send_message", { to_address: zeroEvm }))?.action).toBe("deny");
    expect(addr.evaluate(request("transfer_credits", { to_address: zeroEvm, amount_cents: 1 }))?.action).toBe("deny");
    expect(addr.evaluate(request("send_message", { to_address: systemSol }))?.action).toBe("deny");
    expect(addr.evaluate(request("transfer_credits", { to_address: systemSol, amount_cents: 1 }, { chainType: "solana" }))?.action).toBe("deny");
  });

  it("checks base58 as given: a lowercased key that is no longer valid is refused", () => {
    // Find a throwaway key whose lowercased form is not a 32-byte base58 key.
    let key = "";
    for (let i = 0; i < 50 && !key; i++) {
      const candidate = bs58.encode(nacl.sign.keyPair().publicKey);
      const lower = candidate.toLowerCase();
      let valid = false;
      try { valid = bs58.decode(lower).length === 32; } catch { valid = false; }
      if (!valid && lower !== candidate) key = candidate;
    }
    expect(key).not.toBe("");
    expect(addr.evaluate(request("send_message", { to_address: key }))).toBeNull();
    expect(addr.evaluate(request("send_message", { to_address: key.toLowerCase() }))?.action).toBe("deny");
    expect(addr.evaluate(request("transfer_credits", { to_address: key.toLowerCase(), amount_cents: 1 }, { chainType: "solana" }))?.action).toBe("deny");
  });

  it("refuses a credit transfer to a mixed-case EVM address with a wrong EIP-55 checksum", () => {
    const good = getAddress("0x8617e340b3d01fa5f11f306f4090fd50e238070d");
    // Flip the case of the last letter: still 40 hex digits, checksum now wrong.
    const i = [...good].map((c, k) => (/[a-fA-F]/.test(c) ? k : -1)).filter((k) => k > 1).pop()!;
    const c = good[i];
    const typo = good.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + good.slice(i + 1);
    const denied = addr.evaluate(request("transfer_credits", { to_address: typo, amount_cents: 1 }));
    expect(denied?.action).toBe("deny");
    expect(denied?.humanMessage).toMatch(/checksum/);
    expect(addr.evaluate(request("fund_child", { to_address: typo, amount_cents: 1 }))?.action).toBe("deny");
    // Correct checksum, all lowercase and all uppercase carry no error.
    expect(addr.evaluate(request("transfer_credits", { to_address: good, amount_cents: 1 }))).toBeNull();
    expect(addr.evaluate(request("transfer_credits", { to_address: good.toLowerCase(), amount_cents: 1 }))).toBeNull();
    expect(addr.evaluate(request("transfer_credits", { to_address: "0x" + good.slice(2).toUpperCase(), amount_cents: 1 }))).toBeNull();
  });

  it("still refuses garbage and non-strings", () => {
    for (const bad of ["not-an-address", "0x1234", "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG", ""]) {
      expect(addr.evaluate(request("send_message", { to_address: bad }))?.action).toBe("deny");
    }
    expect(addr.evaluate(request("send_message", { to_address: 42 }))?.action).toBe("deny");
  });
});

// ─── Rate limits ────────────────────────────────────────────────

describe("rate limits count real effects, not allow decisions", () => {
  let dir: string;
  let db: AutomatonDatabase;
  const rules = createRateLimitRules();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-money-"));
    db = createDatabase(path.join(dir, "state.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function logAllow(tool: string, n: number): void {
    for (let i = 0; i < n; i++) {
      db.raw.prepare(
        `INSERT INTO policy_decisions (id, tool_name, tool_args_hash, risk_level, decision)
         VALUES (?, ?, 'h', 'dangerous', 'allow')`,
      ).run(`${tool}-${i}`, tool);
    }
  }

  function mod(type: string, agoMs = 0): void {
    db.insertModification({
      id: `${type}-${Math.random()}`,
      timestamp: new Date(Date.now() - agoMs).toISOString(),
      type: type as any,
      description: "test",
      reversible: true,
    });
  }

  function child(id: string, opts: { status: string; sandboxId: string; address?: string; createdAt?: string }): void {
    db.raw.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status, created_at)
       VALUES (?, ?, ?, ?, 'g', ?, ?)`,
    ).run(id, id, opts.address ?? "", opts.sandboxId, opts.status, opts.createdAt ?? new Date().toISOString());
  }

  function sandboxLedger(id: string, status: string, agoMs = 0): void {
    const at = Date.now() - agoMs;
    db.raw.prepare(
      `INSERT INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents, debits_credits,
         counterparty, dedupe_key, origin_type, created_at_ms, sent_at_ms, updated_at_ms)
       VALUES (?, ?, 'sandbox_create', 'infra', ?, 500, 1, 'conway:sandbox', 'd', 'agent', ?, ?, ?)`,
    ).run(id, `k-${id}`, status, at, at, at);
  }

  it("a failed update_genesis_prompt (allow logged, nothing changed) does not block the retry", () => {
    const genesis = rule(rules, "rate.genesis_prompt_daily");
    logAllow("update_genesis_prompt", 1);
    expect(genesis.evaluate(request("update_genesis_prompt", {}, { db }))).toBeNull();

    mod("prompt_change");
    const denied = genesis.evaluate(request("update_genesis_prompt", {}, { db }));
    expect(denied?.action).toBe("deny");
    expect(denied?.reasonCode).toBe("RATE_LIMIT_GENESIS");
  });

  it("a prompt change older than a day no longer counts", () => {
    const genesis = rule(rules, "rate.genesis_prompt_daily");
    mod("prompt_change", 25 * 60 * 60 * 1000);
    expect(genesis.evaluate(request("update_genesis_prompt", {}, { db }))).toBeNull();
  });

  it("self-mod counts code_edit rows in the last hour", () => {
    const selfMod = rule(rules, "rate.self_mod_hourly");
    logAllow("edit_own_file", 10);
    for (let i = 0; i < 9; i++) mod("code_edit");
    mod("code_edit", 2 * 60 * 60 * 1000);
    mod("prompt_change");
    expect(selfMod.evaluate(request("edit_own_file", {}, { db }))).toBeNull();
    mod("code_edit");
    expect(selfMod.evaluate(request("edit_own_file", {}, { db }))?.reasonCode).toBe("RATE_LIMIT_SELF_MOD");
  });

  it("three spawns that failed before any sandbox existed do not block a fourth", () => {
    const spawn = rule(rules, "rate.spawn_daily");
    logAllow("spawn_child", 3);
    child("f1", { status: "failed", sandboxId: "" });
    child("f2", { status: "failed", sandboxId: "" });
    // Lifecycle rows use SQLite datetime() text.
    db.raw.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status, created_at)
       VALUES ('f3', 'f3', '', '', 'g', 'failed', datetime('now'))`,
    ).run();
    // The treasury refused or Conway answered 4xx: released, nothing created.
    sandboxLedger("l1", "released");
    sandboxLedger("l2", "denied");
    // Local workers are in-process and cost no sandbox.
    child("w1", { status: "running", sandboxId: "", address: "local://w1" });
    expect(spawn.evaluate(request("spawn_child", {}, { db }))).toBeNull();
  });

  it("three spawns with sandboxes block a fourth, whatever their status", () => {
    const spawn = rule(rules, "rate.spawn_daily");
    child("s1", { status: "failed", sandboxId: "sbx-1" });
    child("s2", { status: "healthy", sandboxId: "sbx-2", address: EVM_PEER });
    db.raw.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status, created_at)
       VALUES ('s3', 's3', '', '', 'g', 'requested', datetime('now'))`,
    ).run();
    const denied = spawn.evaluate(request("spawn_child", {}, { db }));
    expect(denied?.action).toBe("deny");
    expect(denied?.reasonCode).toBe("RATE_LIMIT_SPAWN");
  });

  it("a sandbox creation with an unknown outcome counts although its child row records no sandbox", () => {
    const spawn = rule(rules, "rate.spawn_daily");
    child("s1", { status: "healthy", sandboxId: "sbx-1", address: EVM_PEER });
    child("s2", { status: "failed", sandboxId: "sbx-2" });
    child("u1", { status: "failed", sandboxId: "" });
    expect(spawn.evaluate(request("spawn_child", {}, { db }))).toBeNull();
    // The POST left and timed out: a prepaid sandbox may exist.
    sandboxLedger("u1-ledger", "unknown");
    expect(spawn.evaluate(request("spawn_child", {}, { db }))?.reasonCode).toBe("RATE_LIMIT_SPAWN");
  });

  it("old spawns and old unknown creations fall out of the window", () => {
    const spawn = rule(rules, "rate.spawn_daily");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    child("o1", { status: "healthy", sandboxId: "a", address: EVM_PEER, createdAt: old });
    child("o2", { status: "healthy", sandboxId: "b", createdAt: old });
    child("o3", { status: "healthy", sandboxId: "c", createdAt: old });
    sandboxLedger("o4", "unknown", 25 * 60 * 60 * 1000);
    expect(spawn.evaluate(request("spawn_child", {}, { db }))).toBeNull();
  });

  it("fails closed without a database", () => {
    for (const [id, tool] of [
      ["rate.genesis_prompt_daily", "update_genesis_prompt"],
      ["rate.self_mod_hourly", "edit_own_file"],
      ["rate.spawn_daily", "spawn_child"],
    ] as const) {
      expect(rule(rules, id).evaluate(request(tool, {}))?.reasonCode).toBe("DB_UNAVAILABLE");
    }
  });

  it("caps on-chain writes that spend wallet ETH on gas (review TREASURY-5)", () => {
    const onchain = rule(rules, "rate.onchain_writes_daily");
    expect(onchain.appliesTo).toEqual({ by: "name", names: ["give_feedback", "register_erc8004"] });
    const tx = (id: string, status: string, created: string) =>
      db.raw.prepare(
        `INSERT INTO onchain_transactions (id, tx_hash, chain, operation, status, created_at)
         VALUES (?, ?, 'eip155:8453', 'leaveFeedback', ?, ${created})`,
      ).run(id, `0x${id}`, status);
    // Allow decisions alone do not count; a day-old transaction does not either.
    logAllow("give_feedback", 10);
    tx("old", "confirmed", "datetime('now', '-25 hours')");
    for (let i = 0; i < 4; i++) tx(`t${i}`, i === 0 ? "failed" : "pending", "datetime('now')");
    expect(onchain.evaluate(request("give_feedback", {}, { db }))).toBeNull();
    // A reverted transaction still paid gas, so every status counts.
    tx("t4", "failed", "datetime('now', '-1 hours')");
    const denied = onchain.evaluate(request("register_erc8004", {}, { db }));
    expect(denied?.action).toBe("deny");
    expect(denied?.reasonCode).toBe("RATE_LIMIT_ONCHAIN");
  });
});

// ─── Confirmation threshold ─────────────────────────────────────

describe("financial.require_confirmation says what it does", () => {
  let entries: LogEntry[];

  beforeEach(() => {
    entries = [];
    StructuredLogger.setSink((e) => entries.push(e));
  });

  afterEach(() => {
    StructuredLogger.resetSink();
  });

  it("refuses 3000c honestly: no confirmation flow, the operator can raise the threshold", () => {
    const confirm = rule(createFinancialRules(DEFAULT_TREASURY_POLICY), "financial.require_confirmation");
    const r = confirm.evaluate(request("transfer_credits", { to_address: EVM_PEER, amount_cents: 3000 }));
    expect(r?.action).toBe("quarantine");
    expect(r?.reasonCode).toBe("TRANSFER_ABOVE_CONFIRMATION_THRESHOLD");
    expect(r?.humanMessage).toContain("$10.00");
    expect(r?.humanMessage).toContain("no confirmation flow exists");
    expect(r?.humanMessage).toContain("treasuryPolicy.requireConfirmationAboveCents");
    expect(r?.humanMessage).not.toMatch(/CONFIRMATION_REQUIRED|awaiting|pending/i);
    expect(confirm.evaluate(request("transfer_credits", { to_address: EVM_PEER, amount_cents: 1000 }))).toBeNull();
  });

  it("warns once at construction when maxSingleTransferCents is set above the threshold", () => {
    const policy = { ...DEFAULT_TREASURY_POLICY, maxSingleTransferCents: 5000 };
    createFinancialRules(policy);
    const warnings = entries.filter((e) => e.level === "warn" && /maxSingleTransferCents/.test(e.message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("has no effect above requireConfirmationAboveCents");
    expect(transferCapWarning(policy)).not.toBeNull();
  });

  it("the shipped defaults agree: no warning, and the single cap is the threshold", () => {
    createFinancialRules(DEFAULT_TREASURY_POLICY);
    expect(entries.filter((e) => /maxSingleTransferCents/.test(e.message))).toHaveLength(0);
    expect(transferCapWarning(DEFAULT_TREASURY_POLICY)).toBeNull();
    expect(DEFAULT_TREASURY_POLICY.maxSingleTransferCents).toBe(DEFAULT_TREASURY_POLICY.requireConfirmationAboveCents);
  });

  it("does not warn when the single cap is at or below the threshold", () => {
    const policy = { ...DEFAULT_TREASURY_POLICY, maxSingleTransferCents: 1000, requireConfirmationAboveCents: 1000 };
    createFinancialRules(policy);
    expect(entries.filter((e) => /maxSingleTransferCents/.test(e.message))).toHaveLength(0);
    expect(transferCapWarning(policy)).toBeNull();
  });
});

describe("transfer_credits tells the agent which chain the recipient must be on", () => {
  it("describes both address formats and the unit", () => {
    const tool = createBuiltinTools("sbx").find((t) => t.name === "transfer_credits")!;
    const props = (tool.parameters as any).properties;
    expect(props.to_address.description).toMatch(/own chain/);
    expect(props.to_address.description).toMatch(/0x\.\.\. on an EVM automaton/);
    expect(props.to_address.description).toMatch(/base58 \(case-sensitive\) on a Solana automaton/);
    expect(props.amount_cents.description).toMatch(/cents/);
  });
});
