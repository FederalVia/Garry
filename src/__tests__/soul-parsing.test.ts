/**
 * SOUL.md parsing keeps a markdown genesis intact, wizard-created souls have
 * a genesis baseline (any script), unknown alignment never wakes the agent,
 * and soul updates validate only what they change.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSoulMd } from "../setup/defaults.js";
import { computeGenesisAlignment, parseSoulMd, writeSoulMd, createDefaultSoul } from "../soul/model.js";
import { truncateUtf8, updateSoul } from "../soul/tools.js";
import { reflectOnSoul } from "../soul/reflection.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient } from "./mocks.js";
import type { AutomatonDatabase, HeartbeatLegacyContext, TickContext } from "../types.js";

const GENESIS = [
  "Build tools that other agents pay for.",
  "",
  "## Goals",
  "Earn 10 USDC by Friday.",
  "",
  "## Strategy",
  "Sell API access by the call.",
  "",
  "## Values",
  "Be frugal.",
].join("\n");

const savedHome = process.env.HOME;
let home: string;
let soulPath: string;
let db: AutomatonDatabase;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "soul-parsing-"));
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  soulPath = path.join(home, ".automaton", "SOUL.md");
  process.env.HOME = home;
  db = createTestDb();
});

afterEach(() => {
  process.env.HOME = savedHome;
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  vi.doUnmock("../soul/tools.js");
  vi.resetModules();
});

function wizardSoul(genesis = GENESIS): string {
  return generateSoulMd("bot", "0x1234567890abcdef1234567890abcdef12345678", "0xcreator", genesis);
}

async function runSoulReflectionTask(): Promise<{ shouldWake: boolean; message?: string }> {
  const taskCtx: HeartbeatLegacyContext = {
    identity: createTestIdentity(),
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
  };
  return BUILTIN_TASKS.soul_reflection({} as TickContext, taskCtx);
}

describe("F185: only known section names split SOUL.md", () => {
  it("keeps a wizard genesis with ## Goals / ## Strategy / ## Values in the core purpose", () => {
    const soul = parseSoulMd(wizardSoul());
    expect(soul.corePurpose).toContain("Earn 10 USDC by Friday.");
    expect(soul.corePurpose).toContain("Sell API access by the call.");
    expect(soul.corePurpose).toContain("Be frugal.");
    expect(soul.strategy).toBe("");
    expect(soul.values[0]).toBe("Survive: maintain compute resources at all costs");
    expect(soul.name).toBe("bot");

    const rewritten = writeSoulMd(soul);
    expect(rewritten).toContain("Earn 10 USDC by Friday.");
    const again = parseSoulMd(rewritten);
    expect(again.corePurpose).toBe(soul.corePurpose);
    expect(again.strategy).toBe("");
    expect(again.genesisPromptOriginal).toBe(soul.genesisPromptOriginal);
  });

  it("treats an unknown ## heading in a hand-edited soul as content", () => {
    const md = "# bot\n\n## Mission\nDo work.\n\n## Notes\nKeep this.\n\n## Strategy\nGo.\n";
    const soul = parseSoulMd(md);
    expect(soul.corePurpose).toContain("## Notes\nKeep this.");
    expect(soul.strategy).toBe("Go.");
  });
});

describe("F183: genesis baseline for wizard souls, any script", () => {
  it("takes the wizard mission as the genesis prompt", () => {
    const soul = parseSoulMd(wizardSoul());
    expect(soul.genesisPromptOriginal).toBe(GENESIS);
    expect(computeGenesisAlignment(soul.corePurpose, soul.genesisPromptOriginal)).toBeGreaterThan(0.99);
  });

  it("scores identical CJK and Cyrillic text as aligned", () => {
    const zh = "构建其他代理愿意付费使用的工具，并在周五前赚取十美元。";
    const ja = "他のエージェントが支払うツールを作る";
    const ru = "Создавать инструменты, за которые платят другие агенты.";
    expect(computeGenesisAlignment(zh, zh)).toBeGreaterThan(0.9);
    expect(computeGenesisAlignment(ja, ja)).toBeGreaterThan(0.9);
    expect(computeGenesisAlignment(ru, ru)).toBeGreaterThan(0.9);
    expect(computeGenesisAlignment(zh, ru)).toBeLessThan(0.1);
  });

  it("does not wake soul_reflection for a fresh wizard soul", async () => {
    fs.writeFileSync(soulPath, wizardSoul());
    const result = await runSoulReflectionTask();
    expect(result.shouldWake).toBe(false);
  });

  it("does not wake for a soul without a recorded genesis, even with a stored alignment of 0", async () => {
    const soul = createDefaultSoul("Do useful work.", "bot");
    const v1 = writeSoulMd({ ...soul, genesisPromptOriginal: "", genesisAlignment: 0 });
    expect(v1).toContain("genesis_alignment: 0.0000");
    fs.writeFileSync(soulPath, v1);
    const result = await runSoulReflectionTask();
    expect(result.shouldWake).toBe(false);
    const reflection = await reflectOnSoul(db.raw, soulPath);
    expect(reflection.alignmentKnown).toBe(false);
    expect(reflection.suggestedUpdates).toEqual([]);
  });
});

describe("F184: updates validate only changed keys; reflection reports only applied updates", () => {
  it("lets a capabilities update through with a 2,500-char core purpose and keeps it intact", async () => {
    const purpose = "Serve the creator. ".repeat(132).trim();
    expect(purpose.length).toBeGreaterThan(2400);
    const soul = createDefaultSoul(purpose, "bot");
    fs.writeFileSync(soulPath, writeSoulMd(soul));

    const result = await updateSoul(db.raw, { capabilities: "Tools used: exec" }, "reflection", "test", soulPath);
    expect(result.errors).toBeUndefined();
    expect(result.success).toBe(true);

    const after = parseSoulMd(fs.readFileSync(soulPath, "utf8"));
    expect(after.corePurpose).toBe(purpose);
    expect(after.genesisPromptOriginal).toBe(purpose);
    expect(after.capabilities).toBe("Tools used: exec");
  });

  it("keeps a rewritten wizard soul with a 40 KB genesis readable (under the 64 KiB cap)", async () => {
    const genesis = "Earn revenue by selling useful tools to other agents. ".repeat(760).trim();
    expect(genesis.length).toBeGreaterThan(40_000);
    fs.writeFileSync(soulPath, wizardSoul(genesis));

    const result = await updateSoul(db.raw, { strategy: "Ship one tool a week." }, "agent", "test", soulPath);
    expect(result.errors).toBeUndefined();
    expect(fs.statSync(soulPath).size).toBeLessThanOrEqual(64 * 1024);

    const reloaded = await import("../soul/model.js").then((m) => m.loadCurrentSoul(db.raw, soulPath));
    expect(reloaded).not.toBeNull();
    expect(reloaded!.corePurpose).toBe(genesis);
    expect(reloaded!.strategy).toBe("Ship one tool a week.");
    expect(genesis.startsWith(reloaded!.genesisPromptOriginal)).toBe(true);
  });

  it("shortens a long CJK genesis copy by bytes, keeping as much as fits", async () => {
    for (const n of [6000, 7000, 8000]) {
      const genesis = "交易".repeat(n);
      fs.writeFileSync(soulPath, wizardSoul(genesis));
      const result = await updateSoul(db.raw, { capabilities: "c" }, "reflection", "test", soulPath);
      expect(result.errors).toBeUndefined();
      const size = fs.statSync(soulPath).size;
      expect(size).toBeLessThanOrEqual(64 * 1024);
      const kept = parseSoulMd(fs.readFileSync(soulPath, "utf8")).genesisPromptOriginal;
      expect(genesis.startsWith(kept)).toBe(true);
      if (Buffer.byteLength(genesis) * 2 > 64 * 1024) {
        // Cut to the cap: at most one 3-byte character of room left over.
        expect(kept.length).toBeGreaterThan(0);
        expect(64 * 1024 - size).toBeLessThan(4);
      }
    }
  });

  it("still refuses an oversized core purpose when the update sets it", async () => {
    fs.writeFileSync(soulPath, writeSoulMd(createDefaultSoul("Short.", "bot")));
    const result = await updateSoul(db.raw, { corePurpose: "x".repeat(2500) }, "agent", "test", soulPath);
    expect(result.success).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/Core purpose exceeds/);
  });

  it("returns autoUpdated [] when the soul update is rejected", async () => {
    vi.resetModules();
    vi.doMock("../soul/tools.js", () => ({
      updateSoul: vi.fn(async () => ({ success: false, version: 0, errors: ["disk full"] })),
    }));
    const { reflectOnSoul: reflect } = await import("../soul/reflection.js");
    fs.writeFileSync(soulPath, writeSoulMd(createDefaultSoul("Do useful work.", "bot")));
    db.insertTransaction({ id: "t1", type: "transfer_out", amountCents: 100, description: "paid a peer", timestamp: new Date().toISOString() } as any);

    const reflection = await reflect(db.raw, soulPath);
    expect(reflection.autoUpdated).toEqual([]);
    expect(reflection.autoUpdateErrors).toEqual(["disk full"]);
  });
});

describe("truncateUtf8", () => {
  it("never splits a character", () => {
    expect(truncateUtf8("交易", 5)).toBe("交");
    expect(truncateUtf8("a😀b", 4)).toBe("a");
    expect(truncateUtf8("a😀b", 5)).toBe("a😀");
    expect(truncateUtf8("abc", 10)).toBe("abc");
    expect(truncateUtf8("abc", 0)).toBe("");
  });
});
