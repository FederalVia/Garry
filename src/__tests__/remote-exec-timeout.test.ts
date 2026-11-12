/**
 * Remote sandbox exec: the HTTP call waits as long as the command may run
 * (plus a margin) and is never re-sent after a client-side abort, since the
 * command may already be running in the sandbox.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConwayClient } from "../conway/client.js";

let fetchMock: ReturnType<typeof vi.fn>;
let answerAfterMs: number | null;

beforeEach(() => {
  vi.useFakeTimers();
  answerAfterMs = null;
  fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
      if (answerAfterMs !== null) {
        setTimeout(() => {
          resolve(
            new Response(JSON.stringify({ stdout: "done", stderr: "", exit_code: 0 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }, answerAfterMs);
      }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function client() {
  return createConwayClient({ apiUrl: "https://api.conway.test", apiKey: "k", sandboxId: "sbx-1" });
}

describe("remote exec timeout", () => {
  it("waits for a 60 s command with a 120 s timeout: one POST, success", async () => {
    answerAfterMs = 60_000;
    const pending = client().exec("apt-get install -y something", 120_000);
    await vi.advanceTimersByTimeAsync(61_000);
    const res = await pending;
    expect(res.stdout).toBe("done");
    expect(res.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.timeout).toBe(120_000);
  });

  it("gives up after command timeout + 15 s without re-sending", async () => {
    answerAfterMs = null;
    let settled: "pending" | "resolved" | "rejected" = "pending";
    const pending = client()
      .exec("sleep 999", 120_000)
      .then(
        () => {
          settled = "resolved";
        },
        () => {
          settled = "rejected";
        },
      );
    await vi.advanceTimersByTimeAsync(134_000);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(settled).toBe("rejected");
    // Let any backoff and re-send happen if the client were going to.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
