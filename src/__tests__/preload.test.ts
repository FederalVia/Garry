/**
 * Every module the runtime imports lazily is loaded at startup, so a
 * rebuild can never mix new modules into a running process.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LAZY_MODULES, preloadLazyModules } from "../runtime/preload.js";

const SRC = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(SRC, "runtime");

function sourcesToScan(): string[] {
  const files = [path.join(SRC, "agent/tools.ts"), path.join(SRC, "agent/loop.ts")];
  for (const dir of ["heartbeat", "self-mod"]) {
    for (const f of fs.readdirSync(path.join(SRC, dir))) {
      if (f.endsWith(".ts")) files.push(path.join(SRC, dir, f));
    }
  }
  return files;
}

/** A specifier as an absolute path (relative ones) or a bare package name. */
function normalize(fromDir: string, specifier: string): string {
  return specifier.startsWith(".") ? path.resolve(fromDir, specifier) : specifier;
}

describe("preloadLazyModules", () => {
  it("lists every await import() target in tools, loop, heartbeat and self-mod", () => {
    const listed = new Set(LAZY_MODULES.map((m) => normalize(RUNTIME_DIR, m)));
    const missing: string[] = [];
    let found = 0;
    for (const file of sourcesToScan()) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/await\s+import\(\s*["']([^"']+)["']\s*\)/g)) {
        found++;
        const target = normalize(path.dirname(file), match[1]);
        if (!listed.has(target)) missing.push(`${path.relative(SRC, file)}: ${match[1]}`);
      }
    }
    expect(found).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it("every listed module exists and loads", { timeout: 60_000 }, async () => {
    for (const m of LAZY_MODULES) {
      if (!m.startsWith(".")) continue;
      const ts = normalize(RUNTIME_DIR, m).replace(/\.js$/, ".ts");
      expect(fs.existsSync(ts), m).toBe(true);
    }
    const result = await preloadLazyModules();
    expect(result.failed).toEqual([]);
    expect(result.loaded).toBe(LAZY_MODULES.length);
  });
});
