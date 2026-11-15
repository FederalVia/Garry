/**
 * security: the container and dedicated-user layouts keep the owner's files
 * out of the agent's reach. Static checks of the Dockerfile, the compose
 * file, .dockerignore and the systemd unit; they run everywhere.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** The files the agent must read but never change, and the owner folder. */
const OWNER_FILES = [
  "automaton.json",
  "wallet.json",
  "config.json",
  "heartbeat.yml",
  "constitution.md",
  "inference-providers.json",
];
const AGENT_STATE = "/home/automaton/.automaton";

/** Dockerfile instructions with line continuations joined and comments dropped. */
function dockerInstructions(text: string): Array<{ op: string; args: string }> {
  const out: Array<{ op: string; args: string }> = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line) && buf === "") continue;
    if (/\\\s*$/.test(line)) {
      buf += line.replace(/\\\s*$/, " ");
      continue;
    }
    buf += line;
    const m = /^\s*([A-Za-z]+)\s+(.*)$/.exec(buf.trim());
    if (m) out.push({ op: m[1]!.toUpperCase(), args: m[2]!.trim() });
    buf = "";
  }
  return out;
}

describe("security: Dockerfile", () => {
  const ins = dockerInstructions(read("Dockerfile"));
  const args = new Map<string, string>();
  for (const i of ins.filter((i) => i.op === "ARG")) {
    const [k, ...v] = i.args.split("=");
    if (v.length) args.set(k!, v.join("="));
  }
  const resolve = (s: string) => s.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => args.get(a ?? b) ?? "");

  it("pins every base image by digest", () => {
    const froms = ins.filter((i) => i.op === "FROM");
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const f of froms) {
      const image = resolve(f.args.split(/\s+/)[0]!);
      expect(image, f.args).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it("runs as a non-root user, set before CMD and ENTRYPOINT in the final stage", () => {
    const lastFrom = ins.map((i) => i.op).lastIndexOf("FROM");
    const final = ins.slice(lastFrom);
    const userIdx = final.map((i) => i.op).lastIndexOf("USER");
    expect(userIdx).toBeGreaterThan(0);
    const user = final[userIdx]!.args.split(":")[0]!;
    expect(user).not.toMatch(/^(0|root)$/);
    expect(final.map((i) => i.op).indexOf("CMD")).toBeGreaterThan(userIdx);
    expect(final.map((i) => i.op).indexOf("ENTRYPOINT")).toBeGreaterThan(userIdx);
  });

  it("has a healthcheck that runs the healthcheck script", () => {
    const hc = ins.find((i) => i.op === "HEALTHCHECK");
    expect(hc?.args).toMatch(/dist\/healthcheck\.js/);
  });

  it("copies everything into /app root-owned, so the agent user cannot change the code", () => {
    const lastFrom = ins.map((i) => i.op).lastIndexOf("FROM");
    const copies = ins.slice(lastFrom).filter((i) => i.op === "COPY");
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) expect(c.args, c.args).toMatch(/--chown=root:root/);
    const entry = copies.find((c) => /entrypoint\.sh/.test(c.args));
    expect(entry?.args).toMatch(/--chmod=0?555/);
  });
});

