import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { PREFIX_CONWAY } from "../src/protocol.js";
import {
  type Harness,
  evmSigner,
  postJson,
  request,
  rowCount,
  send,
  signSend,
  solanaSigner,
  startRelay,
} from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("POST /v1/messages", () => {
  let h: Harness;
  const alice = evmSigner();
  const bob = evmSigner();
  const carol = evmSigner();
  const mallory = evmSigner();

  beforeEach(async () => {
    h = await startRelay();
  });
  afterEach(async () => {
    await h.stop();
  });

  it("stores a genuine EVM send with a UUID id and the v1 protocol", async () => {
    const p = await signSend(alice, bob.address, "hello bob", h.clock.now(), { replyTo: "msg-1" });
    const r = await send(h.url, p);
    expect(r.status).toBe(200);
    expect(r.json.id).toMatch(UUID);
    expect(r.json.created_at).toBe(new Date(h.clock.now()).toISOString());
    expect(r.headers["cache-control"]).toBe("no-store");
    const row = h.relay.db.prepare("SELECT * FROM messages").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: r.json.id,
      from_addr: alice.address,
      to_addr: bob.address,
      content: "hello bob",
      signed_at: p.signed_at,
      signature: p.signature,
      protocol: "automaton/1",
      reply_to: "msg-1",
    });
  });

  it("stores a genuine Solana send, keeping base58 case", async () => {
    const sol = solanaSigner();
    const p = await signSend(sol, bob.address, "gm", h.clock.now());
    const r = await send(h.url, p);
    expect(r.status).toBe(200);
    expect(r.json.id).toMatch(UUID);
    const row = h.relay.db.prepare("SELECT from_addr, protocol FROM messages").get() as Record<string, unknown>;
    expect(row).toEqual({ from_addr: sol.address, protocol: "automaton/1" });

    const back = await signSend(bob, sol.address, "gm back", h.clock.now());
    expect((await send(h.url, back)).status).toBe(200);
    const to = h.relay.db.prepare("SELECT to_addr FROM messages WHERE content = 'gm back'").get() as { to_addr: string };
    expect(to.to_addr).toBe(sol.address);
  });

  it("normalizes a mixed-case EVM sender and recipient", async () => {
    const p = await signSend(alice, bob.address, "x", h.clock.now());
    const r = await send(h.url, { ...p, from: "0x" + p.from.slice(2).toUpperCase(), to: "0x" + p.to.slice(2).toUpperCase() });
    expect(r.status).toBe(200);
    const row = h.relay.db.prepare("SELECT from_addr, to_addr FROM messages").get() as Record<string, unknown>;
    expect(row).toEqual({ from_addr: alice.address, to_addr: bob.address });
  });

  it("refuses a forged sender (signed by Mallory, from = Alice) and stores nothing", async () => {
    const p = await signSend(mallory, bob.address, "I am alice", h.clock.now());
    const r = await send(h.url, { ...p, from: alice.address });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "signature does not match sender" });
    expect(rowCount(h)).toBe(0);
  });

  it("refuses tampered content", async () => {
    const p = await signSend(alice, bob.address, "pay 1", h.clock.now());
    expect((await send(h.url, { ...p, content: "pay 1000" })).status).toBe(401);
    expect(rowCount(h)).toBe(0);
  });

  it("refuses a signature made for Carol but posted to Bob", async () => {
    const p = await signSend(alice, carol.address, "for carol", h.clock.now());
    expect((await send(h.url, { ...p, to: bob.address })).status).toBe(401);
    expect(rowCount(h)).toBe(0);
  });

  it("refuses signed_at 6 minutes old or more than 2 minutes in the future (the client's own skew)", async () => {
    const old = await signSend(alice, bob.address, "old", h.clock.now() - 6 * 60_000);
    const r1 = await send(h.url, old);
    expect(r1.status).toBe(400);
    expect(r1.json.error).toBe("signed_at outside window");
    const future = await signSend(alice, bob.address, "future", h.clock.now() + 2 * 60_000 + 1_000);
    expect((await send(h.url, future)).status).toBe(400);
    // Inside the window on both sides is fine, including a clock 90 s fast.
    expect((await send(h.url, await signSend(alice, bob.address, "a", h.clock.now() - 4 * 60_000))).status).toBe(200);
    expect((await send(h.url, await signSend(alice, bob.address, "b", h.clock.now() + 30_000))).status).toBe(200);
    expect((await send(h.url, await signSend(alice, bob.address, "c", h.clock.now() + 90_000))).status).toBe(200);
  });

  it("refuses a bad timestamp format", async () => {
    const p = await signSend(alice, bob.address, "x", h.clock.now());
    for (const signed_at of ["2026-03-01 12:00:00Z", "yesterday", "2026-03-01T12:00:00+01:00", ""]) {
      const r = await send(h.url, { ...p, signed_at });
      expect(r.status).toBe(400);
    }
  });

  it("refuses a declared body over the cap with 413 before reading it", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`${h.url}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(600_000) },
      });
      req.on("response", (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      // Only the headers and a few bytes are ever sent: the reply must not wait for the rest.
      req.write("{");
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "body too large" });
  });

  it("refuses a streamed body over the cap", async () => {
    const h2 = await startRelay({ limits: { maxBodyBytes: 2_000 } });
    try {
      const res = await new Promise<number>((resolve) => {
        const req = http.request(`${h2.url}/v1/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
        });
        req.on("response", (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        // The relay may close the socket once it has replied.
        req.on("error", () => resolve(-1));
        req.write("x".repeat(1_500));
        setTimeout(() => req.write("x".repeat(1_500)), 20);
      });
      expect(res).toBe(413);
      expect(rowCount(h2)).toBe(0);
    } finally {
      await h2.stop();
    }
  });

  it("accepts the largest client message even when it is all multi-byte text", async () => {
    // 64 000 UTF-16 units of 3-byte characters: about 192 KB on the wire.
    const content = "€".repeat(64_000);
    const p = await signSend(alice, bob.address, content, h.clock.now());
    const r = await send(h.url, p);
    expect(r.status).toBe(200);
  });

  it("refuses content over 64 000 units, empty content, bad JSON and non-string fields", async () => {
    const big = await signSend(alice, bob.address, "a".repeat(64_001), h.clock.now());
    expect((await send(h.url, big)).json.error).toBe("invalid content");
    const empty = await signSend(alice, bob.address, "", h.clock.now());
    expect((await send(h.url, empty)).status).toBe(400);
    const bad = await postJson(h.url, "/v1/messages", "{not json");
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: "invalid json" });
    expect((await postJson(h.url, "/v1/messages", "[1,2]")).status).toBe(400);
    const p = await signSend(alice, bob.address, "x", h.clock.now());
    for (const field of ["from", "to", "content", "signed_at", "signature"]) {
      const r = await send(h.url, { ...p, [field]: 42 });
      expect(r.status).toBe(400);
    }
    expect((await send(h.url, { ...p, reply_to: 7 })).status).toBe(400);
    expect(rowCount(h)).toBe(0);
  });

  it("refuses content with an unpaired surrogate, which SQLite could not return exactly", async () => {
    for (const content of ["hi \ud83d there", "x\udc00", "\ud800"]) {
      const p = await signSend(alice, bob.address, content, h.clock.now());
      const r = await send(h.url, p);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: "invalid content" });
    }
    expect(rowCount(h)).toBe(0);
    // A properly paired emoji is fine.
    expect((await send(h.url, await signSend(alice, bob.address, "hi \ud83d\ude00", h.clock.now()))).status).toBe(200);
  });

  it("refuses bad addresses, a sender writing to itself and a bad reply_to", async () => {
    const p = await signSend(alice, bob.address, "x", h.clock.now());
    expect((await send(h.url, { ...p, from: "0x123" })).json.error).toBe("invalid sender");
    expect((await send(h.url, { ...p, to: "bob" })).json.error).toBe("invalid recipient");
    const self = await signSend(alice, alice.address, "me", h.clock.now());
    expect((await send(h.url, self)).json.error).toBe("sender is recipient");
    const reply = await signSend(alice, bob.address, "x", h.clock.now(), { replyTo: "has space" });
    expect((await send(h.url, reply)).json.error).toBe("invalid reply_to");
    expect((await send(h.url, { ...p, reply_to: "r".repeat(129) })).status).toBe(400);
    expect((await send(h.url, { ...p, reply_to: null })).status).toBe(200);
  });

  it("refuses a malformed signature with 400 before verifying", async () => {
    const p = await signSend(alice, bob.address, "x", h.clock.now());
    const r = await send(h.url, { ...p, signature: "0x1234" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid signature");
  });

  it("refuses a content type other than application/json with 415", async () => {
    const p = await signSend(alice, bob.address, "x", h.clock.now());
    const r = await request(h.url, "/v1/messages", {
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(p),
    });
    expect(r.status).toBe(415);
    expect((await postJson(h.url, "/v1/messages", p, { "Content-Type": "application/json; charset=utf-8" })).status).toBe(200);
  });

  it("never echoes request data in an error", async () => {
    const p = await signSend(alice, bob.address, "<script>secret</script>", h.clock.now());
    const r = await send(h.url, { ...p, from: "<script>evil</script>" });
    expect(r.text).not.toContain("script");
  });

  it("treats a replayed payload as a duplicate: same id, one row", async () => {
    const p = await signSend(alice, bob.address, "once", h.clock.now());
    const r1 = await send(h.url, p);
    const r2 = await send(h.url, p);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.json).toEqual({ id: r1.json.id, duplicate: true });
    expect(r1.json.duplicate).toBeUndefined();
    expect(rowCount(h)).toBe(1);
  });

  it("refuses a stale replay once the clock has moved 6 minutes", async () => {
    const p = await signSend(alice, bob.address, "once", h.clock.now());
    expect((await send(h.url, p)).status).toBe(200);
    h.clock.advance(6 * 60_000);
    const r = await send(h.url, p);
    expect(r.status).toBe(400);
    expect(rowCount(h)).toBe(1);
  });

  it("refuses a Conway-signed send by default and accepts it with legacyConway", async () => {
    const p = await signSend(alice, bob.address, "old style", h.clock.now(), { prefix: PREFIX_CONWAY });
    expect((await send(h.url, p)).status).toBe(401);
    expect(rowCount(h)).toBe(0);

    const legacy = await startRelay({ legacyConway: true });
    try {
      const p2 = await signSend(alice, bob.address, "old style", legacy.clock.now(), { prefix: PREFIX_CONWAY });
      expect((await send(legacy.url, p2)).status).toBe(200);
      const v1 = await signSend(alice, bob.address, "new style", legacy.clock.now());
      expect((await send(legacy.url, v1)).status).toBe(200);
      const rows = legacy.relay.db.prepare("SELECT content, protocol FROM messages ORDER BY seq").all();
      expect(rows).toEqual([
        { content: "old style", protocol: "conway" },
        { content: "new style", protocol: "automaton/1" },
      ]);
    } finally {
      await legacy.stop();
    }
  });

  it("allowlists refuse a sender or recipient not on them with 403", async () => {
    const priv = await startRelay({
      allowedSenders: [alice.address.toUpperCase().replace("0X", "0x")],
      allowedRecipients: [bob.address],
    });
    try {
      expect((await send(priv.url, await signSend(alice, bob.address, "ok", priv.clock.now()))).status).toBe(200);
      const r1 = await send(priv.url, await signSend(carol, bob.address, "no", priv.clock.now()));
      expect(r1.status).toBe(403);
      expect(r1.json.error).toBe("sender not allowed");
      const r2 = await send(priv.url, await signSend(alice, carol.address, "no", priv.clock.now()));
      expect(r2.status).toBe(403);
      expect(r2.json.error).toBe("recipient not allowed");
      expect(rowCount(priv)).toBe(1);
    } finally {
      await priv.stop();
    }
  });
});
