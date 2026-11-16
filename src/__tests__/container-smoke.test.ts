/**
 * security: build the image and run its entrypoint with the documented
 * mounts. Needs a reachable Docker daemon; skipped (with the reason printed)
 * when `docker info` fails within 10 s, AUTOMATON_SKIP_DOCKER_SMOKE is set,
 * or the Dockerfile's base digest is still the placeholder (the build cannot
 * start; AUTOMATON_SMOKE_NODE_IMAGE=<tag>@sha256:<digest> builds it anyway).
 * CI pins the digest first and runs it in its own job.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_STATE, agentMounts, agentMountsWithout } from "./fixtures/container-mounts.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const IMAGE = process.env.AUTOMATON_SMOKE_IMAGE || "automaton:smoke";
const STATE = AGENT_STATE;

const PLACEHOLDER_DIGEST_RE = /^ARG NODE_IMAGE=[^@\s]+@sha256:0{64}\s*$/m;
const NODE_IMAGE_OVERRIDE = process.env.AUTOMATON_SMOKE_NODE_IMAGE?.trim() || "";

/** Why the smoke test cannot run here, or null. */
function smokeSkipReason(
  dockerfile: string,
  overrideImage: string,
  dockerInfo: () => string | null,
  skipRequested = !!process.env.AUTOMATON_SKIP_DOCKER_SMOKE,
): string | null {
  if (skipRequested) return "AUTOMATON_SKIP_DOCKER_SMOKE is set";
  if (!overrideImage && PLACEHOLDER_DIGEST_RE.test(dockerfile)) {
    return "the Dockerfile's base image digest is a placeholder (run scripts/pin-base-image.sh, or set AUTOMATON_SMOKE_NODE_IMAGE)";
  }
  return dockerInfo();
}

function dockerAvailable(): string | null {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 10_000 });
  if (r.error) return `docker not usable (${r.error.message})`;
  if (r.status !== 0) return "no Docker daemon reachable";
  return null;
}

