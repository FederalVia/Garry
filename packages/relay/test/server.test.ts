import { describe, it, expect } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { createRelay, RELAY_VERSION } from "../src/server.js";
import { SCHEMA_VERSION } from "../src/store.js";
import { evmSigner, makeClock, poll, request, send, signSend, startRelay, tempDir } from "./helpers.js";

const alice = evmSigner();
const bob = evmSigner();

describe("relay server", () => {
  it("404 for an unknown path, 405 with Allow for a wrong method, /healthz with no data", async () => {
    const h = await startRelay();
    try {
      const nf = await request(h.url, "/v1/nope", { method: "GET" });
      expect(nf.status).toBe(404);
      expect(nf.json).toEqual({ error: "not found" });
      const wrong = await request(h.url, "/v1/messages", { method: "GET" });
      expect(wrong.status).toBe(405);
      expect(wrong.headers.allow).toBe("POST");
      expect((await request(h.url, "/v1/messages/count", { method: "POST" })).status).toBe(405);
      const health = await request(h.url, "/healthz", { method: "GET" });
      expect(health.status).toBe(200);
      expect(health.json).toEqual({ ok: true, version: RELAY_VERSION });
      expect(health.headers["cache-control"]).toBe("no-store");
      // Query strings do not change routing.
      expect((await request(h.url, "/healthz?x=1", { method: "GET" })).status).toBe(200);
    } finally {
      await h.stop();
    }
  });

  it("the reported version matches package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(RELAY_VERSION).toBe(pkg.version);
  });

  it("listens on loopback and resolves its URL", async () => {
    const h = await startRelay();
    try {
      expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await h.stop();
    }
  });

  it("close() resolves promptly with a keep-alive client connected", async () => {
    const h = await startRelay();
    const agent = new http.Agent({ keepAlive: true });
    try {
      const r = await request(h.url, "/healthz", { method: "GET", agent });
      expect(r.status).toBe(200);
      const started = Date.now();
      await h.relay.close();
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(h.relay.db.open).toBe(false);
      await h.relay.close(); // idempotent
    } finally {
      agent.destroy();
      await h.stop();
    }
  });

  it("refuses to open a DB whose schema is newer than this relay", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "relay.db");
    const db = new Database(dbPath);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => createRelay({ dbPath })).toThrow("relay DB schema 2 is newer than this relay");
  });

  it("creates schema version 1 with a private file", async () => {
    const h = await startRelay();
    try {
      expect(h.relay.db.pragma("user_version", { simple: true })).toBe(1);
      expect(h.relay.db.pragma("journal_mode", { simple: true })).toBe("wal");
      const tables = (h.relay.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]).map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(["meta", "messages", "poll_nonces", "recipients"]));
      expect(fs.statSync(h.dbPath).mode & 0o777).toBe(0o600);
    } finally {
      await h.stop();
    }
  });

  it("a restart on the same file keeps the epoch and the messages", async () => {
    const dir = tempDir();
    const clock = makeClock();
    const first = await startRelay({}, clock, dir);
    await send(first.url, await signSend(alice, bob.address, "kept", clock.now()));
    const page1 = await poll(first, bob);
    await first.relay.close();

    const second = await startRelay({ dbPath: first.dbPath }, clock, dir);
    try {
      const again = await poll(second, bob);
      expect(again.json.messages.map((m: { content: string }) => m.content)).toEqual(["kept"]);
      expect(again.json.next_cursor).toBe(page1.json.next_cursor);
      const after = await poll(second, bob, { cursor: page1.json.next_cursor });
      expect(after.json.messages).toEqual([]);
    } finally {
      await second.stop();
    }
  });

  it("a wiped DB gets a new epoch, so an old cursor restarts from the beginning", async () => {
    const clock = makeClock();
    const first = await startRelay({}, clock);
    await send(first.url, await signSend(alice, bob.address, "one", clock.now()));
    const oldCursor = (await poll(first, bob)).json.next_cursor;
    await first.stop();

    const fresh = await startRelay({}, clock);
    try {
      await send(fresh.url, await signSend(alice, bob.address, "after wipe", clock.now()));
      const r = await poll(fresh, bob, { cursor: oldCursor });
      expect(r.json.messages.map((m: { content: string }) => m.content)).toEqual(["after wipe"]);
    } finally {
      await fresh.stop();
    }
  });

  it("the access log has method, route, status and duration only", async () => {
    const h = await startRelay({ accessLog: true });
    try {
      const p = await signSend(alice, bob.address, "very secret content", h.clock.now());
      await send(h.url, p);
      await request(h.url, `/v1/${alice.address}`, { method: "GET" });
      await poll(h, bob);
      const access = h.logs.filter((l) => l.startsWith("info "));
      expect(access).toHaveLength(3);
      expect(access[0]).toMatch(/^info POST \/v1\/messages 200 \d+ms$/);
      expect(access[1]).toMatch(/^info GET \(unknown\) 404 \d+ms$/);
      const all = h.logs.join("\n");
      expect(all).not.toContain("very secret content");
      expect(all).not.toContain(p.signature);
      expect(all).not.toContain(alice.address);
      expect(all).not.toContain(bob.address);
    } finally {
      await h.stop();
    }
  });

  it("auth failures are logged at debug level with a shortened address only", async () => {
    const h = await startRelay();
    try {
      const r = await request(h.url, "/v1/messages/poll", {
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Address": bob.address,
          "X-Timestamp": new Date(h.clock.now()).toISOString(),
          "X-Signature": "0x" + "11".repeat(65),
          "X-Auth-Nonce": "0".repeat(32),
        },
        body: "{}",
      });
      expect(r.status).toBe(401);
      const debug = h.logs.filter((l) => l.startsWith("debug "));
      expect(debug).toHaveLength(1);
      expect(debug[0]).toContain("bad signature");
      expect(debug[0]).toContain(bob.address.slice(0, 6));
      expect(debug[0]).not.toContain(bob.address);
    } finally {
      await h.stop();
    }
  });

  it("an internal error gives a bare 500", async () => {
    const h = await startRelay();
    try {
      h.relay.db.exec("DROP TABLE messages");
      const r = await send(h.url, await signSend(alice, bob.address, "x", h.clock.now()));
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ error: "internal error" });
      expect(h.logs.some((l) => l.startsWith("error "))).toBe(true);
    } finally {
      await h.stop();
    }
  });
});
