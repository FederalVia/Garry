/**
 * `--run` startup: with no usable config and no terminal it exits 1 with a
 * clear message instead of hanging in the wizard and exiting 0; a second
 * instance on the same state database exits 1 naming the holder. A child
 * with only genesis.json gets its config built non-interactively. Through
 * the real entrypoint (network stubbed): startup recovers stranded inbox
 * claims, and SIGTERM mid-turn lets the running tool finish, skips the rest
 * and exits 0. Every config written here gets a wallet.json first: --run
 * never creates an identity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { acquireInstanceLock } from "../state/instance-lock.js";
import { createDatabase } from "../state/database.js";
import { SHUTDOWN_SKIP_ERROR } from "../agent/loop.js";

const REPO = path.resolve(__dirname, "../..");
const ENTRY = path.join(REPO, "src/index.ts");
const CREATOR = "0x" + "1".repeat(40);
const PARENT = "0x" + "3".repeat(40);
const TEST_PRIVATE_KEY = "0x" + "ab".repeat(32);

/** --run loads wallet.json and never creates one, so tests write it first. */
function writeTestWallet(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "wallet.json"),
    JSON.stringify({ chainType: "evm", privateKey: TEST_PRIVATE_KEY, createdAt: "2026-01-01T00:00:00.000Z" }),
    { mode: 0o600 },
  );
}

function runEntrypoint(home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    for (const k of ["CONWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CONWAY_SANDBOX_ID"]) delete env[k];
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, "--run"], {
      cwd: REPO,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (d) => (output += String(d)));
    child.stderr!.on("data", (d) => (output += String(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`--run did not exit within 30 s:\n${output}`));
    }, 30_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe("--run startup", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "run-startup-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("with no config, no genesis.json and no terminal, exits 1 with a clear message", { timeout: 60_000 }, async () => {
    const { code, output } = await runEntrypoint(home);
    expect(code).toBe(1);
    expect(output).toContain("no terminal for the setup wizard");
    expect(output).not.toContain("Chain type");
  });

  it("with a truncated automaton.json, exits 1 saying it cannot be read", { timeout: 60_000 }, async () => {
    fs.mkdirSync(path.join(home, ".automaton"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".automaton", "automaton.json"), '{"name":"parent","sandboxId":"sb');
    const { code, output } = await runEntrypoint(home);
    expect(code).toBe(1);
    expect(output).toContain("cannot be read");
    expect(output).not.toContain("First-run setup");
  });

  it("refuses a second instance on the same state database, naming the holder's pid", { timeout: 60_000 }, async () => {
    const dir = path.join(home, ".automaton");
    fs.mkdirSync(dir, { mode: 0o700 });
    writeTestWallet(dir);
    fs.writeFileSync(
      path.join(dir, "automaton.json"),
      JSON.stringify({
        name: "solo",
        genesisPrompt: "g",
        creatorAddress: CREATOR,
        conwayApiKey: "cnwy_k_test_only",
        sandboxId: "",
        dbPath: path.join(dir, "state.db"),
      }),
      { mode: 0o600 },
    );
    const lock = acquireInstanceLock(path.join(dir, "state.db.lock"));
    try {
      const { code, output } = await runEntrypoint(home);
      expect(code).toBe(1);
      expect(output).toContain(`(pid ${process.pid}) is already running`);
      expect(output).toContain("state.db.lock");
      // It stopped before opening the database.
      expect(fs.existsSync(path.join(dir, "state.db"))).toBe(false);
    } finally {
      lock.release();
    }
  });
});

const FETCH_STUB = path.join(__dirname, "fixtures", "fetch-stub.mjs");

interface RunningEntrypoint {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
}

