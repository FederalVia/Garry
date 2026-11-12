/**
 * Which Conway and relay requests are re-sent. A non-idempotent request
 * that may already have done its work is sent once unless it carries a key
 * (Conway's LB 404 re-send) or the caller vouches for it (retryUnsafe).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createConwayClient } from "../conway/client.js";
import { createSocialClient } from "../social/client.js";
import { ResilientHttpClient } from "../conway/http-client.js";

const API = "https://api.conway.tech";
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  key?: string;
}

let calls: Call[];

function stub(answer: (url: string, method: string) => Response): void {
  calls = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, key: headers["Idempotency-Key"] });
    return answer(url, method);
  }) as typeof fetch;
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function conway() {
  return createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "sb1", treasury: () => undefined });
}

beforeEach(() => {
  // Skip backoff sleeps; attempt counts are what matter here.
  const proto = ResilientHttpClient.prototype as unknown as { backoff: (attempt: number) => Promise<void> };
  vi.spyOn(proto, "backoff").mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Runs a call whose 404 re-sends wait on real timers, with those timers faked. */
async function withFakeTimers<T>(fn: () => Promise<T>): Promise<T | Error> {
  vi.useFakeTimers();
  const p = fn().catch((e: Error) => e);
  await vi.runAllTimersAsync();
  return p;
}

describe("Conway client: non-idempotent calls", () => {
  it("exposePort on a 504 is sent once, with an Idempotency-Key (F144)", async () => {
    stub(() => json(504));
    await expect(conway().exposePort(8080)).rejects.toThrow(/504/);
    const posts = calls.filter((c) => c.url.endsWith("/ports/expose"));
    expect(posts).toHaveLength(1);
    expect(posts[0].key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("addDnsRecord on a 504 is sent once", async () => {
    stub(() => json(504));
    await expect(conway().addDnsRecord("a.com", "A", "@", "1.2.3.4")).rejects.toThrow(/504/);
    expect(calls).toHaveLength(1);
  });

  it("addDnsRecord on the LB's 404 is re-sent with the same key", async () => {
    let n = 0;
    stub(() => (++n < 3 ? json(404) : json(200, { id: "rec1", type: "A" })));
    const result = await withFakeTimers(() => conway().addDnsRecord("a.com", "A", "@", "1.2.3.4"));
    expect(result).toMatchObject({ id: "rec1" });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.key)).size).toBe(1);
    expect(calls[0].key).toBeTruthy();
  });

  it("the sandbox file upload carries a key and is not retried on 503", async () => {
    stub(() => json(503));
    await expect(conway().writeFile("/root/x.txt", "hi")).rejects.toThrow(/503/);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBeTruthy();
  });

  it("idempotent methods keep their retries and 404 re-sends", async () => {
    stub(() => json(503));
    await expect(conway().listSandboxes()).rejects.toThrow(/503/);
    expect(calls).toHaveLength(4); // 1 + maxRetries

    let n = 0;
    stub(() => (++n < 2 ? json(404) : json(200)));
    const removed = await withFakeTimers(() => conway().removePort(8080));
    expect(removed).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
  });
});

describe("relay client", () => {
  it("send (POST) is not retried on 503; poll (a read-only POST) is", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const social = createSocialClient("https://relay.example.com", account);

    stub(() => json(503, { error: "busy" }));
    await expect(social.send("0x1234567890abcdef1234567890abcdef12345678", "hello")).rejects.toThrow(/503/);
    expect(calls.filter((c) => c.url.endsWith("/v1/messages"))).toHaveLength(1);

    stub(() => json(503, { error: "busy" }));
    await expect(social.poll()).rejects.toThrow(/503/);
    expect(calls.filter((c) => c.url.endsWith("/v1/messages/poll"))).toHaveLength(4);
  });
});
