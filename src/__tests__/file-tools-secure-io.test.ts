/**
 * Local read_file / write_file: the policy rule checks the path, but the
 * file can be swapped for a symlink before the I/O. The I/O itself must not
 * follow a link to a sensitive or protected file. write_file is confined
 * to the real HOME, the same directory ~ means everywhere else locally.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { createConwayClient } from "../conway/client.js";
import { createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase, PolicyRequest, ToolContext } from "../types.js";

const savedHome = process.env.HOME;
let home: string;
let db: AutomatonDatabase;
let ctx: ToolContext;

function tool(name: string) {
  return createBuiltinTools("").find((t) => t.name === name)!;
}

function request(name: string, args: Record<string, unknown>): PolicyRequest {
  return {
    tool: tool(name),
    args,
    context: ctx,
    turnContext: {
      inputSource: "agent",
      turnToolCallCount: 0,
      sessionSpend: {
        recordSpend: () => {},
        getHourlySpend: () => 0,
        getDailySpend: () => 0,
        getTotalSpend: () => 0,
        checkLimit: () => ({ allowed: true, currentHourlySpend: 0, currentDailySpend: 0, limitHourly: 1e9, limitDaily: 1e9 }),
        pruneOldRecords: () => 0,
      },
    },
  };
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-tools-home-")));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  fs.writeFileSync(path.join(home, ".automaton", "wallet.json"), '{"privateKey":"SECRET_WALLET_KEY"}');
  fs.writeFileSync(path.join(home, ".automaton", "automaton.json"), '{"conwayApiKey":"SECRET_CONFIG"}');
  db = createTestDb();
  ctx = {
    identity: { ...createTestIdentity(), sandboxId: "" },
    config: { ...createTestConfig(), sandboxId: "" },
    db,
    conway: createConwayClient({ apiUrl: "https://api.conway.invalid", apiKey: "k", sandboxId: "" }),
    inference: {} as ToolContext["inference"],
  } as ToolContext;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Run `swap` once, just before the first openSync whose path matches. */
function swapBeforeOpen(match: (p: string) => boolean, swap: () => void): void {
  const realOpen = fs.openSync.bind(fs);
  let done = false;
  vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (!done && match(String(p))) {
      done = true;
      swap();
    }
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
}

/** Replace the real directory dir with a symlink to target. */
function swapDirForLink(dir: string, target: string): void {
  fs.renameSync(dir, `${dir}.real`);
  fs.symlinkSync(target, dir);
}