describe("security: docker-compose agent service", () => {
  const compose = YAML.parse(read("deploy/docker-compose.yml"));
  const agent = compose.services.agent;
  const volumes: string[] = agent.volumes;

  it("has a read-only root, no capabilities and no privilege gain", () => {
    expect(agent.read_only).toBe(true);
    expect(agent.cap_drop).toEqual(["ALL"]);
    expect(agent.security_opt).toContain("no-new-privileges:true");
    expect(agent.privileged).toBeUndefined();
    expect(agent.user).toBeUndefined(); // the image's non-root user
  });

  it("mounts every owner file and the owner folder read-only over the read-write state folder", () => {
    expect(volumes).toContain(`./data/state:${AGENT_STATE}`);
    for (const f of OWNER_FILES) {
      expect(volumes, f).toContain(`./data/config/${f}:${AGENT_STATE}/${f}:ro`);
    }
    expect(volumes).toContain(`./data/owner:${AGENT_STATE}/owner:ro`);
    // Nothing else is mounted read-write except the state folder.
    const rw = volumes.filter((v) => !v.endsWith(":ro"));
    expect(rw).toEqual([`./data/state:${AGENT_STATE}`]);
  });

  it("never mounts the Docker socket and publishes no ports", () => {
    for (const [name, svc] of Object.entries<any>(compose.services)) {
      for (const v of svc.volumes ?? []) expect(String(v), name).not.toMatch(/docker\.sock/);
      expect(svc.ports, name).toBeUndefined();
      expect(svc.network_mode, name).not.toBe("host");
      expect(svc.privileged, name).toBeUndefined();
    }
  });

  it("setup and configure never mount data/state where the agent binds its owner files", () => {
    for (const name of ["setup", "configure"]) {
      const svc = compose.services[name];
      const vols: string[] = svc.volumes;
      // A private ~/.automaton; data/state only elsewhere.
      expect(svc.tmpfs.some((t: string) => t.startsWith(`${AGENT_STATE}:`)), name).toBe(true);
      for (const v of vols.filter((v) => v.startsWith("./data/state"))) {
        expect(v.split(":")[1], `${name}: ${v}`).toBe("/state");
      }
      expect(vols, name).toContain("./data/config:/config");
    }
  });

  it("keeps the owner's write services behind a profile the agent cannot start", () => {
    for (const name of ["setup", "configure", "cli"]) {
      expect(compose.services[name]?.profiles, name).toEqual(["owner"]);
    }
  });
});

describe("security: entrypoint", () => {
  const sh = read("deploy/entrypoint.sh");

  it("refuses root and checks every owner file, the owner folder and its contents", () => {
    expect(sh).toMatch(/id -u.*= "0"/);
    expect(sh).toMatch(/AUTOMATON_ALLOW_ROOT/);
    for (const f of OWNER_FILES) expect(sh).toContain(f);
    expect(sh).toMatch(/\$STATE\/owner/);
    // Writable is not enough: a missing or replaceable file is refused too.
    expect(sh).toMatch(/is missing/);
    expect(sh).toMatch(/could be renamed or replaced/);
  });
});

describe("security: .dockerignore", () => {
  const lines = read(".dockerignore").split("\n").map((l) => l.trim());
  it("keeps secrets and local state out of the build context", () => {
    for (const name of ["wallet.json", "automaton.json", "config.json", "inference-providers.json", ".env", ".env.*", "**/*.db", ".git", "node_modules"]) {
      expect(lines, name).toContain(name);
    }
  });
});

describe("security: systemd unit (dedicated user)", () => {
  const unit = read("deploy/automaton.service");
  const values = (key: string) =>
    unit.split("\n").filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1).trim());

  it("runs as the automaton user with the same read-only layout as the container", () => {
    expect(values("User")).toEqual(["automaton"]);
    expect(values("NoNewPrivileges")).toEqual(["yes"]);
    expect(values("ProtectSystem")).toEqual(["strict"]);
    expect(values("ReadWritePaths")).toEqual(["/var/lib/automaton/.automaton"]);
    const ro = values("ReadOnlyPaths");
    for (const f of OWNER_FILES) expect(ro, f).toContain(`/var/lib/automaton/.automaton/${f}`);
    expect(ro).toContain("/var/lib/automaton/.automaton/owner");
    // A "-" prefix would silently skip a missing path, which the agent could then create.
    for (const p of ro) expect(p.startsWith("-"), p).toBe(false);
  });

  it("the lock script creates every read-only path the unit lists", () => {
    const lock = read("scripts/lock-owner-files.sh");
    for (const f of OWNER_FILES) expect(lock, f).toContain(f);
    expect(lock).toMatch(/1770/);
  });
});
