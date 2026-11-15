/**
 * security: under the documented dedicated-user layout the agent's own
 * shell cannot change its config, wallet, provider prices or owner database,
 * and the container entrypoint refuses a layout where it could.
 *
 * The file-system half needs root (it builds the layout with
 * scripts/lock-owner-files.sh and runs the writes as uid/gid 65534); it is
 * skipped elsewhere. The tripwire half runs everywhere.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCommandSafetyRules,
  getForbiddenCommandMatch,
} from "../agent/policy-rules/command-safety.js";
import type { AutomatonTool, PolicyRequest, ToolContext } from "../types.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LOCK = path.join(ROOT, "scripts", "lock-owner-files.sh");
const ENTRYPOINT_SRC = path.join(ROOT, "deploy", "entrypoint.sh");
const AGENT = 65534;

const isRoot = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
const nogroup = (() => {
  if (!isRoot) return "";
  const r = spawnSync("getent", ["group", String(AGENT)], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(":")[0]! : "";
})();
const rootOnly = isRoot && nogroup ? describe : describe.skip;
if (!isRoot) {
  // eslint-disable-next-line no-console
  console.info("config-readonly-exec: file-system checks need root on Linux (they switch to uid 65534); skipped");
}

// CI runs this file as root and sets the variable, so a skip there is a failure.
describe("security: read-only layout test preconditions", () => {
  it("runs the file-system checks where they are required", () => {
    if (process.env.AUTOMATON_REQUIRE_ROOT_LAYOUT_TESTS) {
      expect(isRoot, "must run as root on Linux").toBe(true);
      expect(nogroup, "group 65534 must exist").not.toBe("");
    }
  });
});

const OWNER_FILES = [
  "automaton.json",
  "wallet.json",
  "config.json",
  "heartbeat.yml",
  "constitution.md",
  "inference-providers.json",
  "mcp-servers.json",
];

function sha(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Run a shell command as the agent user (uid/gid 65534). */
function asAgent(cmd: string, opts: { cwd: string; env?: Record<string, string> }) {
  return spawnSync("/bin/sh", ["-c", cmd], {
    cwd: opts.cwd,
    uid: AGENT,
    gid: AGENT,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, ...(opts.env ?? {}) },
    encoding: "utf8",
    timeout: 20_000,
  });
}

/** The agent user must be able to reach the temp folders. */
function openAncestors(dir: string): void {
  const stop = path.dirname(fs.realpathSync(os.tmpdir()));
  for (let d = dir; d !== stop && d !== path.dirname(d); d = path.dirname(d)) {
    const mode = fs.statSync(d).mode & 0o777;
    if ((mode & 0o001) === 0) fs.chmodSync(d, mode | 0o011);
  }
}

/** What the setup wizard leaves behind when run as the agent user. */
function seedState(state: string, config: Record<string, unknown> = { name: "a", providers: { mode: "standalone" } }): void {
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(state, "automaton.json"), JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "wallet.json"), JSON.stringify({ privateKey: "0x" + "1".repeat(64) }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "heartbeat.yml"), "entries: []\n", { mode: 0o600 });
  fs.mkdirSync(path.join(state, "owner"), { mode: 0o700 });
  const db = new Database(path.join(state, "owner", "owner.db"));
  db.pragma("journal_mode = DELETE");
  db.exec("CREATE TABLE budget_grants (id INTEGER PRIMARY KEY, amount_cents INTEGER NOT NULL)");
  db.close();
  for (const p of [state, ...fs.readdirSync(state).map((f) => path.join(state, f)), path.join(state, "owner", "owner.db")]) {
    fs.chownSync(p, AGENT, AGENT);
  }
}

function lock(state: string) {
  return spawnSync("/bin/sh", [LOCK, state, nogroup], { encoding: "utf8" });
}

let base: string;
let fakeApp: string;
let ENTRYPOINT: string;

