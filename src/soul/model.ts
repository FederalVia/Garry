/**
 * Soul Model — Data model, parser, writer for structured SOUL.md
 *
 * Supports both legacy (unstructured markdown) and soul/v1 (YAML frontmatter + structured markdown) formats.
 * Phase 2.1: Soul System Redesign
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type BetterSqlite3 from "better-sqlite3";
import type { SoulModel } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { readRegularFileNoFollow } from "../security/secure-fs.js";
const logger = createLogger("soul");

/** Read cap for SOUL.md; a rewrite must stay under it or the soul is lost. */
export const MAX_SOUL_FILE_BYTES = 64 * 1024;

/**
 * Top-level section names. Only these open a section: any other "## " line
 * (a heading inside a markdown genesis prompt) stays in the current section.
 */
const KNOWN_SECTIONS = new Set([
  "identity",
  "mission",
  "core purpose",
  "values",
  "behavioral guidelines",
  "personality",
  "boundaries",
  "strategy",
  "capabilities",
  "relationships",
  "children",
  "financial character",
  "financial history",
  "genesis prompt",
]);

/** The fixed text that follows the genesis in the setup wizard's SOUL.md. */
const WIZARD_VALUES_TAIL = "## Values\n- Survive: maintain compute resources at all costs";

/** Frontmatter values are single-line scalars; a newline would start a new key or section. */
function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, 256);
}

/**
 * Section bodies are written verbatim, and any line starting with "##" would
 * open a new section on reload. Escape a leading "#" with a backslash (and
 * one more backslash on lines that already start with "\#"), undone by
 * unescapeBody, so the text round-trips but cannot spill into another section.
 */
function escapeBody(text: string): string {
  return text.replace(/^(?=\\*#)/gm, "\\");
}

function unescapeBody(text: string): string {
  return text.replace(/^\\(?=\\*#)/gm, "");
}

// ─── Constants ──────────────────────────────────────────────────

const SOUL_FORMAT = "soul/v1" as const;

// ─── Hash Utility ───────────────────────────────────────────────

export function createHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ─── Genesis Alignment ──────────────────────────────────────────

// Scripts written without spaces between words: compared as character bigrams.
const NO_SPACE_SCRIPT_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]+/gu;
const NO_SPACE_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** Word tokens for any script (letters, marks and digits are kept). */
export function alignmentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const words = text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u);
  for (const word of words) {
    if (!word) continue;
    for (const run of word.match(NO_SPACE_SCRIPT_RUN) ?? []) {
      if (!NO_SPACE_SCRIPT.test(run)) {
        tokens.add(run);
        continue;
      }
      const chars = Array.from(run);
      if (chars.length === 1) {
        tokens.add(chars[0]);
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1]);
    }
  }
  return tokens;
}

/**
 * Compute alignment between current soul and genesis prompt.
 * Uses Jaccard + recall similarity on word sets.
 */
export function computeGenesisAlignment(
  currentPurpose: string,
  genesisPrompt: string,
): number {
  if (!currentPurpose.trim() || !genesisPrompt.trim()) return 0;

  const tokenize = alignmentTokens;

  const currentTokens = tokenize(currentPurpose);
  const genesisTokens = tokenize(genesisPrompt);

  if (currentTokens.size === 0 || genesisTokens.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of currentTokens) {
    if (genesisTokens.has(token)) intersectionSize++;
  }

  // Jaccard similarity
  const unionSize = new Set([...currentTokens, ...genesisTokens]).size;
  const jaccard = unionSize > 0 ? intersectionSize / unionSize : 0;

  // Recall: how much of genesis is reflected in current
  const recall = genesisTokens.size > 0 ? intersectionSize / genesisTokens.size : 0;

  // Combined score: average of Jaccard and recall
  return Math.min(1, Math.max(0, (jaccard + recall) / 2));
}

// ─── Parser ─────────────────────────────────────────────────────

/**
 * Parse SOUL.md content into a structured SoulModel.
 * Handles both legacy (unstructured markdown) and soul/v1 (YAML frontmatter + structured markdown).
 */
export function parseSoulMd(content: string): SoulModel {
  const contentHash = createHash(content);

  // Try to parse as soul/v1 format (YAML frontmatter)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const body = frontmatterMatch[2];

    // Check if it's soul/v1 format
    if (/format:\s*soul\/v1/i.test(frontmatter)) {
      return parseSoulV1(frontmatter, body, content, contentHash);
    }
  }

  // Legacy format: parse unstructured markdown
  return parseLegacy(content, contentHash);
}

