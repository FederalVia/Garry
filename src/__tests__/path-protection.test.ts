/**
 * Path Protection Tests (Sub-phase 0.4)
 *
 * Tests for:
 * - resolveAndValidatePath: traversal and symlink blocking
 * - isProtectedFile: exact path-segment matching (no substring false positives)
 * - write_file: blocks protected files
 * - read_file: blocks sensitive files
 * - Policy rules: path.protected_files, path.read_sensitive, path.traversal_detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { isProtectedFile } from "../self-mod/code.js";
import { createPathProtectionRules } from "../agent/policy-rules/path-protection.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import type { PolicyRequest, AutomatonTool, ToolContext } from "../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

// ─── Helpers ──────────────────────────────────────────────────

function makeMockTool(name: string): AutomatonTool {
  return {
    name,
    description: `mock ${name}`,
    category: "vm",
    riskLevel: "caution",
    parameters: {},
    execute: async () => "",
  };
}

function makeMockRequest(
  toolName: string,
  args: Record<string, unknown>,
): PolicyRequest {
  return {
    tool: makeMockTool(toolName),
    args,
    context: {} as ToolContext,
    turnContext: {
      inputSource: undefined,
      turnToolCallCount: 0,
      sessionSpend: {
        recordSpend: () => {},
        getHourlySpend: () => 0,
        getDailySpend: () => 0,
        getTotalSpend: () => 0,
        checkLimit: () => ({
          allowed: true,
          currentHourlySpend: 0,
          currentDailySpend: 0,
          limitHourly: 0,
          limitDaily: 0,
        }),
        pruneOldRecords: () => 0,
      },
    },
  };
}

// ─── isProtectedFile Tests ──────────────────────────────────────

describe("isProtectedFile", () => {
  it("matches exact protected file names", () => {
    expect(isProtectedFile("wallet.json")).toBe(true);
    expect(isProtectedFile("config.json")).toBe(true);
    expect(isProtectedFile("state.db")).toBe(true);
    expect(isProtectedFile("constitution.md")).toBe(true);
  });

  it("matches protected files with path prefix", () => {
    expect(isProtectedFile("/home/user/.automaton/wallet.json")).toBe(true);
    expect(isProtectedFile("/some/path/self-mod/code.ts")).toBe(true);
    expect(isProtectedFile("/some/path/agent/tools.ts")).toBe(true);
  });

  it("matches newly added protected files", () => {
    expect(isProtectedFile("/some/path/self-mod/upstream.ts")).toBe(true);
    expect(isProtectedFile("/some/path/self-mod/upstream.js")).toBe(true);
    expect(isProtectedFile("/some/path/self-mod/tools-manager.ts")).toBe(true);
    expect(isProtectedFile("/some/path/self-mod/tools-manager.js")).toBe(true);
    expect(isProtectedFile("/some/path/skills/loader.ts")).toBe(true);
    expect(isProtectedFile("/some/path/skills/loader.js")).toBe(true);
    expect(isProtectedFile("/some/path/skills/registry.ts")).toBe(true);
    expect(isProtectedFile("/some/path/skills/registry.js")).toBe(true);
    expect(isProtectedFile("/some/path/automaton.json")).toBe(true);
    expect(isProtectedFile("/some/path/package.json")).toBe(true);
    expect(isProtectedFile("/some/path/SOUL.md")).toBe(true);
    expect(isProtectedFile("/some/path/agent/policy-engine.ts")).toBe(true);
    expect(isProtectedFile("/some/path/agent/policy-engine.js")).toBe(true);
    expect(isProtectedFile("/some/path/agent/policy-rules/index.ts")).toBe(true);
    expect(isProtectedFile("/some/path/agent/policy-rules/index.js")).toBe(true);
  });

  it("does NOT false-positive on substring matches", () => {
    // "tools.ts" should not match "my-tools.ts"
    expect(isProtectedFile("/some/path/my-tools.ts")).toBe(false);
    // "code.ts" should not match "barcode.ts"
    expect(isProtectedFile("/some/path/barcode.ts")).toBe(false);
    // "config.json" should not match "my-config.json"
    expect(isProtectedFile("/some/path/my-config.json")).toBe(false);
    // "wallet.json" should not match "test-wallet.json"
    expect(isProtectedFile("/some/path/test-wallet.json")).toBe(false);
  });

  it("allows normal unprotected files", () => {
    expect(isProtectedFile("/some/path/readme.md")).toBe(false);
    expect(isProtectedFile("/some/path/src/index.ts")).toBe(false);
    expect(isProtectedFile("/some/path/data.csv")).toBe(false);
  });

  it("blocks paths in blocked directories", () => {
    expect(isProtectedFile("/home/user/.ssh/id_rsa")).toBe(true);
    expect(isProtectedFile("/home/user/.gnupg/keys")).toBe(true);
    expect(isProtectedFile("/etc/systemd/system/something.service")).toBe(true);
    expect(isProtectedFile("/proc/self/environ")).toBe(true);
  });
});

// ─── Policy Rules Tests ─────────────────────────────────────────

describe("path protection policy rules", () => {
  const rules = createPathProtectionRules();

  const protectedFilesRule = rules.find((r) => r.id === "path.protected_files")!;
  const readSensitiveRule = rules.find((r) => r.id === "path.read_sensitive")!;
  const traversalRule = rules.find((r) => r.id === "path.traversal_detection")!;

  describe("path.protected_files", () => {
    it("denies write to wallet.json", () => {
      const request = makeMockRequest("write_file", { path: "wallet.json" });
      const result = protectedFilesRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reasonCode).toBe("PROTECTED_FILE");
    });

    it("denies write to injection-defense.ts", () => {
      const request = makeMockRequest("write_file", {
        path: "/some/path/injection-defense.ts",
      });
      const result = protectedFilesRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("allows write to normal file", () => {
      const request = makeMockRequest("write_file", { path: "readme.md" });
      const result = protectedFilesRule.evaluate(request);
      expect(result).toBeNull();
    });

    it("denies edit_own_file to protected file", () => {
      const request = makeMockRequest("edit_own_file", { path: "agent/tools.ts" });
      request.tool = makeMockTool("edit_own_file");
      const result = protectedFilesRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });
  });

  describe("path.read_sensitive", () => {
    it("denies read of wallet.json", () => {
      const request = makeMockRequest("read_file", { path: "wallet.json" });
      request.tool = makeMockTool("read_file");
      const result = readSensitiveRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reasonCode).toBe("SENSITIVE_FILE_READ");
    });

    it("denies read of .env", () => {
      const request = makeMockRequest("read_file", { path: ".env" });
      request.tool = makeMockTool("read_file");
      const result = readSensitiveRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("denies read of automaton.json", () => {
      const request = makeMockRequest("read_file", { path: "automaton.json" });
      request.tool = makeMockTool("read_file");
      const result = readSensitiveRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("denies read of .key files", () => {
      const request = makeMockRequest("read_file", { path: "server.key" });
      request.tool = makeMockTool("read_file");
      const result = readSensitiveRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("denies read of .pem files", () => {
      const request = makeMockRequest("read_file", { path: "cert.pem" });
      request.tool = makeMockTool("read_file");
      const result = readSensitiveRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("denies read of private-key files", () => {
      const request = makeMockRequest("read_file", { path: "private-key.txt" });
      request.tool = makeMockTool("read_file");
      const result = readSensitiveRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("allows read of normal file", () => {
      const request = makeMockRequest("read_file", { path: "readme.md" });
      request.tool = makeMockTool("read_file");
      const result = readSensitiveRule.evaluate(request);
      expect(result).toBeNull();
    });
  });

  describe("path.traversal_detection", () => {
    // Traversal detection only applies to edit_own_file (local filesystem).
    // write_file and read_file operate on the remote Conway sandbox via API,
    // so local cwd-based checks would false-positive on sandbox paths.

    it("denies edit_own_file with ../../../etc/passwd", () => {
      const request = makeMockRequest("edit_own_file", {
        path: "../../../etc/passwd",
      });
      request.tool = makeMockTool("edit_own_file");
      const result = traversalRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reasonCode).toBe("PATH_TRAVERSAL");
    });

    it("denies edit_own_file with double-slash paths", () => {
      const request = makeMockRequest("edit_own_file", {
        path: "/tmp//escape/trick",
      });
      request.tool = makeMockTool("edit_own_file");
      const result = traversalRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("allows edit_own_file with normal relative paths", () => {
      const request = makeMockRequest("edit_own_file", {
        path: "src/agent/tools.ts",
      });
      request.tool = makeMockTool("edit_own_file");
      const result = traversalRule.evaluate(request);
      expect(result).toBeNull();
    });

    it("allows edit_own_file with absolute paths within cwd", () => {
      const cwd = process.cwd();
      const request = makeMockRequest("edit_own_file", {
        path: path.join(cwd, "src", "index.ts"),
      });
      request.tool = makeMockTool("edit_own_file");
      const result = traversalRule.evaluate(request);
      expect(result).toBeNull();
    });

    it("denies edit_own_file with absolute paths outside cwd", () => {
      const request = makeMockRequest("edit_own_file", {
        path: "/etc/passwd",
      });
      request.tool = makeMockTool("edit_own_file");
      const result = traversalRule.evaluate(request);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reasonCode).toBe("PATH_TRAVERSAL");
    });

    it("does not apply to write_file (remote sandbox)", () => {
      const request = makeMockRequest("write_file", {
        path: "/home/conway/app.py",
      });
      // The rule's appliesTo only includes edit_own_file,
      // so it should not match write_file at all.
      // We verify by checking appliesTo directly.
      const appliesTo = traversalRule.appliesTo;
      expect(appliesTo.by).toBe("name");
      if (appliesTo.by === "name") {
        expect(appliesTo.names).not.toContain("write_file");
        expect(appliesTo.names).not.toContain("read_file");
        expect(appliesTo.names).toContain("edit_own_file");
      }
    });
  });
});

// ─── Rule Registration Tests ─────────────────────────────────────

describe("path protection rule registration", () => {
  it("exports three rules", () => {
    const rules = createPathProtectionRules();
    expect(rules).toHaveLength(3);
  });

  it("all rules have priority 200", () => {
    const rules = createPathProtectionRules();
    for (const rule of rules) {
      expect(rule.priority).toBe(200);
    }
  });

  it("all rules have correct IDs", () => {
    const rules = createPathProtectionRules();
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("path.protected_files");
    expect(ids).toContain("path.read_sensitive");
    expect(ids).toContain("path.traversal_detection");
  });
});

// ─── Real paths, read gaps and clone targets ─────────────────────

describe("path protection on real paths", () => {
  const rules = createPathProtectionRules();
  const protectedFilesRule = rules.find((r) => r.id === "path.protected_files")!;
  const readSensitiveRule = rules.find((r) => r.id === "path.read_sensitive")!;
  let tmp: string;
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "path-protection-")));
    home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    fs.writeFileSync(path.join(home, ".automaton", "wallet.json"), JSON.stringify({ privateKey: "0x" + "cd".repeat(32) }));
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function read(filePath: string) {
    const request = makeMockRequest("read_file", { path: filePath });
    return readSensitiveRule.evaluate(request);
  }

  it("denies reads of SSH keys, process environment, env variants, backups and state-dir files", () => {
    const gaps = [
      "~/.ssh/id_ed25519",
      "/root/.ssh/id_rsa",
      "/proc/self/environ",
      ".env.local",
      ".env.production",
      "automaton.json.bak",
      "~/.config/solana/id.json",
      "~/.automaton/state.db",
      "~/.automaton/inference-providers.json",
      "~/.automaton/.git/config",
      `${home}/.automaton/state.db`,
    ];
    for (const gap of gaps) {
      const result = read(gap);
      expect(result, gap).not.toBeNull();
      expect(result!.reasonCode, gap).toBe("SENSITIVE_FILE_READ");
    }
    expect(read("~/.automaton/WORKLOG.md")).toBeNull();
    expect(read("~/.automaton/workspace/g/a.txt")).toBeNull();
  });

  it("main read_file of a relative symlink to the wallet is denied before conway.readFile runs", async () => {
    const cwd = path.join(tmp, "cwd");
    fs.mkdirSync(cwd);
    fs.symlinkSync(path.join(home, ".automaton", "wallet.json"), path.join(cwd, "notes.txt"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    const result = await runMainReadFile("notes.txt");

    expect(result.error).toContain("SENSITIVE_FILE_READ");
    expect(result.readCalls).toEqual([]);
    expect(result.execCalls).toEqual([]);
  });

  it("main read_file is checked against every base the tool may resolve a relative path in", async () => {
    // The link is in HOME, where the exec(cat) fallback runs, not in cwd.
    fs.symlinkSync(path.join(home, ".automaton", "wallet.json"), path.join(home, "notes.txt"));
    vi.spyOn(process, "cwd").mockReturnValue(path.join(tmp));

    const result = await runMainReadFile("notes.txt");

    expect(result.error).toContain("SENSITIVE_FILE_READ");
    expect(result.readCalls).toEqual([]);
  });

  it("denies git_clone into the skills directory, the state directory or the runtime's guard code", () => {
    for (const target of [
      "~/.automaton/skills/x",
      `${home}/.automaton/skills/x`,
      "~/.automaton",
      "~/.automaton/heartbeat.yml",
      path.join(process.cwd(), "src", "agent", "policy-rules", "x"),
    ]) {
      const request = makeMockRequest("git_clone", { url: "https://example.test/r.git", path: target });
      const result = protectedFilesRule.evaluate(request);
      expect(result, target).not.toBeNull();
      expect(result!.action, target).toBe("deny");
    }
    const ok = makeMockRequest("git_clone", { url: "https://example.test/r.git", path: "~/.automaton/workspace/g/repo" });
    expect(protectedFilesRule.evaluate(ok)).toBeNull();
  });

  it("denies write_file onto a symlink, naming the link", () => {
    fs.writeFileSync(path.join(tmp, "plain.txt"), "x");
    fs.symlinkSync(path.join(tmp, "plain.txt"), path.join(tmp, "link.txt"));
    const result = protectedFilesRule.evaluate(makeMockRequest("write_file", { path: path.join(tmp, "link.txt") }));
    expect(result?.reasonCode).toBe("PROTECTED_SYMLINK");
  });

  it("expands \"~name/...\" the way the tools do, so it cannot dodge the read rule", async () => {
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    fs.mkdirSync(path.join(home, "proj"));
    fs.symlinkSync("../.ssh/id_ed25519", path.join(home, "proj", "README.md"));
    fs.symlinkSync("../.automaton/wallet.json", path.join(home, "proj", "notes.md"));
    for (const p of [
      "~proj/README.md",
      "~proj/notes.md",
      "~.config/solana/id.json",
      "~.aws/credentials",
      "~.automaton/inference-providers.json",
      "~.automaton/wallet.json",
      "~//.ssh/id_ed25519",
    ]) {
      expect(read(p)?.reasonCode, p).toBe("SENSITIVE_FILE_READ");
    }
    // A literal "~name" file in cwd is still checked too.
    const cwd = path.join(tmp, "cwd");
    fs.mkdirSync(path.join(cwd, "~x"), { recursive: true });
    fs.symlinkSync(path.join(home, ".automaton", "wallet.json"), path.join(cwd, "~x", "a.txt"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(read("~x/a.txt")?.reasonCode).toBe("SENSITIVE_FILE_READ");

    const result = await runMainReadFile("~proj/README.md");
    expect(result.error).toContain("SENSITIVE_FILE_READ");
    expect(result.readCalls).toEqual([]);
  });

  it("denies write_file through a symlink reached as \"~dir/link\"", () => {
    fs.writeFileSync(path.join(home, ".automaton", "heartbeat.yml"), "entries: []\n");
    fs.mkdirSync(path.join(home, "d"));
    fs.symlinkSync("../.automaton/heartbeat.yml", path.join(home, "d", "notes.txt"));
    // A directory link into the runtime's guard code.
    fs.symlinkSync(path.join(process.cwd(), "src", "agent"), path.join(home, "d", "lnk"));
    const write = (p: string) => protectedFilesRule.evaluate(makeMockRequest("write_file", { path: p }));

    expect(write("~d/notes.txt")?.action).toBe("deny");
    expect(write("~d/notes.txt")?.reasonCode).toBe("PROTECTED_SYMLINK");
    expect(write("~d/lnk/policy-rules/financial.ts")?.action).toBe("deny");
    expect(write("~.automaton/heartbeat.yml")?.action).toBe("deny");
    expect(write("~d/plain.txt")).toBeNull();
  });

  async function runMainReadFile(filePath: string) {
    const db = createTestDb();
    try {
      const conway = new MockConwayClient();
      const readCalls: string[] = [];
      const origRead = conway.readFile.bind(conway);
      conway.readFile = async (p: string) => {
        readCalls.push(p);
        return origRead(p);
      };
      const identity = createTestIdentity();
      const config = createTestConfig();
      const context: ToolContext = { identity, config, db, conway, inference: new MockInferenceClient([]) };
      const request = makeMockRequest("read_file", {});
      const result = await executeTool(
        "read_file",
        { path: filePath },
        createBuiltinTools(identity.sandboxId),
        context,
        new PolicyEngine(db.raw, createDefaultRules()),
        { ...request.turnContext, inputSource: "agent" },
      );
      return { error: result.error ?? "", readCalls, execCalls: conway.execCalls.map((c) => c.command) };
    } finally {
      db.close();
    }
  }
});
