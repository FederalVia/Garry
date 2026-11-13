/**
 * The ~/.automaton state repo receives a commit after soul updates and skill
 * changes, and only the allowlisted state files are ever committed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const savedEnv: Record<string, string | undefined> = {};
let home: string;
let stateDir: string;
let db: AutomatonDatabase;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: stateDir, encoding: "utf-8" });
}

function commitCount(): number {
  return Number(git("rev-list", "--count", "HEAD").trim());
}

function tracked(): string[] {
  return git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
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

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "state-commits-")));
  stateDir = path.join(home, ".automaton");
  fs.mkdirSync(stateDir, { recursive: true });
  for (const key of ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = path.join(home, "no-global-gitconfig");
  write("SOUL.md", "# bot\n\n## Mission\nDo useful work.\n");
  const { initStateRepo } = await import("../git/state-versioning.js");
  await initStateRepo(await localConway());
  db = createTestDb();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("H4-008: state changes are committed", () => {
  it("updateSoul adds a soul commit containing SOUL.md", async () => {
    const before = commitCount();
    write("automaton.json", '{"conwayApiKey":"cnwy_k_SECRET"}');
    write("notes.txt", "scratch");
    const { updateSoul } = await import("../soul/tools.js");
    const result = await updateSoul(db.raw, { strategy: "Sell tools." }, "agent", "pivot");
    expect(result.success).toBe(true);

    expect(commitCount()).toBe(before + 1);
    expect(git("log", "-1", "--format=%s").trim()).toMatch(/^soul: v\d+ \(agent\): pivot$/);
    expect(git("show", "HEAD:SOUL.md")).toContain("Sell tools.");
    expect(tracked()).not.toContain("automaton.json");
    expect(tracked()).not.toContain("notes.txt");
  });

  it("createSkill and removeSkill each add a skill commit; WORKLOG.md rides along", async () => {
    const { createSkill, removeSkill } = await import("../skills/registry.js");
    const conway = await localConway();
    const before = commitCount();
    write("WORKLOG.md", "- did a thing\n");
    write("wallet.json", '{"privateKey":"0xabc"}');
    await createSkill("helper", "Helps.", "Do the thing.", "~/.automaton/skills", db, conway);

    expect(commitCount()).toBe(before + 1);
    expect(git("log", "-1", "--format=%s").trim()).toBe("skill: create skill: helper");
    expect(tracked()).toEqual(expect.arrayContaining(["skills/helper/SKILL.md", "WORKLOG.md"]));
    expect(tracked()).not.toContain("wallet.json");

    await removeSkill("helper", db, conway, "~/.automaton/skills", true);
    expect(commitCount()).toBe(before + 2);
    expect(tracked()).not.toContain("skills/helper/SKILL.md");
  });

  it("commits a skill cloned from git as files, not as an embedded repository, honouring the allowlist", async () => {
    const skill = path.join(stateDir, "skills", "cloned");
    write("skills/cloned/SKILL.md", "---\nname: cloned\n---\nDo it.\n");
    write("skills/cloned/lib/run.sh", "echo hi\n");
    write("skills/cloned/deploy.key", "SECRET");
    execFileSync("git", ["init", "-q", skill]);

    const { commitSkillChange } = await import("../git/state-versioning.js");
    const sha = await commitSkillChange("cloned", "install");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const entries = git("ls-tree", "-r", "HEAD", "--", "skills/cloned").trim().split("\n");
    expect(entries.every((e) => e.startsWith("100644 blob"))).toBe(true);
    expect(tracked()).toEqual(expect.arrayContaining(["skills/cloned/SKILL.md", "skills/cloned/lib/run.sh"]));
    expect(tracked()).not.toContain("skills/cloned/deploy.key");

    // An unchanged tree makes no empty commit.
    const count = commitCount();
    expect(await commitSkillChange("cloned", "update")).toBe("No changes to commit");
    expect(commitCount()).toBe(count);
  });

  it("returns quietly without a state repo, and never throws", async () => {
    fs.rmSync(path.join(stateDir, ".git"), { recursive: true, force: true });
    const { commitStateChange } = await import("../git/state-versioning.js");
    await expect(commitStateChange("x")).resolves.toBe("No state repo");
  });
});
