/**
 * Install commands used to set up child sandboxes and to rebuild after an
 * upstream pull. They must install from the pnpm lockfile: npm resolves a
 * different tree, ignores pnpm.overrides, and fails on npm 10.9.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  INSTALL_AND_BUILD,
  INSTALL_AND_BUILD_NO_SCRIPTS,
  PNPM_VERSION,
} from "../self-mod/install.js";

const repoRoot = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("install commands", () => {
  it("pin the pnpm version from package.json packageManager", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.packageManager).toBe(`pnpm@${PNPM_VERSION}`);
  });

  it("install from the lockfile and then build", () => {
    expect(INSTALL_AND_BUILD).toContain("pnpm install --frozen-lockfile");
    expect(INSTALL_AND_BUILD).toMatch(/pnpm install --frozen-lockfile && pnpm run build$/);
    expect(INSTALL_AND_BUILD_NO_SCRIPTS).toContain("pnpm install --frozen-lockfile --ignore-scripts");
  });

  it("install pnpm only when it is missing", () => {
    expect(INSTALL_AND_BUILD).toContain(
      `command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@${PNPM_VERSION}`,
    );
  });

  it("no runtime code installs project dependencies with npm", () => {
    // npm install -g <tool> is fine; a project-level npm install is not.
    const offenders = sourceFiles(path.join(repoRoot, "src")).flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${path.relative(repoRoot, file)}:${i + 1}` }))
        // A standalone "npm" (not the end of "pnpm") used as a command: followed
        // by the end of the string, a separator, or a flag other than -g.
        // Messages such as "npm install failed" do not match.
        .filter(({ line }) =>
          /(?<![\w-])npm (install|ci)(?=\s*(&&|;|\||["'`]|$)|\s+--?(?!g\b)[a-z])/.test(line) &&
          !line.trim().startsWith("*"),
        ),
    );
    expect(offenders.map((o) => o.at)).toEqual([]);
  });
});