const skipReason = smokeSkipReason(fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8"), NODE_IMAGE_OVERRIDE, dockerAvailable);
if (skipReason) {
  // eslint-disable-next-line no-console
  console.info(`container-smoke: skipped: ${skipReason}`);
}
const suite = skipReason ? describe.skip : describe;

describe("security: container smoke test preconditions", () => {
  const pinned = "ARG NODE_IMAGE=node:22-bookworm-slim@sha256:" + "ab".repeat(32) + "\n";
  const placeholder = "ARG NODE_IMAGE=node:22-bookworm-slim@sha256:" + "0".repeat(64) + "\n";
  const daemon = () => null;

  // The last argument pins the skip switch, which CI sets for the main suite.
  it("skips with a reason while the base digest is the placeholder, even with a daemon", () => {
    expect(smokeSkipReason(`# x\n${placeholder}FROM \${NODE_IMAGE}\n`, "", daemon, false)).toMatch(/digest is a placeholder/);
    expect(smokeSkipReason(pinned, "", daemon, false)).toBeNull();
    expect(smokeSkipReason(placeholder, "node:22-bookworm-slim@sha256:" + "cd".repeat(32), daemon, false)).toBeNull();
    expect(smokeSkipReason(pinned, "", () => "no Docker daemon reachable", false)).toBe("no Docker daemon reachable");
    expect(smokeSkipReason(pinned, "", daemon, true)).toBe("AUTOMATON_SKIP_DOCKER_SMOKE is set");
  });

  it("does not skip where CI requires it", () => {
    if (process.env.AUTOMATON_REQUIRE_DOCKER_SMOKE) expect(skipReason).toBeNull();
  });
});

function docker(args: string[], timeout = 120_000): SpawnSyncReturns<string> {
  return spawnSync("docker", args, { encoding: "utf8", timeout, cwd: ROOT });
}

suite("security: container image smoke test", () => {
  let dir: string;
  let mounts: string[];
  let fakeApp: string[];

  beforeAll(() => {
    const buildArgs = NODE_IMAGE_OVERRIDE ? ["--build-arg", `NODE_IMAGE=${NODE_IMAGE_OVERRIDE}`] : [];
    const build = docker(["build", ...buildArgs, "-t", IMAGE, "-f", "Dockerfile", "."], 20 * 60_000);
    expect(build.status, build.stderr.slice(-4000)).toBe(0);

    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "container-smoke-")));
    for (const d of ["state", "state-bare", "config", "owner", "fake-app/dist"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
    // Stands in for the agent: what `run` execs once the layout check passed.
    fs.writeFileSync(path.join(dir, "fake-app", "dist", "index.js"), 'console.log("STARTED " + process.argv.slice(2).join(" "));\n');
    const cfg = path.join(dir, "config");
    fs.writeFileSync(path.join(cfg, "automaton.json"), JSON.stringify({ name: "smoke", providers: { mode: "standalone" } }));
    fs.writeFileSync(path.join(cfg, "wallet.json"), JSON.stringify({ privateKey: "0x" + "1".repeat(64) }));
    fs.writeFileSync(path.join(cfg, "config.json"), "{}");
    fs.writeFileSync(path.join(cfg, "heartbeat.yml"), "entries: []\n");
    fs.writeFileSync(path.join(cfg, "inference-providers.json"), "{}");
    fs.writeFileSync(path.join(cfg, "mcp-servers.json"), '{ "version": 1, "enabled": false }');
    fs.copyFileSync(path.join(ROOT, "constitution.md"), path.join(cfg, "constitution.md"));
    // Writable by anyone on the host, so the read-only mount is the only thing
    // that can refuse the agent's writes below (not file ownership).
    for (const f of fs.readdirSync(cfg)) fs.chmodSync(path.join(cfg, f), 0o666);
    // Tunnel credential files; as writable on the host as the files above.
    fs.mkdirSync(path.join(cfg, "public-access"));
    fs.writeFileSync(path.join(cfg, "public-access", "tunnel.json"), "{}");
    fs.chmodSync(path.join(cfg, "public-access", "tunnel.json"), 0o666);
    fs.chmodSync(path.join(cfg, "public-access"), 0o777);
    fs.chmodSync(path.join(dir, "owner"), 0o777);
    // The image's user is 10001; it needs to write the state folder.
    for (const state of ["state", "state-bare"]) {
      if (process.getuid?.() === 0) fs.chownSync(path.join(dir, state), 10001, 10001);
      else fs.chmodSync(path.join(dir, state), 0o777);
    }
    fs.chmodSync(dir, 0o755);
    mounts = agentMounts(dir);
    fakeApp = ["-v", `${dir}/fake-app:/fake-app:ro`, "-e", "AUTOMATON_APP_DIR=/fake-app"];
  }, 25 * 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints its version", () => {
    const r = docker(["run", "--rm", IMAGE, "version"]);
    expect(r.status, r.stderr).toBe(0);
  });

  it("runs as uid 10001, not root", () => {
    const r = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"]);
    expect(r.stdout.trim()).toBe("10001");
  });

  it("refuses to run the agent as root", () => {
    const r = docker(["run", "--rm", "--user", "0", ...mounts, IMAGE, "run"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/as root/);
  });

  it("the documented mounts pass the layout check and the agent is started", () => {
    const r = docker(["run", "--rm", "--read-only", "--tmpfs", "/tmp", ...mounts, ...fakeApp, IMAGE, "run"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("STARTED --run");
    expect(r.stderr).not.toMatch(/refusing to start/);
  });

  it("refuses a config mounted read-write", () => {
    const rw = mounts.map((m) => (m.includes("automaton.json") ? m.replace(/:ro$/, "") : m));
    const r = docker(["run", "--rm", "--read-only", "--tmpfs", "/tmp", ...rw, ...fakeApp, IMAGE, "run"]);
    expect(r.status).toBe(64);
    expect(r.stdout).not.toContain("STARTED");
    // That file and nothing else: the rest of the layout is as documented.
    const named = r.stderr.split("\n").filter((l) => l.startsWith(`  ${STATE}/`));
    expect(named).toEqual([`  ${STATE}/automaton.json is writable`]);
  });

  it("refuses to start without the public-access mount, and with it mounted read-write", () => {
    // A state folder no earlier run has put mount points in.
    const without = agentMountsWithout(dir, "public-access", "state-bare");
    const missing = docker(["run", "--rm", "--read-only", "--tmpfs", "/tmp", ...without, ...fakeApp, IMAGE, "run"]);
    expect(missing.status).toBe(64);
    expect(missing.stdout).not.toContain("STARTED");
    expect(missing.stderr).toMatch(/public-access is missing/);

    const rw = mounts.map((m) => (m.includes("public-access") ? m.replace(/:ro$/, "") : m));
    const writable = docker(["run", "--rm", "--read-only", "--tmpfs", "/tmp", ...rw, ...fakeApp, IMAGE, "run"]);
    expect(writable.status).toBe(64);
    expect(writable.stderr).toMatch(/public-access is writable/);
  });

  it("the agent's shell cannot write the read-only owner files", () => {
    for (const f of ["automaton.json", "wallet.json", "inference-providers.json", "mcp-servers.json"]) {
      const r = docker([
        "run", "--rm", "--read-only", ...mounts, "--entrypoint", "sh", IMAGE, "-c",
        `echo x >> ${STATE}/${f}`,
      ]);
      expect(r.status, f).not.toBe(0);
      expect(r.stderr, f).toMatch(/Read-only file system/i);
    }
    const r = docker(["run", "--rm", "--read-only", ...mounts, "--entrypoint", "sh", IMAGE, "-c", `touch ${STATE}/owner/owner.db-journal`]);
    expect(r.stderr).toMatch(/Read-only file system/i);
    // The public-access folder: no new file, no change to a credential file in it.
    for (const cmd of [`touch ${STATE}/public-access/x`, `echo x >> ${STATE}/public-access/tunnel.json`]) {
      const pa = docker(["run", "--rm", "--read-only", ...mounts, "--entrypoint", "sh", IMAGE, "-c", cmd]);
      expect(pa.status, cmd).not.toBe(0);
      expect(pa.stderr, cmd).toMatch(/Read-only file system/i);
    }
    expect(fs.readdirSync(path.join(dir, "config", "public-access"))).toEqual(["tunnel.json"]);
    const app = docker(["run", "--rm", "--read-only", ...mounts, "--entrypoint", "sh", IMAGE, "-c", "echo x >> /app/dist/index.js"]);
    expect(app.status).not.toBe(0);
  });

  it("the owner CLI works inside the image", () => {
    const owner = mounts.map((m) => (m.endsWith(`${STATE}/owner:ro`) ? m.replace(/:ro$/, "") : m));
    if (process.getuid?.() === 0) fs.chownSync(path.join(dir, "owner"), 10001, 10001);
    else fs.chmodSync(path.join(dir, "owner"), 0o777);
    const r = docker(["run", "--rm", "--read-only", "--tmpfs", "/tmp", ...owner, IMAGE, "cli", "budget", "show", "--init"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(fs.existsSync(path.join(dir, "owner", "owner.db"))).toBe(true);
  });

  it("the healthcheck reports unhealthy on a fresh state folder", () => {
    const r = docker(["run", "--rm", "--read-only", ...mounts, IMAGE, "healthcheck"]);
    expect(r.status).toBe(1);
  });
});
