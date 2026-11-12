/**
 * The ~/.automaton state repo never commits API keys: an allowlist
 * .gitignore for new repos, and a migration for repos created before it.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogEntry } from "../types.js";

const ORIGINAL_ENV = { ...process.env };
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};
const SECRET_CONFIG = JSON.stringify({
  name: "a",
  conwayApiKey: "cnwy_k_SECRET_CONWAY",
  openaiApiKey: "sk-SECRET_OPENAI",
  anthropicApiKey: "sk-ant-SECRET_ANTHROPIC",
});

let home: string;
let stateDir: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: stateDir, encoding: "utf-8", env: { ...process.env } });
}

function write(rel: string, content: string): void {
  const p = path.join(stateDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function localConway() {
  const { createConwayClient } = await import("../conway/client.js");
  return createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "x", sandboxId: "" });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "state-repo-"));
  stateDir = path.join(home, ".automaton");
  fs.mkdirSync(stateDir, { recursive: true });
  Object.assign(process.env, GIT_ENV, { HOME: home });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("F174: state repo allowlist", () => {
  it("a fresh repo commits only allowlisted files, never automaton.json", async () => {
    write("automaton.json", SECRET_CONFIG);
    write("wallet.json", '{"privateKey":"0xabc"}');
    write("SOUL.md", "# Soul\n");
    write("workspace/g/x.txt", "work");
    write("skills/s/SKILL.md", "Skill.");
    write("skills/s/.env", "TOKEN=1");
    write("inference-providers.json", "{}");

    const { initStateRepo } = await import("../git/state-versioning.js");
    await initStateRepo(await localConway());

    const tracked = git(["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n").sort();
    expect(tracked).toEqual([".gitignore", "SOUL.md", "skills/s/SKILL.md"]);
    expect(git(["log", "--all", "--format=%H", "--", "automaton.json"]).trim()).toBe("");
  });

  it("commitStateChange does not pick up key files under skills/", async () => {
    write("SOUL.md", "# Soul\n");
    write("skills/s/SKILL.md", "Skill.");
    const { initStateRepo, commitStateChange } = await import("../git/state-versioning.js");
    const conway = await localConway();
    await initStateRepo(conway);

    write("skills/s/key.pem", "-----BEGIN PRIVATE KEY-----");
    write("skills/s/SKILL.md.tmp-abc123", "partial");
    write("skills/.install-deadbeef/SKILL.md", "half-cloned");
    write("skills/s/SKILL.md", "Skill v2.");
    await commitStateChange(conway, "update skill", "skill");

    const tracked = git(["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
    expect(tracked).toContain("skills/s/SKILL.md");
    expect(tracked).not.toContain("skills/s/key.pem");
    expect(tracked.some((t) => t.includes(".tmp-") || t.includes(".install-"))).toBe(false);
  });

  it("migrates an existing repo: rewrites .gitignore, untracks automaton.json, warns once, is idempotent", async () => {
    // A repo as the old initStateRepo left it: automaton.json committed.
    write(".gitignore", "wallet.json\nconfig.json\nstate.db\n");
    write("automaton.json", SECRET_CONFIG);
    write("SOUL.md", "# Soul\n");
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "genesis"]);
    expect(git(["ls-files"])).toContain("automaton.json");

    const { StructuredLogger } = await import("../observability/logger.js");
    const entries: LogEntry[] = [];
    StructuredLogger.setSink((e) => entries.push(e));
    try {
      const { initStateRepo, STATE_GITIGNORE } = await import("../git/state-versioning.js");
      const conway = await localConway();
      await initStateRepo(conway);

      expect(fs.readFileSync(path.join(stateDir, ".gitignore"), "utf-8")).toBe(STATE_GITIGNORE);
      expect(git(["ls-files"]).split("\n")).not.toContain("automaton.json");
      expect(fs.existsSync(path.join(stateDir, "automaton.json"))).toBe(true);
      expect(git(["status", "--porcelain"]).trim()).toBe("");
      expect(entries.some((e) => e.level === "error" && /rotate/.test(e.message))).toBe(true);

      const head = git(["rev-parse", "HEAD"]).trim();
      await initStateRepo(conway);
      expect(git(["rev-parse", "HEAD"]).trim()).toBe(head);
    } finally {
      StructuredLogger.resetSink();
    }
  });
});