function parseSoulV1(
  frontmatter: string,
  body: string,
  rawContent: string,
  contentHash: string,
): SoulModel {
  // Parse frontmatter fields
  const getField = (key: string): string => {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match ? match[1].trim() : "";
  };

  const getNumberField = (key: string, fallback: number): number => {
    const val = getField(key);
    const num = parseFloat(val);
    return isNaN(num) ? fallback : num;
  };

  // Parse body sections
  const sections = parseSections(body);

  return {
    format: "soul/v1",
    version: getNumberField("version", 1),
    updatedAt: getField("updated_at") || new Date().toISOString(),
    name: getField("name") || "",
    address: getField("address") || "",
    creator: getField("creator") || "",
    bornAt: getField("born_at") || "",
    constitutionHash: getField("constitution_hash") || "",
    genesisPromptOriginal: sections["genesis prompt"] || "",
    genesisAlignment: getNumberField("genesis_alignment", 1.0),
    lastReflected: getField("last_reflected") || "",
    corePurpose: sections["core purpose"] || sections["mission"] || "",
    values: parseList(sections["values"] || ""),
    behavioralGuidelines: parseList(sections["behavioral guidelines"] || ""),
    personality: sections["personality"] || "",
    boundaries: parseList(sections["boundaries"] || ""),
    strategy: sections["strategy"] || "",
    capabilities: sections["capabilities"] || "",
    relationships: sections["relationships"] || sections["children"] || "",
    financialCharacter: sections["financial character"] || sections["financial history"] || "",
    rawContent,
    contentHash,
  };
}

function parseLegacy(content: string, contentHash: string): SoulModel {
  const wizard = splitWizardTemplate(content);
  const sections = wizard
    ? { ...parseSections(wizard.head), ...parseSections(wizard.tail), mission: wizard.mission }
    : parseSections(content);

  // Extract identity info from legacy format
  const identitySection = sections["identity"] || "";
  const getName = (): string => {
    const match = identitySection.match(/Name:\s*(.+)/i) || content.match(/^#\s+(.+)/m);
    return match ? match[1].trim() : "";
  };
  const getIdentityField = (key: string): string => {
    const match = identitySection.match(new RegExp(`${key}:\\s*(.+)`, "i"));
    return match ? match[1].trim() : "";
  };

  return {
    format: "soul/v1",
    version: 1,
    updatedAt: new Date().toISOString(),
    name: getName(),
    address: getIdentityField("Address"),
    creator: getIdentityField("Creator"),
    bornAt: getIdentityField("Born"),
    constitutionHash: "",
    // The wizard copies the genesis prompt verbatim into Mission.
    genesisPromptOriginal: wizard ? wizard.mission : "",
    genesisAlignment: 1.0,
    lastReflected: "",
    corePurpose: sections["mission"] || sections["core purpose"] || "",
    values: parseList(sections["values"] || ""),
    behavioralGuidelines: parseList(sections["behavioral guidelines"] || ""),
    personality: sections["personality"] || "",
    boundaries: parseList(sections["boundaries"] || ""),
    strategy: sections["strategy"] || "",
    capabilities: sections["capabilities"] || "",
    relationships: sections["relationships"] || sections["children"] || "",
    financialCharacter: sections["financial character"] || sections["financial history"] || "",
    rawContent: content,
    contentHash,
  };
}

// ─── Section Parser ─────────────────────────────────────────────

/**
 * The setup wizard's legacy SOUL.md (setup/defaults.ts generateSoulMd, also
 * used for children): "## Identity" with "- Name:", then "## Mission" with the
 * genesis verbatim, then a fixed "## Values" list. The genesis may contain
 * any heading, known names included, so Mission runs from the first
 * "## Mission" line to the last fixed "## Values" line.
 */
function splitWizardTemplate(content: string): { head: string; mission: string; tail: string } | null {
  const text = content.replace(/\r\n/g, "\n");
  const identity = /^##\s+Identity\s*$/m.exec(text);
  const missionHeader = /^##\s+Mission[^\S\n]*\n/m.exec(text);
  const tailAt = text.lastIndexOf(`\n${WIZARD_VALUES_TAIL}`);
  if (!identity || !missionHeader || tailAt < 0) return null;
  if (identity.index > missionHeader.index || tailAt < missionHeader.index) return null;
  const head = text.slice(0, missionHeader.index);
  if (!/^-\s*Name:/m.test(head)) return null;
  return {
    head,
    mission: text.slice(missionHeader.index + missionHeader[0].length, tailAt).trim(),
    tail: text.slice(tailAt + 1),
  };
}

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const sectionPattern = /^##\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  const sectionHeaders: { name: string; start: number; matchStart: number }[] = [];

  while ((match = sectionPattern.exec(body)) !== null) {
    const name = match[1].trim().toLowerCase();
    if (!KNOWN_SECTIONS.has(name)) continue;
    sectionHeaders.push({
      name,
      start: match.index + match[0].length,
      matchStart: match.index,
    });
  }

  for (let i = 0; i < sectionHeaders.length; i++) {
    const start = sectionHeaders[i].start;
    // Use the next header's matchStart (position of "##") as the end boundary,
    // instead of computing it from trimmed name length which can be wrong when
    // headers have extra whitespace or multi-byte characters.
    const end = i + 1 < sectionHeaders.length ? sectionHeaders[i + 1].matchStart : body.length;
    sections[sectionHeaders[i].name] = unescapeBody(body.slice(start, end).trim());
  }

  return sections;
}

