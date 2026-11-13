/**
 * Identity: the wallet is the authority and is never created behind the
 * operator's back. --run refuses a missing wallet, an address that differs
 * from automaton.json and a chain that differs from the wallet; with no
 * chain in the config the wallet's chain is used. Concurrent creators agree
 * on one key; an empty wallet.json is an error, not a reason for a new key.
 * --provision writes the new key where the runtime reads it and signs for
 * the host it talks to. registerParent is gone.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import bs58 from "bs58";
import nacl from "tweetnacl";

const REPO = path.resolve(__dirname, "../..");
const ENTRY = path.join(REPO, "src/index.ts");
const RECORDER = path.join(__dirname, "fixtures", "fetch-recorder.mjs");
const CREATOR = "0x" + "1".repeat(40);

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    RECORDER_LOG: path.join(home, "requests.log"),
    RECORDER_SCRIPT: path.join(home, "script.json"),
  };
  for (const k of ["CONWAY_API_KEY", "CONWAY_API_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_BASE_URL", "CONWAY_SANDBOX_ID"]) {
    delete env[k];
  }
  return env;
}

function runEntry(home: string, args: string[]): { child: ChildProcess; done: Promise<{ code: number | null; output: string }>; output: () => string } {
  fs.writeFileSync(path.join(home, "script.json"), JSON.stringify({ ollamaModels: ["llama3.2:latest"] }));
  const child = spawn(process.execPath, ["--import", "tsx", "--import", RECORDER, ENTRY, ...args], {
    cwd: REPO,
    env: childEnv(home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (d) => (output += String(d)));
  child.stderr!.on("data", (d) => (output += String(d)));
  const done = new Promise<{ code: number | null; output: string }>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  return { child, done, output: () => output };
}

function writeConfig(home: string, extra: Record<string, unknown>): void {
  const dir = path.join(home, ".automaton");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "automaton.json"),
    JSON.stringify({
      name: "identity-test",
      genesisPrompt: "g",
      creatorAddress: CREATOR,
      sandboxId: "",
      ollamaBaseUrl: "http://localhost:11434",
      dbPath: path.join(dir, "state.db"),
      ...extra,
    }),
  );
}

function writeEvmWallet(home: string, privateKey = generatePrivateKey()): string {
  const dir = path.join(home, ".automaton");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "wallet.json"), JSON.stringify({ chainType: "evm", privateKey, createdAt: "x" }), { mode: 0o600 });
  return privateKeyToAccount(privateKey).address;
}

function writeSolanaWallet(home: string): string {
  const dir = path.join(home, ".automaton");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kp = nacl.sign.keyPair();
  fs.writeFileSync(
    path.join(dir, "wallet.json"),
    JSON.stringify({ chainType: "solana", secretKey: bs58.encode(kp.secretKey), createdAt: "x" }),
    { mode: 0o600 },
  );
  return bs58.encode(kp.publicKey);
}

describe("--run and the wallet", () => {
  let home: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "identity-run-")));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("a missing wallet.json with automaton.json present refuses to start and creates nothing", { timeout: 60_000 }, async () => {
    const recorded = "0x" + "4".repeat(40);
    writeConfig(home, { walletAddress: recorded });
    const { code, output } = await runEntry(home, ["--run"]).done;
    expect(code).toBe(1);
    expect(output).toContain(`wallet.json is missing but automaton.json records address ${recorded}`);
    expect(output).toContain("A new identity is never created here");
    expect(fs.existsSync(path.join(home, ".automaton", "wallet.json"))).toBe(false);
  });

  it("an address that differs from automaton.json refuses to start", { timeout: 60_000 }, async () => {
    const actual = writeEvmWallet(home);
    writeConfig(home, { walletAddress: "0x" + "5".repeat(40) });
    const { code, output } = await runEntry(home, ["--run"]).done;
    expect(code).toBe(1);
    expect(output).toContain(`but wallet.json holds ${actual}`);
  });

  it("a chainType that differs from the wallet refuses to start, naming both", { timeout: 60_000 }, async () => {
    writeEvmWallet(home);
    writeConfig(home, { chainType: "solana" });
    const { code, output } = await runEntry(home, ["--run"]).done;
    expect(code).toBe(1);
    expect(output).toContain('chainType "solana" but wallet.json holds a evm key');
  });

  it("with no chainType in the config, the wallet's chain is used", { timeout: 60_000 }, async () => {
    const address = writeSolanaWallet(home);
    writeConfig(home, {});
    const run = runEntry(home, ["--run"]);
    const start = Date.now();
    const statePath = path.join(home, ".automaton", "state.db");
    // The identity rows are written before the first turn.
    while (!/\[WAKE UP\]/.test(run.output())) {
      if (run.child.exitCode !== null) throw new Error(`exited early:\n${run.output().slice(-3000)}`);
      if (Date.now() - start > 45_000) throw new Error(`no wake-up:\n${run.output().slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    run.child.kill("SIGTERM");
    expect((await run.done).code).toBe(0);
    const db = new Database(statePath, { readonly: true });
    try {
      const get = (k: string) => (db.prepare("SELECT value FROM identity WHERE key = ?").get(k) as { value: string }).value;
      expect(get("chainType")).toBe("solana");
      expect(get("address")).toBe(address);
    } finally {
      db.close();
    }
  });
});

describe("wallet creation", () => {
  let home: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "identity-init-")));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("four concurrent --init processes agree on one address and exactly one is new", { timeout: 90_000 }, async () => {
    const runs = Array.from({ length: 4 }, () => runEntry(home, ["--init"]).done);
    const results = await Promise.all(runs);
    const parsed = results.map((r) => {
      expect(r.code, r.output).toBe(0);
      const line = r.output.split("\n").find((l) => l.includes("isNew"));
      const json = JSON.parse(line!.slice(line!.indexOf("{")));
      return typeof json.message === "string" ? JSON.parse(json.message) : json;
    });
    expect(new Set(parsed.map((p) => p.address)).size).toBe(1);
    expect(parsed.filter((p) => p.isNew === true)).toHaveLength(1);
    const wallet = JSON.parse(fs.readFileSync(path.join(home, ".automaton", "wallet.json"), "utf8"));
    expect(privateKeyToAccount(wallet.privateKey).address).toBe(parsed[0].address);
  });
});

describe("wallet loading in-process", () => {
  const savedHome = process.env.HOME;
  let home: string;
  let wallet: typeof import("../identity/wallet.js");

  beforeAll(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "identity-unit-")));
    process.env.HOME = home;
    vi.resetModules();
    wallet = await import("../identity/wallet.js");
  });

  afterAll(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  beforeEach(() => {
    fs.rmSync(path.join(home, ".automaton"), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  });

  it("loadWallet throws WalletMissingError and creates nothing", () => {
    expect(() => wallet.loadWallet()).toThrow(wallet.WalletMissingError);
    expect(fs.existsSync(wallet.getWalletPath())).toBe(false);
  });

  it("a zero-byte wallet.json is a clear error and no new key is made", async () => {
    fs.writeFileSync(wallet.getWalletPath(), "");
    await expect(wallet.getWallet()).rejects.toThrow(/empty or corrupt.*restore it from backup \(no new key was created\)/);
    expect(() => wallet.loadWallet()).toThrow(wallet.WalletCorruptError);
    expect(fs.readFileSync(wallet.getWalletPath(), "utf8")).toBe("");
  });

  it("getWallet creates once, then loads the same identity", async () => {
    const first = await wallet.getWallet("evm");
    const second = await wallet.getWallet("evm");
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.chainIdentity.address).toBe(first.chainIdentity.address);
  });
});

describe("provisioning", () => {
  const savedHome = process.env.HOME;
  const realFetch = globalThis.fetch;
  let home: string;
  let bodies: Array<{ url: string; body: any }>;

  beforeAll(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "identity-provision-")));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterAll(() => {
    process.env.HOME = savedHome;
    globalThis.fetch = realFetch;
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  beforeEach(() => {
    bodies = [];
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(typeof input === "string" ? input : input.url);
      bodies.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/v1/auth/nonce")) return json({ nonce: "abcdefgh12345678" });
      if (url.endsWith("/v1/auth/verify")) return json({ access_token: "jwt" });
      if (url.endsWith("/v1/auth/api-keys")) return json({ key: "cnwy_k_NEW", key_prefix: "cnwy_k_NE" });
      return json({});
    }) as any;
  });

  it("writes the new key into automaton.json, so it replaces the old one at runtime", async () => {
    const dir = path.join(home, ".automaton");
    fs.mkdirSync(dir, { recursive: true });
    writeEvmWallet(home);
    fs.writeFileSync(path.join(dir, "automaton.json"), JSON.stringify({ name: "a", genesisPrompt: "g", conwayApiKey: "cnwy_k_OLD" }));
    const { provision } = await import("../identity/provision.js");
    const { loadConfig } = await import("../config.js");
    const result = await provision("https://api.conway.tech");
    expect(result.apiKey).toBe("cnwy_k_NEW");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).apiKey).toBe("cnwy_k_NEW");
    expect(loadConfig({})!.conwayApiKey).toBe("cnwy_k_NEW");
  });

  it("signs for the host it talks to; api.conway.tech keeps conway.tech", async () => {
    const { provision, siweDomainFor } = await import("../identity/provision.js");
    expect(siweDomainFor("https://api.conway.tech")).toBe("conway.tech");
    expect(siweDomainFor("https://api.staging.example")).toBe("api.staging.example");
    expect(siweDomainFor("https://api.staging.example:8443/x")).toBe("api.staging.example:8443");
    await provision("https://api.staging.example");
    const verify = bodies.find((b) => b.url.endsWith("/v1/auth/verify"))!;
    expect(verify.body.message).toMatch(/^api\.staging\.example wants you to sign in/);
    expect(verify.body.message).not.toContain("conway.tech wants you");
  });

  it("never creates a wallet", async () => {
    fs.rmSync(path.join(home, ".automaton", "wallet.json"), { force: true });
    const { provision } = await import("../identity/provision.js");
    await expect(provision("https://api.conway.tech")).rejects.toThrow(/No wallet/);
    expect(fs.existsSync(path.join(home, ".automaton", "wallet.json"))).toBe(false);
  });

  it("registerParent is gone", async () => {
    const mod = await import("../identity/provision.js");
    expect("registerParent" in mod).toBe(false);
  });
});
