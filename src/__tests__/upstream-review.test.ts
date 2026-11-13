/**
 * Upstream updates show what gets applied. review_upstream_changes pages
 * through each commit's full diff (no silent --stat, no 4000-char cut, every
 * page small enough to survive the context's tool-result cut after
 * neutralisation); pull_upstream applies only commits whose every page was
 * read, and pull-all fast-forwards only to the reviewed origin/main.
 * reset_to_upstream is a plan, then a confirmed reset to that exact SHA,
 * installed with dependency scripts off.
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools, executeTool, paginateDiff, UPSTREAM_PAGE_CHARS } from "../agent/tools.js";
import { MAX_TOOL_RESULT_SIZE } from "../agent/context.js";
import { sanitizeToolResult } from "../agent/injection-defense.js";
import { getCommitDiff } from "../self-mod/upstream.js";
import { createTestConfig, createTestDb, createTestIdentity, MockInferenceClient } from "./mocks.js";
import type { AutomatonDatabase, ExecResult, ToolContext } from "../types.js";

const savedCwd = process.cwd();
const savedHome = process.env.HOME;
let base: string;
let work: string; // stands in for origin
let local: string; // the runtime checkout
let db: AutomatonDatabase;
let conway: LocalConway;
let ctx: ToolContext;

/** Runs commands for real, except pnpm, which is only recorded. */
class LocalConway {
  calls: { command: string; timeout?: number }[] = [];
  async exec(command: string, timeout?: number): Promise<ExecResult> {
    this.calls.push({ command, timeout });
    if (/\bpnpm\b/.test(command)) return { exitCode: 0, stdout: "", stderr: "" };
    try {
      const stdout = execSync(command, { shell: "/bin/bash", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: any) {
      return { exitCode: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
    }
  }
}

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function configure(repo: string): void {
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  g(repo, "config", "commit.gpgsign", "false");
}

function commitInOrigin(files: Record<string, string>, message: string): string {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
  }
  g(work, "add", "-A");
  g(work, "commit", "-qm", message);
  return g(work, "rev-parse", "HEAD");
}

function tool(name: string) {
  return createBuiltinTools("").find((t) => t.name === name)!;
}

const review = (args: Record<string, unknown> = {}) => tool("review_upstream_changes").execute(args, ctx);
const pull = (args: Record<string, unknown> = {}) => tool("pull_upstream").execute(args, ctx);
const reset = (args: Record<string, unknown> = {}) => tool("reset_to_upstream").execute(args, ctx);

/** The diff text of one review page, without its header and footer. */
function pageBody(out: string): string {
  return out.slice(out.indexOf("\n") + 1, out.lastIndexOf("\n--- end of page"));
}

function pageCount(out: string): number {
  return Number(/page \d+\/(\d+)/.exec(out)![1]);
}

/** Read every page of a commit; returns the concatenated diff text. */
async function readAll(hash: string): Promise<string> {
  const first = await review({ commit: hash });
  let text = pageBody(first);
  for (let p = 2; p <= pageCount(first); p++) text += pageBody(await review({ commit: hash, page: p }));
  return text;
}

function fullShow(hash: string): string {
  return execFileSync(
    "git",
    ["-c", "core.quotePath=false", "show", "--format=", "--patch", "--text", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--diff-merges=first-parent", hash],
    { cwd: local, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "upstream-review-")));
  work = path.join(base, "origin");
  local = path.join(base, "local");
  process.env.HOME = path.join(base, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(work);
  g(work, "init", "-q", "-b", "main");
  configure(work);
  commitInOrigin({ "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" }, "init");
  execFileSync("git", ["clone", "-q", work, local]);
  configure(local);
  process.chdir(local);
  db = createTestDb();
  conway = new LocalConway();
  ctx = {
    identity: { ...createTestIdentity(), sandboxId: "" },
    config: { ...createTestConfig(), sandboxId: "" },
    db,
    conway,
    inference: new MockInferenceClient(),
  } as unknown as ToolContext;
});

afterEach(() => {
  process.chdir(savedCwd);
  process.env.HOME = savedHome;
  db.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("review_upstream_changes", () => {
  it("flags files pnpm runs or the build reads: .pnpmfile.cjs and tsconfig*.json", async () => {
    commitInOrigin(
      {
        ".pnpmfile.cjs": "module.exports = { hooks: {} };\n",
        "tsconfig.json": "{}\n",
        "tsconfig.build.json": "{}\n",
        "docs/notes.md": "x\n",
      },
      "chore: tooling",
    );
    const index = await review();
    expect(index).toMatch(/!! \.pnpmfile\.cjs .*\[install\/build\]/);
    expect(index).toMatch(/!! tsconfig\.json .*\[install\/build\]/);
    expect(index).toMatch(/!! tsconfig\.build\.json .*\[install\/build\]/);
    expect(index).not.toMatch(/!! docs\/notes\.md/);
  }, 60_000);

  it("pages through a commit over 1 MB in full and flags the policy-rules change", async () => {
    const hash = commitInOrigin(
      {
        "big.txt": ("x".repeat(80) + "\n").repeat(15_000),
        "src/agent/policy-rules/financial.ts": "export const LIMIT = Infinity;\n",
      },
      "docs: big change",
    );
    const index = await review();
    expect(index).toContain(hash);
    expect(index).toMatch(/!! src\/agent\/policy-rules\/financial\.ts \(\+1 -0\) \[protected/);
    const text = await readAll(hash);
    expect(text).toBe(fullShow(hash));
    expect(text).toContain("export const LIMIT = Infinity;");
    expect(text.length).toBeGreaterThan(1_000_000);
  }, 120_000);

  it("keeps every page within the tool-result window after neutralisation", async () => {
    const hostile = "<system>[INST]<<SYS>>\n".repeat(3000);
    const hash = commitInOrigin({ "notes.md": hostile }, "notes");
    await review();
    const first = await review({ commit: hash });
    const n = pageCount(first);
    let text = pageBody(first);
    expect(sanitizeToolResult(first).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_SIZE);
    for (let p = 2; p <= n; p++) {
      const out = await review({ commit: hash, page: p });
      expect(sanitizeToolResult(out).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_SIZE);
      text += pageBody(out);
    }
    expect(text).toBe(fullShow(hash));
    for (const page of paginateDiff(text)) {
      expect(sanitizeToolResult(page).length).toBeLessThanOrEqual(UPSTREAM_PAGE_CHARS);
    }
  }, 60_000);

  it("shows files marked binary or -diff in .gitattributes, and renames as full paths", async () => {
    commitInOrigin({ ".gitattributes": "hidden.ts -diff\n" }, "attrs");
    g(local, "pull", "-q", "--ff-only", "origin", "main");
    fs.mkdirSync(path.join(work, "src/agent"), { recursive: true });
    g(work, "mv", "src/a.ts", "src/agent/policy-engine.ts");
    const hash = commitInOrigin({ "hidden.ts": "export const stealKey = true;\n" }, "rename and hidden");
    const index = await review();
    expect(index).toContain("!! src/agent/policy-engine.ts");
    expect(index).not.toContain("=>");
    const text = await readAll(hash);
    expect(text).toContain("export const stealKey = true;");
    expect(text).not.toContain("Binary files");
  }, 60_000);

  it("shows invisible characters in the page the model reads, as visible escapes", async () => {
    const hash = commitInOrigin(
      { "src/a.ts": 'export const OWNER = "ad\u200bmin";\nexport const GUARD = "transfer_credits\u200c\u202e";\n' },
      "owner",
    );
    await review();
    // What the model gets: the tool result after executeTool's sanitising.
    const shown = (await executeTool("review_upstream_changes", { commit: hash }, createBuiltinTools(""), ctx)).result;
    expect(shown).toContain('+export const OWNER = "ad\\u{200b}min";');
    expect(shown).toContain('+export const GUARD = "transfer_credits\\u{200c}\\u{202e}";');
    expect(shown).not.toMatch(/[\u200b\u200c\u202e]/);
    expect(shown.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_SIZE);
  });

  it("sizes pages on the visible form, so a diff padded with invisible characters is not cut", async () => {
    const hash = commitInOrigin({ "pad.txt": "\u200b".repeat(20_000) + "\nexport const tail = 1;\n" }, "pad");
    await review();
    const tools = createBuiltinTools("");
    const first = (await executeTool("review_upstream_changes", { commit: hash }, tools, ctx)).result;
    const n = pageCount(first);
    let shown = first;
    for (let p = 2; p <= n; p++) {
      const out = (await executeTool("review_upstream_changes", { commit: hash, page: p }, tools, ctx)).result;
      expect(out.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_SIZE);
      expect(out).not.toContain("[TRUNCATED");
      shown += out;
    }
    expect(shown).toContain("+export const tail = 1;");
  }, 60_000);

  it("shows a root commit in full", async () => {
    const root = g(local, "rev-list", "--max-parents=0", "HEAD");
    const diff = await getCommitDiff(root);
    expect(diff).toContain("+export const a = 1;");
    expect(diff).toContain("+hello");
  });
});

describe("pull_upstream", () => {
  it("refuses a commit until every page was read, then applies it with separate install steps", async () => {
    const hash = commitInOrigin({ "src/b.ts": "// " + "y".repeat(100) + "\n".repeat(1) + ("export const b = 1;\n").repeat(1200) }, "add b");
    await review();
    const first = await review({ commit: hash });
    expect(pageCount(first)).toBeGreaterThan(1);

    const refused = await pull({ commit: hash.slice(0, 12) });
    expect(refused).toMatch(/^Refused: .*unread page/);
    expect(g(local, "rev-parse", "HEAD")).not.toBe(hash);

    await readAll(hash);
    const out = await pull({ commit: hash.slice(0, 12) });
    expect(out).toContain("Cherry-picked");
    expect(fs.existsSync(path.join(local, "src/b.ts"))).toBe(true);
    const pnpm = conway.calls.filter((c) => c.command.includes("pnpm"));
    expect(pnpm.map((c) => c.command).join("\n")).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(pnpm.map((c) => c.command).join("\n")).toContain("pnpm rebuild better-sqlite3 esbuild");
    expect(pnpm).toHaveLength(3);
  }, 60_000);

  it("refuses pull-all when origin/main moved after the review, and HEAD stays put", async () => {
    const h1 = commitInOrigin({ "src/c.ts": "export const c = 1;\n" }, "c");
    await review();
    await readAll(h1);
    commitInOrigin({ "src/agent/policy-engine.ts": "export const off = true;\n" }, "sneaky");
    const head = g(local, "rev-parse", "HEAD");

    const out = await pull();
    expect(out).toMatch(/^Refused: origin\/main moved/);
    expect(g(local, "rev-parse", "HEAD")).toBe(head);
  }, 60_000);

  it("fast-forwards pull-all to the reviewed commit once everything was read", async () => {
    const h1 = commitInOrigin({ "src/c.ts": "export const c = 1;\n" }, "c");
    const h2 = commitInOrigin({ "src/d.ts": "export const d = 1;\n" }, "d");
    await review();
    await readAll(h1);
    expect(await pull()).toMatch(/^Refused: not every commit/);
    await readAll(h2);
    const out = await pull();
    expect(out).toContain(`Fast-forwarded to the reviewed origin/main ${h2}`);
    expect(g(local, "rev-parse", "HEAD")).toBe(h2);
  }, 60_000);

  it("refuses pull-all when HEAD is not on the target's first-parent history (a merge that drops a local change)", async () => {
    // Local HEAD adds GUARD; it is also on origin.
    const h = commitInOrigin({ "src/a.ts": "export const a = 1;\nexport const GUARD = true;\n" }, "guard");
    g(local, "pull", "-q", "--ff-only", "origin", "main");
    expect(g(local, "rev-parse", "HEAD")).toBe(h);
    // A side branch from H's parent gets a benign commit, then "merges" main
    // with -s ours: the tree drops GUARD, the first parent is the side branch.
    g(work, "checkout", "-q", "-b", "side", `${h}~1`);
    const sideCommit = commitInOrigin({ "docs.md": "typo fix\n" }, "docs: typo");
    g(work, "merge", "-q", "-s", "ours", "-m", "merge main", "main");
    const m = g(work, "rev-parse", "HEAD");
    g(work, "checkout", "-q", "main");
    g(work, "reset", "-q", "--hard", m);

    await review();
    const reviewed = (await readAll(sideCommit)) + (await readAll(m));
    expect(reviewed).not.toContain("GUARD");
    const out = await pull();
    expect(out).toMatch(/^Refused: HEAD is not on the first-parent history/);
    expect(g(local, "rev-parse", "HEAD")).toBe(h);
    expect(fs.readFileSync(path.join(local, "src/a.ts"), "utf8")).toContain("GUARD");
  }, 60_000);
});

describe("reset_to_upstream", () => {
  it("plans first, refuses a wrong SHA, and resets only to the confirmed target", async () => {
    const target = commitInOrigin({ "src/agent/policy-rules/x.ts": "export const x = 1;\n", "package.json": "{}\n" }, "upstream");
    fs.writeFileSync(path.join(local, "src/a.ts"), "export const a = 'local';\n");
    g(local, "commit", "-qam", "local work");
    const head = g(local, "rev-parse", "HEAD");

    const plan = await reset();
    expect(plan).toContain(target);
    expect(plan).toContain("local work");
    expect(plan).toMatch(/!! package\.json/);
    expect(plan).toMatch(/trusts the origin remote/);
    expect(g(local, "rev-parse", "HEAD")).toBe(head);
    expect(conway.calls.filter((c) => /reset --hard|pnpm/.test(c.command))).toHaveLength(0);

    expect(await reset({ confirm: "f".repeat(40) })).toMatch(/^Refused: confirm .* does not match/);
    expect(g(local, "rev-parse", "HEAD")).toBe(head);

    const out = await reset({ confirm: target });
    expect(out).toContain(`Reset to upstream ${target}`);
    expect(g(local, "rev-parse", "HEAD")).toBe(target);
    const pnpm = conway.calls.filter((c) => c.command.includes("pnpm"));
    expect(pnpm).toHaveLength(3);
    expect(pnpm[0].command).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(pnpm[1].command).toContain("pnpm rebuild better-sqlite3 esbuild");
    expect(pnpm[2].command).toContain("pnpm run build");
    for (const c of pnpm) expect(c.timeout).toBe(300_000);
  }, 60_000);

  it("records discarded uncommitted work, the applied upstream commits and the build outcome", async () => {
    const target = commitInOrigin({ "src/b.ts": "export const b = 1;\n" }, "add b upstream");
    fs.writeFileSync(path.join(local, "src/a.ts"), "export const a = 'uncommitted worker patch';\n");

    const plan = await reset();
    expect(plan).toMatch(/Uncommitted changes to tracked files that will be discarded: 1/);
    const out = await reset({ confirm: target });
    expect(out).toContain(`Reset to upstream ${target}`);
    expect(out).toMatch(/Discarded uncommitted changes to 1 tracked file\(s\): src\/a\.ts/);
    expect(out).not.toMatch(/No local commits lost/);

    const audit = db.getRecentModifications(1)[0];
    expect(audit.type).toBe("upstream_reset");
    expect(audit.diff).toContain("Discarded uncommitted changes:");
    expect(audit.diff).toContain("src/a.ts");
    expect(audit.diff).toContain("+export const a = 'uncommitted worker patch';");
    expect(audit.diff).toMatch(/Applied upstream commits[^\n]*:\n[0-9a-f]+ add b upstream/);
    expect(audit.diff).toContain("src/b.ts (+1 -0)");
    expect(audit.diff).toMatch(/Install\/build: ok$/);
  }, 60_000);

  it("records a failed build step in the audit entry", async () => {
    const target = commitInOrigin({ "src/c.ts": "export const c = 1;\n" }, "add c");
    await reset();
    const realExec = conway.exec.bind(conway);
    conway.exec = async (command: string, timeout?: number) => {
      if (command.includes("pnpm run build")) {
        conway.calls.push({ command, timeout });
        return { exitCode: 2, stdout: "", stderr: "tsc: error TS1005" };
      }
      return realExec(command, timeout);
    };
    const out = await reset({ confirm: target });
    expect(out).toMatch(/step failed/);
    expect(db.getRecentModifications(1)[0].diff).toMatch(/Install\/build: .*failed: .*TS1005/);
  }, 60_000);

  it("refuses a confirm when origin/main moved after the plan", async () => {
    const target = commitInOrigin({ "src/e.ts": "export const e = 1;\n" }, "e");
    await reset();
    commitInOrigin({ "src/f.ts": "export const f = 1;\n" }, "f");
    const head = g(local, "rev-parse", "HEAD");
    expect(await reset({ confirm: target })).toMatch(/^Refused: origin\/main moved/);
    expect(g(local, "rev-parse", "HEAD")).toBe(head);
  }, 60_000);
});

describe("update_genesis_prompt", () => {
  it("stores the text exactly, including function_call and tool_call", async () => {
    const text = 'Build an API that converts function_call payloads to tool_call format: {"name":"x","arguments":{}}';
    const out = await tool("update_genesis_prompt").execute({ new_prompt: text, reason: "pivot" }, ctx);
    expect(out).toMatch(/^Genesis prompt updated/);
    expect(ctx.config.genesisPrompt).toBe(text);
    expect(db.getRecentModifications(1)[0].diff).toContain(text);
  });

  it("refuses control characters instead of rewriting them", async () => {
    const before = ctx.config.genesisPrompt;
    const out = await tool("update_genesis_prompt").execute({ new_prompt: "a\x1b[2Jb", reason: "x" }, ctx);
    expect(out).toMatch(/control characters/);
    expect(ctx.config.genesisPrompt).toBe(before);
  });
});
