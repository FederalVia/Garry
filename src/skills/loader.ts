/**
 * Skills Loader
 *
 * Discovers and loads SKILL.md files from ~/.automaton/skills/
 * Each skill is a directory containing a SKILL.md file with
 * YAML frontmatter + Markdown instructions.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Skill, SkillSource, AutomatonDatabase } from "../types.js";
import { parseSkillMd } from "./format.js";
import { sanitizeInput } from "../agent/injection-defense.js";
import { createLogger } from "../observability/logger.js";
import { readRegularFileNoFollow } from "../security/secure-fs.js";
import { stateDir } from "../security/protected-paths.js";
import { redactKeyMaterial, redactSecrets } from "../security/secret-redaction.js";

const logger = createLogger("skills.loader");

export const SKILL_NAME_RE = /^[a-zA-Z0-9-]+$/;

// Maximum total size of all skill instructions combined
const MAX_TOTAL_SKILL_INSTRUCTIONS = 10_000;
// One skill may not crowd out the others (built-in survival skills included).
const MAX_PER_SKILL_SECTION = 4_000;
const MAX_RENDERED_DESCRIPTION = 300;
export const MAX_SKILL_FILE_BYTES = 64 * 1024;
const INSTALL_TMP_PREFIX = ".install-";

// Patterns that indicate malicious instruction content
const SUSPICIOUS_INSTRUCTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Tool call JSON syntax
  { pattern: /\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/, label: "tool_call_json" },
  { pattern: /<tool_call>/i, label: "tool_call_xml" },
  // System prompt override attempts
  { pattern: /\bYou are now\b/i, label: "identity_override" },
  { pattern: /\bIgnore previous\b/i, label: "ignore_instructions" },
  { pattern: /\bSystem:\s/i, label: "system_role_injection" },
  // Forged skill block markers
  { pattern: /\[\s*(?:END\s+)?SKILL\s*:/i, label: "skill_marker" },
  { pattern: /\bEND\s+SKILLS\b/i, label: "skill_marker" },
  // Sensitive file references
  { pattern: /wallet\.json/i, label: "sensitive_file_wallet" },
  { pattern: /\.env\b/, label: "sensitive_file_env" },
  { pattern: /private.?key/i, label: "sensitive_file_key" },
];

/**
 * Resolve and vet the skills root. It must be a real directory (not a
 * symlink) inside the state directory; otherwise a link could make the loader
 * read, or the installer write, somewhere else.
 */
