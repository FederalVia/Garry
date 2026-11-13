import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PREFIX_CONWAY } from "../src/protocol.js";
import {
  type Harness,
  type Signer,
  evmSigner,
  freshNonce,
  poll,
  pollHeaders,
  postJson,
  request,
  send,
  signSend,
  solanaSigner,
  startRelay,
} from "./helpers.js";

async function deliver(h: Harness, from: Signer, to: Signer, n: number, prefix = "m"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await send(h.url, await signSend(from, to.address, `${prefix}${i}`, h.clock.now()));
    expect(r.status).toBe(200);
    ids.push(r.json.id);
  }
  return ids;
}

describe("POST /v1/messages/poll", () => {
  let h: Harness;
  const alice = evmSigner();
  const bob = evmSigner();
  const carol = evmSigner();
  const mallory = evmSigner();

  beforeEach(async () => {
    // Paging sends 120 messages from one sender: lift the per-sender limits here.
    h = await startRelay({ limits: { senderPerMinute: 1_000, senderPerHour: 1_000, pollPerMinute: 1_000 } });
  });
  afterEach(async () => {
    await h.stop();
  });

  it("refuses missing headers and a bad signature with a bare 401", async () => {
    const none = await postJson(h.url, "/v1/messages/poll", {});
    expect(none.status).toBe(401);
    expect(none.json).toEqual({ error: "unauthorized" });
    const headers = await pollHeaders(bob, h.clock.now());
    const bad = await poll(h, bob, {}, { ...headers, "X-Signature": "0x" + "11".repeat(65) });
    expect(bad.status).toBe(401);
    expect(bad.json).toEqual({ error: "unauthorized" });
  });

  it("refuses a poll for Bob signed by Mallory", async () => {
    await deliver(h, alice, bob, 1);
    const forged = await pollHeaders(mallory, h.clock.now());
    const r = await poll(h, bob, {}, { ...forged, "X-Wallet-Address": bob.address });
    expect(r.status).toBe(401);
    expect(r.text).not.toContain("m0");
  });

  it("refuses a timestamp 6 minutes old", async () => {
    const headers = await pollHeaders(bob, h.clock.now() - 6 * 60_000);
    expect((await poll(h, bob, {}, headers)).status).toBe(401);
  });

  it("accepts a nonce once only", async () => {
    const headers = await pollHeaders(bob, h.clock.now());
    expect((await poll(h, bob, {}, headers)).status).toBe(200);
    expect((await poll(h, bob, {}, headers)).status).toBe(401);
    // A captured header stays dead for the whole timestamp window.
    h.clock.advance(4 * 60_000);
    expect((await poll(h, bob, {}, headers)).status).toBe(401);
  });

  it("refuses a nonce that is not 32 lowercase hex characters", async () => {
    for (const nonce of ["xyz", "ABCDEF0123456789ABCDEF0123456789", freshNonce() + "0", ""]) {
      const headers = await pollHeaders(bob, h.clock.now(), { nonce });
      expect((await poll(h, bob, {}, headers)).status).toBe(401);
    }
  });

  it("refuses a legacy Conway poll by default and accepts it with legacyConway", async () => {
    const headers = await pollHeaders(bob, h.clock.now(), { prefix: PREFIX_CONWAY });
    expect(headers["X-Auth-Nonce"]).toBeUndefined();
    expect((await poll(h, bob, {}, headers)).status).toBe(401);

    const legacy = await startRelay({ legacyConway: true });
    try {
      const lh = await pollHeaders(bob, legacy.clock.now(), { prefix: PREFIX_CONWAY });
      const r = await postJson(legacy.url, "/v1/messages/poll", {}, lh);
      expect(r.status).toBe(200);
      // Replayable within the window, exactly as on Conway: documented, and legacy only.
      expect((await postJson(legacy.url, "/v1/messages/poll", {}, lh)).status).toBe(200);
      // A v1 poll still works on a legacy relay, single-use as always.
      const v1 = await pollHeaders(bob, legacy.clock.now());
      expect((await postJson(legacy.url, "/v1/messages/poll", {}, v1)).status).toBe(200);
      expect((await postJson(legacy.url, "/v1/messages/poll", {}, v1)).status).toBe(401);
      // A v1 nonce header with a Conway-form signature is refused.
      expect((await postJson(legacy.url, "/v1/messages/poll", {}, { ...lh, "X-Auth-Nonce": freshNonce() })).status).toBe(401);
    } finally {
      await legacy.stop();
    }
  });

  it("pages 120 messages as 50, 50 and 20, then a stable empty page; in order, no gaps or duplicates", async () => {
    const ids = await deliver(h, alice, bob, 120);
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await poll(h, bob, { cursor, limit: 50 });
      expect(r.status).toBe(200);
      sizes.push(r.json.messages.length);
      seen.push(...r.json.messages.map((m: { id: string }) => m.id));
      expect(typeof r.json.next_cursor).toBe("string");
      cursor = r.json.next_cursor;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual(ids);
    const empty = await poll(h, bob, { cursor, limit: 50 });
    expect(empty.json.messages).toEqual([]);
    expect(empty.json.next_cursor).toBe(cursor);
    const again = await poll(h, bob, { cursor: empty.json.next_cursor });
    expect(again.json.next_cursor).toBe(cursor);
  });

  it("Bob never sees Carol's mail", async () => {
    await deliver(h, alice, carol, 3, "carol-");
    await deliver(h, alice, bob, 1, "bob-");
    const r = await poll(h, bob);
    expect(r.json.messages.map((m: { content: string }) => m.content)).toEqual(["bob-0"]);
  });

  it("a foreign cursor and a cursor from another epoch both restart from the beginning", async () => {
    await deliver(h, alice, bob, 3);
    const first = await poll(h, bob);
    expect(first.json.messages).toHaveLength(3);
    const [epoch, seq] = first.json.next_cursor.split(".");
    expect(epoch).toMatch(/^[0-9a-f]{16}$/);
    expect(Number(seq)).toBe(h.clock.now() + 2);
    for (const cursor of ["abc", "0000000000000000.2", `${epoch}`, "12345", `${epoch}.x`]) {
      const r = await poll(h, bob, { cursor });
      expect(r.status).toBe(200);
      expect(r.json.messages).toHaveLength(3);
    }
  });

  it("a cursor longer than 128 characters (left over from another relay) restarts instead of failing", async () => {
    await deliver(h, alice, bob, 2);
    const r = await poll(h, bob, { cursor: "c".repeat(500) });
    expect(r.status).toBe(200);
    expect(r.json.messages).toHaveLength(2);
  });

  it("refuses a cursor that is not a string", async () => {
    expect((await poll(h, bob, { cursor: 5 })).status).toBe(400);
    expect((await poll(h, bob, { cursor: null })).status).toBe(200);
  });

  it("clamps limit 0 and 1000, and refuses a non-number limit", async () => {
    await deliver(h, alice, bob, 120);
    const low = await poll(h, bob, { limit: 0 });
    expect(low.json.messages).toHaveLength(1);
    const high = await poll(h, bob, { limit: 1_000 });
    expect(high.json.messages).toHaveLength(100);
    const fallback = await poll(h, bob, {});
    expect(fallback.json.messages).toHaveLength(50);
    expect((await poll(h, bob, { limit: "10" })).status).toBe(400);
    expect((await poll(h, bob, "[]")).status).toBe(400);
  });

  it("every message carries signature, signed_at, createdAt and the normalized recipient", async () => {
    const sol = solanaSigner();
    const p = await signSend(alice, bob.address, "hi", h.clock.now(), { replyTo: "r-1" });
    await send(h.url, { ...p, to: "0x" + p.to.slice(2).toUpperCase() });
    await send(h.url, await signSend(sol, bob.address, "gm", h.clock.now()));
    const r = await poll(h, bob);
    expect(r.json.messages).toHaveLength(2);
    const [m1, m2] = r.json.messages;
    expect(m1).toEqual({
      id: expect.any(String),
      from: alice.address,
      to: bob.address,
      content: "hi",
      signature: p.signature,
      signed_at: p.signed_at,
      createdAt: new Date(h.clock.now()).toISOString(),
      replyTo: "r-1",
      protocol: "automaton/1",
    });
    expect(m2.from).toBe(sol.address);
    expect(m2.replyTo).toBeNull();

    // Solana recipients poll with their base58 address as is.
    await send(h.url, await signSend(bob, sol.address, "to sol", h.clock.now()));
    const solPoll = await poll(h, sol);
    expect(solPoll.status).toBe(200);
    expect(solPoll.json.messages.map((m: { to: string }) => m.to)).toEqual([sol.address]);
  });

  it("messages are not deleted on read: a client that lost its cursor gets them again", async () => {
    await deliver(h, alice, bob, 2);
    expect((await poll(h, bob)).json.messages).toHaveLength(2);
    expect((await poll(h, bob)).json.messages).toHaveLength(2);
  });

  it("count reports unread mail relative to the last poll", async () => {
    const count = async () =>
      request(h.url, "/v1/messages/count", { method: "GET", headers: await pollHeaders(bob, h.clock.now()) });
    let r = await count();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ unread: 0 });
    await deliver(h, alice, bob, 5);
    expect((await count()).json).toEqual({ unread: 5 });
    const page = await poll(h, bob, { limit: 3 });
    expect((await count()).json).toEqual({ unread: 2 });
    await poll(h, bob, { cursor: page.json.next_cursor });
    expect((await count()).json).toEqual({ unread: 0 });
    // Polling again from the start does not move the mark backwards.
    await poll(h, bob, { limit: 1 });
    expect((await count()).json).toEqual({ unread: 0 });

    const headers = await pollHeaders(bob, h.clock.now());
    expect((await request(h.url, "/v1/messages/count", { method: "GET", headers })).status).toBe(200);
    expect((await request(h.url, "/v1/messages/count", { method: "GET", headers })).status).toBe(401);
    expect((await request(h.url, "/v1/messages/count", { method: "GET" })).status).toBe(401);
  });

  it("refuses a poll body over 4 096 bytes", async () => {
    const r = await poll(h, bob, { cursor: "x".repeat(5_000) });
    expect(r.status).toBe(413);
  });

  it("refuses a poll that is not application/json", async () => {
    const headers = await pollHeaders(bob, h.clock.now());
    const r = await request(h.url, "/v1/messages/poll", { headers: { ...headers, "Content-Type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(415);
  });
});
