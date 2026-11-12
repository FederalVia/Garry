/**
 * Give each test run its own temporary directory and delete it afterwards.
 *
 * Many tests create directories with fs.mkdtempSync(os.tmpdir()) and never
 * remove them, so every full run used to leave hundreds of databases behind
 * in /tmp. Pointing TMPDIR at a per-run directory before the workers start
 * collects all of them in one place.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-vitest-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
}
