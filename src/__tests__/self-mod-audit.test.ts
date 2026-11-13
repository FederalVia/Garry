/**
 * Self-modification results and audit entries say what actually happened:
 * the stored diff covers the whole change, failed installs are not recorded
 * (and only code edits count toward the edit limit), registry specs only,
 * and edit_own_file reports a commit that was not made.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editFile, validateModification } from "../self-mod/code.js";
import { diffLines, formatAuditDiff } from "../self-mod/line-diff.js";
import { createBuiltinTools } from "../agent/tools.js";
import { createConwayClient } from "../conway/client.js";
import { isRegistryPackageSpec } from "../agent/policy-rules/validation.js";
import type { AutomatonDatabase, ExecResult, ToolContext } from "../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

/** Runs git for real in the repo; `npm` commands are recorded and answered. */
class RepoConway extends MockConwayClient {
  private readonly local = createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "x", sandboxId: "" });
  npmExitCode = 0;
  /** Claims an identity is configured, so no fallback flags are added. */
  claimIdentity = false;

  override async exec(command: string, timeout?: number): Promise<ExecResult> {
    this.execCalls.push({ command, timeout });
    if (this.claimIdentity && /git config user\.(name|email)$/.test(command)) {
      return { stdout: "someone\n", stderr: "", exitCode: 0 };
    }
    if (/\bnpm (run build|install)\b/.test(command)) {
      return this.npmExitCode === 0
        ? { stdout: "ok", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "npm ERR! 404 Not Found - GET https://registry.npmjs.org/axois-helper", exitCode: this.npmExitCode };
    }
    return this.local.exec(command, timeout);
  }
}

const IDENTITY_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];

let tmp: string;
let repo: string;
let db: AutomatonDatabase;
let conway: RepoConway;
const savedEnv: Record<string, string | undefined> = {};

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function ctx(): ToolContext {
  return {
    identity: { ...createTestIdentity(), sandboxId: "" },
    config: { ...createTestConfig(), sandboxId: "" },
    db,
    conway,
    inference: new MockInferenceClient(),
  } as unknown as ToolContext;
}

const tool = (name: string) => createBuiltinTools("").find((t) => t.name === name)!;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "self-mod-audit-")));
  repo = path.join(tmp, "repo");
  // No git identity anywhere: no env, no global or system config, and the
  // repo refuses to guess one.
  for (const key of [...IDENTITY_ENV, "HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]) savedEnv[key] = process.env[key];
  for (const key of IDENTITY_ENV) delete process.env[key];
  process.env.HOME = path.join(tmp, "home");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = path.join(tmp, "no-global-gitconfig");
  fs.mkdirSync(path.join(tmp, "home", ".automaton"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "memory"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "@conway/automaton" }));
  fs.writeFileSync(path.join(repo, "src/memory/notes.ts"), "export const notes = 1;\n");
  git("init", "-q");
  git("config", "user.useConfigOnly", "true");
  git("add", "-A");
  git("-c", "user.name=Op", "-c", "user.email=op@example.invalid", "commit", "-q", "-m", "init");
  db = createTestDb();
  conway = new RepoConway();
  vi.spyOn(process, "cwd").mockReturnValue(repo);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("F186: the audit diff covers the whole change", () => {
  it("records a change at line 150 after an insertion at line 1", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
    fs.writeFileSync(path.join(repo, "src/memory/big.ts"), lines.join("\n") + "\n");
    const edited = ["// header comment", ...lines];
    edited[150] = "export const v150 = spendLimitCheck(150);";
    const result = await editFile(conway, db, "src/memory/big.ts", edited.join("\n") + "\n", "edit big", { repoRoot: repo });
    expect(result.success).toBe(true);

    const diff = db.getRecentModifications(1)[0].diff!;
    expect(diff.split("\n")[0]).toMatch(/^\+2 -1 lines; sha256\(new\)=[0-9a-f]{64}$/);
    expect(diff).toContain("+// header comment");
    expect(diff).toContain("-export const v150 = 150;");
    expect(diff).toContain("+export const v150 = spendLimitCheck(150);");
    // Unchanged lines far from both changes are not listed.
    expect(diff).not.toContain("v80 = 80");
  });

  it("cuts only the assembled text and says how many changed lines were left out", () => {
    const d = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect([d.added, d.deleted]).toEqual([2, 1]);

    const before = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace(/line (\d+)/g, (m, n) => (Number(n) % 2 ? `LINE ${n}` : m));
    const text = formatAuditDiff(before, after, "0".repeat(64), 2000);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.split("\n")[0]).toBe(`+150 -150 lines; sha256(new)=${"0".repeat(64)}`);
    expect(text).toMatch(/\n… \(truncated: \d+ more changed lines; see the git commit, if one was made, or the file \(sha256 above\)\)$/);
  });
});

