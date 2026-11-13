/**
 * The status and persistence text the model reads every turn match the code:
 * the ERC-8004 line names the chain, and the state repo is not described as
 * committing every change.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt, formatRegistryIdentity } from "../agent/system-prompt.js";
import { createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

const savedHome = process.env.HOME;
let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-status-"));
  process.env.HOME = tmp;
  fs.mkdirSync(path.join(tmp, ".automaton"), { recursive: true });
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function prompt(db = createTestDb()): string {
  return buildSystemPrompt({
    identity: createTestIdentity(),
    config: createTestConfig(),
    financial: { creditsCents: 1000, usdcBalance: 0, lastChecked: new Date().toISOString() },
    state: "running" as any,
    db,
    tools: [],
    skills: [],
    isFirstRun: false,
  });
}

const entry = (chain: string, agentId: string) => ({
  agentId,
  agentURI: "https://a/card.json",
  chain,
  contractAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  txHash: `0x${"ab".repeat(32)}`,
  registeredAt: new Date().toISOString(),
});

describe("system prompt status", () => {
  it("labels a testnet-only registration as not registered on mainnet", () => {
    const db = createTestDb();
    db.setRegistryEntry(entry("eip155:84532", "12"));
    expect(prompt(db)).toContain("ERC-8004 Agent ID: 12 (Base Sepolia testnet; not registered on Base mainnet)");
    db.setRegistryEntry(entry("eip155:8453", "40"));
    expect(prompt(db)).toContain("ERC-8004 Agent ID: 40 (Base mainnet)");
  });

  it("says not registered with no entry", () => {
    expect(formatRegistryIdentity(undefined)).toBe("not registered");
  });

  it("does not claim every state change is a commit", () => {
    const text = prompt();
    expect(text).not.toContain("Every change is a commit");
    expect(text).toContain("SOUL.md and skills/ are committed when they change");
  });
});
