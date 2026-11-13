/**
 * The poll credential. Automaton/1 signs a fresh random nonce for every
 * request, so a captured header set is good for one request, and the HTTP
 * client never re-sends it: a retry is signed again. Conway compat sends
 * exactly the old request. Fetch is stubbed except for one loopback server.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { createSocialClient } from "../social/client.js";

const self = privateKeyToAccount(generatePrivateKey());
const addr = self.address.toLowerCase();

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let seen: Seen[] = [];

function stub(answer: (n: number) => Response): void {
  seen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      seen.push({ url: String(input), method: String(init?.method ?? "GET"), headers });
      return answer(seen.length);
    }),
  );
}

const ok = () => new Response(JSON.stringify({ messages: [], next_cursor: "e.0" }), { status: 200 });
const status = (s: number) => new Response(JSON.stringify({ error: "x" }), { status: s });

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signedOver(message: string, signature: string): Promise<boolean> {
  return verifyMessage({ address: self.address, message, signature: signature as `0x${string}` });
}

describe("Automaton/1 poll", () => {
  it("sends X-Auth-Nonce and signs Automaton/1:poll:{address}:{timestamp}:{nonce}", async () => {
    stub(ok);
    const r = await createSocialClient("https://relay.example.com", self).poll("e.5");
    expect(r.nextCursor).toBe("e.0");
    expect(seen).toHaveLength(1);
    const h = seen[0]!.headers;
    expect(h["x-wallet-address"]).toBe(addr);
    expect(h["x-auth-nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(await signedOver(`Automaton/1:poll:${addr}:${h["x-timestamp"]}:${h["x-auth-nonce"]}`, h["x-signature"]!)).toBe(true);
    expect(await signedOver(`Conway:poll:${addr}:${h["x-timestamp"]}`, h["x-signature"]!)).toBe(false);
  });

  it("a 503 then a 200 is two requests with different nonces and signatures", async () => {
    stub((n) => (n === 1 ? status(503) : ok()));
    await createSocialClient("https://relay.example.com", self).poll();
    expect(seen).toHaveLength(2);
    const [a, b] = [seen[0]!.headers, seen[1]!.headers];
    expect(a["x-auth-nonce"]).not.toBe(b["x-auth-nonce"]);
    expect(a["x-signature"]).not.toBe(b["x-signature"]);
    for (const h of [a, b]) {
      expect(await signedOver(`Automaton/1:poll:${addr}:${h["x-timestamp"]}:${h["x-auth-nonce"]}`, h["x-signature"]!)).toBe(true);
    }
  });

  it("gives up after two attempts", async () => {
    stub(() => status(502));
    await expect(createSocialClient("https://relay.example.com", self).poll()).rejects.toThrow(/Poll failed \(502\)/);
    expect(seen).toHaveLength(2);
  });

  it("a 401, a 429 or a 501 is not retried", async () => {
    for (const s of [401, 429, 501]) {
      stub(() => status(s));
      await expect(createSocialClient("https://relay.example.com", self).poll()).rejects.toThrow(new RegExp(`\\(${s}\\)`));
      expect(seen, String(s)).toHaveLength(1);
    }
  });

  it("a network error is retried once with a fresh nonce", async () => {
    let n = 0;
    seen = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: any, init?: RequestInit) => {
        seen.push({ url: "", method: "POST", headers: { ...(init?.headers as Record<string, string>) } });
        if (++n === 1) throw new TypeError("fetch failed");
        return ok();
      }),
    );
    await createSocialClient("https://relay.example.com", self).poll();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers["X-Auth-Nonce"]).not.toBe(seen[1]!.headers["X-Auth-Nonce"]);
  });

  it("unreadCount also signs a nonce", async () => {
    stub(() => new Response(JSON.stringify({ unread: 3 }), { status: 200 }));
    expect(await createSocialClient("https://relay.example.com", self).unreadCount()).toBe(3);
    const h = seen[0]!.headers;
    expect(seen[0]!.method).toBe("GET");
    expect(await signedOver(`Automaton/1:poll:${addr}:${h["x-timestamp"]}:${h["x-auth-nonce"]}`, h["x-signature"]!)).toBe(true);
  });

  // GET is idempotent, so the HTTP client would retry it by itself, re-sending a used nonce.
  it("unreadCount is never re-sent with the same nonce: two requests, two nonces, on a run of 503s", async () => {
    stub(() => status(503));
    await expect(createSocialClient("https://relay.example.com", self).unreadCount()).rejects.toThrow(/\(503\)/);
    expect(seen).toHaveLength(2);
    expect(new Set(seen.map((s) => s.headers["x-auth-nonce"])).size).toBe(2);
  });

  it("unreadCount: a 503 then a 200 succeeds on a fresh nonce", async () => {
    stub((n) => (n === 1 ? status(503) : new Response(JSON.stringify({ unread: 2 }), { status: 200 })));
    expect(await createSocialClient("https://relay.example.com", self).unreadCount()).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers["x-auth-nonce"]).not.toBe(seen[1]!.headers["x-auth-nonce"]);
  });
});

describe("Conway compat poll", () => {
  it("sends exactly today's three auth headers over Conway:poll and no nonce", async () => {
    stub(ok);
    await createSocialClient("https://social.conway.tech", self).poll();
    const h = seen[0]!.headers;
    expect(Object.keys(h).sort()).toEqual(["content-type", "x-signature", "x-timestamp", "x-wallet-address"]);
    expect(await signedOver(`Conway:poll:${addr}:${h["x-timestamp"]}`, h["x-signature"]!)).toBe(true);
  });
});

describe("relay URL", () => {
  it("accepts loopback HTTP and refuses other plain HTTP before anything is signed", async () => {
    const signMessage = vi.fn(async () => "0x00");
    const signer = { chainType: "evm" as const, address: self.address, signMessage };
    expect(() => createSocialClient("http://localhost:8787", signer as any)).not.toThrow();
    expect(() => createSocialClient("http://127.0.0.1:8787", signer as any)).not.toThrow();
    expect(() => createSocialClient("http://[::1]:8787", signer as any)).not.toThrow();
    expect(() => createSocialClient("http://relay.test", signer as any)).toThrow(/HTTPS/);
    expect(signMessage).not.toHaveBeenCalled();

    stub(ok);
    await createSocialClient("http://localhost:8787", self).poll();
    expect(seen[0]!.url).toBe("http://localhost:8787/v1/messages/poll");
  });

  it("polls an IPv6 loopback relay over plain HTTP", async () => {
    // Fetch is stubbed (IPv6 may be unavailable here); the HTTP client's own URL check still runs.
    stub(ok);
    const r = await createSocialClient("http://[::1]:8787", self).poll();
    expect(r.nextCursor).toBe("e.0");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://[::1]:8787/v1/messages/poll");
    expect(seen[0]!.headers["x-auth-nonce"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("polls a real loopback HTTP server", async () => {
    vi.unstubAllGlobals();
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ messages: [], next_cursor: req.headers["x-auth-nonce"] ? "got-nonce" : "no-nonce" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await createSocialClient(`http://127.0.0.1:${port}`, self).poll();
      expect(r.nextCursor).toBe("got-nonce");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
