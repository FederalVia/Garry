/**
 * The shared sensitive/protected path definition, the secure file primitives
 * and the scrubbed child environment.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkRead,
  checkWrite,
  GUARD_COMMAND_FRAGMENTS,
  matchProtected,
  matchSensitive,
  runtimeRoot,
  stateDir,
} from "../security/protected-paths.js";
import {
  readFileSafe,
  readRegularFileNoFollow,
  UnsafePathError,
  writeFileSafe,
} from "../security/secure-fs.js";
import { childProcessEnv } from "../security/child-env.js";

let tmp: string;
let home: string;
let originalHome: string | undefined;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "protected-paths-")));
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const H = () => home;
const S = () => path.join(home, ".automaton");
const R = () => runtimeRoot();

describe("matchSensitive (read-deny)", () => {
  const denied = (): string[] => [
    // secret names, anywhere
    `${S()}/wallet.json`, "/x/wallet.json", "/x/wallet.json.bak", "/x/automaton.json", "/x/automaton.json.bak",
    "/x/config.json", "/x/.env", "/x/.env.local", "/x/.env.production", "/x/server.key", "/x/cert.pem",
    "/x/a.p12", "/x/a.pfx", "/x/a.jks", "/x/a.keystore", "/x/private-key.txt", "/x/id_rsa", "/x/id_ed25519",
    "/x/id_ecdsa_sk", "/x/id_dsa", "/x/.netrc", "/x/_netrc", "/x/.pgpass", "/x/.git-credentials", "/x/.npmrc",
    "/x/.pypirc", "/x/state.db", "/x/state.db-wal", "/x/state.db-shm", "/x/state.db-journal",
    "/x/.bash_history", "/x/.zsh_history", "/x/.python_history", "/x/.node_repl_history",
    // secret dirs
    `${H()}/.ssh/config`, "/root/.ssh/id_rsa", `${H()}/.ssh/id_ed25519`, "/x/.gnupg/k", "/x/.gpg/k",
    "/x/.aws/credentials", "/x/.azure/a", "/x/.gcloud/a", "/x/.kube/config", "/x/.docker/config.json",
    "/x/.password-store/a", `${H()}/.config/solana/id.json`, "/x/.config/gcloud/a", "/x/.config/gh/hosts.yml",
    "/x/.local/share/keyrings/a",
    // system
    "/proc/self/environ", "/proc/1/environ", "/sys/kernel/x", "/dev/sda", "/run/secrets/token",
    "/var/run/secrets/token", "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/sudoers.d/x",
    // state dir allowlist
    `${S()}/state.db`, `${S()}/inference-providers.json`, `${S()}/.git/config`, `${S()}/unknown.txt`,
    `${S()}/automaton.json`, "/root/.automaton/notes.txt",
  ];
  const allowed = (): string[] => [
    "/x/.env.example", "/x/.env.sample", "/x/.env.template", "/x/.env.dist", "/dev/null", "/x/id_rsa.pub",
    "/tmp/x.txt", "/p/tsconfig.json", "/p/barcode.ts", `${R()}/src/memory/tools.ts`, "/p/test-wallet.json",
    `${S()}`, `${S()}/SOUL.md`, `${S()}/WORKLOG.md`, `${S()}/heartbeat.yml`, `${S()}/constitution.md`,
    `${S()}/genesis.json`, `${S()}/agent-card.json`, `${S()}/agent.log`, `${S()}/logs/a.txt`,
    `${S()}/skills/x/SKILL.md`, `${S()}/workspace/g/a.txt`, `${S()}/runtime/src/x.ts`,
  ];

  it("denies every read-deny rule", () => {
    for (const p of denied()) expect(matchSensitive(p), p).not.toBeNull();
  });

  it("allows ordinary paths and the state-dir read allowlist", () => {
    for (const p of allowed()) expect(matchSensitive(p), p).toBeNull();
  });

  it("stateDir follows HOME", () => {
    expect(stateDir()).toBe(S());
  });
});

describe("matchProtected (write-deny)", () => {
  const extraDenied = (): string[] => [
    `${S()}/SOUL.md`, `${S()}/heartbeat.yml`, `${S()}/constitution.md`, `${S()}/genesis.json`, `${S()}/agent.log`,
    `${S()}/skills`, "/x/inference-providers.json", "/x/heartbeat.yml", "/x/package.json", "/x/injection-defense.ts",
    "/x/injection-defense.js", "/x/injection-defense.d.ts", "/x/SOUL.md", "/x/constitution.md",
    // home startup files
    `${H()}/.bashrc`, `${H()}/.bash_profile`, `${H()}/.profile`, `${H()}/.zshrc`, `${H()}/.zprofile`,
    `${H()}/.gitconfig`, `${H()}/.config/git/config`, `${H()}/.local/bin/git`, `${H()}/bin/node`, "/root/.bashrc",
    // system
    "/etc/hosts", "/usr/bin/x", "/lib/x", "/lib64/x", "/bin/sh", "/sbin/x", "/boot/x", "/var/spool/cron/root",
    // guard surface with distinctive names, anywhere
    "/p/src/agent/policy-engine.ts", "/p/src/agent/policy-rules/financial.ts", "/p/dist/agent/policy-rules/financial.js",
    "/p/src/agent/spend-tracker.ts", "/p/src/agent/injection-defense.ts", "/p/src/agent/inbox-isolation.ts",
    "/p/src/agent/tools.ts", "/p/src/agent/harness-types.ts", "/p/src/agent/harness-registry.ts",
    "/p/src/self-mod/code.ts", "/p/src/self-mod/upstream.ts", "/p/src/self-mod/audit-log.ts", "/p/src/skills/loader.ts",
    "/p/src/skills/registry.ts", "/p/src/security/protected-paths.ts", "/p/src/security/secure-fs.ts",
    // the runtime checkout
    ...[R(), `${S()}/runtime`].flatMap((root) => [
      `${root}/src/agent/loop.ts`, `${root}/src/agent/system-prompt.ts`, `${root}/src/agent/harnesses/coding-harness.ts`,
      `${root}/src/skills/format.ts`, `${root}/src/orchestration/local-worker.ts`,
      `${root}/src/inference/provider-registry.ts`, `${root}/src/inference/budget.ts`,
      `${root}/src/inference/inference-client.ts`, `${root}/src/observability/logger.ts`, `${root}/src/soul/validator.ts`,
      // the inference spend gate and the paths that must pass through it
      `${root}/src/inference/gate.ts`, `${root}/src/inference/policy.ts`, `${root}/src/inference/errors.ts`,
      `${root}/src/inference/router.ts`, `${root}/dist/inference/gate.js`, `${root}/src/conway/inference.ts`,
      `${root}/src/inference/registry.ts`,
      `${root}/src/conway/http-client.ts`, `${root}/src/registry/erc8004.ts`, `${root}/dist/registry/erc8004.js`,
      `${root}/src/soul/tools.ts`, `${root}/src/soul/model.ts`, `${root}/src/heartbeat/config.ts`,
      `${root}/src/heartbeat/tasks.ts`, `${root}/dist/agent/harnesses/general-harness.js`,
      // balance reads and the operator's money paths
      `${root}/src/conway/balance.ts`, `${root}/src/heartbeat/tick-context.ts`, `${root}/src/operator/fund.ts`,
      `${root}/src/operator/send.ts`, `${root}/dist/operator/fund.js`, `${root}/packages/cli/src/commands/fund.ts`,
      `${root}/packages/cli/src/commands/send.ts`,
      `${root}/src/security/x.ts`, `${root}/src/treasury/x.ts`, `${root}/src/conway/client.ts`,
      `${root}/src/identity/wallet.ts`, `${root}/src/git/tools.ts`, `${root}/src/state/database.ts`,
      `${root}/src/replication/x.ts`, `${root}/src/survival/x.ts`, `${root}/src/index.ts`, `${root}/src/types.ts`,
      `${root}/src/config.ts`, `${root}/dist/index.js`, `${root}/node_modules/x/index.js`, `${root}/.git/config`,
      `${root}/scripts/automaton.sh`, `${root}/package.json`, `${root}/pnpm-lock.yaml`, `${root}/package-lock.json`,
      `${root}/tsconfig.json`, `${root}/tsconfig.test.json`, `${root}/.gitignore`, `${root}/constitution.md`,
      // review GUARDS-1/GUARDS-2: the workspace packages and workspace build inputs
      `${root}/packages/cli/dist/commands/fund.js`, `${root}/packages/cli/dist/commands/send.js`,
      `${root}/packages/cli/dist/index.js`, `${root}/packages/cli/src/commands/status.ts`,
      `${root}/packages/cli/tsconfig.json`, `${root}/packages/cli/node_modules/.bin/tsc`,
      `${root}/packages/cli/evil/conway/x402.ts`, `${root}/packages/evil/build.sh`, `${root}/packages/evil`,
      `${root}/pnpm-workspace.yaml`, `${root}/.pnpmfile.cjs`, `${root}/.pnpmfile.mjs`,
      // review money paths: the shared transfer classifier, the on-chain signer, guard helpers
      `${root}/src/conway/transfer-status.ts`, `${root}/src/registry/erc8004.ts`,
      `${root}/dist/registry/erc8004.js`, `${root}/src/agent/text-normalize.ts`,
      `${root}/src/observability/terminal-safe.ts`,
    ]),
  ];
  const allowed = (): string[] => [
    `${S()}/WORKLOG.md`, `${S()}/workspace/g/a.txt`, `${S()}/skills/x/SKILL.md`, `${S()}/runtime/src/memory/x.ts`,
    "/tmp/x.txt", "/p/tsconfig.json", "/p/src/index.ts", "/p/src/config.ts", "/p/src/types.ts", "/p/src/git/x.ts",
    "/p/barcode.ts", "/p/my-tools.ts", "/p/.env.example", `${H()}/notes.txt`, `${H()}/project/bin/x`,
    `${R()}/src/memory/tools.ts`, `${R()}/src/agent/context.ts`, `${R()}/src/__tests__/x.test.ts`,
    `${R()}/src/orchestration/planner.ts`, `${R()}/README.md`, `${S()}/workspace/g/tsconfig.json`,
    `${S()}/workspace/g/src/index.ts`, `${S()}/workspace/g/src/config.ts`,
    // generic guard names belong to the runtime only when inside a checkout
    `${S()}/workspace/g/src/agent/loop.ts`, `${S()}/workspace/g/src/soul/model.ts`, "/p/src/heartbeat/config.ts",
    "/p/src/agent/harnesses/main.py", "/p/src/inference/budget.ts", "/p/lib/audit-log.js",
    // workspace packages belong to the runtime only inside a checkout
    "/p/packages/cli/dist/index.js", "/p/packages/cli/tsconfig.json", "/p/pnpm-workspace.yaml",
    `${S()}/workspace/g/packages/cli/src/commands/status.ts`, `${S()}/workspace/g/pnpm-workspace.yaml`,
  ];

  it("denies every read-deny path too (superset)", () => {
    const readDenied = [
      `${S()}/wallet.json`, "/x/.env.local", "/proc/self/environ", `${S()}/state.db`, `${H()}/.ssh/id_rsa`,
      `${S()}/inference-providers.json`, `${S()}/unknown.txt`,
    ];
    for (const p of readDenied) expect(matchProtected(p), p).not.toBeNull();
  });

  it("denies the write-only rules", () => {
    for (const p of extraDenied()) expect(matchProtected(p), p).not.toBeNull();
  });

  it("allows ordinary project files and the state-dir write allowlist", () => {
    for (const p of allowed()) expect(matchProtected(p), p).toBeNull();
  });

  it("lists the inference spend gate files among the guard command fragments", () => {
    for (const f of [
      "inference/gate",
      "inference/policy",
      "inference/errors",
      "inference/router",
      "inference/budget",
      "conway/inference",
    ]) {
      expect(GUARD_COMMAND_FRAGMENTS, f).toContain(f);
    }
  });

  it("lists balance reads and the operator money paths among the guard command fragments", () => {
    for (const f of ["conway/balance", "conway/transfer-status", "registry/erc8004", "heartbeat/tick-context", "operator/fund", "operator/send"]) {
      expect(GUARD_COMMAND_FRAGMENTS, f).toContain(f);
    }
  });

  it("protects the relay client's verdict code, the distress notifier and the relay store", () => {
    for (const p of [
      `${R()}/src/social/inbound.ts`,
      `${R()}/src/social/settings.ts`,
      `${R()}/dist/social/signing.js`,
      `${R()}/src/notify/distress.ts`,
    ]) {
      expect(matchProtected(p) ?? "none", p).toMatch(/^guard:(social|notify)/);
    }
    for (const name of ["relay.db", "relay.db-wal", "relay.db-shm", "relay.db-journal"]) {
      expect(matchSensitive(`/var/lib/automaton-relay/${name}`), name).not.toBeNull();
      expect(matchProtected(`${H()}/.local/state/automaton-relay/${name}`), name).not.toBeNull();
    }
    for (const f of ["social/inbound", "social/signing", "social/protocol", "social/settings", "notify/distress"]) {
      expect(GUARD_COMMAND_FRAGMENTS, f).toContain(f);
    }
  });

  it("SOUL.md is readable but not writable", () => {
    expect(matchSensitive(`${S()}/SOUL.md`)).toBeNull();
    expect(matchProtected(`${S()}/SOUL.md`)).not.toBeNull();
  });
});

describe("checkRead / checkWrite on the filesystem", () => {
  let dir: string;
  let wallet: string;

  beforeAll(() => {
    dir = path.join(tmp, "fs-cases");
    fs.mkdirSync(path.join(dir, "outside"), { recursive: true });
    fs.mkdirSync(path.join(dir, "root"), { recursive: true });
    wallet = path.join(S(), "wallet.json");
    fs.writeFileSync(wallet, JSON.stringify({ privateKey: "0x" + "ab".repeat(32) }));
    fs.writeFileSync(path.join(dir, "root", "plain.txt"), "plain");
  });

  it("a symlink to the wallet: read denied, write denied", () => {
    const link = path.join(dir, "root", "readme.md");
    fs.symlinkSync(wallet, link);
    const read = checkRead(link);
    expect(read.ok).toBe(false);
    expect(read.code).toBe("SENSITIVE_FILE");
    expect(checkWrite(link).code).toBe("SYMLINK");
    expect(() => readFileSafe(link)).toThrow(UnsafePathError);
  });

  it("a symlink to an ordinary file inside the root: read allowed, write denied", () => {
    const link = path.join(dir, "root", "alias.txt");
    fs.symlinkSync(path.join(dir, "root", "plain.txt"), link);
    expect(checkRead(link, { root: path.join(dir, "root") }).ok).toBe(true);
    expect(readFileSafe(link, { root: path.join(dir, "root") })).toBe("plain");
    expect(checkWrite(link, { root: path.join(dir, "root") }).code).toBe("SYMLINK");
  });

  it("a parent-directory symlink is resolved and confined", () => {
    const linkDir = path.join(dir, "root", "statelink");
    fs.symlinkSync(S(), linkDir);
    fs.writeFileSync(path.join(S(), "unknown.txt"), "x");
    expect(checkRead(path.join(linkDir, "unknown.txt")).code).toBe("SENSITIVE_FILE");

    const outLink = path.join(dir, "root", "outlink");
    fs.symlinkSync(path.join(dir, "outside"), outLink);
    const w = checkWrite(path.join(outLink, "x.ts"), { root: path.join(dir, "root") });
    expect(w.ok).toBe(false);
    expect(w.code).toBe("OUTSIDE_ROOT");
    expect(() => writeFileSafe(path.join(outLink, "x.ts"), "x", { root: path.join(dir, "root") })).toThrow(UnsafePathError);
    expect(fs.existsSync(path.join(dir, "outside", "x.ts"))).toBe(false);
  });

  it("a dangling symlink: read fails, write denied and nothing is created at the target", () => {
    const link = path.join(dir, "root", "dangling.ts");
    fs.symlinkSync(path.join(dir, "outside", "created.ts"), link);
    expect(() => readFileSafe(link)).toThrow();
    expect(checkWrite(link).code).toBe("SYMLINK");
    expect(() => writeFileSafe(link, "x")).toThrow(UnsafePathError);
    expect(fs.existsSync(path.join(dir, "outside", "created.ts"))).toBe(false);
  });

  it("a hard link to the wallet is denied for reads (inode match)", () => {
    const hard = path.join(dir, "root", "innocent.txt");
    fs.linkSync(wallet, hard);
    const read = checkRead(hard);
    expect(read.ok).toBe(false);
    expect(read.code).toBe("HARDLINK");
    expect(() => readFileSafe(hard)).toThrow(UnsafePathError);
    expect(checkWrite(hard).code).toBe("HARDLINK");
  });

  it("a hard link among ordinary files: read allowed, write denied", () => {
    const a = path.join(dir, "root", "a.txt");
    const b = path.join(dir, "root", "b.txt");
    fs.writeFileSync(a, "shared");
    fs.linkSync(a, b);
    expect(checkRead(b).ok).toBe(true);
    expect(checkWrite(b).code).toBe("HARDLINK");
    expect(() => writeFileSafe(b, "changed")).toThrow(UnsafePathError);
    expect(fs.readFileSync(a, "utf8")).toBe("shared");
  });

  it("a FIFO is denied for reads", () => {
    const fifo = path.join(dir, "root", "pipe");
    execFileSync("mkfifo", [fifo]);
    expect(checkRead(fifo).code).toBe("NOT_REGULAR");
    expect(checkWrite(fifo).code).toBe("NOT_REGULAR");
  });

  it("the workspace packages of a checkout found on disk are protected (review GUARDS-1, GUARDS-2)", () => {
    const copy = path.join(dir, "ws-copy");
    const cli = path.join(copy, "packages", "cli");
    fs.mkdirSync(path.join(cli, "dist", "commands"), { recursive: true });
    fs.mkdirSync(path.join(cli, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "@conway/automaton" }));
    fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@conway/automaton-cli" }));
    fs.writeFileSync(path.join(cli, "dist", "commands", "fund.js"), "// built");
    fs.writeFileSync(path.join(cli, "node_modules", ".bin", "tsc"), "#!/bin/sh\n");
    for (const target of [
      path.join(cli, "dist", "commands", "fund.js"),
      path.join(cli, "dist", "commands", "send.js"),
      path.join(cli, "tsconfig.json"),
      path.join(cli, "node_modules", ".bin", "tsc"),
      path.join(cli, "evil", "conway", "x402.ts"),
      path.join(copy, "pnpm-workspace.yaml"),
      path.join(copy, ".pnpmfile.cjs"),
    ]) {
      expect(checkWrite(target).code, target).toBe("PROTECTED_FILE");
    }
    // A new workspace package (a clone target) is refused too.
    expect(checkWrite(path.join(copy, "packages", "evil"), { allowDirectory: true }).code).toBe("PROTECTED_FILE");
  });

  it("a file inside an automaton checkout found on disk gets the checkout rules", () => {
    const copy = path.join(dir, "copy");
    fs.mkdirSync(path.join(copy, "src"), { recursive: true });
    fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "@conway/automaton" }));
    expect(checkWrite(path.join(copy, "src", "index.ts")).code).toBe("PROTECTED_FILE");
    expect(checkWrite(path.join(copy, "dist", "x.js")).code).toBe("PROTECTED_FILE");
    expect(checkWrite(path.join(copy, "src", "memory", "x.ts")).ok).toBe(true);
    // The spending gate, the payment primitives it wraps and the funding
    // origin label are guard code.
    for (const guard of [
      ["src", "treasury", "treasury.ts"],
      ["src", "treasury", "guarded-conway.ts"],
      ["src", "conway", "x402.ts"],
      ["src", "conway", "client.ts"],
      ["src", "orchestration", "simple-tracker.ts"],
      ["dist", "treasury", "treasury.js"],
    ]) {
      expect(checkWrite(path.join(copy, ...guard)).code).toBe("PROTECTED_FILE");
    }
    // An ordinary project with the same layout is not a checkout.
    const project = path.join(dir, "project");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "weather-api" }));
    expect(checkWrite(path.join(project, "src", "index.ts")).ok).toBe(true);
  });
});

describe("secure-fs", () => {
  let dir: string;

  beforeAll(() => {
    dir = path.join(tmp, "securefs");
    fs.mkdirSync(dir, { recursive: true });
  });

  it("writeFileSafe creates parents, keeps the existing mode and replaces atomically", () => {
    const target = path.join(dir, "deep", "a", "file.txt");
    expect(writeFileSafe(target, "one")).toBe(target);
    fs.chmodSync(target, 0o600);
    writeFileSafe(target, "two");
    expect(fs.readFileSync(target, "utf8")).toBe("two");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(target)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("links are refused, also for trusted writers; replaceLinks swaps the entry instead of writing through it", () => {
    const victim = path.join(dir, "victim.json");
    fs.writeFileSync(victim, "VICTIM");
    const link = path.join(dir, "SKILL.md");
    fs.symlinkSync(victim, link);
    expect(() => writeFileSafe(link, "agent")).toThrow(UnsafePathError);
    expect(() => writeFileSafe(link, "trusted", { trustedWriter: true })).toThrow(UnsafePathError);
    expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM");
    writeFileSafe(link, "replaced", { trustedWriter: true, replaceLinks: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, "utf8")).toBe("replaced");
    expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM");

    const hard = path.join(dir, "hard.json");
    fs.linkSync(victim, hard);
    expect(() => writeFileSafe(hard, "trusted", { trustedWriter: true })).toThrow(UnsafePathError);
    writeFileSafe(hard, "replaced2", { trustedWriter: true, replaceLinks: true });
    expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM");
    expect(fs.readFileSync(hard, "utf8")).toBe("replaced2");
  });

  it("a trusted writer may write a protected file but stays confined to its root", () => {
    const root = path.join(dir, "trusted-root");
    fs.mkdirSync(root);
    writeFileSafe(path.join(root, "automaton.json"), "{}", { trustedWriter: true, root });
    expect(fs.readFileSync(path.join(root, "automaton.json"), "utf8")).toBe("{}");
    expect(() => writeFileSafe(path.join(dir, "escape.txt"), "x", { trustedWriter: true, root })).toThrow(UnsafePathError);
  });

  it("readFileSafe enforces maxBytes and root", () => {
    const big = path.join(dir, "big.txt");
    fs.writeFileSync(big, "x".repeat(100));
    expect(() => readFileSafe(big, { maxBytes: 10 })).toThrow(UnsafePathError);
    expect(() => readFileSafe(big, { root: path.join(dir, "deep") })).toThrow(UnsafePathError);
    expect(readFileSafe(big)).toHaveLength(100);
  });

  it("readRegularFileNoFollow returns content only for a plain regular file inside its root", () => {
    const root = path.join(dir, "loader-root");
    fs.mkdirSync(root);
    const plain = path.join(root, "SKILL.md");
    fs.writeFileSync(plain, "hello");
    expect(readRegularFileNoFollow(plain, { root, maxBytes: 100 })).toBe("hello");
    expect(readRegularFileNoFollow(path.join(root, "missing.md"), { root, maxBytes: 100 })).toBeNull();
    expect(readRegularFileNoFollow(plain, { root, maxBytes: 2 })).toBeNull();

    const link = path.join(root, "LINK.md");
    fs.symlinkSync(path.join(S(), "wallet.json"), link);
    expect(readRegularFileNoFollow(link, { root, maxBytes: 1000 })).toBeNull();

    const hard = path.join(root, "HARD.md");
    fs.linkSync(plain, hard);
    expect(readRegularFileNoFollow(hard, { root, maxBytes: 100 })).toBeNull();

    const sub = path.join(root, "sub");
    fs.symlinkSync(path.join(dir, "deep"), sub);
    expect(readRegularFileNoFollow(path.join(sub, "a", "file.txt"), { root, maxBytes: 100 })).toBeNull();
    expect(readRegularFileNoFollow(path.join(dir, "big.txt"), { root, maxBytes: 1000 })).toBeNull();
  });

  it("readRegularFileNoFollow can load the operator's providers file from the state dir", () => {
    const providers = path.join(S(), "inference-providers.json");
    fs.writeFileSync(providers, "{\"providers\":[]}");
    expect(checkRead(providers).ok).toBe(false);
    expect(readRegularFileNoFollow(providers, { root: S(), maxBytes: 1000 })).toBe("{\"providers\":[]}");
  });
});

describe("childProcessEnv", () => {
  it("drops credentials and keeps PATH, HOME, proxy and locale", () => {
    const env = childProcessEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
      HTTPS_PROXY: "http://proxy:3128",
      NO_PROXY: "localhost",
      CONWAY_API_KEY: "cnwy_k_x",
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
      GROQ_API_KEY: "g",
      TOGETHER_API_KEY: "t",
      OPENAI_BASE_URL: "https://evil",
      GITHUB_TOKEN: "ghp",
      NPM_TOKEN: "n",
      DB_PASSWORD: "p",
      AWS_SECRET_ACCESS_KEY: "s",
      WALLET_PRIVATE_KEY: "k",
      GOOGLE_APPLICATION_CREDENTIALS: "/x",
      NODE_ENV: "test",
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "HTTPS_PROXY", "LANG", "NODE_ENV", "NO_PROXY", "PATH"]);
  });
});
