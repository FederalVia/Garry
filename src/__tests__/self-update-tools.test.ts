/**
 * Self-update tools report what they really did: revert_last_edit reverts
 * only commits edit_own_file recorded, newest first (no toggling, no
 * operator commits, no protected files); pull_upstream runs in the repo and
 * applies only reviewed commits;
 * every rebuild says the running process keeps the old code until restart.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools, SELF_MOD_COMMITS_KEY } from "../agent/tools.js";
import { createConwayClient } from "../conway/client.js";
import { RESTART_NOTICE, RESTART_REQUIRED_KEY } from "../self-mod/restart-notice.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";

const savedHome = process.env.HOME;
const savedCwd = process.cwd();
let home: string;
let repo: string;
let db: AutomatonDatabase;
let ctx: ToolContext;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function tool(name: string) {
  return createBuiltinTools("").find((t) => t.name === name)!;
}

function readA(): string {
  return fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8");
}

async function edit(content: string, description: string, file = "src/a.ts"): Promise<string> {
  return tool("edit_own_file").execute({ path: file, content, description }, ctx);
}

async function revert(): Promise<string> {
  return tool("revert_last_edit").execute({}, ctx);
}

function gitTry(...args: string[]): void {
  try {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  } catch {
    // a conflicting cherry-pick exits non-zero on purpose
  }
}

/** The operator cherry-picks a commit that conflicts on src/b.ts, resolves it by hand and stages it. */
function operatorMidCherryPick(): void {
  fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 1;\n");
  git("add", "src/b.ts");
  git("commit", "-q", "-m", "operator: add b");
  const main = git("rev-parse", "--abbrev-ref", "HEAD");
  git("checkout", "-q", "-b", "op");
  fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 'theirs';\n");
  git("commit", "-qam", "op change");
  const opSha = git("rev-parse", "HEAD");
  git("checkout", "-q", main);
  fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 'ours';\n");
  git("commit", "-qam", "main change");
  gitTry("cherry-pick", opSha);
  fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 'OPERATOR RESOLUTION';\n");
  git("add", "src/b.ts");
  expect(fs.existsSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
}

function expectOperatorCherryPickIntact(): void {
  expect(fs.existsSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
  expect(fs.readFileSync(path.join(repo, "src", "b.ts"), "utf8")).toBe("export const b = 'OPERATOR RESOLUTION';\n");
  expect(git("diff", "--cached", "--name-only")).toBe("src/b.ts");
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "selfmod-home-")));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "selfmod-repo-")));
  process.env.HOME = home;
  fs.mkdirSync(path.join(repo, "src", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "selfmod-fixture", private: true, scripts: { build: "true" } }),
  );
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "agent", "policy-engine.ts"), "export const guard = 1;\n");
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  process.chdir(repo);

  db = createTestDb();
  ctx = {
    identity: { ...createTestIdentity(), sandboxId: "" },
    config: { ...createTestConfig(), sandboxId: "" },
    db,
    conway: createConwayClient({ apiUrl: "https://api.conway.invalid", apiKey: "k", sandboxId: "" }),
    inference: new MockInferenceClient(),
  } as ToolContext;
});

