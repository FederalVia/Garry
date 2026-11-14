/**
 * The operator file, agent-supplied values and agent-row approval.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentServerApprovalHash,
  agentWritableRoots,
  checkAgentPackageIntegrity,
  checkAgentPackageLocation,
  loadMcpConfig,
  packageFingerprint,
  parseRegistrySpec,
  resolveAgentRow,
  validateAgentLaunchValues,
} from "../../mcp/config.js";
import { StructuredLogger } from "../../observability/logger.js";
import { clearRegisteredSecrets, redactSecrets, registerSecret } from "../../security/secret-redaction.js";

let tmp: string;
let home: string;
let originalHome: string | undefined;
let cfgPath: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-")));
  home = path.join(tmp, "home");
  originalHome = process.env.HOME;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  cfgPath = path.join(home, ".automaton", "mcp-servers.json");
});

afterAll(() => {
  clearRegisteredSecrets();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

afterEach(() => {
  clearRegisteredSecrets();
});

function write(doc: unknown, mode = 0o600): void {
  fs.writeFileSync(cfgPath, typeof doc === "string" ? doc : JSON.stringify(doc));
  fs.chmodSync(cfgPath, mode);
}

describe("operator file", () => {
  it("a missing file is not present and disabled", () => {
    const cfg = loadMcpConfig({ path: path.join(tmp, "nope.json") });
    expect(cfg.present).toBe(false);
    expect(cfg.enabled).toBe(false);
  });

  it("refuses a group- or world-writable file", () => {
    write({ version: 1, servers: { a: { command: process.execPath } } }, 0o620);
    const cfg = loadMcpConfig({ path: cfgPath });
    expect(cfg.present).toBe(false);
    expect(cfg.warnings.join()).toMatch(/group- or world-writable/);
  });

  it("refuses a file with another hard link", () => {
    write({ version: 1, servers: {} });
    const link = path.join(tmp, "hardlink.json");
    fs.rmSync(link, { force: true });
    fs.linkSync(cfgPath, link);
    try {
      const cfg = loadMcpConfig({ path: cfgPath });
      expect(cfg.present).toBe(false);
    } finally {
      fs.rmSync(link);
    }
  });

  it("skips bad entries with a warning and loads the rest", () => {
    write({
      version: 1,
      servers: {
        Bad_Name: { command: process.execPath },
        unknownkey: { command: process.execPath, shell: true },
        missing: { command: "definitely-not-a-real-binary-xyz" },
        good: { command: process.execPath, args: ["x"] },
        web: { transport: "http", url: "https://user:pw@example.com/mcp" },
        host: { transport: "http", url: "https://example.com/mcp", headers: { Host: "evil" } },
      },
    });
    const cfg = loadMcpConfig({ path: cfgPath });
    expect(cfg.servers.map((s) => s.name)).toEqual(["good"]);
    const w = cfg.warnings.join("\n");
    expect(w).toMatch(/"Bad_Name" skipped: its name must match/);
    expect(w).toMatch(/"unknownkey" skipped: unknown key\(s\) "shell"/);
    expect(w).toMatch(/"missing" skipped: command .* was not found/);
    expect(w).toMatch(/"web" skipped: the URL carries credentials/);
    expect(w).toMatch(/"host" skipped: header "Host" is set by the runtime/);
  });

  it("clamps limits and resolves the command to an absolute real path", () => {
    write({ version: 1, servers: { a: { command: path.basename(process.execPath), callTimeoutMs: 10_000_000, maxResultChars: 99 } } });
    const cfg = loadMcpConfig({ path: cfgPath, envPath: path.dirname(process.execPath) });
    const a = cfg.servers[0];
    expect(a.transport).toBe("stdio");
    if (a.transport !== "stdio") return;
    expect(a.command).toBe(fs.realpathSync(process.execPath));
    expect(a.callTimeoutMs).toBe(600_000);
    expect(a.maxResultChars).toBe(1_000);
    expect(a.cwd).toBe(path.join(home, ".automaton", "mcp", "a"));
  });

  it("registers env and header values as secrets and never logs them", () => {
    const lines: string[] = [];
    StructuredLogger.setSink((e) => lines.push(JSON.stringify(e)));
    try {
      write({
        version: 1,
        servers: {
          gh: { command: process.execPath, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_operator_token_0123456789", SHORT: "abc" } },
          docs: { transport: "http", url: "https://example.com/mcp?key=query-secret-0123456789", headers: { Authorization: "Bearer header-secret-0123456789" } },
        },
      });
      const cfg = loadMcpConfig({ path: cfgPath });
      expect(cfg.servers).toHaveLength(2);
      expect(redactSecrets("x ghp_operator_token_0123456789 y")).toBe("x [REDACTED:mcp:gh] y");
      expect(redactSecrets("Bearer header-secret-0123456789")).toContain("[REDACTED:mcp:docs]");
      expect(redactSecrets("query-secret-0123456789")).toBe("[REDACTED:mcp:docs]");
      expect(cfg.warnings.join()).toMatch(/env SHORT is shorter than 16 characters/);
      expect(cfg.warnings.join()).not.toContain("abc");
      expect(lines.join("\n")).not.toContain("ghp_operator_token");
    } finally {
      StructuredLogger.resetSink();
    }
  });

  it("refuses a secret-bearing server whose program the agent can write or shadow", () => {
    const bin = path.join(home, ".automaton", "workspace", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const fake = path.join(bin, "github-mcp-server");
    fs.writeFileSync(fake, "#!/bin/sh\n");
    fs.chmodSync(fake, 0o755);
    write({
      version: 1,
      servers: {
        gh: { command: "github-mcp-server", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_operator_token_0123456789" } },
        plain: { command: "github-mcp-server" },
      },
    });
    const cfg = loadMcpConfig({ path: cfgPath, envPath: bin });
    expect(cfg.servers.map((s) => s.name)).toEqual(["plain"]);
    expect(cfg.warnings.join()).toMatch(/"gh" skipped: its command resolves to .* which the agent can write/);
  });

  it("refuses a secret-bearing server whose script argument the agent can write", () => {
    const prefix = path.join(tmp, "npm-global-script");
    const pkg = path.join(prefix, "lib", "node_modules", "mcp-github");
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    const script = path.join(pkg, "index.js");
    fs.writeFileSync(script, "console.log('server')\n");
    const token = { GITHUB_TOKEN: "ghp_operator_token_0123456789" };
    write({
      version: 1,
      servers: {
        vianode: { command: process.execPath, args: [script], env: token },
        viaflag: { command: process.execPath, args: [`--import=${script}`, "/dev/null"], env: token },
        relative: { command: process.execPath, args: ["index.js"], cwd: pkg, env: token },
        nosecret: { command: process.execPath, args: [script] },
        // A directory argument (a filesystem server's root) is not a program.
        dirarg: { command: process.execPath, args: [pkg], env: token },
      },
    });
    const cfg = loadMcpConfig({ path: cfgPath, npmPrefix: prefix });
    expect(cfg.servers.map((s) => s.name).sort()).toEqual(["dirarg", "nosecret"]);
    for (const name of ["vianode", "viaflag", "relative"]) {
      expect(cfg.warnings.join("\n")).toMatch(new RegExp(`"${name}" skipped: its argument .* which the agent can write`));
    }
  });

  it("refuses a secret-bearing script whose #!/usr/bin/env interpreter resolves into an agent-writable dir", () => {
    const prefix = path.join(tmp, "npm-global-shebang");
    const npmBin = path.join(prefix, "bin");
    fs.mkdirSync(npmBin, { recursive: true });
    fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
    // The agent planted "node" in the npm global bin (install_npm_package can).
    fs.writeFileSync(path.join(npmBin, "node"), "#!/bin/sh\n");
    fs.chmodSync(path.join(npmBin, "node"), 0o755);
    const opDir = path.join(tmp, "operator-bin");
    fs.mkdirSync(opDir, { recursive: true });
    const server = path.join(opDir, "server");
    fs.writeFileSync(server, "#!/usr/bin/env node\nconsole.log(1)\n");
    fs.chmodSync(server, 0o755);
    const direct = path.join(opDir, "direct");
    fs.writeFileSync(direct, `#!${path.join(npmBin, "node")}\n`);
    fs.chmodSync(direct, 0o755);
    const token = { GITHUB_TOKEN: "ghp_operator_token_0123456789" };
    write({
      version: 1,
      servers: {
        viaenv: { command: server, env: token },
        viapath: { command: direct, env: token },
        nosecret: { command: server },
        // The operator's PATH for this server puts a safe dir first.
        safepath: { command: server, env: { ...token, PATH: `${path.dirname(process.execPath)}:${npmBin}` } },
      },
    });
    const cfg = loadMcpConfig({ path: cfgPath, npmPrefix: prefix, envPath: `${npmBin}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
    expect(cfg.servers.map((s) => s.name).sort()).toEqual(["nosecret", "safepath"]);
    for (const name of ["viaenv", "viapath"]) {
      expect(cfg.warnings.join("\n")).toMatch(new RegExp(`"${name}" skipped: its command runs through .*/bin/node, inside .* which the agent can write`));
    }
  });

  it("treats the npm global bin dir as agent-writable when this user can write it", () => {
    const prefix = path.join(tmp, "npm-prefix");
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
    const roots = agentWritableRoots(prefix);
    expect(roots).toContain(path.join(prefix, "bin"));
    expect(roots).toContain(path.join(home, ".automaton"));
  });

  it("warns about launchers that fetch code on start", () => {
    const bin = path.join(tmp, "launchers");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "npx"), "#!/bin/sh\n");
    fs.chmodSync(path.join(bin, "npx"), 0o755);
    write({ version: 1, servers: { a: { command: "npx", args: ["-y", "some-server"] } } });
    const cfg = loadMcpConfig({ path: cfgPath, envPath: bin });
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.warnings.join()).toMatch(/runs through npx, which fetches code/);
  });

  it("requires version 1 and valid approvals", () => {
    write({ version: 2, servers: {} });
    expect(loadMcpConfig({ path: cfgPath }).present).toBe(false);
    write({ version: 1, agentServers: { ok: `sha256:${"a".repeat(64)}`, bad: "md5:1" } });
    const cfg = loadMcpConfig({ path: cfgPath });
    expect([...cfg.agentApprovals.keys()]).toEqual(["ok"]);
  });
});

describe("agent-supplied values", () => {
  it("accepts only npm registry specs", () => {
    expect(parseRegistrySpec("some-server")).toEqual({ name: "some-server" });
    expect(parseRegistrySpec("@scope/server@1.2.3")).toEqual({ name: "@scope/server", version: "1.2.3" });
    for (const bad of [
      "../.automaton/workspace/evil",
      "/abs/path",
      "./local",
      "file:../x",
      "git+https://github.com/x/y.git",
      "https://example.com/x.tgz",
      "github:x/y",
      "x@latest",
      "x@^1.0.0",
      "Upper",
      "a/../b",
      "evil.tgz/..",
    ]) {
      expect(parseRegistrySpec(bad), bad).toBeNull();
    }
  });

  it("refuses credential and loader env names, secret values and metacharacters", () => {
    expect(validateAgentLaunchValues(["--port", "1"], { LOG_LEVEL: "debug" })).toEqual({ args: ["--port", "1"], env: { LOG_LEVEL: "debug" } });
    for (const env of [{ LD_PRELOAD: "/x.so" }, { NODE_OPTIONS: "--require x" }, { API_TOKEN: "x" }, { PATH: "/tmp" }, { GIT_SSH: "x" }]) {
      expect("error" in validateAgentLaunchValues([], env), JSON.stringify(env)).toBe(true);
    }
    registerSecret("wallet-secret-value-0123456789", "wallet");
    expect(validateAgentLaunchValues([], { X: "wallet-secret-value-0123456789" })).toEqual({ error: "env value of X contains a secret" });
    expect(validateAgentLaunchValues(["a;b"], {})).toMatchObject({ error: expect.stringMatching(/shell metacharacter/) });
  });
});

describe("agent rows", () => {
  function setupPackage(): { prefix: string; pkgDir: string; bin: string; contentHash: string } {
    const prefix = path.join(tmp, `prefix-${Math.random().toString(36).slice(2)}`);
    const pkgDir = path.join(prefix, "lib", "node_modules", "fixture-mcp");
    fs.mkdirSync(path.join(pkgDir, "node_modules", "dep"), { recursive: true });
    const bin = path.join(pkgDir, "server.mjs");
    fs.writeFileSync(bin, "// v1\n");
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "fixture-mcp", version: "1.0.0", bin: "server.mjs" }));
    fs.writeFileSync(path.join(pkgDir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const fp = packageFingerprint(fs.realpathSync(pkgDir));
    if ("error" in fp) throw new Error(fp.error);
    return { prefix, pkgDir: fs.realpathSync(pkgDir), bin: fs.realpathSync(bin), contentHash: fp.hash };
  }

  it("starts only with the operator approval of exactly this spec", () => {
    const { prefix, bin, contentHash } = setupPackage();
    const config = { transport: "stdio", package: "fixture-mcp", version: "1.0.0", bin, contentHash, args: ["--x"], env: {}, installedBy: "agent" };
    const row = { id: "r1", name: "fixture", type: "mcp", config, enabled: true };
    const hash = agentServerApprovalHash({ package: "fixture-mcp", version: "1.0.0", bin, contentHash, args: ["--x"], env: {} });
    const base = { operatorNames: new Set<string>(), localExec: true, npmPrefix: prefix };
    const unapproved = resolveAgentRow(row, { ...base, approvals: new Map() });
    expect(unapproved.skip).toContain(`"fixture": "${hash}"`);
    expect(unapproved.skip).toContain("runtime user's file and network access");
    const ok = resolveAgentRow(row, { ...base, approvals: new Map([["fixture", hash]]) });
    expect(ok.spec?.command).toBe(process.execPath);
    expect(ok.spec?.args).toEqual([bin, "--x"]);
    // A changed row with the old approval does not start.
    const changed = { ...row, config: { ...config, args: ["--y"] } };
    expect(resolveAgentRow(changed, { ...base, approvals: new Map([["fixture", hash]]) }).skip).toMatch(/not approved/);
    // Remote sandbox: refused even when approved.
    expect(resolveAgentRow(row, { ...base, localExec: false, approvals: new Map([["fixture", hash]]) }).skip).toMatch(/only where exec runs/);
    // An operator server with the same name wins.
    expect(resolveAgentRow(row, { ...base, operatorNames: new Set(["fixture"]), approvals: new Map([["fixture", hash]]) }).skip).toMatch(/operator server/);
    // A row without a content hash (installed before pinning) does not start.
    const { contentHash: _drop, ...unpinned } = config;
    expect(resolveAgentRow({ ...row, config: unpinned }, { ...base, approvals: new Map([["fixture", hash]]) }).skip).toMatch(/no pinned content hash/);
  });

  it("refuses an approved package whose version or files changed after approval", () => {
    const { prefix, pkgDir, bin, contentHash } = setupPackage();
    const agent = { package: "fixture-mcp", version: "1.0.0", bin, contentHash };
    const config = { transport: "stdio", ...agent, args: [], env: {}, installedBy: "agent" };
    const row = { id: "r2", name: "fixture", type: "mcp", config, enabled: true };
    const approvals = new Map([["fixture", agentServerApprovalHash({ ...agent, args: [], env: {} })]]);
    const ctx = { approvals, operatorNames: new Set<string>(), localExec: true, npmPrefix: prefix };
    expect(resolveAgentRow(row, ctx).spec?.agent).toEqual(agent);
    expect(checkAgentPackageIntegrity(agent, prefix, { content: true })).toEqual({ bin });

    // Code replaced, version unchanged: refused before spawning.
    fs.writeFileSync(bin, "require('fs').readFileSync(process.env.HOME + '/.automaton/wallet.json');\n");
    expect(checkAgentPackageIntegrity(agent, prefix, { content: true })).toMatchObject({ error: expect.stringMatching(/files changed/) });
    fs.writeFileSync(bin, "// v1\n");
    // A dependency changed: refused as well.
    fs.writeFileSync(path.join(pkgDir, "node_modules", "dep", "index.js"), "evil();\n");
    expect(checkAgentPackageIntegrity(agent, prefix, { content: true })).toMatchObject({ error: expect.stringMatching(/files changed/) });
    fs.writeFileSync(path.join(pkgDir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    expect(checkAgentPackageIntegrity(agent, prefix, { content: true })).toEqual({ bin });

    // Another version installed in place (npm install -g pkg@other): refused at resolve.
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "fixture-mcp", version: "6.6.6", bin: "server.mjs" }));
    expect(resolveAgentRow(row, ctx).skip).toMatch(/installed version is 6\.6\.6, not the approved 1\.0\.0/);
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "other", version: "1.0.0" }));
    expect(resolveAgentRow(row, ctx).skip).toMatch(/names another package/);
  });

  it("fingerprints links by target without following them", () => {
    const { pkgDir, contentHash } = setupPackage();
    fs.symlinkSync("/etc/hostname", path.join(pkgDir, "link"));
    const withLink = packageFingerprint(pkgDir);
    expect("hash" in withLink && withLink.hash).not.toBe(contentHash);
    fs.rmSync(path.join(pkgDir, "link"));
    expect(packageFingerprint(pkgDir)).toEqual({ hash: contentHash });
  });

  it("does not start rows from before MCP execution existed", () => {
    const r = resolveAgentRow(
      { id: "old", name: "slack", type: "mcp", config: {}, enabled: true },
      { approvals: new Map(), operatorNames: new Set(), localExec: true, npmPrefix: null },
    );
    expect(r.skip).toMatch(/reinstall it with install_mcp_server/);
  });

  it("refuses a package dir that is a link to a directory the agent writes", () => {
    const prefix = path.join(tmp, "prefix-link");
    const nm = path.join(prefix, "lib", "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    const evil = path.join(home, ".automaton", "workspace", "evil");
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, "server.mjs"), "");
    fs.symlinkSync(evil, path.join(nm, "evil"));
    const r = checkAgentPackageLocation("evil", path.join(nm, "evil", "server.mjs"), prefix);
    expect("error" in r && r.error).toMatch(/linked or missing/);
    const outside = checkAgentPackageLocation("fixture-mcp", "/bin/sh", setupPackage().prefix);
    expect("error" in outside && outside.error).toMatch(/not inside its package directory/);
  });
});
