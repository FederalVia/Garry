/**
 * Git tools: the default ~/.automaton must be expanded before it is quoted
 * (a quoted ~ never expands), and a failing git command must be an error,
 * never "Clean: true" or "No commits yet".
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import { createConwayClient } from "../conway/client.js";
import { MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";

const savedHome = process.env.HOME;
let home: string;
let db: AutomatonDatabase;
let ctx: ToolContext;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-tools-home-")));
  process.env.HOME = home;
  const stateDir = path.join(home, ".automaton");
  fs.mkdirSync(stateDir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: stateDir, encoding: "utf8" });
  git("init", "-q", "-b", "statebranch");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(stateDir, "SOUL.md"), "# soul\n");
  git("add", "SOUL.md");
  git("commit", "-q", "-m", "genesis: state repo");
  fs.writeFileSync(path.join(stateDir, "SOUL.md"), "# soul v2\n");

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
  db.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const tools = () => createBuiltinTools("");

describe("git tools default path", () => {
  it("git_status without a path reads ~/.automaton", async () => {
    const res = await executeTool("git_status", {}, tools(), ctx);
    expect(res.error).toBeUndefined();
    expect(res.result).toContain("Branch: statebranch");
    expect(res.result).toContain("Modified: 1");
    expect(res.result).toContain("Clean: false");
  });

  it("git_log without a path lists the state repo's commits", async () => {
    const res = await executeTool("git_log", {}, tools(), ctx);
    expect(res.result).toContain("genesis: state repo");
  });

  it("git_diff without a path shows the change", async () => {
    const res = await executeTool("git_diff", {}, tools(), ctx);
    expect(res.result).toContain("+# soul v2");
  });
});

describe("git tools failures", () => {
  it("a path that is not a repository is an error, not a clean tree", async () => {
    const plain = path.join(home, "plain");
    fs.mkdirSync(plain);
    const status = await executeTool("git_status", { path: plain }, tools(), ctx);
    expect(status.result).not.toContain("Clean: true");
    expect(status.error).toMatch(/git status failed/);

    const log = await executeTool("git_log", { path: plain }, tools(), ctx);
    expect(log.result).not.toContain("No commits yet");
    expect(log.error).toMatch(/git log failed/);

    const diff = await executeTool("git_diff", { path: path.join(home, "missing") }, tools(), ctx);
    expect(diff.result).not.toContain("(no changes)");
    expect(diff.error).toMatch(/git diff failed/);
  });

  it("a repository without commits still reads as no commits", async () => {
    const empty = path.join(home, "empty");
    fs.mkdirSync(empty);
    execFileSync("git", ["init", "-q"], { cwd: empty });
    const log = await executeTool("git_log", { path: empty }, tools(), ctx);
    expect(log.error).toBeUndefined();
    expect(log.result).toBe("No commits yet.");
  });
});