describe("H4-006: install_npm_package", () => {
  it("writes no modification row for a failed install and reports the exit code", async () => {
    conway.npmExitCode = 1;
    const out = await tool("install_npm_package").execute({ package: "axois-helper" }, ctx());
    expect(out).toMatch(/^Failed to install axois-helper \(exit code 1\): npm ERR! 404/);
    expect(db.getRecentModifications(10)).toEqual([]);
  });

  it("records a successful install and passes the spec quoted after --", async () => {
    const out = await tool("install_npm_package").execute({ package: "left-pad@>=1.0.0" }, ctx());
    expect(out).toMatch(/^Installed: left-pad@>=1.0.0/);
    expect(conway.execCalls.at(-1)!.command).toBe("npm install -g -- 'left-pad@>=1.0.0'");
    expect(db.getRecentModifications(10).map((m) => m.type)).toEqual(["tool_install"]);
  });

  it("refuses flags, paths, GitHub shorthand, URLs and tarballs", async () => {
    for (const spec of ["-g", "--foo", "./x", "/abs", "owner/repo", "x.tgz", "foo@..", "foo@./x", "https://e.com/x.tgz", "git+ssh://x", "foo@github:a/b"]) {
      expect(isRegistryPackageSpec(spec), spec).toBe(false);
      const out = await tool("install_npm_package").execute({ package: spec }, ctx());
      expect(out, spec).toMatch(/^Blocked: invalid package spec/);
    }
    for (const spec of ["express", "@scope/pkg", "pkg.js", "lodash@4.17.21", "typescript@^5", "@types/node@latest"]) {
      expect(isRegistryPackageSpec(spec), spec).toBe(true);
    }
    expect(conway.execCalls.filter((c) => c.command.includes("npm install"))).toEqual([]);
  });

  it("does not let 20 install rows rate-limit an edit; 20 code edits do", () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      db.insertModification({ id: `i${i}`, timestamp: now, type: "tool_install", description: "x", reversible: true });
    }
    expect(validateModification(db, "src/memory/notes.ts", 10, { repoRoot: repo }).allowed).toBe(true);
    for (let i = 0; i < 20; i++) {
      db.insertModification({ id: `e${i}`, timestamp: now, type: "code_edit", description: "x", reversible: true });
    }
    expect(validateModification(db, "src/memory/notes.ts", 10, { repoRoot: repo }).allowed).toBe(false);
  });
});

describe("H4-004: edit_own_file reports the commit honestly", () => {
  it("commits with a fallback identity when git has none configured", async () => {
    const out = await tool("edit_own_file").execute(
      { path: "src/memory/notes.ts", content: "export const notes = 2;\n", description: "bump" },
      ctx(),
    );
    expect(out).toMatch(/audited \+ git-committed as [0-9a-f]{7}/);
    expect(git("log", "-1", "--format=%s|%an|%ae").trim()).toBe("self-mod: bump|Automaton|automaton@localhost");
    // Nothing was written to the repo's config.
    expect(() => git("config", "user.email")).toThrow();
  });

  it("says NOT committed when the commit fails", async () => {
    fs.writeFileSync(path.join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'hook refused' >&2\nexit 1\n", { mode: 0o755 });
    const out = await tool("edit_own_file").execute(
      { path: "src/memory/notes.ts", content: "export const notes = 3;\n", description: "bump" },
      ctx(),
    );
    expect(out).toMatch(/NOT committed: .*hook refused/);
    expect(out).toMatch(/revert_last_edit cannot undo this edit/);
    expect(fs.readFileSync(path.join(repo, "src/memory/notes.ts"), "utf8")).toBe("export const notes = 3;\n");
  });
});

describe("revert_last_edit without a git identity", () => {
  const notes = () => fs.readFileSync(path.join(repo, "src/memory/notes.ts"), "utf8");

  it("reverts with the fallback identity, audits and rebuilds", async () => {
    await tool("edit_own_file").execute(
      { path: "src/memory/notes.ts", content: "export const notes = 2;\n", description: "bump" },
      ctx(),
    );
    const out = await tool("revert_last_edit").execute({}, ctx());
    expect(out).toMatch(/^Reverted: [0-9a-f]{7}/);
    expect(notes()).toBe("export const notes = 1;\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "-1", "--format=%s|%an").trim()).toBe('Revert "self-mod: bump"|Automaton');
    expect(db.getRecentModifications(5).some((m) => m.type === "code_revert")).toBe(true);
    expect(conway.execCalls.some((c) => /npm run build/.test(c.command))).toBe(true);
  });

  it("rolls back a revert git applied but could not commit", async () => {
    await tool("edit_own_file").execute(
      { path: "src/memory/notes.ts", content: "export const notes = 2;\n", description: "bump" },
      ctx(),
    );
    conway.claimIdentity = true;
    const out = await tool("revert_last_edit").execute({}, ctx());
    expect(out).toMatch(/could not commit it, so the change was rolled back/);
    expect(out).toMatch(/stays on the revert list/);
    expect(notes()).toBe("export const notes = 2;\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(db.getKV("self_mod.commits")).toContain("src/memory/notes.ts");
  });
});