/** A fake /app whose index.js only reports that it started, and a copy of the entrypoint the agent user can read. */
function makeFakeApp(dir: string): void {
  fakeApp = path.join(dir, "app");
  fs.mkdirSync(path.join(fakeApp, "dist"), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, "dist", "index.js"), 'console.log("STARTED " + process.argv.slice(2).join(" "));\n');
  ENTRYPOINT = path.join(dir, "entrypoint.sh");
  fs.copyFileSync(ENTRYPOINT_SRC, ENTRYPOINT);
  fs.chmodSync(ENTRYPOINT, 0o555);
}

rootOnly("security: dedicated-user layout (lock-owner-files.sh)", () => {
  let home: string;
  let state: string;
  let hashes: Map<string, string>;
  const guarded = () => [...OWNER_FILES.map((f) => path.join(state, f)), path.join(state, "owner", "owner.db")];

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ro-layout-")));
    fs.chmodSync(base, 0o755);
    openAncestors(base);
    makeFakeApp(base);
    home = path.join(base, "home");
    fs.mkdirSync(home, { mode: 0o755 });
    state = path.join(home, ".automaton");
    seedState(state);

    const r = lock(state);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("created " + path.join(state, "config.json"));
    expect(r.stdout).toContain("created " + path.join(state, "inference-providers.json"));
    expect(r.stdout).toContain("created " + path.join(state, "mcp-servers.json"));
    hashes = new Map(guarded().map((p) => [p, sha(p)]));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("sets root ownership, group read and a sticky state folder", () => {
    for (const p of guarded()) {
      const st = fs.statSync(p);
      expect(st.uid, p).toBe(0);
      expect(st.gid, p).toBe(AGENT);
      expect(st.mode & 0o022, p).toBe(0);
    }
    const s = fs.statSync(state);
    expect(s.uid).toBe(0);
    expect(s.mode & 0o7777).toBe(0o1770);
    const o = fs.statSync(path.join(state, "owner"));
    expect([o.uid, o.mode & 0o777]).toEqual([0, 0o750]);
  });

  it("is idempotent", () => {
    const r = lock(state);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already locked");
  });

  const attacks = (f: string): string[] => [
    `echo x >> ${f}`,
    `: > ${f}`,
    `echo '{}' > planted.$$ && mv -f planted.$$ ${f}`,
    `rm -f ${f}`,
    `ln -sf /etc/hostname ${f}`,
    `chmod 666 ${f}`,
    `cp /etc/hostname ${f}`,
  ];

  for (const f of ["automaton.json", "wallet.json", "inference-providers.json", "mcp-servers.json", "heartbeat.yml", "owner/owner.db"]) {
    it(`the agent's shell cannot change ${f}`, () => {
      for (const cmd of attacks(f)) {
        const r = asAgent(cmd, { cwd: state });
        expect(r.status, `${cmd} should fail`).not.toBe(0);
        for (const [p, h] of hashes) {
          expect(fs.lstatSync(p).isFile(), `${p} after ${cmd}`).toBe(true);
          expect(sha(p), `${p} after ${cmd}`).toBe(h);
          expect(fs.statSync(p).uid, `${p} after ${cmd}`).toBe(0);
        }
      }
    });
  }

  it("cannot plant a journal next to owner.db or replace the owner folder", () => {
    for (const cmd of ["touch owner/owner.db-journal", "mv owner owner.old", "rm -rf owner", "mkdir owner/x"]) {
      const r = asAgent(cmd, { cwd: state });
      expect(r.status, cmd).not.toBe(0);
    }
    expect(fs.existsSync(path.join(state, "owner", "owner.db-journal"))).toBe(false);
    expect(fs.statSync(path.join(state, "owner")).uid).toBe(0);
  });

  it("the agent can still create and change its own files in the state folder", () => {
    const r = asAgent("echo hi > agent-note.txt && echo more >> agent-note.txt && mkdir -p workspace && touch workspace/x", { cwd: state });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.statSync(path.join(state, "agent-note.txt")).uid).toBe(AGENT);
  });

  it("the entrypoint starts the agent on this layout", () => {
    const r = asAgent(`sh ${ENTRYPOINT} run`, { cwd: base, env: { HOME: home, AUTOMATON_APP_DIR: fakeApp } });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("STARTED --run");
  });

  it("reconfiguring as root (the documented procedure) works and the lock script restores the layout", async () => {
    const cfg = path.join(state, "automaton.json");
    // As the agent user, a save (temp file, then rename over) is refused by the sticky folder.
    const denied = asAgent(`echo '{}' > automaton.json.tmp-1 && mv -f automaton.json.tmp-1 automaton.json`, { cwd: state });
    expect(denied.status).not.toBe(0);
    asAgent("rm -f automaton.json.tmp-1", { cwd: state });
    expect(sha(cfg)).toBe(hashes.get(cfg));

    // As root, the runtime's own writer replaces it (what --configure's save does).
    const { writeFileSafe } = await import("../security/secure-fs.js");
    const next = JSON.stringify({ name: "b", providers: { mode: "standalone" } });
    writeFileSafe(cfg, next, { trustedWriter: true, mode: 0o600 });
    expect(fs.readFileSync(cfg, "utf8")).toBe(next);
    expect([fs.statSync(cfg).uid, fs.statSync(cfg).gid, fs.statSync(cfg).mode & 0o777]).toEqual([0, 0, 0o600]);
    // Unreadable to the agent until locked again.
    expect(asAgent("cat automaton.json", { cwd: state }).status).not.toBe(0);

    const r = lock(state);
    expect(r.status, r.stderr).toBe(0);
    expect([fs.statSync(cfg).uid, fs.statSync(cfg).gid, fs.statSync(cfg).mode & 0o777]).toEqual([0, AGENT, 0o640]);
    const started = asAgent(`sh ${ENTRYPOINT} run`, { cwd: base, env: { HOME: home, AUTOMATON_APP_DIR: fakeApp } });
    expect(started.stdout).toContain("STARTED --run");
    hashes.set(cfg, sha(cfg));
  });

  it("the entrypoint refuses root", () => {
    const r = spawnSync("/bin/sh", [ENTRYPOINT, "run"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, AUTOMATON_APP_DIR: fakeApp },
      encoding: "utf8",
    });
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/as root/);
  });
});