/** `--run` with fetch stubbed by the preloaded fixture; chat replies follow `chat`. */
function startStubbedRun(home: string, chat: unknown[], credits = 50_000): RunningEntrypoint {
  fs.writeFileSync(path.join(home, "script.json"), JSON.stringify({ chat, credits }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    STUB_LOG: path.join(home, "stub.log"),
    STUB_SCRIPT: path.join(home, "script.json"),
    AUTOMATON_RPC_URL: "https://rpc.stub.invalid",
  };
  for (const k of [
    "CONWAY_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CONWAY_SANDBOX_ID",
    "AUTOMATON_SHUTDOWN_GRACE_MS",
  ]) {
    delete env[k];
  }
  const child = spawn(process.execPath, ["--import", "tsx", "--import", FETCH_STUB, ENTRY, "--run"], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (d) => (output += String(d)));
  child.stderr!.on("data", (d) => (output += String(d)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, exited, output: () => output };
}

async function waitUntil(cond: () => boolean, ms: number, what: string, run: RunningEntrypoint): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`entrypoint exited while waiting for ${what}:\n${run.output().slice(-4000)}`);
    }
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}:\n${run.output().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function writeRunConfig(home: string): string {
  const dir = path.join(home, ".automaton");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeTestWallet(dir);
  fs.writeFileSync(
    path.join(dir, "automaton.json"),
    JSON.stringify({
      name: "lifecycle",
      genesisPrompt: "test",
      creatorAddress: CREATOR,
      sandboxId: "",
      conwayApiUrl: "https://api.conway.invalid",
      conwayApiKey: "cnwy_k_test_only",
      socialRelayUrl: "",
      dbPath: path.join(dir, "state.db"),
    }),
    { mode: 0o600 },
  );
  return path.join(dir, "state.db");
}

function chatRequests(home: string): number {
  const logPath = path.join(home, "stub.log");
  if (!fs.existsSync(logPath)) return 0;
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.includes('"chat"')).length;
}

describe("--run lifecycle through the real entrypoint", () => {
  let home: string;
  let running: RunningEntrypoint | undefined;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-lifecycle-")));
    running = undefined;
  });

  afterEach(async () => {
    const child = running?.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await running!.exited;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("recovers stranded inbox claims at startup", { timeout: 90_000 }, async () => {
    const dbPath = writeRunConfig(home);
    const seed = createDatabase(dbPath);
    const insert = seed.raw.prepare(
      `INSERT INTO inbox_messages (id, from_address, content, received_at, status, retry_count, max_retries)
       VALUES (?, ?, ?, datetime('now'), 'in_progress', ?, 3)`,
    );
    const from = "0x" + "3".repeat(40);
    insert.run("m-retry", from, "hello", 1);
    insert.run("m-exhausted", from, "hello", 3);
    insert.run("m-answered", from, "hello", 0);
    seed.setKV("inbox.tools_started", JSON.stringify({ turnId: "t-crashed", ids: ["m-answered"] }));
    seed.close();

    // In debt: the loop runs no turn, so nothing touches the rows after recovery.
    running = startStubbedRun(home, [], -500);
    await waitUntil(() => /Automaton is dead/.test(running!.output()), 60_000, "the loop to stop for funding", running);
    expect(running.output()).toContain("Recovered stranded inbox claims: 1 re-queued, 1 failed (retries used up), 1 already answered.");
    running.child.kill("SIGTERM");
    expect((await running.exited).code).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT id, status FROM inbox_messages ORDER BY id").all();
      expect(rows).toEqual([
        { id: "m-answered", status: "processed" },
        { id: "m-exhausted", status: "failed" },
        { id: "m-retry", status: "received" },
      ]);
      expect(db.prepare("SELECT value FROM kv WHERE key = 'inbox.tools_started'").get()).toBeUndefined();
    } finally {
      db.close();
    }
    expect(chatRequests(home)).toBe(0);
  });

  it("on SIGTERM mid-turn, lets the running tool finish, records the rest as skipped and exits 0", { timeout: 90_000 }, async () => {
    const dbPath = writeRunConfig(home);
    running = startStubbedRun(home, [
      {
        tools: [
          { name: "exec", args: { command: 'echo started > "$HOME/m0"; sleep 3; echo one > "$HOME/m1"' } },
          { name: "exec", args: { command: 'echo two > "$HOME/m2"' } },
        ],
      },
      { text: "should never be asked" },
    ]);
    await waitUntil(() => fs.existsSync(path.join(home, "m0")), 60_000, "the first tool to start", running);
    running.child.kill("SIGTERM");
    const { code } = await running.exited;
    expect(code).toBe(0);

    expect(fs.existsSync(path.join(home, "m1"))).toBe(true);
    expect(fs.existsSync(path.join(home, "m2"))).toBe(false);
    const db = new Database(dbPath, { readonly: true });
    try {
      const calls = db.prepare("SELECT name, error, result FROM tool_calls ORDER BY rowid").all() as {
        name: string;
        error: string | null;
        result: string;
      }[];
      expect(calls.map((c) => [c.name, c.error])).toEqual([
        ["exec", null],
        ["exec", SHUTDOWN_SKIP_ERROR],
      ]);
      expect(calls[0].result).toContain("exit_code: 0");
      const state = db.prepare("SELECT value FROM kv WHERE key = 'agent_state'").get() as { value: string };
      expect(state.value).toBe("sleeping");
    } finally {
      db.close();
    }
    expect(chatRequests(home)).toBe(1);
  });
});

