/**
 * security: the container's owner services (setup, configure) never touch
 * the agent's state folder entries that the agent service bind-mounts its
 * read-only owner files onto. Unlinking or replacing one of those files from
 * another container detaches the agent's read-only bind and hands it a
 * writable copy, so setup and configure work in a private ~/.automaton and
 * move the results to data/config only.
 *
 * Runs the real deploy/entrypoint.sh with a fake app; no Docker, no root.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../state/instance-lock.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ENTRYPOINT = path.join(ROOT, "deploy", "entrypoint.sh");
const OWNER_FILES = [
  "automaton.json",
  "wallet.json",
  "config.json",
  "heartbeat.yml",
  "constitution.md",
  "inference-providers.json",
  "mcp-servers.json",
];

/** The fake runtime: --setup writes every owner file and the agent's starting files; --configure rewrites automaton.json. */
const FAKE_INDEX = `
const fs = require("fs"), path = require("path");
const dir = path.join(process.env.HOME, ".automaton");
const put = (name, text) => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", text, { mode: 0o600 }); fs.renameSync(p + ".tmp", p); };
fs.appendFileSync(process.env.FAKE_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "--setup") {
  put("automaton.json", JSON.stringify({ name: "a", providers: { mode: "standalone" } }));
  put("wallet.json", "{\\"privateKey\\":\\"0x1\\"}");
  put("heartbeat.yml", "entries: []\\n");
  put("SOUL.md", "fresh soul\\n");
  put("skills/survival/SKILL.md", "skill\\n");
} else if (process.argv[2] === "--configure") {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "automaton.json"), "utf8"));
  cfg.budget = { allowanceCents: 1000 };
  put("automaton.json", JSON.stringify(cfg));
}
`;

interface Layout {
  base: string;
  home: string;
  priv: string;
  state: string;
  config: string;
  app: string;
  log: string;
}

let L: Layout;
let inodes: Map<string, number>;

