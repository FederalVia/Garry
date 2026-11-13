/**
 * Children clone this fork by default, and the install docs and installer
 * point at it too.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { childCloneCommand, DEFAULT_CHILD_RUNTIME_REPO } from "../replication/spawn.js";

const FORK = "https://github.com/FederalVia/Garry.git";
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("child runtime default", () => {
  it("is the fork, on its default branch", () => {
    expect(DEFAULT_CHILD_RUNTIME_REPO).toBe(FORK);
    const cmd = childCloneCommand();
    expect(cmd.startsWith(`git clone ${FORK} /root/automaton && cd /root/automaton && `)).toBe(true);
    expect(cmd).not.toContain("--branch");
  });

  it("an operator's repo and ref still win", () => {
    expect(childCloneCommand("https://example.com/own.git", "v1")).toMatch(
      /^git clone --branch v1 https:\/\/example\.com\/own\.git \/root\/automaton/,
    );
  });
});

describe("install docs and installer", () => {
  it.each(["README.md", "DOCUMENTATION.md", "scripts/automaton.sh"])("%s points at the fork", (rel) => {
    const text = read(rel);
    expect(text).toContain(FORK);
    expect(text).not.toContain("Conway-Research/automaton.git");
    expect(text).not.toContain("conway.tech/automaton.sh");
  });

  it("the installer clones the fork", () => {
    expect(read("scripts/automaton.sh")).toMatch(/^REPO="https:\/\/github\.com\/FederalVia\/Garry\.git"$/m);
  });

  it("the README quick start clones the fork and enters its directory", () => {
    const readme = read("README.md");
    expect(readme).toContain(`git clone ${FORK}\ncd Garry\n`);
    expect(readme).toContain("https://raw.githubusercontent.com/FederalVia/Garry/main/scripts/automaton.sh");
  });

  it("the README explains running without Conway", () => {
    const readme = read("README.md");
    expect(readme).toContain("### Run without Conway");
    expect(readme).toContain('"dailyCapCeilingCents": 200');
  });
});
