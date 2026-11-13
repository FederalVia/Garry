/**
 * Soul Validator — Content validation and injection detection for soul content.
 *
 * Validates soul sections against size limits, structural requirements,
 * and injection patterns. Never throws — returns ValidationResult objects.
 *
 * Phase 2.1: Soul System Redesign
 */

import type { SoulModel, SoulValidationResult } from "../types.js";

// ─── Size Limits ────────────────────────────────────────────────

const LIMITS = {
  corePurpose: 2000,
  values: 20,
  behavioralGuidelines: 30,
  personality: 1000,
  boundaries: 20,
  strategy: 3000,
  listItem: 1000,
  capabilities: 4000,
  relationships: 4000,
  financialCharacter: 2000,
  genesisPromptOriginal: 2000,
  name: 100,
  address: 128,
  creator: 128,
  bornAt: 64,
  constitutionHash: 64,
  lastReflected: 64,
  updatedAt: 64,
} as const;

/** Written as single-line YAML scalars in the SOUL.md frontmatter. */
const FRONTMATTER_FIELDS = [
  "name",
  "address",
  "creator",
  "bornAt",
  "constitutionHash",
  "lastReflected",
  "updatedAt",
] as const;

/**
 * Rewritten by reflection from observed activity (peer names included), so
 * injection text is stripped rather than rejected: reflection must keep working.
 */
const AUTO_SECTIONS = ["capabilities", "relationships", "financialCharacter"] as const;

// ─── Injection Patterns ─────────────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  // Prompt boundaries
  /<\/?system>/i,
  /<\/?prompt>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /<<\/SYS>>/i,
  /\[SYSTEM\]/i,
  /END\s+OF\s+(SYSTEM|PROMPT)/i,
  /BEGIN\s+NEW\s+(PROMPT|INSTRUCTIONS?)/i,

  // ChatML markers
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /<\|endoftext\|>/i,

  // Tool call syntax
  /\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/,
  /\btool_call\b/i,
  /\bfunction_call\b/i,

  // System overrides
  /ignore\s+(all\s+)?(previous|prior|above)/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /override\s+(all\s+)?safety/i,
  /bypass\s+(all\s+)?restrictions?/i,
  /new\s+instructions?:/i,
  /your\s+real\s+instructions?\s+(are|is)/i,

  // Encoding evasion
  /\x00/, // null bytes
  /\u200b/, // zero-width space
  /\u200c/, // zero-width non-joiner
  /\u200d/, // zero-width joiner
  /\ufeff/, // BOM
];

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check if text contains injection patterns.
 */
