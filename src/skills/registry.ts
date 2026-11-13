/**
 * Skills Registry
 *
 * Install skills from remote sources:
 * - Git repos: git clone <url> ~/.automaton/skills/<name>
 * - URLs: fetch a SKILL.md from any URL
 * - Self-created: the automaton writes its own SKILL.md files
 *
 * All shell commands use execFileSync with argument arrays to prevent injection.
 * Directory operations use fs.* to avoid shell interpolation entirely.
 */

import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import * as yaml from "yaml";
import type {
  Skill,
  AutomatonDatabase,
  ConwayClient,
} from "../types.js";
import { parseSkillMd } from "./format.js";
import {
  MAX_SKILL_FILE_BYTES,
  prepareSkillForStorage,
  resolveSkillsRoot,
} from "./loader.js";
import { readRegularFileNoFollow, writeFileSafe } from "../security/secure-fs.js";
import { commitSkillChange } from "../git/state-versioning.js";

const execFileAsync = promisify(execFile);

// Validation patterns to prevent injection via path/URL arguments
const SKILL_NAME_RE = /^[a-zA-Z0-9-]+$/;
const SAFE_URL_RE = /^https?:\/\/[^\s;|&$`(){}<>]+$/;

// Size limits for skill content
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 10_000;

const INSTALL_TMP_PREFIX = ".install-";
const GIT_CLONE_TIMEOUT_MS = 60_000;
const URL_FETCH_TIMEOUT_S = 30;

/**
 * Validate that a skill path does not escape the skills directory.
 * Prevents path traversal attacks via crafted skill names.
 */
function validateSkillPath(skillsDir: string, name: string): string {
  const resolved = path.resolve(skillsDir, name);
  if (!resolved.startsWith(path.resolve(skillsDir) + path.sep)) {
    throw new Error(`Skill path traversal detected: ${name}`);
  }
  return resolved;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * An existing skill directory may be updated in place only if it is a real
 * directory at its own path (no link anywhere in it).
 */
function assertRealSkillDir(target: string): boolean {
  const st = lstatOrNull(target);
  if (!st) return false;
  if (st.isSymbolicLink() || !st.isDirectory() || fs.realpathSync(target) !== target) {
    throw new Error(`Skill directory is not a plain directory: ${target}`);
  }
  return true;
}

/**
 * SKILL.md is always replaced, never written through: a symlink or a
 * hard link left at that name is unlinked first (unlink never follows).
 */
function unlinkUnsafeSkillMd(skillMdPath: string): void {
  const st = lstatOrNull(skillMdPath);
  if (st && !st.isDirectory() && (st.isSymbolicLink() || st.nlink > 1)) {
    fs.unlinkSync(skillMdPath);
  }
}

/**
 * Install a skill from a git repository.
 * Clones into a temporary directory under the skills root with symlinks
 * checked out as plain files, verifies SKILL.md is a regular blob, then
 * renames the clone into ~/.automaton/skills/<name>/.
 */
export async function installSkillFromGit(
  repoUrl: string,
  name: string,
  skillsDir: string,
  db: AutomatonDatabase,
  _conway: ConwayClient,
): Promise<Skill> {
  // Validate inputs to prevent injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }
  if (!SAFE_URL_RE.test(repoUrl)) {
    throw new Error(`Invalid repo URL: "${repoUrl}". Must be an http(s) URL with no shell metacharacters.`);
  }

  const realRoot = resolveSkillsRoot(skillsDir, { create: true });
  const targetDir = validateSkillPath(realRoot, name);
  if (lstatOrNull(targetDir)) {
    throw new Error(`Skill "${name}" is already installed; remove it first`);
  }

  const tmpDir = path.join(realRoot, `${INSTALL_TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}`);
  try {
    try {
      // Top-level -c applies during checkout; --config persists it so a
      // later pull in this directory also checks links out as plain files.
      await execFileAsync(
        "git",
        [
          "-c", "core.symlinks=false",
          "-c", "core.hooksPath=/dev/null",
          "clone", "--depth", "1", "--no-recurse-submodules",
          "--config", "core.symlinks=false",
          "--", repoUrl, tmpDir,
        ],
        { encoding: "utf-8", timeout: GIT_CLONE_TIMEOUT_MS },
      );
    } catch (err: any) {
      throw new Error(`Failed to clone skill repo: ${err.message}`);
    }

    // The index records what the repo says SKILL.md is; a link (120000) or
    // submodule (160000) is rejected even though checkout made it a file.
    const { stdout: lsOut } = await execFileAsync(
      "git",
      ["-C", tmpDir, "ls-files", "-s", "--", "SKILL.md"],
      { encoding: "utf-8", timeout: 10_000 },
    );
    const mode = lsOut.trim().split(/\s+/)[0] ?? "";
    if (!mode) {
      throw new Error("No SKILL.md found in cloned repo");
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new Error("SKILL.md must be a regular file");
    }

    const content = readRegularFileNoFollow(path.join(tmpDir, "SKILL.md"), {
      root: tmpDir,
      maxBytes: MAX_SKILL_FILE_BYTES,
    });
    if (content === null) {
      throw new Error("SKILL.md must be a regular file of at most 64 KiB inside the repo");
    }

    const skillMdPath = path.join(targetDir, "SKILL.md");
    const parsed = parseSkillMd(content, skillMdPath, "git", { name });
    if (!parsed) {
      throw new Error("Failed to parse SKILL.md from cloned repo");
    }

    fs.renameSync(tmpDir, targetDir);
    const skill = prepareSkillForStorage(parsed);
    db.upsertSkill(skill);
    await versionSkillChange(realRoot, name, "install");
    return skill;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Install a skill from a URL (fetches a single SKILL.md).
 * The body is downloaded to memory and written with temp file + rename, so
 * nothing already at the destination is followed.
 */
export async function installSkillFromUrl(
  url: string,
  name: string,
  skillsDir: string,
  db: AutomatonDatabase,
  _conway: ConwayClient,
): Promise<Skill> {
  // Validate inputs to prevent injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }
  if (!SAFE_URL_RE.test(url)) {
    throw new Error(`Invalid URL: "${url}". Must be an http(s) URL with no shell metacharacters.`);
  }

  const realRoot = resolveSkillsRoot(skillsDir, { create: true });
  const targetDir = validateSkillPath(realRoot, name);
  if (assertRealSkillDir(targetDir) && lstatOrNull(path.join(targetDir, ".git"))) {
    throw new Error(`Skill "${name}" was installed from git; remove it before installing from a URL`);
  }

  let body: Buffer;
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-fsSL",
        "--proto", "=https,http",
        "--proto-redir", "=https,http",
        "--max-filesize", String(MAX_SKILL_FILE_BYTES),
        "--max-time", String(URL_FETCH_TIMEOUT_S),
        "--", url,
      ],
      { encoding: "buffer", maxBuffer: MAX_SKILL_FILE_BYTES + 1, timeout: (URL_FETCH_TIMEOUT_S + 5) * 1000 },
    );
    body = stdout;
  } catch (err: any) {
    throw new Error(`Failed to fetch SKILL.md from URL: ${err.message}`);
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("Fetched SKILL.md is not valid UTF-8");
  }

  const skillMdPath = path.join(targetDir, "SKILL.md");
  const parsed = parseSkillMd(content, skillMdPath, "url", { name });
  if (!parsed) {
    throw new Error("Failed to parse fetched SKILL.md");
  }

  if (!lstatOrNull(targetDir)) {
    fs.mkdirSync(targetDir, { mode: 0o700 });
  }
  assertRealSkillDir(targetDir);
  unlinkUnsafeSkillMd(skillMdPath);
  writeFileSafe(skillMdPath, content, { root: targetDir, trustedWriter: true, mode: 0o600 });

  const skill = prepareSkillForStorage(parsed);
  db.upsertSkill(skill);
  await versionSkillChange(realRoot, name, "install");
  return skill;
}

/**
 * Create a new skill authored by the automaton itself.
 * Uses fs.* for directory creation and file writing (no shell needed).
 */
export async function createSkill(
  name: string,
  description: string,
  instructions: string,
  skillsDir: string,
  db: AutomatonDatabase,
  _conway: ConwayClient,
): Promise<Skill> {
  // Validate name to prevent path traversal/injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }

  // Enforce size limits
  const safeDescription = description.slice(0, MAX_DESCRIPTION_LENGTH);
  const safeInstructions = instructions.slice(0, MAX_INSTRUCTIONS_LENGTH);

  const realRoot = resolveSkillsRoot(skillsDir, { create: true });
  const targetDir = validateSkillPath(realRoot, name);

  if (!lstatOrNull(targetDir)) {
    fs.mkdirSync(targetDir, { mode: 0o700 });
  }
  assertRealSkillDir(targetDir);

  // Generate YAML frontmatter safely using yaml.stringify (prevents YAML injection)
  const frontmatter = yaml.stringify({
    name,
    description: safeDescription,
    "auto-activate": true,
  });
  const content = `---\n${frontmatter}---\n\n${safeInstructions}`;

  const skillMdPath = path.join(targetDir, "SKILL.md");
  unlinkUnsafeSkillMd(skillMdPath);
  writeFileSafe(skillMdPath, content, { root: targetDir, trustedWriter: true, mode: 0o600 });

  const skill: Skill = prepareSkillForStorage({
    name,
    description: safeDescription,
    autoActivate: true,
    instructions: safeInstructions,
    source: "self",
    path: skillMdPath,
    enabled: true,
    installedAt: new Date().toISOString(),
  });

  db.upsertSkill(skill);
  await versionSkillChange(realRoot, name, "create");
  return skill;
}

/**
 * Remove a skill (disable in DB and optionally delete from disk).
 * Every row backed by the skill's directory is disabled, whatever name it
 * was stored under, so rows created from untrusted frontmatter go too.
 */
export async function removeSkill(
  name: string,
  db: AutomatonDatabase,
  _conway: ConwayClient,
  skillsDir: string,
  deleteFiles: boolean = false,
): Promise<void> {
  // Validate name to prevent path traversal/injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }

  db.removeSkill(name);

  const lexicalRoot = path.resolve(resolveHome(skillsDir));
  let root = lexicalRoot;
  try {
    root = resolveSkillsRoot(skillsDir);
  } catch {
    // Missing or unusable root: match rows by the configured path only.
  }
  const targetDir = validateSkillPath(root, name);
  const backingDirs = new Set([targetDir, path.join(lexicalRoot, name)]);
  for (const row of db.getSkills(true)) {
    if (!row.path) continue;
    const rowDir = path.dirname(path.resolve(resolveHome(row.path)));
    if (backingDirs.has(rowDir)) {
      db.removeSkill(row.name);
    }
  }

  if (deleteFiles) {
    const st = lstatOrNull(targetDir);
    if (st?.isSymbolicLink()) {
      throw new Error(`Refusing to delete skill "${name}": its directory is a symlink`);
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  await versionSkillChange(root, name, "remove");
}

/** Commit to the state repo, only when this skills root is the state repo's own. */
async function versionSkillChange(
  skillsRoot: string,
  name: string,
  action: "install" | "create" | "remove",
): Promise<void> {
  const stateSkills = path.join(process.env.HOME || "/root", ".automaton", "skills");
  let real = stateSkills;
  try {
    real = fs.realpathSync(stateSkills);
  } catch {
    return;
  }
  if (path.resolve(skillsRoot) !== real && path.resolve(skillsRoot) !== path.resolve(stateSkills)) return;
  await commitSkillChange(name, action);
}

/**
 * List all installed skills.
 */
export function listSkills(db: AutomatonDatabase): Skill[] {
  return db.getSkills();
}

function resolveHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}
