import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { createRelay, DEFAULT_RETENTION_MS } from "../src/server.js";
import { type Harness, evmSigner, poll, pollHeaders, request, rowCount, send, signSend, startRelay, tempDir } from "./helpers.js";

const HOUR = 3_600_000;
const alice = evmSigner();
const bob = evmSigner();
const carol = evmSigner();

describe("retention", () => {
  const open: Harness[] = [];
  async function relay(retentionMs = HOUR): Promise<Harness> {
    const h = await startRelay({ retentionMs });
    open.push(h);
    return h;
  }
  afterEach(async () => {
    while (open.length) await open.pop()!.stop();
  });

  it("defaults to 7 days", () => {
    expect(DEFAULT_RETENTION_MS).toBe(7 * 24 * HOUR);
  });

  it("an expired message is not returned, even before pruning", async () => {
    const h = await relay();
    await send(h.url, await signSend(alice, bob.address, "short-lived", h.clock.now()));
    h.clock.advance(HOUR - 1_000);
    expect((await poll(h, bob)).json.messages).toHaveLength(1);
    h.clock.advance(1_000);
    expect((await poll(h, bob)).json.messages).toHaveLength(0);
    expect(rowCount(h)).toBe(1); // still on disk until prune
  });

  it("prune() deletes expired messages and expired nonces, and keeps live ones", async () => {
    const h = await relay();
    await send(h.url, await signSend(alice, bob.address, "old", h.clock.now()));
    expect((await poll(h, bob)).status).toBe(200); // records one nonce
    h.clock.advance(30 * 60_000);
    await send(h.url, await signSend(alice, bob.address, "new", h.clock.now()));
    h.clock.advance(31 * 60_000);
    h.relay.prune();
    const contents = h.relay.db.prepare("SELECT content FROM messages").all();
    expect(contents).toEqual([{ content: "new" }]);
    expect((h.relay.db.prepare("SELECT count(*) AS n FROM poll_nonces").get() as { n: number }).n).toBe(0);
  });

  it("prune() forgets recipients with no retained mail without changing their unread count", async () => {
    const h = await relay();
    await send(h.url, await signSend(alice, bob.address, "x", h.clock.now()));
    await poll(h, bob);
    h.clock.advance(HOUR + 1);
    h.relay.prune();
    expect((h.relay.db.prepare("SELECT count(*) AS n FROM recipients").get() as { n: number }).n).toBe(0);
    await send(h.url, await signSend(alice, bob.address, "y", h.clock.now()));
    const r = await request(h.url, "/v1/messages/count", { method: "GET", headers: await pollHeaders(bob, h.clock.now()) });
    expect(r.json).toEqual({ unread: 1 });
  });

  it("seq is not reused after a delete, so an old cursor still works", async () => {
    const h = await relay();
    await send(h.url, await signSend(alice, bob.address, "a", h.clock.now()));
    await send(h.url, await signSend(alice, bob.address, "b", h.clock.now()));
    const page = await poll(h, bob);
    const cursor: string = page.json.next_cursor;
    const cursorSeq = Number(cursor.split(".")[1]);
    expect(cursorSeq).toBe(h.clock.now() + 1);
    h.clock.advance(HOUR + 1);
    h.relay.prune();
    expect(rowCount(h)).toBe(0);
    await send(h.url, await signSend(carol, bob.address, "c", h.clock.now()));
    const seq = (h.relay.db.prepare("SELECT seq FROM messages").get() as { seq: number }).seq;
    expect(seq).toBeGreaterThan(cursorSeq);
    const next = await poll(h, bob, { cursor });
    expect(next.json.messages.map((m: { content: string }) => m.content)).toEqual(["c"]);
  });

  it("a replay after expiry is refused by the signed_at window, never stored again", async () => {
    const h = await relay();
    const p = await signSend(alice, bob.address, "once", h.clock.now());
    expect((await send(h.url, p)).status).toBe(200);
    h.clock.advance(HOUR + 1);
    h.relay.prune();
    expect(rowCount(h)).toBe(0);
    const r = await send(h.url, p);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("signed_at outside window");
    expect(rowCount(h)).toBe(0);
  });

  it("a retention below 1 hour is refused", () => {
    const dir = tempDir();
    expect(() => createRelay({ dbPath: path.join(dir, "r.db"), retentionMs: HOUR - 1 })).toThrow(/at least 1 hour/);
    expect(() => createRelay({ dbPath: path.join(dir, "r.db"), retentionMs: Number.NaN })).toThrow(/at least 1 hour/);
  });

  it("prunes in batches larger than one batch", async () => {
    const h = await relay();
    const insert = h.relay.db.prepare(
      `INSERT INTO messages (id, from_addr, to_addr, content, signed_at, signature, protocol, sig_hash, created_at, expires_at)
       VALUES (?, 'f', 't', 'c', 's', 'sig', 'automaton/1', ?, 0, ?)`,
    );
    h.relay.db.transaction(() => {
      for (let i = 0; i < 12_000; i++) insert.run(`id${i}`, `h${i}`, h.clock.now() - 1);
    })();
    h.relay.prune();
    expect(rowCount(h)).toBe(0);
  });
});
