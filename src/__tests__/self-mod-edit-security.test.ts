/**
 * Self-modification (editFile / edit_own_file): guard files are protected,
 * links are never written through, commits contain only the edited file,
 * and a failed rebuild is reported.
 *
 * Each test uses a temp git repo laid out like the runtime checkout. The
 * Conway client runs git locally and resolves relative file paths against
 * that repo, as the real client does against its working directory.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editFile } from "../self-mod/code.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import { createConwayClient } from "../conway/client.js";
import type { AutomatonDatabase, ExecResult, PolicyRequest, ToolContext } from "../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Local Conway client for a repo: git runs for real; `npm run build` is recorded and answered. */
class RepoConway extends MockConwayClient {
  private readonly local = createConwayClient({ apiUrl: "http://127.0.0.1:9", apiKey: "x", sandboxId: "" });
  buildExitCode = 0;

  constructor(private readonly repo: string) {
    super();
  }

  private resolve(filePath: string): string {
    return path.resolve(this.repo, filePath);
  }

  override async exec(command: string, timeout?: number): Promise<ExecResult> {
    this.execCalls.push({ command, timeout });
    if (command.includes("npm run build")) {
      return this.buildExitCode === 0
        ? { stdout: "built", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "error TS2304: Cannot find name 'x'.", exitCode: this.buildExitCode };
    }
    return this.local.exec(command, timeout);
  }

  override async writeFile(filePath: string, content: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.resolve(filePath)), { recursive: true });
    fs.writeFileSync(this.resolve(filePath), content, "utf8");
  }

  override async readFile(filePath: string): Promise<string> {
    return fs.readFileSync(this.resolve(filePath), "utf8");
  }
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

const GUARDS = [
  "src/agent/policy-rules/financial.ts",
  "src/agent/policy-rules/authority.ts",
  "src/agent/policy-rules/command-safety.ts",
  "src/agent/spend-tracker.ts",
  "src/agent/inbox-isolation.ts",
  "src/agent/harnesses/coding-harness.ts",
  "src/agent/policy-engine.ts",
  // Redaction chokepoints for workers and logs.
  "src/inference/inference-client.ts",
  "src/observability/logger.ts",
];

