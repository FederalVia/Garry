import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { RelayEnvError, isLoopbackHost, limitVariable, parseRelayEnv, startupWarnings } from "../src/env.js";
import { evmSigner, request, tempDir } from "./helpers.js";

const HOME = "/home/someone";

describe("parseRelayEnv", () => {
  it("defaults: loopback host, port 8787, 7 days, legacy off, open, XDG-style DB path", () => {
    const c = parseRelayEnv({}, HOME);
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8787);
    expect(c.options).toEqual({
      dbPath: "/home/someone/.local/state/automaton-relay/relay.db",
      retentionMs: 168 * 3_600_000,
      legacyConway: false,
      trustProxy: false,
      accessLog: false,
      allowedSenders: undefined,
      allowedRecipients: undefined,
      limits: {},
    });
    expect(isLoopbackHost(c.host)).toBe(true);
  });

  it("uses XDG_STATE_HOME when it is absolute", () => {
    expect(parseRelayEnv({ XDG_STATE_HOME: "/var/state" }, HOME).options.dbPath).toBe(
      "/var/state/automaton-relay/relay.db",
    );
    expect(parseRelayEnv({ XDG_STATE_HOME: "relative" }, HOME).options.dbPath).toBe(
      "/home/someone/.local/state/automaton-relay/relay.db",
    );
    expect(parseRelayEnv({ RELAY_DB: "/data/relay.db" }, HOME).options.dbPath).toBe("/data/relay.db");
  });

  it("reads every setting", () => {
    const alice = evmSigner();
    const c = parseRelayEnv(
      {
        RELAY_HOST: "0.0.0.0",
        RELAY_PORT: "9000",
        RELAY_RETENTION_HOURS: "24",
        RELAY_LEGACY_CONWAY: "1",
        RELAY_TRUST_PROXY: "true",
        RELAY_ACCESS_LOG: "1",
        RELAY_ALLOWED_SENDERS: ` ${alice.address.toUpperCase().replace("0X", "0x")} ,`,
        RELAY_ALLOWED_RECIPIENTS: alice.address,
        RELAY_LIMIT_SENDER_PER_HOUR: "50",
        RELAY_LIMIT_MAX_BODY_BYTES: "1000000",
      },
      HOME,
    );
    expect(c.host).toBe("0.0.0.0");
    expect(isLoopbackHost(c.host)).toBe(false);
    expect(c.port).toBe(9000);
    expect(c.options.retentionMs).toBe(24 * 3_600_000);
    expect(c.options.legacyConway).toBe(true);
    expect(c.options.trustProxy).toBe(true);
    expect(c.options.accessLog).toBe(true);
    expect(c.options.allowedSenders).toEqual([alice.address]);
    expect(c.options.allowedRecipients).toEqual([alice.address]);
    expect(c.options.limits).toEqual({ senderPerHour: 50, maxBodyBytes: 1_000_000 });
  });

  it("has one RELAY_LIMIT_* variable per limit", () => {
    const names = (Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]).map(limitVariable);
    expect(names).toEqual([
      "RELAY_LIMIT_MAX_BODY_BYTES",
      "RELAY_LIMIT_MAX_POLL_BODY_BYTES",
      "RELAY_LIMIT_IP_PER_MINUTE",
      "RELAY_LIMIT_IP_STORED_PER_HOUR",
      "RELAY_LIMIT_SENDER_PER_MINUTE",
      "RELAY_LIMIT_SENDER_PER_HOUR",
      "RELAY_LIMIT_RECIPIENT_PER_HOUR",
      "RELAY_LIMIT_RECIPIENT_MAILBOX",
      "RELAY_LIMIT_TOTAL_MESSAGES",
      "RELAY_LIMIT_TOTAL_BYTES",
      "RELAY_LIMIT_POLL_PER_MINUTE",
    ]);
  });

  it("RELAY_LIMIT_TOTAL_BYTES may go past a billion; other limits may not", () => {
    expect(parseRelayEnv({ RELAY_LIMIT_TOTAL_BYTES: "5000000000" }, HOME).options.limits).toEqual({
      totalBytes: 5_000_000_000,
    });
    expect(() => parseRelayEnv({ RELAY_LIMIT_TOTAL_MESSAGES: "5000000000" }, HOME)).toThrow(RelayEnvError);
  });

  it.each([
    ["RELAY_PORT", "0"],
    ["RELAY_PORT", "70000"],
    ["RELAY_PORT", "80a"],
    ["RELAY_RETENTION_HOURS", "0"],
    ["RELAY_RETENTION_HOURS", "0.5"],
    ["RELAY_LIMIT_SENDER_PER_HOUR", "-1"],
    ["RELAY_LIMIT_TOTAL_MESSAGES", "lots"],
    ["RELAY_LEGACY_CONWAY", "yes"],
    ["RELAY_TRUST_PROXY", "2"],
    ["RELAY_ALLOWED_SENDERS", "0x123"],
    ["RELAY_HOST", "bad host"],
  ])("refuses %s=%s and names the variable", (name, value) => {
    let caught: unknown;
    try {
      parseRelayEnv({ [name]: value }, HOME);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RelayEnvError);
    expect((caught as RelayEnvError).variable).toBe(name);
    expect((caught as Error).message.startsWith(`${name}:`)).toBe(true);
  });
});

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function runMain(env: Record<string, string>) {
  // Only the variables the relay reads, plus PATH: nothing from the real HOME.
  const child = spawn(process.execPath, ["--import", "tsx", MAIN], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, out: () => stdout, err: () => stderr };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("automaton-relay entry point", () => {
  it("exits 1 naming the variable when a setting is invalid", async () => {
    const home = tempDir();
    const run = runMain({ HOME: home, RELAY_PORT: "not-a-port" });
    expect(await run.exited).toBe(1);
    expect(run.err()).toContain("RELAY_PORT");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("starts, creates the DB directory privately, serves /healthz and stops cleanly on SIGTERM", async () => {
    const home = tempDir();
    const port = await freePort();
    const run = runMain({ HOME: home, RELAY_PORT: String(port) });
    try {
      const deadline = Date.now() + 20_000;
      while (!run.out().includes("listening on") && Date.now() < deadline) {
        if (run.child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(run.out()).toContain(`listening on http://127.0.0.1:${port}`);
      const dbDir = path.join(home, ".local", "state", "automaton-relay");
      expect(fs.statSync(dbDir).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(path.join(dbDir, "relay.db"))).toBe(true);
      const health = await request(`http://127.0.0.1:${port}`, "/healthz", { method: "GET" });
      expect(health.json.ok).toBe(true);
      run.child.kill("SIGTERM");
      expect(await run.exited).toBe(0);
    } finally {
      if (run.child.exitCode === null) run.child.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("startupWarnings", () => {
  const ADDR = "0x" + "a".repeat(40);
  it("loopback with no proxy: none", () => {
    expect(startupWarnings(parseRelayEnv({}, HOME))).toEqual([]);
  });

  it("reachable from outside (non-loopback host or trusted proxy) with no allowlist: warns about 503 and disk", () => {
    for (const env of [{ RELAY_HOST: "0.0.0.0" }, { RELAY_TRUST_PROXY: "1" }]) {
      const w = startupWarnings(parseRelayEnv(env, HOME));
      expect(w.some((l) => /no RELAY_ALLOWED_SENDERS or RELAY_ALLOWED_RECIPIENTS/.test(l) && /503/.test(l))).toBe(true);
    }
    const allowed = startupWarnings(parseRelayEnv({ RELAY_TRUST_PROXY: "1", RELAY_ALLOWED_RECIPIENTS: ADDR }, HOME));
    expect(allowed.some((l) => /RELAY_ALLOWED/.test(l))).toBe(false);
  });

  it("warns when the same user has an agent state folder", () => {
    const w = startupWarnings(parseRelayEnv({}, HOME), "/home/someone/.automaton");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/separate user/);
  });
});