function makeLayout(): Layout {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owner-services-")));
  const home = path.join(base, "home");
  const priv = path.join(home, ".automaton");
  const state = path.join(base, "state");
  const config = path.join(base, "config");
  const app = path.join(base, "app");
  for (const d of [priv, path.join(priv, "owner"), state, config, path.join(app, "dist"), path.join(app, "packages", "cli", "dist")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(app, "dist", "index.js"), FAKE_INDEX);
  fs.writeFileSync(path.join(app, "packages", "cli", "dist", "index.js"), "");
  fs.copyFileSync(path.join(ROOT, "constitution.md"), path.join(app, "constitution.md"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
  // What the agent's container binds its read-only files onto.
  for (const f of OWNER_FILES) fs.writeFileSync(path.join(state, f), "AGENT MOUNT POINT");
  return { base, home, priv, state, config, app, log: path.join(base, "node.log") };
}

function run(cmd: "setup" | "configure", env: Record<string, string> = {}) {
  return spawnSync("/bin/sh", [ENTRYPOINT, cmd], {
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: L.home,
      AUTOMATON_APP_DIR: L.app,
      AUTOMATON_SHARED_STATE: L.state,
      AUTOMATON_CONFIG_OUT: L.config,
      FAKE_LOG: L.log,
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function expectAgentFilesUntouched(): void {
  for (const f of OWNER_FILES) {
    const p = path.join(L.state, f);
    expect(fs.lstatSync(p).isFile(), p).toBe(true);
    expect(fs.lstatSync(p).ino, `${p} replaced`).toBe(inodes.get(f));
    expect(fs.readFileSync(p, "utf8"), p).toBe("AGENT MOUNT POINT");
  }
}

const ran = () => (fs.existsSync(L.log) ? fs.readFileSync(L.log, "utf8") : "");

beforeEach(() => {
  L = makeLayout();
  inodes = new Map(OWNER_FILES.map((f) => [f, fs.lstatSync(path.join(L.state, f)).ino]));
});
afterEach(() => {
  fs.rmSync(L.base, { recursive: true, force: true });
});

describe("security: container owner services and the agent's bind targets", () => {
  it("setup writes the owner files to data/config and never touches the agent's files in data/state", () => {
    const r = run("setup");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expectAgentFilesUntouched();
    for (const f of OWNER_FILES) expect(fs.statSync(path.join(L.config, f)).size, f).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(L.config, "automaton.json"), "utf8")).name).toBe("a");
    expect(fs.statSync(path.join(L.config, "wallet.json")).mode & 0o077).toBe(0);
    // MCP starts off, as with no file, and the file is private (it will hold tokens).
    expect(JSON.parse(fs.readFileSync(path.join(L.config, "mcp-servers.json"), "utf8"))).toEqual({ version: 1, enabled: false });
    expect(fs.statSync(path.join(L.config, "mcp-servers.json")).mode & 0o077).toBe(0);
    // The agent's starting files are seeded into data/state.
    expect(fs.readFileSync(path.join(L.state, "SOUL.md"), "utf8")).toBe("fresh soul\n");
    expect(fs.readFileSync(path.join(L.state, "skills", "survival", "SKILL.md"), "utf8")).toBe("skill\n");
  });

  it("setup keeps an existing SOUL.md and does not follow a link the agent planted", () => {
    fs.writeFileSync(path.join(L.state, "SOUL.md"), "evolved soul\n");
    const target = path.join(L.base, "elsewhere");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(L.state, "skills"));
    expect(run("setup").status).toBe(0);
    expect(fs.readFileSync(path.join(L.state, "SOUL.md"), "utf8")).toBe("evolved soul\n");
    expect(fs.readdirSync(target)).toEqual([]);
    expectAgentFilesUntouched();
  });

  it("configure edits data/config/automaton.json and never touches the agent's files in data/state", () => {
    fs.writeFileSync(path.join(L.config, "automaton.json"), JSON.stringify({ name: "a", providers: { mode: "standalone" } }));
    fs.writeFileSync(path.join(L.config, "wallet.json"), "{}");
    const r = run("configure");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(ran()).toBe("--configure\n");
    expect(JSON.parse(fs.readFileSync(path.join(L.config, "automaton.json"), "utf8")).budget).toEqual({ allowanceCents: 1000 });
    expectAgentFilesUntouched();
    expect(fs.readdirSync(L.state).sort()).toEqual([...OWNER_FILES].sort());
  });

  it("setup creates data/config/public-access empty and private; configure keeps what the owner put there", () => {
    expect(run("setup").status).toBe(0);
    const pa = path.join(L.config, "public-access");
    const st = fs.lstatSync(pa);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o077).toBe(0);
    expect(fs.readdirSync(pa)).toEqual([]);
    // Only data/config gets it: the agent's state folder is not touched.
    expect(fs.existsSync(path.join(L.state, "public-access"))).toBe(false);

    fs.writeFileSync(path.join(pa, "cred.json"), '{"token":"t"}', { mode: 0o600 });
    const ino = fs.statSync(path.join(pa, "cred.json")).ino;
    expect(run("configure").status).toBe(0);
    expect(fs.readFileSync(path.join(pa, "cred.json"), "utf8")).toBe('{"token":"t"}');
    expect(fs.statSync(path.join(pa, "cred.json")).ino).toBe(ino);
    expect(fs.lstatSync(pa).mode & 0o077).toBe(0);
  });

  it("configure creates the folder for an install made before it existed", () => {
    fs.writeFileSync(path.join(L.config, "automaton.json"), JSON.stringify({ name: "a", providers: { mode: "standalone" } }));
    expect(fs.existsSync(path.join(L.config, "public-access"))).toBe(false);
    expect(run("configure").status).toBe(0);
    expect(fs.lstatSync(path.join(L.config, "public-access")).isDirectory()).toBe(true);
  });

  it("refuses the old layout, with data/state as ~/.automaton, before staging anything", () => {
    fs.writeFileSync(path.join(L.config, "automaton.json"), "{}");
    fs.mkdirSync(path.join(L.state, "owner"));
    fs.symlinkSync(L.state, path.join(L.base, ".automaton"));
    const r2 = run("configure", { HOME: L.base });
    expect(r2.status).toBe(64);
    expect(r2.stderr).toMatch(/must not run in the agent's state folder/);
    expect(ran()).toBe("");
    expectAgentFilesUntouched();
  });

  it("refuses while the agent holds its instance lock on data/state, before staging anything", () => {
    fs.writeFileSync(path.join(L.config, "automaton.json"), "{}");
    const lock = acquireInstanceLock(path.join(L.state, "state.db.lock"));
    try {
      for (const cmd of ["configure", "setup"] as const) {
        const r = run(cmd);
        expect(r.status, cmd).toBe(64);
        expect(r.stderr, cmd).toMatch(/the agent is running on data\/state/);
      }
    } finally {
      lock.release();
    }
    expect(ran()).toBe("");
    expect(fs.readdirSync(L.priv)).toEqual(["owner"]);
    expectAgentFilesUntouched();
    // Stopped: configure goes ahead.
    expect(run("configure").status).toBe(0);
  });
});