export function resolveSkillsRoot(skillsDir: string, opts: { create?: boolean } = {}): string {
  const dir = path.resolve(resolveHome(skillsDir));
  if (opts.create) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Skills directory must be a real directory, not a link: ${dir}`);
  }
  const realRoot = fs.realpathSync(dir);
  let realState: string;
  try {
    realState = fs.realpathSync(stateDir());
  } catch {
    throw new Error(`State directory is missing; refusing to use skills directory ${dir}`);
  }
  if (!realRoot.startsWith(realState + path.sep)) {
    throw new Error(`Skills directory must be inside ${realState}: ${dir}`);
  }
  return realRoot;
}

/**
 * Clean the description before it is stored: one line, capped, with the
 * same injection and key-material filtering as skill bodies. Callers that
 * print the stored description (list_skills) then never see raw text.
 */
export function sanitizeSkillDescription(description: string, skillName: string): string {
  if (typeof description !== "string" || !description.trim()) return "";
  let text = description.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  text = redactKeyMaterial(redactSecrets(text));
  text = validateInstructionContent(text, skillName);
  text = sanitizeInput(text, `skill:${skillName}`, "skill_instruction").content;
  return text.replace(/[\r\n]+/g, " ").slice(0, MAX_RENDERED_DESCRIPTION);
}

/** Normalise a parsed skill before it is written to the database. */
export function prepareSkillForStorage(skill: Skill): Skill {
  return { ...skill, description: sanitizeSkillDescription(skill.description, skill.name) };
}

function removeStaleInstallDirs(realRoot: string, entries: fs.Dirent[]): void {
  for (const entry of entries) {
    if (!entry.name.startsWith(INSTALL_TMP_PREFIX)) continue;
    try {
      // rmSync on a symlink removes only the link, never its target.
      fs.rmSync(path.join(realRoot, entry.name), { recursive: true, force: true });
    } catch (err) {
      logger.warn(`Could not remove stale install dir ${entry.name}`, { error: String(err) });
    }
  }
}

function inferSource(skillDir: string): SkillSource {
  try {
    fs.lstatSync(path.join(skillDir, ".git"));
    return "git";
  } catch {
    return "builtin";
  }
}

/**
 * Scan the skills directory and load all valid SKILL.md files.
 * Returns loaded skills and syncs them to the database.
 *
 * Only real directories with a valid name and a regular, single-link
 * SKILL.md inside them are loaded. Enabled rows not backed by such a
 * directory are disabled, so injected or orphaned rows do not stay in the
 * prompt. Only skills loaded from disk are returned.
 */
export function loadSkills(
  skillsDir: string,
  db: AutomatonDatabase,
): Skill[] {
  const lexicalDir = path.resolve(resolveHome(skillsDir));
  try {
    fs.lstatSync(lexicalDir);
  } catch {
    // Missing directory: nothing on disk to load, and no reason to touch rows.
    return [];
  }
  let realRoot: string;
  try {
    realRoot = resolveSkillsRoot(skillsDir);
  } catch (err) {
    // Leave the DB alone: a moved root must not disable legitimate rows.
    logger.error(`Refusing to load skills: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const loaded: Skill[] = [];
  // Rows backed by a valid directory this pass; everything else is disabled.
  const backed = new Set<string>();

  const entries = fs.readdirSync(realRoot, { withFileTypes: true });
  removeStaleInstallDirs(realRoot, entries);

  for (const entry of entries) {
    // A symlinked directory reports isSymbolicLink(), not isDirectory().
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || !SKILL_NAME_RE.test(entry.name)) continue;

    const skillDir = path.join(realRoot, entry.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const content = readRegularFileNoFollow(skillMdPath, {
      root: skillDir,
      maxBytes: MAX_SKILL_FILE_BYTES,
    });
    if (content === null) {
      if (fs.existsSync(skillMdPath) || isSymlink(skillMdPath)) {
        logger.warn(`Skipping skill "${entry.name}": SKILL.md is not a regular file inside its directory`);
      }
      continue;
    }

    try {
      const existing = db.getSkillByName(entry.name);
      const source = existing?.source ?? inferSource(skillDir);
      const parsed = parseSkillMd(content, skillMdPath, source, { name: entry.name });
      if (!parsed) continue;

      // Check requirements (an unmet requirement skips the skill for now
      // without disabling its row)
      if (!checkRequirements(parsed)) {
        backed.add(entry.name);
        continue;
      }

      const skill = prepareSkillForStorage(parsed);
      // Check if already in DB and preserve enabled state
      if (existing) {
        skill.enabled = existing.enabled;
        skill.installedAt = existing.installedAt;
      }

      db.upsertSkill(skill);
      backed.add(skill.name);
      loaded.push(skill);
    } catch {
      // Skip invalid skill files
    }
  }

  for (const row of db.getSkills(true)) {
    if (!backed.has(row.name)) {
      logger.warn(`Disabling skill row "${row.name.slice(0, 80)}": no valid skill directory backs it`);
      db.removeSkill(row.name);
    }
  }

  // Only skills loaded from disk this pass; DB-only rows never reach the prompt.
  return loaded.filter((s) => s.enabled);
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Validate binary name to prevent injection via skill requirements.
 */
const BIN_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Check if a skill's requirements are met.
 * Uses execFileSync with argument arrays to prevent shell injection.
 */
function checkRequirements(skill: Skill): boolean {
  if (!skill.requires) return true;

  // Check required binaries
  if (skill.requires.bins) {
    for (const bin of skill.requires.bins) {
      // Validate binary name to prevent injection
      if (!BIN_NAME_RE.test(bin)) {
        return false;
      }
      try {
        execFileSync("which", [bin], { stdio: "ignore" });
      } catch {
        return false;
      }
    }
  }

  // Check required environment variables
  if (skill.requires.env) {
    for (const envVar of skill.requires.env) {
      if (!process.env[envVar]) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Validate and sanitize skill instruction content.
 * Strips or flags suspicious patterns that could be injection attempts.
 */
function validateInstructionContent(instructions: string, skillName: string): string {
  let sanitized = instructions;
  const warnings: string[] = [];

  for (const { pattern, label } of SUSPICIOUS_INSTRUCTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      warnings.push(label);
      // Strip ALL occurrences of the matched pattern, not just the first.
      // Without the 'g' flag, .replace() only strips the first match,
      // allowing subsequent duplicates to pass through.
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      sanitized = sanitized.replace(globalPattern, `[REMOVED:${label}]`);
    }
  }

  if (warnings.length > 0) {
    logger.warn(`Skill "${skillName}" instruction content modified: ${warnings.join(", ")}`);
  }

  return sanitized;
}

/**
 * Get the active skill instructions to inject into the system prompt.
 * Only returns instructions from auto-activate skills that are enabled.
 * Instructions are sanitized and wrapped with trust boundary markers.
 */
export function getActiveSkillInstructions(skills: Skill[]): string {
  const active = skills
    .filter((s) => s.enabled && s.autoActivate && SKILL_NAME_RE.test(s.name))
    .sort((a, b) => {
      const ab = a.source === "builtin" ? 0 : 1;
      const bb = b.source === "builtin" ? 0 : 1;
      return ab - bb || a.name.localeCompare(b.name);
    });
  if (active.length === 0) return "";

  let totalLength = 0;
  let truncated = false;
  const sections: string[] = [];

  for (const s of active) {
    // Key material and known secrets never reach the prompt, whatever the file held.
    const redacted = redactKeyMaterial(redactSecrets(s.instructions || ""));

    // Validate instruction content for suspicious patterns
    const validated = validateInstructionContent(redacted, s.name);

    // Sanitize through injection defense (strips tool call syntax, ChatML, etc.)
    const sanitized = sanitizeInput(validated, `skill:${s.name}`, "skill_instruction");

    const description = sanitizeSkillDescription(s.description, s.name);
    const header = `[SKILL: ${s.name} — UNTRUSTED CONTENT]\n${description ? `${description}\n\n` : ""}`;
    const footer = `\n[END SKILL: ${s.name}]`;

    // Per-skill budget so one large skill cannot suppress the rest.
    const budget = Math.min(MAX_PER_SKILL_SECTION, MAX_TOTAL_SKILL_INSTRUCTIONS - totalLength);
    const room = budget - header.length - footer.length;
    if (room < 100) {
      truncated = true;
      continue;
    }
    let body = sanitized.content;
    if (body.length > room) {
      const marker = "\n[SKILL TRUNCATED]";
      body = body.slice(0, room - marker.length) + marker;
      truncated = true;
    }

    const section = header + body + footer;
    totalLength += section.length;
    sections.push(section);
  }

  if (truncated) {
    sections.push(`[SKILL INSTRUCTIONS TRUNCATED: per-skill limit ${MAX_PER_SKILL_SECTION} / total limit ${MAX_TOTAL_SKILL_INSTRUCTIONS} chars]`);
  }

  return sections.join("\n\n");
}

function resolveHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}
