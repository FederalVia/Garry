/**
 * The social relay can be turned off and stays off: in standalone a missing
 * relay URL means no relay, an explicit "" survives a reload and a save, an
 * explicit URL is kept, and Conway mode keeps its default. The first run
 * after the genesis bootstrap sees the same merged config as every restart.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntime } from "../providers/mode.js";

const REPO = path.resolve(__dirname, "../..");
const ENTRY = path.join(REPO, "src/index.ts");
const RECORDER = path.join(__dirname, "fixtures", "fetch-recorder.mjs");

describe("relay defaults", () => {
  const savedHome = process.env.HOME;
  let home: string;
  let cfg: typeof import("../config.js");

  beforeAll(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "config-relay-")));
    process.env.HOME = home;
    vi.resetModules();
    cfg = await import("../config.js");
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

  const file = () => path.join(home, ".automaton", "automaton.json");
  const write = (obj: Record<string, unknown>) =>
    fs.writeFileSync(file(), JSON.stringify({ name: "a", genesisPrompt: "g", creatorAddress: "0x" + "1".repeat(40), ...obj }));

  it("standalone: a missing relay URL is no relay", () => {
    write({ openaiApiKey: "sk" });
    const config = cfg.loadConfig({})!;
    expect(config.socialRelayUrl).toBe("");
    expect(resolveRuntime(config).features.relay).toBe(false);
  });

  it("standalone: an explicit URL is kept and turns the relay on", () => {
    write({ openaiApiKey: "sk", socialRelayUrl: "https://relay.example" });
    const config = cfg.loadConfig({})!;
    expect(config.socialRelayUrl).toBe("https://relay.example");
    expect(resolveRuntime(config).features.relay).toBe(true);
  });

  it("standalone: Conway's relay URL and payee as older saves wrote them count as absent", () => {
    write({
      openaiApiKey: "sk",
      socialRelayUrl: "https://social.conway.tech",
      treasuryPolicy: { x402AllowedDomains: ["conway.tech"], maxSingleTransferCents: 4000 },
    });
    const config = cfg.loadConfig({})!;
    expect(config.socialRelayUrl).toBe("");
    expect(config.treasuryPolicy!.x402AllowedDomains).toEqual([]);
    expect(config.treasuryPolicy!.maxSingleTransferCents).toBe(4000);
    expect(resolveRuntime(config).features.relay).toBe(false);
    // The same file in Conway mode is read as before.
    write({ conwayApiKey: "cnwy", socialRelayUrl: "https://social.conway.tech", treasuryPolicy: { x402AllowedDomains: ["conway.tech"] } });
    const conway = cfg.loadConfig({})!;
    expect(conway.socialRelayUrl).toBe("https://social.conway.tech");
    expect(conway.treasuryPolicy!.x402AllowedDomains).toEqual(["conway.tech"]);
  });

  it("standalone: Conway's relay is used only through providers.relayUrl, which a save does not flatten", () => {
    write({ openaiApiKey: "sk", providers: { relayUrl: "https://social.conway.tech" } });
    const config = cfg.loadConfig({})!;
    expect(config.socialRelayUrl).toBe("https://social.conway.tech");
    expect(resolveRuntime(config).features.relay).toBe(true);
    cfg.saveConfig(config);
    const disk = JSON.parse(fs.readFileSync(file(), "utf8"));
    expect(disk.socialRelayUrl).toBeUndefined();
    expect(disk.providers.relayUrl).toBe("https://social.conway.tech");
  });

  it("Conway mode keeps its default relay", () => {
    write({ conwayApiKey: "cnwy" });
    expect(cfg.loadConfig({})!.socialRelayUrl).toBe("https://social.conway.tech");
  });

  it('an explicit "" survives a reload and a save, in both modes', () => {
    write({ conwayApiKey: "cnwy", socialRelayUrl: "" });
    const config = cfg.loadConfig({})!;
    expect(config.socialRelayUrl).toBe("");
    cfg.saveConfig(config);
    expect(cfg.loadConfig({})!.socialRelayUrl).toBe("");
    write({ openaiApiKey: "sk", socialRelayUrl: "" });
    expect(cfg.loadConfig({})!.socialRelayUrl).toBe("");
  });
});

describe("first run after the genesis bootstrap", () => {
  let home: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "config-relay-genesis-")));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("re-reads automaton.json, so the first session has the merged config", { timeout: 60_000 }, async () => {
    const dir = path.join(home, ".automaton");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "genesis.json"),
      JSON.stringify({
        name: "child",
        genesisPrompt: "Build things.",
        creatorAddress: "0x" + "1".repeat(40),
        parentAddress: "0x" + "3".repeat(40),
        chainType: "evm",
      }),
    );
    fs.writeFileSync(path.join(home, "script.json"), "{}");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      RECORDER_LOG: path.join(home, "requests.log"),
      RECORDER_SCRIPT: path.join(home, "script.json"),
    };
    for (const k of ["CONWAY_API_KEY", "CONWAY_API_URL", "OPENAI_API_KEY", "OLLAMA_BASE_URL", "CONWAY_SANDBOX_ID"]) delete env[k];
    const child = spawn(process.execPath, ["--import", "tsx", "--import", RECORDER, ENTRY, "--run"], {
      cwd: REPO,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (d) => (output += String(d)));
    child.stderr!.on("data", (d) => (output += String(d)));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const start = Date.now();
    try {
      while (!/Mode: /.test(output)) {
        if (child.exitCode !== null) throw new Error(`exited early:\n${output.slice(-3000)}`);
        if (Date.now() - start > 45_000) throw new Error(`no mode line:\n${output.slice(-3000)}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      // The wizard/genesis object has no socialRelayUrl; the re-read config has the default.
      expect(output).toMatch(/Mode: conway \(Conway key from automaton\.json\).*Relay: https:\/\/social\.conway\.tech/);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });
});
