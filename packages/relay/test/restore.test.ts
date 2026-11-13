import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type Harness, evmSigner, makeClock, poll, send, signSend, startRelay, tempDir } from "./helpers.js";

const alice = evmSigner();
const bob = evmSigner();

describe("restoring a backup", () => {
  const open: Harness[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()!.stop();
  });

  async function deliver(h: Harness, content: string): Promise<void> {
    expect((await send(h.url, await signSend(alice, bob.address, content, h.clock.now()))).status).toBe(200);
  }

  /** Sends m1, backs up, sends m2 and m3, lets Bob poll them, then restores the backup and restarts. */
  async function restoredRelay(rotate: (dbPath: string) => void = () => {}) {
    const clock = makeClock();
    const dir = tempDir();
    const first = await startRelay({}, clock, dir);
    await deliver(first, "m1");
    const backup = path.join(dir, "backup.db");
    await first.relay.db.backup(backup);
    clock.advance(60_000);
    await deliver(first, "m2");
    await deliver(first, "m3");
    const page = (await poll(first, bob)).json;
    expect(page.messages).toHaveLength(3);
    const cursor: string = page.next_cursor;
    await first.relay.close();

    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(first.dbPath + suffix, { force: true });
    fs.copyFileSync(backup, first.dbPath);
    rotate(first.dbPath);
    clock.advance(60_000);
    const h = await startRelay({ dbPath: first.dbPath }, clock, dir);
    open.push(h);
    return { h, cursor };
  }

  it("new mail after a restore gets seqs above every earlier cursor, so none is skipped", async () => {
    const { h, cursor } = await restoredRelay();
    await deliver(h, "after-1");
    await deliver(h, "after-2");
    const r = await poll(h, bob, { cursor });
    expect(r.status).toBe(200);
    expect(r.json.messages.map((m: { content: string }) => m.content)).toEqual(["after-1", "after-2"]);
    expect(r.json.next_cursor.split(".")[0]).toBe(cursor.split(".")[0]);
  });

  it("seq stays strictly increasing when many sends share a millisecond or the clock steps back", async () => {
    const h = await startRelay();
    open.push(h);
    for (let i = 0; i < 3; i++) await deliver(h, `same-ms-${i}`);
    h.clock.advance(-10_000);
    await deliver(h, "clock-back");
    const seqs = (h.relay.db.prepare("SELECT seq FROM messages ORDER BY rowid").all() as { seq: number }[]).map((r) => r.seq);
    expect(seqs).toEqual([h.clock.now() + 10_000, h.clock.now() + 10_001, h.clock.now() + 10_002, h.clock.now() + 10_003]);
  });

  it("rotating the epoch as the README says makes every old cursor restart from the beginning", async () => {
    const { h, cursor } = await restoredRelay((dbPath) => {
      const db = new Database(dbPath);
      db.exec("UPDATE meta SET value = lower(hex(randomblob(8))) WHERE key = 'epoch'");
      db.close();
    });
    for (let i = 1; i <= 4; i++) await deliver(h, `after-${i}`);
    const r = await poll(h, bob, { cursor });
    expect(r.json.messages.map((m: { content: string }) => m.content)).toEqual([
      "m1",
      "after-1",
      "after-2",
      "after-3",
      "after-4",
    ]);
    expect(r.json.next_cursor.split(".")[0]).not.toBe(cursor.split(".")[0]);
  });
});