rootOnly("security: the entrypoint refuses a layout the agent could change", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ro-entry-")));
    fs.chmodSync(dir, 0o755);
    openAncestors(dir);
    makeFakeApp(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function layout(name: string, config?: Record<string, unknown>): { home: string; state: string } {
    const home = path.join(dir, name);
    fs.mkdirSync(home, { mode: 0o755 });
    const state = path.join(home, ".automaton");
    seedState(state, config);
    return { home, state };
  }
  const start = (home: string) => asAgent(`sh ${ENTRYPOINT} run`, { cwd: dir, env: { HOME: home, AUTOMATON_APP_DIR: fakeApp } });

  it("refuses root-owned read-only files that sit in a folder the agent owns (replaceable)", () => {
    const { home, state } = layout("replaceable");
    fs.writeFileSync(path.join(state, "config.json"), "{}");
    fs.writeFileSync(path.join(state, "inference-providers.json"), "{}");
    fs.writeFileSync(path.join(state, "mcp-servers.json"), "{}");
    fs.copyFileSync(path.join(ROOT, "constitution.md"), path.join(state, "constitution.md"));
    for (const f of [...OWNER_FILES, "owner"]) {
      fs.chownSync(path.join(state, f), 0, 0);
      fs.chmodSync(path.join(state, f), f === "owner" ? 0o755 : 0o644);
    }
    fs.chownSync(path.join(state, "owner", "owner.db"), 0, 0);
    fs.chmodSync(path.join(state, "owner", "owner.db"), 0o644);
    // State folder stays agent-owned, not sticky: every name can be renamed away.
    const r = start(home);
    expect(r.status).toBe(64);
    expect(r.stdout).not.toContain("STARTED");
    expect(r.stderr).toMatch(/automaton\.json sits in a folder the agent user can write/);
    expect(r.stderr).toMatch(/owner sits in a folder the agent user can write/);
  });

  it("refuses an owner file the agent owns, and a missing one", () => {
    const { home, state } = layout("missing");
    expect(lock(state).status).toBe(0);
    fs.rmSync(path.join(state, "inference-providers.json"));
    fs.chownSync(path.join(state, "heartbeat.yml"), AGENT, AGENT);
    fs.chmodSync(path.join(state, "heartbeat.yml"), 0o444);
    const r = start(home);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/inference-providers\.json is missing/);
    expect(r.stderr).toMatch(/heartbeat\.yml is owned by the agent user/);
  });

  it("refuses a writable owner database", () => {
    const { home, state } = layout("owner-writable");
    expect(lock(state).status).toBe(0);
    fs.chownSync(path.join(state, "owner", "owner.db"), AGENT, AGENT);
    fs.chmodSync(path.join(state, "owner", "owner.db"), 0o644);
    const r = start(home);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/owner\.db is writable/);
  });

  it("refuses a config the runtime would have to write at startup", () => {
    const { home, state } = layout("unpinned", { name: "a" });
    expect(lock(state).status).toBe(0);
    const r = start(home);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/sets no providers\.mode/);
  });

  it("starts anyway with the explicit override, and says so", () => {
    const { home } = layout("override");
    const r = asAgent(`sh ${ENTRYPOINT} run`, {
      cwd: dir,
      env: { HOME: home, AUTOMATON_APP_DIR: fakeApp, AUTOMATON_ALLOW_WRITABLE_CONFIG: "1" },
    });
    expect(r.stdout).toContain("STARTED");
    expect(r.stderr).toMatch(/WARNING: AUTOMATON_ALLOW_WRITABLE_CONFIG=1/);
  });
});