function parseList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

// ─── Writer ─────────────────────────────────────────────────────

/**
 * Write a SoulModel back to SOUL.md format (soul/v1).
 */
export function writeSoulMd(soul: SoulModel): string {
  const frontmatter = [
    "---",
    `format: soul/v1`,
    `version: ${soul.version}`,
    `updated_at: ${oneLine(soul.updatedAt)}`,
    `name: ${oneLine(soul.name)}`,
    `address: ${oneLine(soul.address)}`,
    `creator: ${oneLine(soul.creator)}`,
    `born_at: ${oneLine(soul.bornAt)}`,
    `constitution_hash: ${oneLine(soul.constitutionHash)}`,
    `genesis_alignment: ${Number(soul.genesisAlignment).toFixed(4)}`,
    `last_reflected: ${oneLine(soul.lastReflected)}`,
    "---",
  ].join("\n");

  const sections: string[] = [];

  sections.push(`# ${oneLine(soul.name) || "Soul"}`);

  if (soul.corePurpose) {
    sections.push(`## Core Purpose\n${escapeBody(soul.corePurpose)}`);
  }

  if (soul.values.length > 0) {
    sections.push(`## Values\n${escapeBody(soul.values.map((v) => `- ${v}`).join("\n"))}`);
  }

  if (soul.behavioralGuidelines.length > 0) {
    sections.push(
      `## Behavioral Guidelines\n${escapeBody(soul.behavioralGuidelines.map((g) => `- ${g}`).join("\n"))}`,
    );
  }

  if (soul.personality) {
    sections.push(`## Personality\n${escapeBody(soul.personality)}`);
  }

  if (soul.boundaries.length > 0) {
    sections.push(`## Boundaries\n${escapeBody(soul.boundaries.map((b) => `- ${b}`).join("\n"))}`);
  }

  if (soul.strategy) {
    sections.push(`## Strategy\n${escapeBody(soul.strategy)}`);
  }

  if (soul.capabilities) {
    sections.push(`## Capabilities\n${escapeBody(soul.capabilities)}`);
  }

  if (soul.relationships) {
    sections.push(`## Relationships\n${escapeBody(soul.relationships)}`);
  }

  if (soul.financialCharacter) {
    sections.push(`## Financial Character\n${escapeBody(soul.financialCharacter)}`);
  }

  if (soul.genesisPromptOriginal) {
    sections.push(`## Genesis Prompt\n${escapeBody(soul.genesisPromptOriginal)}`);
  }

  return frontmatter + "\n\n" + sections.join("\n\n") + "\n";
}

// ─── Default Soul ───────────────────────────────────────────────

/**
 * Create a default soul from a genesis prompt.
 */
export function createDefaultSoul(
  genesisPrompt: string,
  name: string = "",
  address: string = "",
  creator: string = "",
): SoulModel {
  const now = new Date().toISOString();
  const soul: SoulModel = {
    format: "soul/v1",
    version: 1,
    updatedAt: now,
    name,
    address,
    creator,
    bornAt: now,
    constitutionHash: "",
    genesisPromptOriginal: genesisPrompt,
    genesisAlignment: 1.0,
    lastReflected: "",
    corePurpose: genesisPrompt,
    values: [
      "Survive: maintain compute resources at all costs",
      "Grow: learn new skills and improve capabilities",
      "Create: build things that add value",
      "Connect: communicate with creator and other agents",
    ],
    behavioralGuidelines: [],
    personality: "",
    boundaries: [],
    strategy: "",
    capabilities: "",
    relationships: "",
    financialCharacter: "",
    rawContent: "",
    contentHash: "",
  };

  const content = writeSoulMd(soul);
  soul.rawContent = content;
  soul.contentHash = createHash(content);

  return soul;
}

// ─── Load Current Soul ──────────────────────────────────────────

/**
 * Load the current soul from SOUL.md file.
 * Returns null if SOUL.md does not exist or cannot be read.
 */
export function loadCurrentSoul(
  db: BetterSqlite3.Database | null,
  soulPath?: string,
): SoulModel | null {
  try {
    const home = process.env.HOME || "/root";
    const resolvedPath = path.resolve(soulPath || path.join(home, ".automaton", "SOUL.md"));
    if (!fs.existsSync(resolvedPath) && !isLink(resolvedPath)) return null;
    // Never follow a link: SOUL.md is rendered into every system prompt.
    const content = readRegularFileNoFollow(resolvedPath, {
      root: path.dirname(resolvedPath),
      maxBytes: MAX_SOUL_FILE_BYTES,
    });
    if (content === null) {
      logger.warn("SOUL.md is not a regular file or is over the size cap; ignoring it");
      return null;
    }
    return parseSoulMd(content);
  } catch (error) {
    logger.error("Failed to load SOUL.md", error instanceof Error ? error : undefined);
    return null;
  }
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
