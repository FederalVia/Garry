/**
 * The cancellation scope: the ambient signal survives awaits and timers,
 * merges with explicit signals, and reaches local exec (the process group
 * is killed and the call rejects) and the resilient HTTP client (no send,
 * no retry after an abort). Outside a scope nothing changes.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TaskAbortedError,
  abortableDelay,
  currentCancellationSignal,
  isAbortError,
  linkedAbortController,
  mergeSignals,
  raceWithSignal,
  rethrowIfCancelled,
  runOutsideCancellation,
  runShieldedFromTimeout,
  runWithCancellation,
  throwIfCancelled,
} from "../runtime/cancellation.js";
import { execLocalCommand } from "../conway/client.js";
import { ResilientHttpClient } from "../conway/http-client.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (/^\d+$/.test(text)) return Number(text);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no pid written");
}

describe("scope", () => {
  it("the signal survives awaits and timers, and is absent outside the scope", async () => {
    const ctl = new AbortController();
    expect(currentCancellationSignal()).toBeUndefined();
    const seen = await runWithCancellation(ctl.signal, async () => {
      await new Promise((r) => setTimeout(r, 5));
      const inTimer = await new Promise<AbortSignal | undefined>((r) => setTimeout(() => r(currentCancellationSignal()), 5));
      const outside = runOutsideCancellation(() => currentCancellationSignal());
      return { inTimer, outside };
    });
    expect(seen.inTimer).toBe(ctl.signal);
    expect(seen.outside).toBeUndefined();
  });

  it("throwIfCancelled and rethrowIfCancelled throw the reason only once aborted", async () => {
    const ctl = new AbortController();
    await runWithCancellation(ctl.signal, async () => {
      expect(() => throwIfCancelled()).not.toThrow();
      expect(() => rethrowIfCancelled(new Error("other"))).not.toThrow();
      const reason = new TaskAbortedError("timeout", "cancelled: timed out");
      ctl.abort(reason);
      expect(() => throwIfCancelled()).toThrow(reason);
      // Whatever error the catch saw, the abort is what propagates.
      expect(() => rethrowIfCancelled(new Error("socket hang up"))).toThrow(reason);
    });
    expect(() => throwIfCancelled()).not.toThrow();
  });

  it("an abort without an Error reason still reads as an AbortError", async () => {
    const ctl = new AbortController();
    ctl.abort("gone");
    const err = await runWithCancellation(ctl.signal, async () => {
      try {
        throwIfCancelled();
      } catch (e) {
        return e;
      }
      return null;
    });
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new TaskAbortedError("shutdown", "x"))).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
  });

  it("mergeSignals keeps a single signal as is and aborts with either", () => {
    const a = new AbortController();
    const b = new AbortController();
    expect(mergeSignals(undefined, null)).toBeUndefined();
    expect(mergeSignals(a.signal, undefined)).toBe(a.signal);
    expect(mergeSignals(a.signal, a.signal)).toBe(a.signal);
    const merged = mergeSignals(a.signal, b.signal)!;
    expect(merged.aborted).toBe(false);
    b.abort(new Error("b"));
    expect(merged.aborted).toBe(true);
  });

  it("linkedAbortController follows its parent until released", () => {
    const parent = new AbortController();
    const first = linkedAbortController(parent.signal);
    const second = linkedAbortController(parent.signal);
    second.release();
    parent.abort(new Error("stop"));
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
  });

  it("abortableDelay and raceWithSignal reject on abort", async () => {
    const ctl = new AbortController();
    const delay = abortableDelay(10_000, ctl.signal);
    const race = raceWithSignal(new Promise(() => {}), ctl.signal);
    ctl.abort(new TaskAbortedError("shutdown", "bye"));
    await expect(delay).rejects.toMatchObject({ name: "AbortError", why: "shutdown" });
    await expect(race).rejects.toMatchObject({ name: "AbortError" });
    await expect(raceWithSignal(Promise.resolve(3), new AbortController().signal)).resolves.toBe(3);
  });

  it("a shielded section obeys shutdown only", async () => {
    const root = new AbortController();
    const run = new AbortController();
    const state = { shielded: 0 };
    await runWithCancellation(
      run.signal,
      async () => {
        const inside = runShieldedFromTimeout(async () => {
          expect(state.shielded).toBe(1);
          run.abort(new TaskAbortedError("timeout", "t"));
          await new Promise((r) => setTimeout(r, 10));
          // The run timed out, but the section goes on.
          expect(currentCancellationSignal()!.aborted).toBe(false);
          root.abort(new TaskAbortedError("shutdown", "s"));
          expect(currentCancellationSignal()!.aborted).toBe(true);
          return "done";
        });
        await expect(inside).resolves.toBe("done");
        expect(state.shielded).toBe(0);
        expect(currentCancellationSignal()!.aborted).toBe(true);
      },
      { shutdownSignal: root.signal, state },
    );
  });
});

describe("execLocalCommand", () => {
  it("an ambient abort kills the whole process group and rejects", async () => {
    const pidFile = path.join(tmp, "pid");
    const ctl = new AbortController();
    const run = runWithCancellation(ctl.signal, () =>
      execLocalCommand(`echo $$ > '${pidFile}'; sleep 60 & sleep 60; wait`, 60_000),
    );
    const pid = await readPid(pidFile);
    const started = Date.now();
    ctl.abort(new TaskAbortedError("timeout", "cancelled: timed out"));
    await expect(run).rejects.toMatchObject({ name: "AbortError", why: "timeout" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(groupGone(pid)).toBe(true);
  });

  it("an explicit signal works outside a scope; no signal behaves as before", async () => {
    const ctl = new AbortController();
    const p = execLocalCommand("sleep 30", 60_000, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });

    const plain = await execLocalCommand("echo hi; exit 3", 5_000);
    expect(plain).toMatchObject({ stdout: "hi\n", exitCode: 3 });
  });

  it("refuses to start when the scope is already aborted", async () => {
    const marker = path.join(tmp, "ran");
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      runWithCancellation(ctl.signal, () => execLocalCommand(`touch '${marker}'`, 5_000)),
    ).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("ResilientHttpClient", () => {
  let server: http.Server;
  let port: number;
  let requests: number;
  let closed: number;

  beforeEach(async () => {
    requests = 0;
    closed = 0;
    server = http.createServer((req) => {
      requests++;
      // Accept and never answer.
      req.socket.on("close", () => closed++);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("an ambient abort destroys the request and is never retried", async () => {
    const client = new ResilientHttpClient({ allowHttpOnLoopback: true, baseTimeout: 30_000, maxRetries: 3 });
    const ctl = new AbortController();
    const p = runWithCancellation(ctl.signal, () => client.request(`http://127.0.0.1:${port}/hang`));
    await expect.poll(() => requests).toBe(1);
    ctl.abort(new TaskAbortedError("timeout", "t"));
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => closed).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(requests).toBe(1);
  });

  it("the retry backoff ends at the abort instead of sleeping it out", async () => {
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      requests++;
      res.writeHead(503).end();
    });
    const client = new ResilientHttpClient({
      allowHttpOnLoopback: true,
      maxRetries: 3,
      backoffBase: 20_000,
      backoffMax: 20_000,
    });
    const ctl = new AbortController();
    const started = Date.now();
    const p = runWithCancellation(ctl.signal, () => client.request(`http://127.0.0.1:${port}/busy`));
    await expect.poll(() => requests).toBe(1);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(requests).toBe(1);
  });
});
