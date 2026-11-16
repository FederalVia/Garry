/**
 * Tunnel supervision with a fake tunnel binary: URL parsing from both
 * output shapes, strict candidate validation, restarts with backoff and a
 * bounded crash loop, stop and forced exit leaving no process, abort, single
 * flight, draining a chatty tunnel, and the tunnel's environment.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TunnelSupervisor, findTunnelUrl, type TunnelSpec } from "../../edge/tunnel.js";
import { EXPOSURES_KV, TUNNEL_PIDS_KV, TunnelExposer } from "../../edge/ports.js";
import { liveProcessGroups } from "../../runtime/process-group.js";
import { clearRegisteredSecrets, registerSecret } from "../../security/secret-redaction.js";
import { StructuredLogger } from "../../observability/logger.js";
import type { ResolvedPortsConfig } from "../../edge/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "..", "fixtures", "edge", "fake-tunnel.mjs");
const RUNNER = path.join(HERE, "..", "fixtures", "edge", "exit-runner.ts");
const REPO = path.resolve(HERE, "..", "..", "..");
const CF = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const NGROK = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|dev|io)/;

let dir: string;
const sups: TunnelSupervisor[] = [];
const exposers: TunnelExposer[] = [];

function spec(args: string[], over: Partial<TunnelSpec> = {}): TunnelSpec {
  return {
    command: process.execPath,
    args: [FAKE, ...args],
    urlPattern: CF,
    env: { PATH: process.env.PATH ?? "" },
    startTimeoutMs: 10_000,
    restart: { maxRestarts: 5, windowMs: 600_000, backoffMs: [50, 50, 50] },
    ...over,
  };
}

function sup(port: number, s: TunnelSpec, opts: ConstructorParameters<typeof TunnelSupervisor>[2] = {}): TunnelSupervisor {
  const t = new TunnelSupervisor(port, s, opts);
  sups.push(t);
  return t;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 8_000, step = 25): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, step));
  }
}

function captureWarnings(): string[] {
  const lines: string[] = [];
  StructuredLogger.setSink((e) => {
    if (e.level === "warn") lines.push(e.message);
  });
  return lines;
}

function readPids(file: string): { pid: number; grandchild: number | null } {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-tunnel-"));
});

afterEach(async () => {
  StructuredLogger.resetSink();
  await Promise.allSettled(sups.splice(0).map((s) => s.stop(200)));
  await Promise.allSettled(exposers.splice(0).map((e) => e.close(2_000)));
  clearRegisteredSecrets();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("findTunnelUrl security", () => {
  it("accepts only an https origin matching the pattern in full", () => {
    expect(findTunnelUrl("|  https://abc-1.trycloudflare.com   |", CF)).toBe("https://abc-1.trycloudflare.com");
    expect(findTunnelUrl('{"url":"https://x1.ngrok-free.app"}', NGROK)).toBe("https://x1.ngrok-free.app");
    expect(findTunnelUrl("https://abc.trycloudflare.com/", CF)).toBe("https://abc.trycloudflare.com");
    for (const bad of [
      "http://abc.trycloudflare.com",
      "https://abc.evil.com",
      "https://user:pw@abc.trycloudflare.com",
      "https://abc.trycloudflare.com/path",
      "https://abc.trycloudflare.com?x=1",
      "https://abc.trycloudflare.com:8443",
      "https://abc.trycloudflare.com.evil.com",
      "https://evil.com/https://abc.trycloudflare.com",
    ]) {
      expect(findTunnelUrl(bad, CF), bad).toBeNull();
    }
  });
});

describe("TunnelSupervisor process and output security", () => {
  it("parses the cloudflared URL from stderr and substitutes {port} without a shell", async () => {
    const argsFile = path.join(dir, "args.json");
    const t = sup(4100, spec(["--mode", "cloudflared", "--port", "{port}", "--args-dump", argsFile, "--x", "a;touch " + path.join(dir, "pwned")]));
    const url = await t.start();
    expect(url).toMatch(/^https:\/\/t[0-9a-f]+\.trycloudflare\.com$/);
    expect(t.state).toBe("up");
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    expect(args).toContain("4100");
    expect(args).toContain("a;touch " + path.join(dir, "pwned"));
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
  });

  it("parses the ngrok URL from stdout JSON", async () => {
    const t = sup(4101, spec(["--mode", "ngrok", "--port", "{port}"], { urlPattern: NGROK }));
    expect(await t.start()).toMatch(/^https:\/\/t[0-9a-f]+\.ngrok-free\.app$/);
  });

  it("waits for the ready line when the spec has one", async () => {
    const t = sup(4102, spec(["--ready", "--delay", "50"], { readyPattern: /Registered tunnel connection/ }));
    await t.start();
    expect(t.readyPending).toBe(false);
    const t2 = sup(4103, spec([], { readyPattern: /Registered tunnel connection/, startTimeoutMs: 600 }));
    expect(await t2.start()).toMatch(/trycloudflare/);
    expect(t2.readyPending).toBe(true);
  });

  it("ignores invalid candidates, then times out with a fixed reason (output only in the redacted log) and leaves no process", async () => {
    const secret = "tok_" + "s".repeat(30);
    registerSecret(secret, "test");
    const pidFile = path.join(dir, "pids.json");
    const t = sup(4104, spec(["--invalid", "--no-url", "--pid-file", pidFile, "--secret-in-output", secret], { startTimeoutMs: 800 }));
    const logs = captureWarnings();
    const err = (await t.start().catch((e: unknown) => e)) as Error;
    StructuredLogger.resetSink();
    expect(err).toBeInstanceOf(Error);
    // The error goes to the agent: no tunnel output at all.
    expect(err.message).toBe("Tunnel did not report a public URL within 1 s");
    const line = logs.find((l) => l.includes("did not start"));
    expect(line).toBeDefined();
    expect(line).not.toContain(secret);
    expect(line).toContain("[REDACTED");
    expect(t.state).toBe("failed");
    const { pid } = readPids(pidFile);
    await waitFor(() => !alive(pid), 3_000);
  });

  it("security: a registered token straddling the 1 KB and 4 KB tail windows is redacted, not cut", async () => {
    const secret = "tok_" + "Zq7LkPw9XyT4mNbVcRdSfGhJkLqWeRtYuIoP";
    registerSecret(secret, "test");
    const suffixLeaks = (text: string): number => {
      for (let n = secret.length; n >= 8; n--) if (text.includes(secret.slice(-n))) return n;
      return 0;
    };
    // The filler is shorter than each window by less than the secret, so a
    // cut before redaction keeps most of the secret.
    const t1 = sup(4120, spec(["--no-url", "--secret-in-output", secret, "--pad", "1000"], { startTimeoutMs: 600 }));
    const logs = captureWarnings();
    const err1 = (await t1.start().catch((e: unknown) => e)) as Error;
    StructuredLogger.resetSink();
    expect(err1.message).toMatch(/^Tunnel did not report a public URL/);
    const line = logs.find((l) => l.includes("did not start")) ?? "";
    expect(line).toContain("output tail");
    expect(suffixLeaks(line)).toBe(0);
    const t2 = sup(4121, spec(["--no-url", "--secret-in-output", secret, "--pad", "4070"], { startTimeoutMs: 600 }));
    await t2.start().catch(() => {});
    const tail = t2.outputTail();
    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(suffixLeaks(tail)).toBe(0);
  });

  it("an exit before the URL rejects at once and is not restarted", async () => {
    const t = sup(4106, { ...spec([]), args: [path.join(dir, "missing.mjs")] });
    await expect(t.start()).rejects.toThrow(/^Tunnel did not report a public URL \(exited with code 1\)$/);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.state).toBe("failed");
    expect(t.pid).toBeNull();
  });

  it("restarts after a crash with backoff and reports the new URL", async () => {
    const once = path.join(dir, "crashed");
    const changes: [string | null, string][] = [];
    const states: string[] = [];
    const t = sup(4107, spec(["--crash-once", once]), {
      onUrlChange: (a, b) => changes.push([a, b]),
      onStateChange: (s) => states.push(s),
    });
    const first = await t.start();
    await waitFor(() => changes.length === 1);
    expect(changes[0][0]).toBe(first);
    expect(changes[0][1]).not.toBe(first);
    expect(t.url).toBe(changes[0][1]);
    expect(t.state).toBe("up");
    expect(states).toEqual(["up", "restarting", "up"]);
  });

  it("a crash loop ends failed after maxRestarts with a bounded number of processes; a new start resets", async () => {
    const starts = path.join(dir, "starts");
    const t = sup(
      4108,
      spec(["--crash-after", "50", "--starts", starts], { restart: { maxRestarts: 2, windowMs: 600_000, backoffMs: [30] } }),
    );
    await t.start();
    await waitFor(() => t.state === "failed");
    await new Promise((r) => setTimeout(r, 300));
    const count = fs.readFileSync(starts, "utf8").trim().split("\n").length;
    expect(count).toBe(3);
    expect(t.detail).toMatch(/exited 3 time\(s\)/);
    expect(t.detail).not.toContain("INF");
    await t.start();
    expect(t.state).toBe("up");
    expect(fs.readFileSync(starts, "utf8").trim().split("\n").length).toBe(4);
  });

  it("stop sends SIGTERM to the group and the grandchild is gone", async () => {
    const pidFile = path.join(dir, "pids.json");
    const t = sup(4109, spec(["--grandchild", "--pid-file", pidFile]));
    await t.start();
    const { pid, grandchild } = readPids(pidFile);
    expect(alive(pid)).toBe(true);
    expect(alive(grandchild!)).toBe(true);
    const started = Date.now();
    await t.stop(3_000);
    expect(Date.now() - started).toBeLessThan(2_500);
    await waitFor(() => !alive(pid) && !alive(grandchild!), 3_000);
  });

  it("a tunnel that ignores SIGTERM is killed after the grace period", async () => {
    const pidFile = path.join(dir, "pids.json");
    const t = sup(4110, spec(["--ignore-term", "--pid-file", pidFile]));
    await t.start();
    const { pid } = readPids(pidFile);
    const started = Date.now();
    await t.stop(300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await waitFor(() => !alive(pid), 3_000);
  });

  it("an abort during start leaves nothing running", async () => {
    const pidFile = path.join(dir, "pids.json");
    const t = sup(4111, spec(["--delay", "5000", "--pid-file", pidFile]));
    const ac = new AbortController();
    const p = t.start(ac.signal);
    await waitFor(() => fs.existsSync(pidFile));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const { pid } = readPids(pidFile);
    await waitFor(() => !alive(pid), 3_000);
  });

  it("2 MB of output after the URL does not block the tunnel; the tail stays at most 4 KB", async () => {
    const done = path.join(dir, "done");
    const t = sup(4112, spec(["--flood", String(2 * 1024 * 1024), "--done", done]));
    await t.start();
    await waitFor(() => fs.existsSync(done), 15_000);
    expect(t.outputTail().length).toBeLessThanOrEqual(4096);
  });

  it("a forced exit kills the tunnel and its grandchild", async () => {
    const pidFile = path.join(dir, "pids.json");
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, FAKE, pidFile], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let output = "";
    child.stdout!.on("data", (d) => (output += String(d)));
    child.stderr!.on("data", (d) => (output += String(d)));
    const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    expect(code, output).toBe(1);
    expect(output).toMatch(/URL https:\/\/t[0-9a-f]+\.trycloudflare\.com/);
    const { pid, grandchild } = readPids(pidFile);
    await waitFor(() => !alive(pid) && !alive(grandchild!), 2_000);
  }, 30_000);

  it("a runtime ended by SIGHUP with no handler of its own kills the tunnel and its grandchild", async () => {
    const pidFile = path.join(dir, "pids.json");
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, FAKE, pidFile, "wait"], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let output = "";
    child.stdout!.on("data", (d) => (output += String(d)));
    child.stderr!.on("data", (d) => (output += String(d)));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    try {
      await waitFor(() => /URL https:/.test(output), 20_000);
      child.kill("SIGHUP");
      expect(await exited, output).toBe(129);
      const { pid, grandchild } = readPids(pidFile);
      await waitFor(() => !alive(pid) && !alive(grandchild!), 2_000);
    } finally {
      child.kill("SIGKILL");
      if (fs.existsSync(pidFile)) {
        try {
          process.kill(-readPids(pidFile).pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  }, 30_000);
});

describe("TunnelExposer policy and security", () => {
  function cfg(extraArgs: string[], tunnel: Partial<NonNullable<ResolvedPortsConfig["tunnel"]>> = {}): ResolvedPortsConfig {
    return {
      mode: "tunnel",
      gateway: { host: "127.0.0.1", port: 8480 },
      maxExposed: 3,
      allowedPorts: { min: 1024, max: 65535 },
      deniedPorts: [],
      restoreOnStart: false,
      tunnel: {
        preset: "custom",
        command: process.execPath,
        args: [FAKE, "--port", "{port}", ...extraArgs],
        urlPattern: CF,
        env: {},
        passEnv: [],
        startTimeoutMs: 10_000,
        restart: { maxRestarts: 2, windowMs: 600_000 },
        ...tunnel,
      },
    };
  }

  it("two concurrent exposes of one port start one process; close leaves no process group", async () => {
    const starts = path.join(dir, "starts");
    const ex = new TunnelExposer(cfg(["--starts", starts, "--delay", "200"]), { probe: async () => true });
    exposers.push(ex);
    await ex.start();
    const [a, b] = await Promise.all([ex.expose(5100), ex.expose(5100)]);
    expect(a.url).toBe(b.url);
    expect(fs.readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
    await ex.expose(5101);
    const before = liveProcessGroups().length;
    expect(before).toBeGreaterThanOrEqual(2);
    await ex.close(5_000);
    await waitFor(() => liveProcessGroups().length === before - 2, 3_000);
  });

  it("concurrent exposes of different ports respect maxExposed and start one tunnel", async () => {
    const starts = path.join(dir, "starts");
    const ex = new TunnelExposer({ ...cfg(["--starts", starts, "--delay", "200"]), maxExposed: 1 }, { probe: async () => true });
    exposers.push(ex);
    await ex.start();
    const all = await Promise.allSettled([5110, 5111, 5112].map((p) => ex.expose(p)));
    expect(all.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(all.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([
      expect.stringMatching(/PORT_LIMIT/),
      expect.stringMatching(/PORT_LIMIT/),
    ]);
    expect(fs.readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("records the tunnel pid at spawn, during the first start and during a restart", async () => {
    const starts = path.join(dir, "starts");
    const kv = new Map<string, string>();
    const ex = new TunnelExposer(cfg(["--starts", starts, "--delay", "600", "--crash-once", path.join(dir, "crashed")]), {
      kv: { getKV: (k) => kv.get(k), setKV: (k, v) => void kv.set(k, v) },
      probe: async () => true,
      backoffMs: [30],
    });
    exposers.push(ex);
    await ex.start();
    const startPids = (): number[] => (fs.existsSync(starts) ? fs.readFileSync(starts, "utf8").trim().split("\n").map(Number) : []);
    const exposing = ex.expose(5113);
    await waitFor(() => startPids().length === 1);
    // The URL is not out yet; a hard kill now must still leave the pid behind.
    const recorded = (): number[] => JSON.parse(kv.get(TUNNEL_PIDS_KV) ?? "[]").map((r: { pid: number }) => r.pid);
    expect(recorded()).toEqual([startPids()[0]]);
    const row = JSON.parse(kv.get(TUNNEL_PIDS_KV)!)[0];
    expect(row.argv).toEqual([process.execPath, FAKE, "--port", "5113", "--starts", starts, "--delay", "600", "--crash-once", path.join(dir, "crashed")]);
    expect(row.start).toMatch(/^\d+$/);
    await exposing;
    await waitFor(() => startPids().length === 2);
    expect(ex.list()[0].state).not.toBe("up");
    expect(recorded()).toEqual([startPids()[1]]);
    await waitFor(() => ex.list()[0].state === "up");
  });

  it("a restart reports one 'up' change carrying the address it had before", async () => {
    const ex = new TunnelExposer(cfg(["--crash-once", path.join(dir, "crashed")]), { probe: async () => true, backoffMs: [30] });
    exposers.push(ex);
    await ex.start();
    const first = await ex.expose(5114);
    const events: Array<{ state: string; url: string | null; previousUrl: string | null }> = [];
    ex.onChange((e, previousUrl) => events.push({ state: e.state, url: e.url, previousUrl }));
    await waitFor(() => events.some((e) => e.state === "up"));
    // Give a second, duplicate event the time to arrive.
    await new Promise((r) => setTimeout(r, 200));
    expect(events.map((e) => e.state)).toEqual(["restarting", "up"]);
    const up = events[1];
    expect(up.url).toMatch(CF);
    expect(up.url).not.toBe(first.url);
    expect(up.previousUrl).toBe(first.url);
  });

  it("exposing a port again after its tunnel failed reports one 'up', not two", async () => {
    const ex = new TunnelExposer(cfg(["--crash-once", path.join(dir, "crashed")], { restart: { maxRestarts: 0, windowMs: 600_000 } }), {
      probe: async () => true,
      backoffMs: [30],
    });
    exposers.push(ex);
    await ex.start();
    await ex.expose(5117);
    await waitFor(() => ex.list()[0]?.state === "failed");
    const events: Array<{ state: string; url: string | null; previousUrl: string | null }> = [];
    ex.onChange((e, previousUrl) => events.push({ state: e.state, url: e.url, previousUrl }));
    const again = await ex.expose(5117);
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toEqual([{ state: "up", url: again.url, previousUrl: null }]);
    expect(ex.list()).toMatchObject([{ port: 5117, state: "up", url: again.url }]);
  });

  it("a runtime stop during a start that hangs ends the expose at once and leaves no process", async () => {
    const pidFile = path.join(dir, "pid.json");
    const stop = new AbortController();
    // A tool call of the main loop: no signal of its own, no ambient one.
    const ex = new TunnelExposer(cfg(["--no-url", "--grandchild", "--pid-file", pidFile], { startTimeoutMs: 60_000 }), {
      probe: async () => true,
      shutdownSignal: stop.signal,
    });
    exposers.push(ex);
    await ex.start();
    const exposing = ex.expose(5118).catch((e: unknown) => e as Error);
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0);
    const { pid, grandchild } = readPids(pidFile);
    const t0 = Date.now();
    stop.abort();
    const err = (await exposing) as Error;
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(err.message).toMatch(/^UNAVAILABLE: public access is shutting down$/);
    await waitFor(() => !alive(pid) && !alive(grandchild!), 3_000);
    expect(ex.list()).toEqual([]);
    // Nothing starts once a stop was requested.
    await expect(ex.expose(5119)).rejects.toThrow(/^UNAVAILABLE: /);
  });

  it("close waits for a start it aborted, so its tunnel is gone when close returns (even one that ignores SIGTERM)", async () => {
    const pidFile = path.join(dir, "pid.json");
    const ex = new TunnelExposer(cfg(["--delay", "2000", "--ignore-term", "--pid-file", pidFile]), { probe: async () => true });
    exposers.push(ex);
    await ex.start();
    const exposing = ex.expose(5115).catch((e: unknown) => e as Error);
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0);
    const { pid } = readPids(pidFile);
    await ex.close(5_000);
    expect(alive(pid)).toBe(false);
    expect(((await exposing) as Error).message).toMatch(/^UNAVAILABLE: /);
  });

  it("close settles every start it aborted before returning, wherever the start was", async () => {
    let probeDone = false;
    let probing!: () => void;
    const inProbe = new Promise<void>((r) => (probing = r));
    const ex = new TunnelExposer(cfg([]), {
      probe: async () => {
        probing();
        await new Promise((r) => setTimeout(r, 400));
        probeDone = true;
        return true;
      },
    });
    exposers.push(ex);
    await ex.start();
    const exposing = ex.expose(5116).catch((e: unknown) => e);
    await inProbe;
    await ex.close(5_000);
    expect(probeDone).toBe(true);
    await exposing;
  });

  it("the tunnel env has its own token and passEnv values, and no runtime or DNS credential", async () => {
    const envFile = path.join(dir, "env.json");
    const hostEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: dir,
      OPENAI_API_KEY: "sk-openai-" + "o".repeat(30),
      AUTOMATON_DNS_API_TOKEN: "cf-dns-" + "d".repeat(30),
      NGROK_AUTHTOKEN: "ngrok-" + "n".repeat(30),
    };
    const ex = new TunnelExposer(
      cfg(["--env-dump", envFile], { env: { MYTUNNEL_TOKEN: "own-" + "t".repeat(30) }, passEnv: ["NGROK_AUTHTOKEN"] }),
      { env: hostEnv, probe: async () => true },
    );
    exposers.push(ex);
    await ex.start();
    await ex.expose(5102);
    const env = JSON.parse(fs.readFileSync(envFile, "utf8"));
    expect(env.MYTUNNEL_TOKEN).toBe("own-" + "t".repeat(30));
    expect(env.NGROK_AUTHTOKEN).toBe("ngrok-" + "n".repeat(30));
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AUTOMATON_DNS_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("d".repeat(30));
  });

  it("a crash loop ends failed with a runtime-written detail; a new expose starts again", async () => {
    const ex = new TunnelExposer(cfg(["--crash-after", "50"]), { probe: async () => true, backoffMs: [30] });
    exposers.push(ex);
    await ex.start();
    await ex.expose(5103);
    await waitFor(() => ex.list()[0]?.state === "failed");
    const failed = ex.list()[0];
    expect(failed.url).toBeNull();
    expect(failed.detail).toMatch(/^the tunnel exited 3 time/);
    const again = await ex.expose(5103);
    expect(again.state).toBe("up");
    expect(again.url).toMatch(/trycloudflare/);
  });

  it("close during a background restore starts no further tunnel", async () => {
    const starts = path.join(dir, "starts");
    const kv = new Map<string, string>([[EXPOSURES_KV, JSON.stringify([{ port: 5201 }, { port: 5202 }, { port: 5203 }])]]);
    const ex = new TunnelExposer({ ...cfg(["--starts", starts, "--delay", "400"]), restoreOnStart: true }, {
      kv: { getKV: (k) => kv.get(k), setKV: (k, v) => void kv.set(k, v) },
      probe: async () => true,
    });
    exposers.push(ex);
    const before = liveProcessGroups().length;
    await ex.start();
    await waitFor(() => fs.existsSync(starts));
    await ex.close(5_000);
    // Long enough for the next two restores to have started without the fix.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(fs.readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
    expect(ex.list()).toEqual([]);
    await waitFor(() => liveProcessGroups().length === before, 3_000);
    await expect(ex.expose(5204)).rejects.toThrow(/^UNAVAILABLE: /);
  });

  it("remove during a start stops it: the port never goes public and remove reports it", async () => {
    const ex = new TunnelExposer(cfg(["--delay", "400"]), { probe: async () => true });
    exposers.push(ex);
    await ex.start();
    const before = liveProcessGroups().length;
    const exposing = ex.expose(5301).catch((e: unknown) => e as Error);
    await new Promise((r) => setTimeout(r, 100));
    expect(await ex.remove(5301)).toBe(true);
    const outcome = await exposing;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/^NOT_EXPOSED: /);
    await new Promise((r) => setTimeout(r, 600));
    expect(ex.list()).toEqual([]);
    await waitFor(() => liveProcessGroups().length === before, 3_000);
    expect(await ex.remove(5301)).toBe(false);
  });

  it("security: the ngrok agent API ports are refused under ngrok, even when the owner allows them", () => {
    const ngrok = new TunnelExposer({ ...cfg([], { preset: "ngrok" }), allowedPorts: [4040, 4041, 4045, 4050, 4051] }, {});
    for (const port of [4040, 4041, 4045, 4050]) expect(ngrok.checkPort(port)?.code).toBe("PORT_RESERVED");
    expect(ngrok.checkPort(4051)).toBeNull();
    const customNgrok = new TunnelExposer(cfg([], { command: "/usr/local/bin/ngrok" }), {});
    expect(customNgrok.checkPort(4042)?.code).toBe("PORT_RESERVED");
    const cloudflared = new TunnelExposer(cfg([], { preset: "cloudflared" }), {});
    expect(cloudflared.checkPort(4041)).toBeNull();
  });

  it("a missing tunnel binary makes the mode unavailable", async () => {
    const ex = new TunnelExposer(cfg([], { command: path.join(dir, "nope") }), {});
    exposers.push(ex);
    await ex.start();
    expect(ex.available()).toMatchObject({ ok: false });
    await expect(ex.expose(5104)).rejects.toThrow(/^UNAVAILABLE: the tunnel command/);
  });

  it("start stops tunnel groups a hard-killed earlier run left behind, and only exact matches", async () => {
    const orphan = spawn(process.execPath, [FAKE, "--port", "5105"], { detached: true, stdio: "ignore" });
    // Same command (an interpreter), other arguments: a reused pid must not be killed.
    const sameCmd = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const other = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    for (const c of [orphan, sameCmd, other]) c.unref();
    const startOf = (pid: number): string => {
      const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return st.slice(st.lastIndexOf(")") + 2).split(" ")[19];
    };
    try {
      for (const c of [orphan, sameCmd]) {
        await waitFor(() => fs.existsSync(`/proc/${c.pid}/cmdline`) && fs.readFileSync(`/proc/${c.pid}/cmdline`, "utf8").includes("\0-"));
      }
      const tunnelArgv = (port: number) => [process.execPath, FAKE, "--port", String(port)];
      const kv = new Map<string, string>([[
        TUNNEL_PIDS_KV,
        JSON.stringify([
          { pid: orphan.pid, argv: tunnelArgv(5105), start: startOf(orphan.pid!) },
          // argv0 matches, the rest does not
          { pid: sameCmd.pid, argv: tunnelArgv(5107), start: startOf(sameCmd.pid!) },
          // argv matches, start time does not (a reused pid)
          { pid: other.pid, argv: ["/bin/sh", "-c", "sleep 30"], start: "1" },
          // the runtime itself
          { pid: process.pid, argv: process.argv, start: startOf(process.pid) },
          // the old format (pid only) is never reaped
          sameCmd.pid,
        ]),
      ]]);
      const ex = new TunnelExposer(cfg([]), {
        kv: { getKV: (k) => kv.get(k), setKV: (k, v) => void kv.set(k, v) },
        probe: async () => true,
      });
      exposers.push(ex);
      await ex.start();
      await waitFor(() => !alive(orphan.pid!) || fs.readFileSync(`/proc/${orphan.pid}/stat`, "utf8").includes(") Z"), 3_000);
      expect(alive(other.pid!)).toBe(true);
      expect(alive(sameCmd.pid!)).toBe(true);
      expect(kv.get(TUNNEL_PIDS_KV)).toBe("[]");
      await ex.expose(5106);
      expect(JSON.parse(kv.get(TUNNEL_PIDS_KV)!)).toHaveLength(1);
    } finally {
      for (const p of [orphan.pid, sameCmd.pid, other.pid]) {
        try {
          process.kill(-p!, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  });
});