describe("local read_file", () => {
  it("reads an ordinary file", async () => {
    fs.writeFileSync(path.join(home, "notes.txt"), "hello");
    expect(await tool("read_file").execute({ path: "~/notes.txt" }, ctx)).toBe("hello");
  });

  it("does not follow a symlink swapped in after the policy check", async () => {
    const notes = path.join(home, "notes.txt");
    fs.writeFileSync(notes, "hello");
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    expect(engine.evaluate(request("read_file", { path: notes })).action).toBe("allow");

    fs.unlinkSync(notes);
    fs.symlinkSync(path.join(home, ".automaton", "wallet.json"), notes);

    const out = await tool("read_file").execute({ path: notes }, ctx);
    expect(out).toMatch(/^Blocked:/);
    expect(out).not.toContain("SECRET_WALLET_KEY");
  });

  it("does not follow a parent directory swapped for a link after the check", async () => {
    fs.mkdirSync(path.join(home, ".aws"));
    fs.writeFileSync(path.join(home, ".aws", "credentials"), "AWS_SECRET_XYZZY");
    fs.mkdirSync(path.join(home, "x"));
    fs.writeFileSync(path.join(home, "x", "credentials"), "harmless");
    swapBeforeOpen(
      (p) => p.endsWith(`${path.sep}x${path.sep}credentials`),
      () => swapDirForLink(path.join(home, "x"), path.join(home, ".aws")),
    );

    const out = await tool("read_file").execute({ path: "~/x/credentials" }, ctx);
    expect(out).toMatch(/^Blocked:.*changed while it was being opened/);
    expect(out).not.toContain("AWS_SECRET_XYZZY");
  });

  it("reads back a relative path written by write_file, as exec sees it", async () => {
    expect(await tool("write_file").execute({ path: "notes.txt", content: "hello" }, ctx)).toBe(
      `File written: ${path.join(home, "notes.txt")}`,
    );
    expect(await tool("read_file").execute({ path: "notes.txt" }, ctx)).toBe("hello");
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    expect(engine.evaluate(request("read_file", { path: "notes.txt" })).action).toBe("allow");
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "PRIVATE");
    expect(engine.evaluate(request("read_file", { path: ".ssh/id_rsa" })).action).toBe("deny");
    expect(await tool("read_file").execute({ path: ".ssh/id_rsa" }, ctx)).toMatch(/^Blocked:/);
  });

  it("refuses files over 2 MB and reports a missing file", async () => {
    fs.writeFileSync(path.join(home, "big.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
    expect(await tool("read_file").execute({ path: path.join(home, "big.txt") }, ctx)).toMatch(/^Blocked:.*larger than/);
    expect(await tool("read_file").execute({ path: path.join(home, "nope.txt") }, ctx)).toMatch(/^ERROR: File not found/);
  });
});

describe("local write_file", () => {
  it("writes inside the real HOME", async () => {
    const out = await tool("write_file").execute({ path: "~/work/new.txt", content: "data" }, ctx);
    expect(out).toBe(`File written: ${path.join(home, "work", "new.txt")}`);
    expect(fs.readFileSync(path.join(home, "work", "new.txt"), "utf8")).toBe("data");
  });

  it("refuses a path outside HOME", async () => {
    const out = await tool("write_file").execute({ path: path.join(os.tmpdir(), "outside-home.txt"), content: "x" }, ctx);
    expect(out).toMatch(/^Blocked:.*outside the allowed directory/);
  });

  it("does not write through a symlink swapped in after the policy check", async () => {
    const target = path.join(home, "out.txt");
    fs.writeFileSync(target, "orig");
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    expect(engine.evaluate(request("write_file", { path: target, content: "PWNED" })).action).toBe("allow");

    fs.unlinkSync(target);
    const config = path.join(home, ".automaton", "automaton.json");
    fs.symlinkSync(config, target);

    const out = await tool("write_file").execute({ path: target, content: "PWNED" }, ctx);
    expect(out).toMatch(/^Blocked:/);
    expect(fs.readFileSync(config, "utf8")).toBe('{"conwayApiKey":"SECRET_CONFIG"}');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it("does not write into a directory swapped in for the parent after the check", async () => {
    const sshDir = path.join(home, ".ssh");
    fs.mkdirSync(sshDir);
    fs.writeFileSync(path.join(sshDir, "authorized_keys"), "ORIGINAL_KEYS\n");
    fs.mkdirSync(path.join(home, "x"));
    swapBeforeOpen(
      (p) => p.endsWith(`${path.sep}x${path.sep}authorized_keys`),
      () => swapDirForLink(path.join(home, "x"), sshDir),
    );

    const out = await tool("write_file").execute({ path: "~/x/authorized_keys", content: "ATTACKER_KEY\n" }, ctx);
    expect(out).toMatch(/^Blocked:.*changed while it was being written/);
    expect(fs.readFileSync(path.join(sshDir, "authorized_keys"), "utf8")).toBe("ORIGINAL_KEYS\n");
    expect(fs.readdirSync(sshDir)).toEqual(["authorized_keys"]);
  });

  it("keeps writing to the checked file when the parent is swapped after it was opened", async () => {
    // A rename-based write would look the parent up again here; the write
    // goes through the already opened file instead.
    const sshDir = path.join(home, ".ssh");
    fs.mkdirSync(sshDir);
    fs.writeFileSync(path.join(sshDir, "authorized_keys"), "ORIGINAL_KEYS\n");
    fs.mkdirSync(path.join(home, "x"));
    fs.writeFileSync(path.join(home, "x", "authorized_keys"), "old\n");
    const realTruncate = fs.ftruncateSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "ftruncateSync").mockImplementation(((fd: number, len?: number) => {
      if (!swapped) {
        swapped = true;
        swapDirForLink(path.join(home, "x"), sshDir);
      }
      return realTruncate(fd, len);
    }) as typeof fs.ftruncateSync);

    const out = await tool("write_file").execute({ path: "~/x/authorized_keys", content: "LEGIT\n" }, ctx);
    expect(swapped).toBe(true);
    expect(out).toBe(`File written: ${path.join(home, "x", "authorized_keys")}`);
    expect(fs.readFileSync(path.join(home, "x.real", "authorized_keys"), "utf8")).toBe("LEGIT\n");
    expect(fs.readFileSync(path.join(sshDir, "authorized_keys"), "utf8")).toBe("ORIGINAL_KEYS\n");
    expect(fs.readdirSync(sshDir)).toEqual(["authorized_keys"]);
  });
});
