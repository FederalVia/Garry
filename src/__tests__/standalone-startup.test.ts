/**
 * `--run` with no Conway account, through the real entrypoint with every
 * outbound request recorded (fixtures/fetch-recorder.mjs): which provider
 * setups start, which refuse, and that a standalone run sends nothing to
 * Conway and makes no blockchain call. A Conway key alone behaves as before.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const ENTRY = path.join(REPO, "src/index.ts");
const RECORDER = path.join(__dirname, "fixtures", "fetch-recorder.mjs");
const CREATOR = "0x" + "1".repeat(40);
const TEST_PRIVATE_KEY = "0x" + "cd".repeat(32);
const RPC_HOST = "rpc.stub.invalid";

interface Running {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
}

interface Recorded {
  method: string;
  host: string;
  path: string;
  jsonrpc: boolean;
  nonce?: boolean;
}

function writeHome(
  home: string,
  config: Record<string, unknown>,
  script: Record<string, unknown> = {},
  omit: string[] = [],
  opts: { wallet?: boolean } = {},
): void {
  const dir = path.join(home, ".automaton");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (opts.wallet !== false) {
    fs.writeFileSync(
      path.join(dir, "wallet.json"),
      JSON.stringify({ chainType: "evm", privateKey: TEST_PRIVATE_KEY, createdAt: "2026-01-01T00:00:00.000Z" }),
      { mode: 0o600 },
    );
  }
  fs.writeFileSync(
    path.join(dir, "automaton.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries({
          name: "standalone-test",
          genesisPrompt: "test",
          creatorAddress: CREATOR,
          sandboxId: "",
          dbPath: path.join(dir, "state.db"),
          ...config,
        }).filter(([k]) => !omit.includes(k)),
      ),
    ),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(home, "script.json"), JSON.stringify(script));
}

function start(home: string, command = "--run", extraEnv: NodeJS.ProcessEnv = {}): Running {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    RECORDER_LOG: path.join(home, "requests.log"),
    RECORDER_SCRIPT: path.join(home, "script.json"),
    AUTOMATON_RPC_URL: `https://${RPC_HOST}`,
  };
  for (const k of [
    "CONWAY_API_KEY",
    "CONWAY_API_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "OLLAMA_BASE_URL",
    "CONWAY_SANDBOX_ID",
    "AUTOMATON_SHUTDOWN_GRACE_MS",
  ]) {
    delete env[k];
  }
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ["--import", "tsx", "--import", RECORDER, ENTRY, command], {
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

function requests(home: string): Recorded[] {
  const p = path.join(home, "requests.log");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function waitUntil(cond: () => boolean, ms: number, what: string, run: Running): Promise<void> {
  const startMs = Date.now();
  while (!cond()) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`entrypoint exited while waiting for ${what}:\n${run.output().slice(-4000)}`);
    }
    if (Date.now() - startMs > ms) throw new Error(`timed out waiting for ${what}:\n${run.output().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function exitCode(run: Running, ms = 50_000): Promise<number | null> {
  const timer = setTimeout(() => run.child.kill("SIGKILL"), ms);
  try {
    return (await run.exited).code;
  } finally {
    clearTimeout(timer);
  }
}

async function stop(run: Running): Promise<number | null> {
  run.child.kill("SIGTERM");
  return exitCode(run);
}

const chatTo = (home: string, host: string) =>
  requests(home).filter((r) => r.host === host && /\/(chat\/completions|v1\/messages)$/.test(r.path));

describe("standalone startup matrix", () => {
  let home: string;
  let running: Running | undefined;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "standalone-startup-")));
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

  it("no AI provider: exits 1 naming the settings", { timeout: 60_000 }, async () => {
    writeHome(home, {});
    running = start(home);
    expect(await exitCode(running)).toBe(1);
    expect(running.output()).toContain("Mode: standalone (no Conway key)");
    expect(running.output()).toContain("No AI provider configured");
    expect(requests(home)).toEqual([]);
  });

  it("the documented steps (minimal config, no sandboxId, then --init) start and call the provider", { timeout: 120_000 }, async () => {
    writeHome(home, { providers: { openai: { apiKey: "sk-test-openai" } } }, {}, ["sandboxId"], { wallet: false });
    // Without --init first, --run says how to create the wallet.
    running = start(home);
    expect(await exitCode(running)).toBe(1);
    expect(running.output()).toContain("automaton --init");
    expect(running.output()).toContain("For a new agent");
    running = start(home, "--init");
    expect(await exitCode(running)).toBe(0);
    expect(fs.existsSync(path.join(home, ".automaton", "wallet.json"))).toBe(true);
    running = start(home);
    await waitUntil(() => chatTo(home, "api.openai.com").length >= 1, 45_000, "a chat request to OpenAI", running);
    expect(running.output()).not.toContain("NOT NULL");
    expect(await stop(running)).toBe(0);
  });

  it("no creatorAddress: exits 1 naming the field, before touching the database", { timeout: 60_000 }, async () => {
    writeHome(home, { providers: { openai: { apiKey: "sk-test-openai" } } }, {}, ["sandboxId", "creatorAddress"]);
    running = start(home);
    expect(await exitCode(running)).toBe(1);
    expect(running.output()).toContain("automaton.json has no creatorAddress");
    expect(running.output()).not.toContain("NOT NULL");
    expect(fs.existsSync(path.join(home, ".automaton", "state.db"))).toBe(false);
    expect(requests(home)).toEqual([]);
  });

  it('providers.mode "conway" with no key: exits 1', { timeout: 60_000 }, async () => {
    writeHome(home, { providers: { mode: "conway" }, openaiApiKey: "sk-test-openai" });
    running = start(home);
    expect(await exitCode(running)).toBe(1);
    expect(running.output()).toContain("No Conway API key found");
    expect(requests(home)).toEqual([]);
  });

  it("Ollama only: starts in standalone mode and stops cleanly", { timeout: 60_000 }, async () => {
    writeHome(home, { ollamaBaseUrl: "http://localhost:11434" }, { ollamaModels: ["llama3.2:latest"] });
    running = start(home);
    await waitUntil(() => chatTo(home, "localhost:11434").length >= 1, 45_000, "a chat request to Ollama", running);
    expect(running.output()).toMatch(/Mode: standalone \(no Conway key\)\. Providers: ollama \(http:\/\/localhost:11434/);
    expect(running.output()).toContain("Survival: fixed (normal)");
    expect(await stop(running)).toBe(0);
  });

  it("OpenAI only: starts and calls api.openai.com", { timeout: 60_000 }, async () => {
    writeHome(home, { openaiApiKey: "sk-test-openai" });
    running = start(home);
    await waitUntil(() => chatTo(home, "api.openai.com").length >= 1, 45_000, "a chat request to OpenAI", running);
    expect(running.output()).toContain("openai (key from automaton.json, https://api.openai.com/v1)");
    expect(chatTo(home, "api.openai.com")[0].path).toBe("/v1/chat/completions");
    expect(await stop(running)).toBe(0);
  });

  it("Anthropic only: starts, calls Anthropic and says orchestration is off", { timeout: 60_000 }, async () => {
    // The model tries a goal tool; with orchestration off it is not offered.
    writeHome(
      home,
      { anthropicApiKey: "sk-ant-test" },
      { chat: [{ tools: [{ name: "create_goal", args: { title: "t", description: "d" } }] }] },
    );
    running = start(home);
    await waitUntil(() => chatTo(home, "api.anthropic.com").length >= 2, 45_000, "two chat requests to Anthropic", running);
    expect(running.output()).toContain("Orchestration is off: planner and workers need an OpenAI-compatible or Ollama provider");
    expect(running.output()).toMatch(/inferenceModel gpt-5\.2 cannot be served by your providers; using claude-sonnet-4-6/);
    expect(running.output()).not.toMatch(/criticalModel .* using claude-sonnet/);
    expect(await stop(running)).toBe(0);
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(home, ".automaton", "state.db"), { readonly: true });
    try {
      expect((db.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n).toBe(0);
      // An unoffered name is recorded under a placeholder, with the refusal.
      const calls = db.prepare("SELECT name, result, error FROM tool_calls").all() as Array<{
        name: string;
        result: string;
        error: string | null;
      }>;
      expect(calls.some((c) => c.name !== "create_goal" && /Unknown tool: create_goal/.test(`${c.result} ${c.error}`))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("a hand-written config without providers.mode is pinned standalone: a Conway key stored later stays unused", { timeout: 180_000 }, async () => {
    writeHome(home, { openaiApiKey: "sk-test-openai" });
    const configPath = path.join(home, ".automaton", "automaton.json");
    running = start(home);
    await waitUntil(() => chatTo(home, "api.openai.com").length >= 1, 45_000, "a chat request to OpenAI", running);
    expect(await stop(running)).toBe(0);
    expect(running.output()).toContain('providers.mode saved as "standalone"');
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).providers).toEqual({ mode: "standalone" });

    // A key in ~/.automaton/config.json, then one in the environment as well.
    fs.writeFileSync(path.join(home, ".automaton", "config.json"), JSON.stringify({ apiKey: "cnwy_k_from_config_json" }));
    for (const env of [{}, { CONWAY_API_KEY: "cnwy_k_from_env" }]) {
      fs.rmSync(path.join(home, "requests.log"), { force: true });
      running = start(home, "--run", env);
      await waitUntil(() => chatTo(home, "api.openai.com").length >= 1, 45_000, "a chat request to OpenAI", running);
      expect(await stop(running)).toBe(0);
      const out = running.output();
      expect(out).toContain("Mode: standalone (set in providers.mode)");
      expect(out).toContain("conway key present but unused");
      expect(out).toContain("Daily AI cap: at most 200c ($2.00)");
      expect(requests(home).filter((r) => r.host !== "api.openai.com")).toEqual([]);
    }
  });

  it("an OpenAI-compatible base URL with a priced model: chat goes to that host", { timeout: 60_000 }, async () => {
    writeHome(home, {
      providers: {
        openai: {
          apiKey: "sk-test-compatible",
          baseUrl: "https://llm.example.test/v1",
          models: [{ id: "house-model", inputUsdPerM: 1, outputUsdPerM: 2 }],
        },
      },
    });
    running = start(home);
    await waitUntil(() => chatTo(home, "llm.example.test").length >= 1, 45_000, "a chat request to the custom host", running);
    expect(chatTo(home, "llm.example.test")[0].path).toBe("/v1/chat/completions");
    expect(chatTo(home, "api.openai.com")).toEqual([]);
    expect(await stop(running)).toBe(0);
  });

  it("a Conway key alone: Conway mode, registration and credit balance as before", { timeout: 60_000 }, async () => {
    writeHome(home, { conwayApiKey: "cnwy_k_test_only", conwayApiUrl: "https://api.conway.invalid" });
    running = start(home);
    const conway = () => requests(home).filter((r) => r.host === "api.conway.invalid");
    await waitUntil(
      () => conway().some((r) => r.path === "/v1/chat/completions"),
      45_000,
      "a Conway chat request",
      running,
    );
    expect(running.output()).toContain("Mode: conway (Conway key from automaton.json)");
    expect(conway().some((r) => r.method === "POST" && r.path === "/v1/automatons/register")).toBe(true);
    expect(conway().some((r) => r.path === "/v1/credits/balance")).toBe(true);
    expect(await stop(running)).toBe(0);
  });
});

describe("standalone outbound requests", () => {
  let home: string;
  let running: Running | undefined;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "standalone-egress-")));
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

  it("two turns and a heartbeat tick send nothing to Conway and nothing to a chain", { timeout: 90_000 }, async () => {
    // conwayApiUrl stays at its default, so a stray Conway call would show.
    writeHome(
      home,
      { openaiApiKey: "sk-test-openai" },
      {
        chat: [
          { tools: [{ name: "exec", args: { command: 'echo one > "$HOME/turn1"' } }] },
          { tools: [{ name: "exec", args: { command: 'echo two > "$HOME/turn2"' } }] },
        ],
      },
    );
    running = start(home);
    await waitUntil(() => fs.existsSync(path.join(home, "turn2")), 60_000, "the second turn's tool", running);
    await waitUntil(() => /Daemon started/.test(running!.output()), 10_000, "the heartbeat", running);
    // Let the first heartbeat tick finish its tasks.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await stop(running)).toBe(0);

    const all = requests(home);
    expect(all.filter((r) => r.host === "api.openai.com").length).toBeGreaterThanOrEqual(2);
    expect(all.filter((r) => /(^|\.)conway\.tech(:\d+)?$/.test(r.host))).toEqual([]);
    expect(all.filter((r) => r.jsonrpc)).toEqual([]);
    expect(
      all.filter((r) => ["mainnet.base.org", "api.mainnet-beta.solana.com", RPC_HOST].includes(r.host)),
    ).toEqual([]);
    expect(all.filter((r) => r.method === "NODE")).toEqual([]);
    expect(running.output()).toContain("Relay: off. Payments: off.");
  });

  it("a self-hosted loopback relay works in standalone, with the configured protocol, and nothing else is contacted", { timeout: 90_000 }, async () => {
    // relay.conwayCompat differs from the URL default (strict for a non-conway.tech relay),
    // so the poll shows whether startup passed the relay options to the client.
    writeHome(home, {
      openaiApiKey: "sk-test-openai",
      socialRelayUrl: "http://127.0.0.1:8787",
      relay: { conwayCompat: true },
    });
    running = start(home);
    const relay = () => requests(home).filter((r) => r.host === "127.0.0.1:8787");
    await waitUntil(() => relay().some((r) => r.path === "/v1/messages/poll"), 60_000, "a relay poll", running);
    expect(await stop(running)).toBe(0);

    const output = running.output();
    expect(output).toContain("Relay: http://127.0.0.1:8787 (conway, accepts automaton/1 and conway). Payments: off.");
    expect(output).toContain("Social relay: http://127.0.0.1:8787 (conway, accepts automaton/1 and conway)");
    expect(relay().filter((r) => r.path === "/v1/messages/poll").every((r) => !r.nonce)).toBe(true);
    const all = requests(home);
    expect(all.filter((r) => !["api.openai.com", "127.0.0.1:8787"].includes(r.host))).toEqual([]);
    expect(all.filter((r) => r.jsonrpc)).toEqual([]);
  });

  it("the entrypoint clamps the daily cap and leaves earlier x402 payments unreconciled", { timeout: 90_000 }, async () => {
    writeHome(
      home,
      { openaiApiKey: "sk-test-openai", treasuryPolicy: { maxInferenceDailyCents: 100_000 } },
      { chat: [{ tools: [{ name: "check_inference_spending", args: {} }] }] },
    );
    // A payment an earlier run left without an answer.
    const { createDatabase } = await import("../state/database.js");
    const seeded = createDatabase(path.join(home, ".automaton", "state.db"));
    const now = Date.now();
    seeded.raw
      .prepare(
        `INSERT INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents, debits_credits,
           counterparty, dedupe_key, origin_type, x402_nonce, created_at_ms, updated_at_ms)
         VALUES ('l1', 'k1', 'x402_payment', 'x402', 'unknown', 5, 0, 'api.example', 'd1', 'tool', '0xabc', ?, ?)`,
      )
      .run(now, now);
    seeded.close();

    running = start(home);
    await waitUntil(() => chatTo(home, "api.openai.com").length >= 2, 60_000, "two chat requests", running);
    expect(await stop(running)).toBe(0);

    const out = running.output();
    expect(out).toContain("!!! Daily AI cap clamped !!!");
    expect(out).toContain("1 x402 payment(s) from an earlier run stay unreconciled while payments are off.");
    const all = requests(home);
    expect(all.filter((r) => r.jsonrpc)).toEqual([]);
    expect(all.filter((r) => /(^|\.)conway\.tech(:\d+)?$/.test(r.host))).toEqual([]);
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(home, ".automaton", "state.db"), { readonly: true });
    try {
      const row = db.prepare("SELECT result FROM tool_calls WHERE name = 'check_inference_spending'").get() as
        | { result: string }
        | undefined;
      expect(row?.result).toContain("of 200c cap");
    } finally {
      db.close();
    }
  });
});
