/**
 * Internal state writers replace their file with temp + rename and never
 * write through a link left at their path; loaders of operator files do not
 * follow links; log lines never carry known secrets.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../types.js";

const ORIGINAL_ENV = { ...process.env };
const WALLET_HEX = "1f".repeat(32);
const WALLET_JSON = JSON.stringify({ chainType: "evm", privateKey: `0x${WALLET_HEX}` }, null, 2);

let home: string;
let stateDir: string;
let walletPath: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "state-writers-"));
  stateDir = path.join(home, ".automaton");
  walletPath = path.join(stateDir, "wallet.json");
  process.env.HOME = home;
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(walletPath, WALLET_JSON, { mode: 0o600 });
});

function linkToWallet(name: string): string {
  const p = path.join(stateDir, name);
  fs.symlinkSync("wallet.json", p);
  return p;
}

function walletUnchanged(): void {
  expect(fs.readFileSync(walletPath, "utf-8")).toBe(WALLET_JSON);
}

/**
 * A writer may refuse a link at its path or replace the link by rename;
 * either way the link's target is untouched and nothing is left pointing
 * through it afterwards.
 */
async function attempt(fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

function linkReplacedOrKept(p: string, wrote: boolean): void {
  const st = fs.lstatSync(p);
  if (wrote) {
    expect(st.isFile()).toBe(true);
    expect(st.nlink).toBe(1);
  } else {
    expect(st.isSymbolicLink()).toBe(true);
  }
}

describe("N2: state writers never write through a link", () => {
  it("saveConfig never writes through an automaton.json symlink", async () => {
    const p = linkToWallet("automaton.json");
    const { saveConfig } = await import("../config.js");
    const { createTestConfig } = await import("./mocks.js");
    const wrote = await attempt(() => saveConfig(createTestConfig({ genesisPrompt: "overwrite" })));
    walletUnchanged();
    linkReplacedOrKept(p, wrote);
  });

  it("saveConfig never writes through a hard link at automaton.json", async () => {
    const p = path.join(stateDir, "automaton.json");
    fs.linkSync(walletPath, p);
    const { saveConfig } = await import("../config.js");
    const { createTestConfig } = await import("./mocks.js");
    await attempt(() => saveConfig(createTestConfig({ genesisPrompt: "overwrite" })));
    walletUnchanged();
  });

  it("saveConfig writes a regular automaton.json with mode 0600", async () => {
    const { saveConfig } = await import("../config.js");
    const { createTestConfig } = await import("./mocks.js");
    saveConfig(createTestConfig());
    const st = fs.lstatSync(path.join(stateDir, "automaton.json"));
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("loadHeartbeatConfig ignores a heartbeat.yml symlink, and saving never writes through it", async () => {
    const hb = linkToWallet("heartbeat.yml");
    const { saveHeartbeatConfig, loadHeartbeatConfig } = await import("../heartbeat/config.js");
    const loaded = loadHeartbeatConfig(hb);
    expect(loaded.entries.length).toBeGreaterThan(0);
    const wrote = await attempt(() =>
      saveHeartbeatConfig({ entries: [], defaultIntervalMs: 1, lowComputeMultiplier: 1 }, hb),
    );
    walletUnchanged();
    linkReplacedOrKept(hb, wrote);
  });

  it("updateSoul never writes through a SOUL.md symlink", async () => {
    const p = linkToWallet("SOUL.md");
    const { updateSoul } = await import("../soul/tools.js");
    const { createTestDb } = await import("./mocks.js");
    const result = await updateSoul(createTestDb().raw, { corePurpose: "x" }, "genesis");
    walletUnchanged();
    linkReplacedOrKept(p, result.success);
  });

  it("createSkill replaces a SKILL.md symlink instead of writing through it", async () => {
    const dir = path.join(stateDir, "skills", "notes");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(walletPath, path.join(dir, "SKILL.md"));
    const { createSkill } = await import("../skills/registry.js");
    const { createTestDb } = await import("./mocks.js");
    await createSkill("notes", "d", "Notes body.", path.join(stateDir, "skills"), createTestDb(), {
      writeFile: async (p: string, c: string) => fs.writeFileSync(p, c),
    } as any);
    walletUnchanged();
    expect(fs.lstatSync(path.join(dir, "SKILL.md")).isFile()).toBe(true);
  });

  it("saveAgentCard never writes through an agent-card.json symlink", async () => {
    const p = linkToWallet("agent-card.json");
    const { saveAgentCard } = await import("../registry/agent-card.js");
    const wrote = await attempt(() => saveAgentCard({ name: "x" } as any, {} as any));
    walletUnchanged();
    linkReplacedOrKept(p, wrote);
  });

  it("provision never writes through a config.json symlink", async () => {
    const p = linkToWallet("config.json");
    const { ResilientHttpClient } = await import("../conway/http-client.js");
    const spy = vi.spyOn(ResilientHttpClient.prototype, "request").mockImplementation(async (url: string) => {
      const body = url.endsWith("/nonce")
        ? { nonce: "abcdefgh12345678" }
        : url.endsWith("/verify")
          ? { access_token: "jwt" }
          : { key: "cnwy_k_provisioned_key_000000", key_prefix: "cnwy_k_pro" };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    try {
      const { provision } = await import("../identity/provision.js");
      const wrote = await attempt(() => provision("http://127.0.0.1:9"));
      walletUnchanged();
      linkReplacedOrKept(p, wrote);
    } finally {
      spy.mockRestore();
    }
  });

  it("propagateConstitution never copies a constitution.md symlink's target to the child", async () => {
    linkToWallet("constitution.md");
    const written: string[] = [];
    const conway = {
      writeFile: async (_p: string, c: string) => {
        written.push(c);
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as any;
    const { propagateConstitution } = await import("../replication/constitution.js");
    const { createTestDb } = await import("./mocks.js");
    await expect(propagateConstitution(conway, "child-1", createTestDb().raw)).rejects.toThrow();
    expect(written.join("")).not.toContain(WALLET_HEX);
  });

  it("hostAgentCard writes only into a directory it just created", async () => {
    const execs: string[] = [];
    const writes: string[] = [];
    const conway = {
      exec: async (cmd: string) => {
        execs.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      writeFile: async (p: string) => {
        writes.push(p);
      },
      exposePort: async () => ({ port: 8004, publicUrl: "https://card.example.test" }),
    } as any;
    const { hostAgentCard } = await import("../registry/agent-card.js");
    await hostAgentCard({ name: "x" } as any, conway, 8004);
    const mk = /^mkdir -m 700 '(\/tmp\/agent-card-[0-9a-f]{16})'$/.exec(execs[0]);
    expect(mk).toBeTruthy();
    expect(writes.length).toBe(2);
    for (const w of writes) expect(path.dirname(w)).toBe(mk![1]);
    expect(writes).not.toContain("/tmp/agent-card.json");

    // An existing entry at the chosen name (mkdir fails) aborts before any write.
    const failing = {
      exec: async () => ({ stdout: "", stderr: "File exists", exitCode: 1 }),
      writeFile: async (p: string) => {
        writes.push(p);
      },
    } as any;
    writes.length = 0;
    await expect(hostAgentCard({ name: "x" } as any, failing, 8004)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("wallet creation refuses a dangling wallet.json symlink", async () => {
    fs.rmSync(walletPath);
    const target = path.join(home, "planted-wallet.json");
    fs.symlinkSync(target, walletPath);
    const { getWallet } = await import("../identity/wallet.js");
    await expect(getWallet("evm")).rejects.toThrow(/Refusing to create a wallet/);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("logs never carry known secrets", () => {
  it("redacts registered secrets in messages, context and errors, but keeps transaction hashes", async () => {
    const { registerSecret, clearRegisteredSecrets } = await import("../security/secret-redaction.js");
    const { createLogger, StructuredLogger } = await import("../observability/logger.js");
    registerSecret(`0x${WALLET_HEX}`, "wallet");
    const entries: LogEntry[] = [];
    StructuredLogger.setSink((e) => entries.push(e));
    try {
      const txHash = `0x${"9a".repeat(32)}`;
      const logger = createLogger("test");
      logger.info(`[TOOL RESULT] exec: ${WALLET_JSON} tx ${txHash}`, { output: `key=${WALLET_HEX}` });
      logger.error("failed", new Error(`boom ${WALLET_HEX}`));
      logger.info("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----");
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain(WALLET_HEX);
      expect(serialized).not.toContain("MIIEow");
      expect(serialized).toContain(txHash);
      expect(serialized).toContain("[REDACTED:wallet]");
    } finally {
      StructuredLogger.resetSink();
      clearRegisteredSecrets();
    }
  });
});
