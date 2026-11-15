/**
 * The container healthcheck: healthy while the heartbeat runs, unhealthy
 * when it is stale or has never run, and it never writes state.db.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHealth, DEFAULT_MAX_AGE_MS, maxAgeFromEnv, stateDbPath } from "../healthcheck.js";
import { createDatabase } from "../state/database.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
let home: string;
let dbPath: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "healthcheck-")));
  fs.mkdirSync(path.join(home, ".automaton"), { mode: 0o700 });
  dbPath = path.join(home, ".automaton", "state.db");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A real state.db with one heartbeat row at `startedAt`. */
function seed(startedAt: string | null): void {
  const db = createDatabase(dbPath);
  if (startedAt) {
    db.raw
      .prepare("INSERT OR IGNORE INTO heartbeat_schedule (task_name, cron_expression) VALUES ('health_check', '*/30 * * * *')")
      .run();
    db.raw
      .prepare("INSERT INTO heartbeat_history (id, task_name, started_at, result) VALUES (?, 'health_check', ?, 'success')")
      .run(crypto.randomUUID(), startedAt);
  }
  db.close();
}

function digest(file: string): string {
  // Content as SQLite sees it: every table's rows.
  const db = new Database(file, { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  const h = crypto.createHash("sha256");
  for (const t of tables) h.update(t.name + JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all()));
  db.close();
  return h.digest("hex");
}

describe("healthcheck", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");

  it("is healthy with a recent heartbeat", () => {
    seed(new Date(now - 5 * 60_000).toISOString());
    const r = checkHealth({ home, now });
    expect(r.ok).toBe(true);
    expect(r.lastBeatMs).toBe(now - 5 * 60_000);
  });

  it("is unhealthy when the heartbeat is stale", () => {
    seed(new Date(now - DEFAULT_MAX_AGE_MS - 60_000).toISOString());
    const r = checkHealth({ home, now });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/min ago/);
  });

  it("is unhealthy when no heartbeat ran yet, and when there is no state.db", () => {
    expect(checkHealth({ home, now }).ok).toBe(false);
    seed(null);
    const r = checkHealth({ home, now });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no heartbeat/);
    // fileMustExist: a missing database is not created.
    fs.rmSync(path.join(home, ".automaton"), { recursive: true });
    expect(checkHealth({ home, now }).ok).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("never writes state.db", () => {
    seed(new Date(now - 60_000).toISOString());
    const before = digest(dbPath);
    const raw = fs.readFileSync(dbPath);
    const files = fs.readdirSync(path.dirname(dbPath)).sort();
    for (let i = 0; i < 3; i++) expect(checkHealth({ home, now }).ok).toBe(true);
    expect(digest(dbPath)).toBe(before);
    expect(fs.readFileSync(dbPath).equals(raw)).toBe(true);
    // Only SQLite's own WAL index files may appear next to it.
    const after = fs.readdirSync(path.dirname(dbPath)).filter((f) => !/-(wal|shm)$/.test(f)).sort();
    expect(after).toEqual(files.filter((f) => !/-(wal|shm)$/.test(f)));
  });

  it("follows dbPath from automaton.json without validating or rewriting it", () => {
    const cfg = path.join(home, ".automaton", "automaton.json");
    fs.writeFileSync(cfg, JSON.stringify({ dbPath: "~/.automaton/other.db", budget: "not valid" }));
    const mtime = fs.statSync(cfg).mtimeMs;
    expect(stateDbPath(home)).toBe(path.join(home, ".automaton", "other.db"));
    dbPath = path.join(home, ".automaton", "other.db");
    seed(new Date(now - 60_000).toISOString());
    expect(checkHealth({ home, now }).ok).toBe(true);
    expect(fs.statSync(cfg).mtimeMs).toBe(mtime);
  });

  it("reads the maximum age from the environment", () => {
    expect(maxAgeFromEnv({})).toBe(DEFAULT_MAX_AGE_MS);
    expect(maxAgeFromEnv({ AUTOMATON_HEALTH_MAX_AGE_MIN: "10" })).toBe(600_000);
    expect(maxAgeFromEnv({ AUTOMATON_HEALTH_MAX_AGE_MIN: "x" })).toBe(DEFAULT_MAX_AGE_MS);
  });

  it("exits 0 when healthy and 1 when not, as a script", () => {
    const run = () =>
      spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "src", "healthcheck.ts")], {
        cwd: ROOT,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 60_000,
      });
    let r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toMatch(/^unhealthy/);
    seed(new Date().toISOString());
    r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^healthy/);
  });
});
