import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_LIMITS, type RelayLimits, TokenBuckets, ipKey, resolveLimits } from "../src/limits.js";
import { createRelay } from "../src/server.js";
import {
  type Harness,
  evmSigner,
  makeClock,
  poll,
  pollHeaders,
  postJson,
  rowCount,
  send,
  signSend,
  startRelay,
  tempDir,
} from "./helpers.js";
import path from "node:path";

const alice = evmSigner();
const bob = evmSigner();
const carol = evmSigner();
const dave = evmSigner();
const mallory = evmSigner();

describe("relay limits", () => {
  const open: Harness[] = [];
  async function relay(limits: Partial<RelayLimits>): Promise<Harness> {
    const h = await startRelay({ limits });
    open.push(h);
    return h;
  }
  afterEach(async () => {
    while (open.length) await open.pop()!.stop();
  });

  it("defaults match the owner's numbers", () => {
    expect(DEFAULT_LIMITS).toMatchObject({
      senderPerHour: 100,
      recipientPerHour: 1_000,
      recipientMailbox: 5_000,
      totalMessages: 200_000,
      senderPerMinute: 20,
      pollPerMinute: 60,
      ipPerMinute: 120,
      ipStoredPerHour: 1_000,
      totalBytes: 1_000_000_000,
      maxPollBodyBytes: 4_096,
    });
    expect(() => resolveLimits({ senderPerHour: 0 })).toThrow(/senderPerHour/);
    expect(() => resolveLimits({ senderPerHour: 1.5 })).toThrow(/senderPerHour/);
  });

  it("per-sender per-minute limit gives 429 with Retry-After and recovers as the clock moves", async () => {
    const h = await relay({ senderPerMinute: 2, senderPerHour: 100 });
    for (let i = 0; i < 2; i++) {
      expect((await send(h.url, await signSend(alice, bob.address, `m${i}`, h.clock.now()))).status).toBe(200);
    }
    const r = await send(h.url, await signSend(alice, bob.address, "m2", h.clock.now()));
    expect(r.status).toBe(429);
    expect(r.json.error).toBe("sender rate limit");
    expect(Number(r.headers["retry-after"])).toBe(60);
    // Another sender is unaffected.
    expect((await send(h.url, await signSend(carol, bob.address, "c", h.clock.now()))).status).toBe(200);
    h.clock.advance(61_000);
    expect((await send(h.url, await signSend(alice, bob.address, "m3", h.clock.now()))).status).toBe(200);
  });

  it("per-sender per-hour limit", async () => {
    const h = await relay({ senderPerMinute: 100, senderPerHour: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await send(h.url, await signSend(alice, bob.address, `m${i}`, h.clock.now()))).status).toBe(200);
      h.clock.advance(10 * 60_000);
    }
    const r = await send(h.url, await signSend(alice, bob.address, "m3", h.clock.now()));
    expect(r.status).toBe(429);
    // The oldest of the three leaves the hour 30 minutes from now.
    expect(Number(r.headers["retry-after"])).toBe(30 * 60);
    h.clock.advance(30 * 60_000 + 1_000);
    expect((await send(h.url, await signSend(alice, bob.address, "m4", h.clock.now()))).status).toBe(200);
  });

  it("forged sends do not use up the victim's quota", async () => {
    const h = await relay({ senderPerMinute: 2, senderPerHour: 2 });
    for (let i = 0; i < 10; i++) {
      const p = await signSend(mallory, bob.address, `fake${i}`, h.clock.now());
      expect((await send(h.url, { ...p, from: alice.address })).status).toBe(401);
    }
    for (let i = 0; i < 2; i++) {
      expect((await send(h.url, await signSend(alice, bob.address, `real${i}`, h.clock.now()))).status).toBe(200);
    }
    expect(rowCount(h)).toBe(2);
  });

  it("a replayed duplicate is not counted against the sender", async () => {
    const h = await relay({ senderPerMinute: 1 });
    const p = await signSend(alice, bob.address, "once", h.clock.now());
    expect((await send(h.url, p)).status).toBe(200);
    expect((await send(h.url, p)).json.duplicate).toBe(true);
  });

  it("per-recipient hourly limit", async () => {
    const h = await relay({ recipientPerHour: 2 });
    expect((await send(h.url, await signSend(alice, bob.address, "a", h.clock.now()))).status).toBe(200);
    expect((await send(h.url, await signSend(carol, bob.address, "c", h.clock.now()))).status).toBe(200);
    const r = await send(h.url, await signSend(dave, bob.address, "d", h.clock.now()));
    expect(r.status).toBe(429);
    expect(r.json.error).toBe("recipient rate limit");
    expect(r.headers["retry-after"]).toBeDefined();
    expect((await send(h.url, await signSend(dave, carol.address, "d", h.clock.now()))).status).toBe(200);
  });

  it("a full mailbox gives 429 and a full relay gives 503", async () => {
    const h = await relay({ recipientMailbox: 2, totalMessages: 3 });
    expect((await send(h.url, await signSend(alice, bob.address, "1", h.clock.now()))).status).toBe(200);
    expect((await send(h.url, await signSend(carol, bob.address, "2", h.clock.now()))).status).toBe(200);
    const full = await send(h.url, await signSend(dave, bob.address, "3", h.clock.now()));
    expect(full.status).toBe(429);
    expect(full.json.error).toBe("recipient mailbox full");
    expect(Number(full.headers["retry-after"])).toBeGreaterThan(0);
    expect((await send(h.url, await signSend(alice, carol.address, "4", h.clock.now()))).status).toBe(200);
    const relayFull = await send(h.url, await signSend(alice, dave.address, "5", h.clock.now()));
    expect(relayFull.status).toBe(503);
    expect(relayFull.json.error).toBe("relay full");
    expect(relayFull.headers["retry-after"]).toBeDefined();
  });

  it("the total byte budget gives 503 before the message count is reached, and counts content plus signature", async () => {
    const big = "\u20ac".repeat(1_000); // 3 000 UTF-8 bytes
    const h = await relay({ totalBytes: 7_000 });
    expect((await send(h.url, await signSend(alice, bob.address, big, h.clock.now()))).status).toBe(200);
    expect((await send(h.url, await signSend(carol, dave.address, big, h.clock.now()))).status).toBe(200);
    const row = h.relay.db.prepare("SELECT size, length(CAST(content AS BLOB)) + length(signature) AS expected FROM messages LIMIT 1").get() as { size: number; expected: number };
    expect(row.size).toBe(row.expected);
    const full = await send(h.url, await signSend(dave, carol.address, big, h.clock.now()));
    expect(full.status).toBe(503);
    expect(full.json.error).toBe("relay full");
    // A small message still fits under the budget.
    expect((await send(h.url, await signSend(dave, carol.address, "hi", h.clock.now()))).status).toBe(200);
  });

  it("stored messages per IP are capped whatever the sender and recipient keys", async () => {
    const h = await relay({ ipStoredPerHour: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const from = evmSigner();
      const to = evmSigner();
      statuses.push((await send(h.url, await signSend(from, to.address, `m${i}`, h.clock.now()))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // Refused sends (bad signature, duplicates) do not use the budget.
    h.clock.advance(20 * 60_000);
    const p = await signSend(alice, bob.address, "after", h.clock.now());
    expect((await send(h.url, p)).status).toBe(200);
    expect((await send(h.url, p)).json).toMatchObject({ duplicate: true });
    expect((await send(h.url, await signSend(alice, bob.address, "next", h.clock.now()))).status).toBe(429);
  });

  it("a poll over the per-address limit records no nonce", async () => {
    const h = await relay({ pollPerMinute: 1 });
    const nonces = () => (h.relay.db.prepare("SELECT count(*) AS n FROM poll_nonces").get() as { n: number }).n;
    expect((await poll(h, bob)).status).toBe(200);
    expect(nonces()).toBe(1);
    for (let i = 0; i < 3; i++) {
      expect((await poll(h, bob, {}, await pollHeaders(bob, h.clock.now()))).status).toBe(429);
    }
    expect(nonces()).toBe(1);
  });

  it("reading the mailbox frees it: only unread mail counts toward the cap", async () => {
    const h = await relay({ recipientMailbox: 2 });
    expect((await send(h.url, await signSend(mallory, bob.address, "junk-1", h.clock.now()))).status).toBe(200);
    expect((await send(h.url, await signSend(dave, bob.address, "junk-2", h.clock.now()))).status).toBe(200);
    expect((await send(h.url, await signSend(carol, bob.address, "early", h.clock.now()))).status).toBe(429);
    expect((await poll(h, bob)).json.messages).toHaveLength(2);
    h.clock.advance(60_000);
    expect((await send(h.url, await signSend(alice, bob.address, "friend", h.clock.now()))).status).toBe(200);
    expect((await send(h.url, await signSend(carol, bob.address, "friend-2", h.clock.now()))).status).toBe(200);
    // Unread again: the cap applies.
    expect((await send(h.url, await signSend(dave, bob.address, "junk-3", h.clock.now()))).status).toBe(429);
    // Read mail is still retained, so a client that lost its cursor gets it all again.
    expect((await poll(h, bob, { cursor: null })).json.messages).toHaveLength(4);
  });

  it("the per-IP pre-auth bucket refuses a flood of invalid requests with 429", async () => {
    // 8 a minute: a burst of 2, then one every 7.5 s.
    const h = await relay({ ipPerMinute: 8 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await postJson(h.url, "/v1/messages", "{bad")).status);
    expect(statuses).toEqual([400, 400, 429, 429]);
    const r = await postJson(h.url, "/v1/messages", "{bad");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    // Even a valid send is refused before any work while the bucket is empty.
    expect((await send(h.url, await signSend(alice, bob.address, "x", h.clock.now()))).status).toBe(429);
    h.clock.advance(8_000);
    expect((await send(h.url, await signSend(alice, bob.address, "x", h.clock.now()))).status).toBe(200);
  });

  it("the per-address poll bucket", async () => {
    const h = await relay({ pollPerMinute: 2 });
    expect((await poll(h, bob)).status).toBe(200);
    expect((await poll(h, bob)).status).toBe(200);
    const r = await poll(h, bob);
    expect(r.status).toBe(429);
    expect(Number(r.headers["retry-after"])).toBe(30);
    // Another address has its own bucket.
    expect((await poll(h, carol)).status).toBe(200);
    h.clock.advance(30_000);
    expect((await poll(h, bob)).status).toBe(200);
  });

  it("invalid limit overrides are refused at creation", () => {
    const dir = tempDir();
    expect(() => createRelay({ dbPath: path.join(dir, "r.db"), limits: { totalMessages: -1 } })).toThrow(/totalMessages/);
  });
});

describe("TokenBuckets", () => {
  it("evicts the least recently used key past the cap and drops idle keys", () => {
    const clock = makeClock();
    const b = new TokenBuckets(1, 1 / 60_000, clock.now, 3);
    expect(b.take("a")).toBe(0);
    expect(b.take("b")).toBe(0);
    expect(b.take("c")).toBe(0);
    expect(b.take("a")).toBeGreaterThan(0); // a is now most recent
    expect(b.take("d")).toBe(0); // evicts b
    expect(b.size).toBe(3);
    expect(b.take("b")).toBe(0); // b starts again with a full bucket
    clock.advance(11 * 60_000);
    b.take("e");
    expect(b.size).toBe(1);
  });
});

describe("ipKey", () => {
  it("keeps IPv4, maps IPv4-mapped IPv6 to IPv4, and groups IPv6 by /64", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0db8:0001:0002:ffff::9")).toBe("2001:db8:1:2::/64");
    expect(ipKey("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("unknown")).toBe("unknown");
  });

  it("an IPv6 client rotating addresses inside its /64 shares one stored-message budget", async () => {
    const h = await startRelay({ trustProxy: true, limits: { ipStoredPerHour: 2 } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const p = await signSend(evmSigner(), evmSigner().address, `m${i}`, h.clock.now());
        const r = await postJson(h.url, "/v1/messages", p, { "X-Forwarded-For": `2001:db8:5:6::${i + 1}` });
        statuses.push(r.status);
      }
      expect(statuses).toEqual([200, 200, 429]);
      const other = await signSend(evmSigner(), evmSigner().address, "other", h.clock.now());
      expect((await postJson(h.url, "/v1/messages", other, { "X-Forwarded-For": "2001:db8:5:7::1" })).status).toBe(200);
    } finally {
      await h.stop();
    }
  });
});

describe("TokenBuckets idle sweep", () => {
  it("keeps an hourly bucket until it would be full again, so pausing does not reset it", () => {
    const clock = makeClock();
    const b = new TokenBuckets(2, 2 / 3_600_000, clock.now);
    expect(b.take("ip")).toBe(0);
    expect(b.take("ip")).toBe(0);
    expect(b.take("ip")).toBeGreaterThan(0);
    clock.advance(11 * 60_000);
    b.take("other"); // triggers a sweep
    expect(b.take("ip")).toBeGreaterThan(0);
    clock.advance(61 * 60_000);
    b.take("other");
    expect(b.take("ip")).toBe(0);
  });
});