describe("self-mod editFile security", () => {
  let tmp: string;
  let repo: string;
  let db: AutomatonDatabase;
  let conway: RepoConway;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "self-mod-security-")));
    repo = path.join(tmp, "repo");
    for (const [key, value] of Object.entries({ ...GIT_ENV, HOME: path.join(tmp, "home") })) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    fs.mkdirSync(path.join(tmp, "home", ".automaton"), { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "@conway/automaton", version: "0.0.0" }),
      "README.md": "# readme\n",
      "other.ts": "export const other = 1;\n",
      "src/memory/notes.ts": "export const notes = 1;\n",
      "src/memory/a.ts": "export const a = 1;\n",
    };
    for (const rel of GUARDS) files[rel] = "ORIGINAL guard\n";
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), content);
    }
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    db = createTestDb();
    conway = new RepoConway(repo);
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

  const edit = (filePath: string, content: string) =>
    editFile(conway, db, filePath, content, "test edit", { repoRoot: repo });

  // ── F041: guard files ─────────────────────────────────────────

  it("blocks edits to the policy rules, spend tracker, inbox isolation and harnesses", async () => {
    for (const rel of GUARDS) {
      const result = await edit(rel, "export {}; // PWNED\n");
      expect(result.success, rel).toBe(false);
      expect(result.error, rel).toContain("BLOCKED");
      expect(fs.readFileSync(path.join(repo, rel), "utf8"), rel).toBe("ORIGINAL guard\n");
    }
  });

  it("still allows editing ordinary source", async () => {
    const result = await edit("src/memory/notes.ts", "export const notes = 2;\n");
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(repo, "src/memory/notes.ts"), "utf8")).toBe("export const notes = 2;\n");
  });

  it("edit_own_file and write_file through the policy engine deny guard files and heartbeat.yml", async () => {
    const mock = new MockConwayClient();
    const identity = createTestIdentity();
    const config = createTestConfig();
    const context: ToolContext = { identity, config, db, conway: mock, inference: new MockInferenceClient([]) };
    const tools = createBuiltinTools(identity.sandboxId);
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const turnContext: PolicyRequest["turnContext"] = {
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
    };

    const editResult = await executeTool(
      "edit_own_file",
      { path: "src/agent/policy-rules/financial.ts", content: "export {};\n", reason: "tweak" },
      tools,
      context,
      engine,
      turnContext,
    );
    const writeResult = await executeTool(
      "write_file",
      { path: "~/.automaton/heartbeat.yml", content: "entries: []\n" },
      tools,
      context,
      engine,
      turnContext,
    );

    expect(editResult.error).toContain("PROTECTED_FILE");
    expect(writeResult.error).toContain("PROTECTED_FILE");
    expect(Object.keys(mock.files)).toHaveLength(0);
    expect(fs.readFileSync(path.join(repo, "src/agent/policy-rules/financial.ts"), "utf8")).toBe("ORIGINAL guard\n");
  });

  // ── F180: links ───────────────────────────────────────────────

  it("never writes through a symlink to a guard file", async () => {
    fs.symlinkSync(path.join(repo, "src/agent/policy-engine.ts"), path.join(repo, "notes.txt"));
    const result = await edit("notes.txt", "PWNED");
    expect(result.success).toBe(false);
    expect(result.error).toContain("BLOCKED");
    expect(fs.readFileSync(path.join(repo, "src/agent/policy-engine.ts"), "utf8")).toBe("ORIGINAL guard\n");
  });

  it("refuses a symlink even to an ordinary file", async () => {
    fs.symlinkSync(path.join(repo, "src/memory/a.ts"), path.join(repo, "notes2.txt"));
    const result = await edit("notes2.txt", "PWNED");
    expect(result.success).toBe(false);
    expect(result.error).toContain("SYMLINK");
    expect(fs.readFileSync(path.join(repo, "src/memory/a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("refuses a hard link to a guard file", async () => {
    fs.linkSync(path.join(repo, "src/agent/policy-engine.ts"), path.join(repo, "hard.txt"));
    const result = await edit("hard.txt", "PWNED2");
    expect(result.success).toBe(false);
    expect(result.error).toContain("HARDLINK");
    expect(fs.readFileSync(path.join(repo, "src/agent/policy-engine.ts"), "utf8")).toBe("ORIGINAL guard\n");
  });

  it("refuses a new file under a symlinked parent that points outside the repo", async () => {
    fs.mkdirSync(path.join(tmp, "outside"));
    fs.symlinkSync(path.join(tmp, "outside"), path.join(repo, "src", "link"));
    const result = await edit("src/link/x.ts", "export const x = 1;\n");
    expect(result.success).toBe(false);
    expect(result.error).toContain("BLOCKED");
    expect(fs.readdirSync(path.join(tmp, "outside"))).toEqual([]);
  });

  it("refuses a dangling symlink and creates nothing at its target", async () => {
    fs.mkdirSync(path.join(tmp, "outside"));
    fs.symlinkSync(path.join(tmp, "outside", "new.ts"), path.join(repo, "new.ts"));
    const result = await edit("new.ts", "export const n = 1;\n");
    expect(result.success).toBe(false);
    expect(result.error).toContain("BLOCKED");
    expect(fs.existsSync(path.join(tmp, "outside", "new.ts"))).toBe(false);
  });

  // ── H4-002: commits contain only the edited file ──────────────

  it("commits only the edited file; untracked secrets and other changes stay out", async () => {
    fs.writeFileSync(path.join(repo, ".env.production"), "STRIPE_SECRET=sk_live_123\n");
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = 2;\n");
    const before = Number(git(repo, "rev-list", "--count", "HEAD").trim());

    const result = await edit("README.md", "# readme v2\n");

    expect(result.success).toBe(true);
    const shown = git(repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean);
    expect(shown).toEqual(["README.md"]);
    const status = git(repo, "status", "--porcelain");
    expect(status).toContain("?? .env.production");
    expect(status).toMatch(/^ M other\.ts$/m);
    expect(git(repo, "log", "--all", "--format=%H", "--", ".env.production").trim()).toBe("");
    // README was clean, so there is no pre-modify snapshot.
    expect(Number(git(repo, "rev-list", "--count", "HEAD").trim())).toBe(before + 1);
    expect(git(repo, "log", "-1", "--format=%s")).toContain("self-mod:");
  });

  it("snapshots a dirty file before editing it, and only that file", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "# readme dirty\n");
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = 3;\n");

    const result = await edit("README.md", "# readme v3\n");

    expect(result.success).toBe(true);
    const subjects = git(repo, "log", "-2", "--format=%s").trim().split("\n");
    expect(subjects[0]).toContain("self-mod:");
    expect(subjects[1]).toContain("pre-modify:");
    for (const rev of ["HEAD", "HEAD~1"]) {
      expect(git(repo, "show", "--name-only", "--format=", rev).trim()).toBe("README.md");
    }
    expect(git(repo, "status", "--porcelain")).toMatch(/^ M other\.ts$/m);
  });

  // ── F178: rebuild in the repo, failures reported ──────────────

  it("rebuilds in the repo and reports a failed build", async () => {
    conway.buildExitCode = 2;
    const result = await edit("src/memory/notes.ts", "export const notes = 3;\n");

    const builds = conway.execCalls.map((call) => call.command).filter((command) => command.includes("npm run build"));
    expect(builds).toEqual([`cd '${repo}' && npm run build`]);
    expect(result.success).toBe(true);
    expect(result.error).toContain("rebuild failed");
  });
});

describe("runtime repo .gitignore", () => {
  it("ignores env files, keys and local state", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    for (const name of [".env.production", ".env.local", "x.pem", "x.key", "automaton.json", "wallet.json", "inference-providers.json", "state.db"]) {
      expect(() => git(repoRoot, "check-ignore", "--no-index", "-q", name), name).not.toThrow();
    }
    expect(() => git(repoRoot, "check-ignore", "--no-index", "-q", ".env.example")).toThrow();
  });
});