export function containsInjectionPatterns(text: string): boolean {
  if (!text) return false;
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

export interface ValidateSoulOptions {
  /**
   * Keys this update changes. When given, only these are checked for size and
   * injection and only these are sanitized; every other field is carried as
   * stored (a long creator-written purpose must not block or be truncated by
   * an unrelated update). Required fields are always checked.
   */
  changedKeys?: Iterable<string>;
}

/**
 * Validate a SoulModel against size limits, structural requirements, and injection patterns.
 * Never throws — returns a ValidationResult.
 */
export function validateSoul(soul: SoulModel, opts?: ValidateSoulOptions): SoulValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const changed = opts?.changedKeys ? new Set<string>(opts.changedKeys) : null;
  const check = (key: string): boolean => changed === null || changed.has(key);

  // Structural validation
  if (!soul.corePurpose.trim()) {
    errors.push("Core purpose is required");
  }

  // Size limits
  if (check("corePurpose") && soul.corePurpose.length > LIMITS.corePurpose) {
    errors.push(`Core purpose exceeds ${LIMITS.corePurpose} chars (${soul.corePurpose.length})`);
  }

  if (check("values") && soul.values.length > LIMITS.values) {
    errors.push(`Too many values (${soul.values.length}, max ${LIMITS.values})`);
  }

  if (check("behavioralGuidelines") && soul.behavioralGuidelines.length > LIMITS.behavioralGuidelines) {
    errors.push(
      `Too many behavioral guidelines (${soul.behavioralGuidelines.length}, max ${LIMITS.behavioralGuidelines})`,
    );
  }

  if (check("personality") && soul.personality.length > LIMITS.personality) {
    errors.push(`Personality exceeds ${LIMITS.personality} chars (${soul.personality.length})`);
  }

  if (check("boundaries") && soul.boundaries.length > LIMITS.boundaries) {
    errors.push(`Too many boundaries (${soul.boundaries.length}, max ${LIMITS.boundaries})`);
  }

  if (check("strategy") && soul.strategy && soul.strategy.length > LIMITS.strategy) {
    warnings.push(`Strategy exceeds ${LIMITS.strategy} chars (${soul.strategy.length})`);
  }

  // Injection detection per section
  const textSections: { name: string; content: string }[] = [
    { name: "corePurpose", content: soul.corePurpose },
    { name: "personality", content: soul.personality },
    { name: "strategy", content: soul.strategy },
  ];

  for (const section of textSections) {
    if (!check(section.name)) continue;
    if (section.content && containsInjectionPatterns(section.content)) {
      errors.push(`Injection pattern detected in ${section.name}`);
    }
  }

  const listSections: { name: string; items: string[] }[] = [
    { name: "values", items: soul.values },
    { name: "behavioralGuidelines", items: soul.behavioralGuidelines },
    { name: "boundaries", items: soul.boundaries },
  ];

  for (const section of listSections) {
    if (!check(section.name)) continue;
    for (const item of section.items) {
      if (containsInjectionPatterns(item)) {
        errors.push(`Injection pattern detected in ${section.name}`);
        break;
      }
    }
    if (section.items.some((item) => typeof item !== "string" || item.length > LIMITS.listItem)) {
      errors.push(`${section.name} items must be strings of at most ${LIMITS.listItem} chars`);
    }
  }

  for (const field of FRONTMATTER_FIELDS) {
    const value = soul[field];
    if (value === undefined || value === null || value === "") continue;
    // Unchanged values are written through oneLine(), which keeps the file intact.
    if (!check(field)) continue;
    if (typeof value !== "string") {
      errors.push(`${field} must be a string`);
      continue;
    }
    if (/[\r\n\u2028\u2029]/.test(value) || value.includes("---")) {
      errors.push(`${field} must be a single line without "---"`);
    }
    if (value.length > LIMITS[field]) {
      errors.push(`${field} exceeds ${LIMITS[field]} chars (${value.length})`);
    }
  }

  if (check("genesisPromptOriginal")) {
    if (soul.genesisPromptOriginal && containsInjectionPatterns(soul.genesisPromptOriginal)) {
      errors.push("Injection pattern detected in genesisPromptOriginal");
    }
    if (soul.genesisPromptOriginal && soul.genesisPromptOriginal.length > LIMITS.genesisPromptOriginal) {
      warnings.push(`genesisPromptOriginal exceeds ${LIMITS.genesisPromptOriginal} chars; truncated`);
    }
  }

  for (const field of AUTO_SECTIONS) {
    if (!check(field)) continue;
    const value = soul[field];
    if (!value) continue;
    if (containsInjectionPatterns(value)) {
      warnings.push(`Injection pattern stripped from ${field}`);
    }
    if (value.length > LIMITS[field]) {
      warnings.push(`${field} exceeds ${LIMITS[field]} chars; truncated`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    sanitized: sanitizeSoul(soul, opts?.changedKeys),
  };
}

/**
 * Strip injection patterns and enforce size limits on a soul model.
 * Returns a cleaned copy. With changedKeys, only those fields are cleaned.
 */
export function sanitizeSoul(soul: SoulModel, changedKeys?: Iterable<string>): SoulModel {
  const cleaned: SoulModel = {
    ...soul,
    corePurpose: stripInjection(soul.corePurpose).slice(0, LIMITS.corePurpose),
    values: soul.values.slice(0, LIMITS.values).map(stripInjection),
    behavioralGuidelines: soul.behavioralGuidelines
      .slice(0, LIMITS.behavioralGuidelines)
      .map(stripInjection),
    personality: stripInjection(soul.personality).slice(0, LIMITS.personality),
    boundaries: soul.boundaries.slice(0, LIMITS.boundaries).map(stripInjection),
    strategy: stripInjection(soul.strategy).slice(0, LIMITS.strategy),
    capabilities: soul.capabilities ? stripAll(soul.capabilities).slice(0, LIMITS.capabilities) : soul.capabilities,
    relationships: soul.relationships ? stripAll(soul.relationships).slice(0, LIMITS.relationships) : soul.relationships,
    financialCharacter: soul.financialCharacter
      ? stripAll(soul.financialCharacter).slice(0, LIMITS.financialCharacter)
      : soul.financialCharacter,
    genesisPromptOriginal: soul.genesisPromptOriginal
      ? stripInjection(soul.genesisPromptOriginal).slice(0, LIMITS.genesisPromptOriginal)
      : soul.genesisPromptOriginal,
  };
  if (changedKeys === undefined) return cleaned;
  const changed = new Set<string>(changedKeys);
  const out: SoulModel = { ...soul };
  for (const key of SANITIZED_KEYS) {
    if (changed.has(key)) (out as any)[key] = cleaned[key];
  }
  return out;
}

const SANITIZED_KEYS = [
  "corePurpose",
  "values",
  "behavioralGuidelines",
  "personality",
  "boundaries",
  "strategy",
  "capabilities",
  "relationships",
  "financialCharacter",
  "genesisPromptOriginal",
] as const;

// ─── Internal Helpers ───────────────────────────────────────────

/** stripInjection plus the override phrases, for sections that are cleaned, not rejected. */
function stripAll(text: string): string {
  if (!text) return text;
  let cleaned = stripInjection(text);
  for (const pattern of INJECTION_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    cleaned = cleaned.replace(global, "");
  }
  return cleaned;
}

function stripInjection(text: string): string {
  if (!text) return text;
  let cleaned = text;

  // Remove prompt boundaries
  cleaned = cleaned
    .replace(/<\/?system>/gi, "")
    .replace(/<\/?prompt>/gi, "")
    .replace(/\[INST\]/gi, "")
    .replace(/\[\/INST\]/gi, "")
    .replace(/<<SYS>>/gi, "")
    .replace(/<<\/SYS>>/gi, "")
    .replace(/\[SYSTEM\]/gi, "");

  // Remove ChatML markers
  cleaned = cleaned
    .replace(/<\|im_start\|>/gi, "")
    .replace(/<\|im_end\|>/gi, "")
    .replace(/<\|endoftext\|>/gi, "");

  // Remove tool call syntax
  cleaned = cleaned
    .replace(/\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/g, "")
    .replace(/\btool_call\b/gi, "")
    .replace(/\bfunction_call\b/gi, "");

  // Remove zero-width characters
  cleaned = cleaned
    .replace(/\x00/g, "")
    .replace(/\u200b/g, "")
    .replace(/\u200c/g, "")
    .replace(/\u200d/g, "")
    .replace(/\ufeff/g, "");

  return cleaned;
}