afterEach(() => {
  process.chdir(savedCwd);
  db.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("revert_last_edit", () => {
  it("refuses when the repository state cannot be checked", async () => {
    await edit("export const a = 2;\n", "X");
    const realExec = ctx.conway.exec.bind(ctx.conway);
    ctx = {
      ...ctx,
      conway: {
        ...ctx.conway,
        exec: async (command: string, timeout?: number) => {
          if (command.includes("CHERRY_PICK_HEAD REVERT_HEAD")) throw new Error("exec unavailable");
          return realExec(command, timeout);
        },
      } as ToolContext["conway"],
    };

    const out = await revert();
    expect(out).toMatch(/^Nothing reverted: .*state could not be checked/);
    expect(readA()).toBe("export const a = 2;\n");
    expect(JSON.parse(db.getKV(SELF_MOD_COMMITS_KEY)!)).toHaveLength(1);
  }, 60_000);

  it("goes further back on each call instead of toggling", async () => {
    expect(await edit("export const a = 2;\n", "X")).toContain("git-committed");
    expect(await edit("export const a = 3;\n", "Y")).toContain("git-committed");

    const r1 = await revert();
    expect(r1).toContain("Reverted:");
    expect(readA()).toBe("export const a = 2;\n");

    const r2 = await revert();
    expect(r2).toContain("Reverted:");
    expect(readA()).toBe("export const a = 1;\n");

    expect(await revert()).toMatch(/^No recorded self-modification/);
    expect(readA()).toBe("export const a = 1;\n");
  }, 60_000);

  it("leaves the operator's cherry-pick in progress alone and keeps the entry", async () => {
    await edit("export const a = 2;\n", "X");
    operatorMidCherryPick();

    const out = await revert();
    expect(out).toMatch(/^Nothing reverted: the repository has an operation in progress/);
    expect(out).toContain("CHERRY_PICK_HEAD");
    expectOperatorCherryPickIntact();
    expect(readA()).toBe("export const a = 2;\n");
    expect(JSON.parse(db.getKV(SELF_MOD_COMMITS_KEY)!)).toHaveLength(1);
  }, 60_000);

  it("keeps the entry when git refuses to start because of local changes", async () => {
    await edit("export const a = 2;\n", "X");
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 'operator wip';\n");

    const out = await revert();
    expect(out).toMatch(/^Nothing reverted: git refused to start the revert/);
    expect(readA()).toBe("export const a = 'operator wip';\n");
    expect(JSON.parse(db.getKV(SELF_MOD_COMMITS_KEY)!)).toHaveLength(1);
  }, 60_000);

  it("aborts its own conflicting revert and drops the entry", async () => {
    await edit("export const a = 2;\n", "X");
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 'operator';\n");
    git("commit", "-qam", "operator: change a");

    const out = await revert();
    expect(out).toMatch(/^Revert failed and was aborted/);
    expect(fs.existsSync(path.join(repo, ".git", "REVERT_HEAD"))).toBe(false);
    expect(readA()).toBe("export const a = 'operator';\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(JSON.parse(db.getKV(SELF_MOD_COMMITS_KEY)!)).toHaveLength(0);
  }, 60_000);

  it("never reverts an operator commit at HEAD", async () => {
    await edit("export const a = 2;\n", "X");
    fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 1;\n");
    git("add", "src/b.ts");
    git("commit", "-q", "-m", "operator: add b");

    expect(await revert()).toContain("Reverted:");
    expect(readA()).toBe("export const a = 1;\n");
    expect(fs.readFileSync(path.join(repo, "src", "b.ts"), "utf8")).toBe("export const b = 1;\n");
    expect(git("log", "-2", "--format=%s").split("\n")[1]).toBe("operator: add b");
  }, 60_000);

  it("refuses a recorded commit that touches a protected file", async () => {
    fs.writeFileSync(path.join(repo, "src", "agent", "policy-engine.ts"), "export const guard = 2;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "self-mod: tighten guard");
    const sha = git("rev-parse", "HEAD");
    db.setKV(SELF_MOD_COMMITS_KEY, JSON.stringify([{ sha, path: "src/agent/policy-engine.ts", reason: "x", at: "" }]));

    const out = await revert();
    expect(out).toMatch(/^Refused:/);
    expect(out).toContain("src/agent/policy-engine.ts");
    expect(fs.readFileSync(path.join(repo, "src", "agent", "policy-engine.ts"), "utf8")).toBe("export const guard = 2;\n");
    expect(git("rev-parse", "HEAD")).toBe(sha);
  }, 60_000);

  it("does not record an edit that made no commit, so the stack never repeats a sha", async () => {
    await edit("export const a = 2;\n", "X");
    const out = await edit("export const a = 2;\n", "same content");
    expect(out).toContain("no new commit");
    expect(JSON.parse(db.getKV(SELF_MOD_COMMITS_KEY)!)).toHaveLength(1);

    expect(await revert()).toContain("Reverted:");
    expect(readA()).toBe("export const a = 1;\n");
    expect(await revert()).toMatch(/^No recorded self-modification/);
  }, 60_000);

  it("drops a recorded commit that is no longer in history and moves on", async () => {
    await edit("export const a = 2;\n", "X");
    await edit("export const a = 3;\n", "Y");
    git("reset", "-q", "--hard", "HEAD~1");
    expect(readA()).toBe("export const a = 2;\n");

    expect(await revert()).toMatch(/no longer in the history/);
    expect(await revert()).toContain("Reverted:");
    expect(readA()).toBe("export const a = 1;\n");
  }, 60_000);

  it("says a restart is needed and sets the restart flag", async () => {
    const edited = await edit("export const a = 2;\n", "X");
    expect(edited).toContain(RESTART_NOTICE);
    db.deleteKV(RESTART_REQUIRED_KEY);

    const reverted = await revert();
    expect(reverted).toContain(RESTART_NOTICE);
    const flag = JSON.parse(db.getKV(RESTART_REQUIRED_KEY)!);
    expect(flag.reason).toContain("revert_last_edit");
    expect(typeof flag.at).toBe("string");
  }, 60_000);
});

describe("pull_upstream", () => {
  it("runs every command inside the repo, validates the commit and refuses unreviewed commits", async () => {
    const conway = new MockConwayClient();
    const mockCtx = { ...ctx, conway } as ToolContext;
    const pull = tool("pull_upstream");

    expect(await pull.execute({ commit: "abc1234; rm -rf /" }, mockCtx)).toMatch(/^Blocked:/);
    expect(conway.execCalls).toHaveLength(0);

    const out = await pull.execute({ commit: "abc1234" }, mockCtx);
    expect(out).toMatch(/^Refused: nothing has been reviewed/);
    expect(conway.execCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of conway.execCalls) {
      expect(call.command.startsWith(`cd '${repo}' && `)).toBe(true);
      expect(call.command).not.toContain("cherry-pick");
    }
  });

  it("aborts its own failed cherry-pick of a reviewed commit and reports git's output", async () => {
    // origin/main carries an upstream change to src/a.ts; HEAD changes it locally.
    const upstreamDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "selfmod-origin-")));
    try {
      execFileSync("git", ["clone", "-q", repo, upstreamDir]);
      const up = (...a: string[]) => execFileSync("git", a, { cwd: upstreamDir, encoding: "utf8" }).trim();
      up("config", "user.email", "test@example.com");
      up("config", "user.name", "Test");
      up("config", "commit.gpgsign", "false");
      up("checkout", "-q", "-B", "main");
      fs.writeFileSync(path.join(upstreamDir, "src", "a.ts"), "export const a = 'upstream';\n");
      up("commit", "-qam", "upstream change");
      const sha = up("rev-parse", "HEAD");
      git("remote", "add", "origin", upstreamDir);
      fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 'local';\n");
      git("commit", "-qam", "local change");

      const index = await tool("review_upstream_changes").execute({}, ctx);
      expect(index).toContain(sha);
      await tool("review_upstream_changes").execute({ commit: sha }, ctx);

      const out = await tool("pull_upstream").execute({ commit: sha }, ctx);
      expect(out).toMatch(/^Git operation failed/);
      expect(out).toContain("CONFLICT");
      expect(fs.existsSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
      expect(readA()).toBe("export const a = 'local';\n");
      expect(git("status", "--porcelain")).toBe("");
    } finally {
      fs.rmSync(upstreamDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses to start on top of the operator's cherry-pick in progress", async () => {
    operatorMidCherryPick();
    const upstream = git("rev-parse", "HEAD~1");

    const out = await tool("pull_upstream").execute({ commit: upstream }, ctx);
    expect(out).toMatch(/^Nothing applied: the repository has an operation in progress/);
    expectOperatorCherryPickIntact();
  }, 60_000);
});