describe("bootstrapConfigFromGenesis", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-"));
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".automaton"), { mode: 0o700 });
    // Modules read HOME when loaded.
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeGenesis(g: Record<string, unknown>): void {
    fs.writeFileSync(path.join(home, ".automaton", "genesis.json"), JSON.stringify(g));
  }

  function stubs() {
    const address = "0x" + "2".repeat(40);
    return {
      getWallet: vi.fn(async () => ({
        account: {} as any,
        chainIdentity: { address, chainType: "evm" } as any,
        chainType: "evm" as const,
        isNew: false,
      })),
      provision: vi.fn(async () => ({ apiKey: "cnwy_k_provisioned", walletAddress: address, keyPrefix: "cnwy_k_pr" })),
      detectEnvironment: () => ({ sandboxId: "sbx-child" }),
    };
  }

  it("writes automaton.json with the genesis name and parent, and keeps an existing SOUL.md", async () => {
    writeGenesis({
      name: "child-1",
      genesisPrompt: "Build things.",
      creatorAddress: CREATOR,
      parentAddress: PARENT,
      chainType: "evm",
    });
    fs.writeFileSync(path.join(home, ".automaton", "SOUL.md"), "evolved soul");
    const { bootstrapConfigFromGenesis } = await import("../setup/genesis-bootstrap.js");
    const deps = stubs();
    const config = await bootstrapConfigFromGenesis(deps);

    const saved = JSON.parse(fs.readFileSync(path.join(home, ".automaton", "automaton.json"), "utf8"));
    expect(saved.name).toBe("child-1");
    expect(saved.parentAddress).toBe(PARENT);
    expect(saved.sandboxId).toBe("sbx-child");
    expect(saved.conwayApiKey).toBe("cnwy_k_provisioned");
    expect(config.name).toBe("child-1");
    expect(deps.provision).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(home, ".automaton", "SOUL.md"), "utf8")).toBe("evolved soul");
    expect(fs.existsSync(path.join(home, ".automaton", "heartbeat.yml"))).toBe(true);
  });

  it("a genesis.json without genesisPrompt throws and writes nothing", async () => {
    writeGenesis({ name: "child-2", creatorAddress: CREATOR, parentAddress: PARENT });
    const { bootstrapConfigFromGenesis } = await import("../setup/genesis-bootstrap.js");
    const deps = stubs();
    await expect(bootstrapConfigFromGenesis(deps)).rejects.toThrow(/genesisPrompt/);
    expect(deps.provision).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".automaton", "automaton.json"))).toBe(false);
  });

  it("a failed key provision throws and writes no config", async () => {
    writeGenesis({ name: "c", genesisPrompt: "g", creatorAddress: CREATOR, parentAddress: PARENT });
    const { bootstrapConfigFromGenesis } = await import("../setup/genesis-bootstrap.js");
    const deps = stubs();
    deps.provision.mockRejectedValueOnce(new Error("SIWE refused"));
    await expect(bootstrapConfigFromGenesis(deps)).rejects.toThrow(/SIWE refused/);
    expect(fs.existsSync(path.join(home, ".automaton", "automaton.json"))).toBe(false);
  });
});