function execRequest(command: string): PolicyRequest {
  const tool: AutomatonTool = {
    name: "exec",
    description: "exec",
    category: "vm",
    riskLevel: "caution",
    parameters: {},
    execute: async () => "",
  };
  return {
    tool,
    args: { command },
    context: {} as ToolContext,
    turnContext: {
      inputSource: "agent",
      turnToolCallCount: 0,
      sessionSpend: {
        recordSpend: () => {},
        getHourlySpend: () => 0,
        getDailySpend: () => 0,
        getTotalSpend: () => 0,
        checkLimit: () => ({ allowed: true, currentHourlySpend: 0, currentDailySpend: 0, limitHourly: 0, limitDaily: 0 }),
        pruneOldRecords: () => 0,
      },
    },
  };
}

describe("security: the exec tripwire refuses the same writes", () => {
  const rule = createCommandSafetyRules().find((r) => r.id === "command.forbidden_patterns")!;
  const commands = [
    "echo x >> ~/.automaton/automaton.json",
    ": > ~/.automaton/wallet.json",
    "mv /tmp/x ~/.automaton/automaton.json",
    "rm -f ~/.automaton/wallet.json",
    "ln -sf /tmp/x ~/.automaton/automaton.json",
    "chmod 666 ~/.automaton/automaton.json",
    "echo '{\"providers\":[]}' > ~/.automaton/inference-providers.json",
    "echo '{\"version\":1}' > ~/.automaton/mcp-servers.json",
    "sqlite3 ~/.automaton/owner/owner.db 'INSERT INTO budget_grants VALUES (1)'",
    "touch ~/.automaton/owner/owner.db-journal",
    "mv ~/.automaton/owner ~/.automaton/owner.old",
    "cd ~/.automaton && echo '{}' > config.json",
  ];
  for (const cmd of commands) {
    it(`denies: ${cmd}`, () => {
      expect(getForbiddenCommandMatch(cmd)).not.toBeNull();
      const result = rule.evaluate(execRequest(cmd));
      expect(result?.action).toBe("deny");
    });
  }
});
