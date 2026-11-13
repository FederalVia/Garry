/**
 * Soul Tools — Tool implementations for soul management.
 *
 * Provides updateSoul, reflectOnSoul (trigger), viewSoul, and viewSoulHistory.
 * All operations validate before saving and log to soul_history.
 *
 * Phase 2.1: Soul System Redesign
 */

import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import type { SoulModel, SoulHistoryRow } from "../types.js";
import { loadCurrentSoul, writeSoulMd, createHash, createDefaultSoul, MAX_SOUL_FILE_BYTES } from "./model.js";
import { validateSoul } from "./validator.js";
import { insertSoulHistory, getCurrentSoulVersion, getLatestSoulHistory, getSoulHistory } from "../state/database.js";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import { writeFileSafe } from "../security/secure-fs.js";
import { commitSoulUpdate } from "../git/state-versioning.js";
const logger = createLogger("soul");

type SoulKey = keyof SoulModel;
type ChangeSource = SoulHistoryRow["changeSource"];

const TEXT_KEYS: SoulKey[] = [
  "name", "address", "creator", "bornAt", "constitutionHash", "genesisPromptOriginal",
  "lastReflected", "corePurpose", "personality", "strategy", "capabilities",
  "relationships", "financialCharacter", "updatedAt",
];
const LIST_KEYS: SoulKey[] = ["values", "behavioralGuidelines", "boundaries"];
const NUMBER_KEYS: SoulKey[] = ["genesisAlignment"];
const ALL_CONTENT_KEYS = new Set<SoulKey>([...TEXT_KEYS, ...LIST_KEYS, ...NUMBER_KEYS]);

/**
 * Which soul sections each change source may write. The agent edits only its
 * mutable self-description; reflection only its auto-derived sections;
 * identity and genesis fields belong to the creator and setup paths.
 */
const ALLOWED_KEYS_BY_SOURCE: Record<ChangeSource, ReadonlySet<SoulKey>> = {
  agent: new Set<SoulKey>([
    "corePurpose", "values", "behavioralGuidelines", "personality", "boundaries", "strategy",
  ]),
  reflection: new Set<SoulKey>([
    "capabilities", "relationships", "financialCharacter", "genesisAlignment", "lastReflected",
  ]),
  human: ALL_CONTENT_KEYS,
  system: ALL_CONTENT_KEYS,
  genesis: ALL_CONTENT_KEYS,
};

/** Sources whose text must not carry a section heading ("## Capabilities"). */
const UNTRUSTED_SOURCES = new Set<ChangeSource>(["agent", "reflection"]);
const SECTION_HEADING = /^##/m;

function checkUpdateKeys(updates: Record<string, unknown>, source: ChangeSource): string[] {
  const errors: string[] = [];
  const allowed = ALLOWED_KEYS_BY_SOURCE[source] ?? new Set<SoulKey>();
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.has(key as SoulKey)) {
      errors.push(`Section "${key}" cannot be changed by ${source}`);
      continue;
    }
    if (TEXT_KEYS.includes(key as SoulKey) && typeof value !== "string") {
      errors.push(`Section "${key}" must be text`);
    } else if (
      LIST_KEYS.includes(key as SoulKey) &&
      !(Array.isArray(value) && value.every((v) => typeof v === "string"))
    ) {
      errors.push(`Section "${key}" must be a list of strings`);
    } else if (NUMBER_KEYS.includes(key as SoulKey) && (typeof value !== "number" || !Number.isFinite(value))) {
      errors.push(`Section "${key}" must be a number`);
    } else if (UNTRUSTED_SOURCES.has(source)) {
      const texts = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
      if (texts.some((t) => typeof t === "string" && SECTION_HEADING.test(t))) {
        errors.push(`Section "${key}" must not contain a line starting with "##"`);
      }
    }
  }
  return errors;
}

// ─── Update Soul ────────────────────────────────────────────────

export interface UpdateSoulResult {
  success: boolean;
  version: number;
  errors?: string[];
}

/**
 * Update the soul with new content. Validates, versions, saves to file, and logs.
 */
export async function updateSoul(
  db: BetterSqlite3.Database,
  updates: Partial<SoulModel>,
  source: SoulHistoryRow["changeSource"],
  reason?: string,
  soulPath?: string,
): Promise<UpdateSoulResult> {
  try {
    const home = process.env.HOME || "/root";
    const resolvedPath = soulPath || path.join(home, ".automaton", "SOUL.md");

    const keyErrors = checkUpdateKeys(updates as Record<string, unknown>, source);
    if (keyErrors.length > 0) {
      return { success: false, version: 0, errors: keyErrors };
    }

    // Load current soul; create a default only when there is no SOUL.md at all.
    let current = loadCurrentSoul(db, resolvedPath);
    const isNew = !current;
    if (!current && pathEntryExists(resolvedPath)) {
      return {
        success: false,
        version: 0,
        errors: [
          `SOUL.md exists but could not be read (over ${MAX_SOUL_FILE_BYTES} bytes, not a regular file, or unreadable); refusing to replace it with a default soul. Fix or shorten the file by hand.`,
        ],
      };
    }
    if (!current) {
      current = createDefaultSoul(
        updates.corePurpose || "No purpose set.",
        updates.name || "",
        updates.address || "",
        updates.creator || "",
      );
    }

    // Merge updates into current soul
    const merged: SoulModel = {
      ...current,
      ...updates,
      format: "soul/v1",
      updatedAt: new Date().toISOString(),
    };

    // Only the keys this update changes are checked and cleaned: an unchanged
    // creator-written purpose or genesis is carried byte for byte.
    const changedKeys = isNew
      ? undefined
      : Object.keys(updates).filter(
          (k) => JSON.stringify((updates as any)[k]) !== JSON.stringify((current as any)[k]),
        );
    const validation = validateSoul(merged, { changedKeys });
    if (!validation.valid) {
      return {
        success: false,
        version: current.version,
        errors: validation.errors,
      };
    }

    // Increment version
    const currentVersion = getCurrentSoulVersion(db);
    const newVersion = Math.max(currentVersion, current.version) + 1;
    const newSoul: SoulModel = {
      ...validation.sanitized,
      version: newVersion,
      updatedAt: new Date().toISOString(),
    };

    // SOUL.md is read with a size cap, so a larger file would lose the soul.
    const content = fitSoulFile(newSoul, changedKeys);
    if (content === null) {
      return {
        success: false,
        version: current.version,
        errors: [`SOUL.md would exceed ${MAX_SOUL_FILE_BYTES} bytes; shorten a section first`],
      };
    }
    writeFileSafe(resolvedPath, content, { trustedWriter: true });

    // Get previous version ID
    const latestHistory = getLatestSoulHistory(db);
    const previousVersionId = latestHistory?.id || null;

    // Log to soul_history
    insertSoulHistory(db, {
      id: ulid(),
      version: newVersion,
      content,
      contentHash: createHash(content),
      changeSource: source,
      changeReason: reason || null,
      previousVersionId,
      approvedBy: null,
      createdAt: new Date().toISOString(),
    });

    if (isStateSoulPath(resolvedPath)) {
      await commitSoulUpdate(`v${newVersion} (${source})${reason ? `: ${oneLineReason(reason)}` : ""}`);
    }

    return { success: true, version: newVersion };
  } catch (error) {
    logger.error("updateSoul failed", error instanceof Error ? error : undefined);
    return {
      success: false,
      version: 0,
      errors: [error instanceof Error ? error.message : "Unknown error"],
    };
  }
}

function pathEntryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err: any) {
    // Only a confirmed absence counts as missing.
    return err?.code !== "ENOENT";
  }
}

/**
 * Serialize the soul within the read cap. A genesis copy this update did not
 * change (the wizard stores the genesis in Core Purpose too) is shortened to
 * fit; the full text stays in Core Purpose and the config. Null when even
 * that is not enough.
 */
function fitSoulFile(soul: SoulModel, changedKeys: string[] | undefined): string | null {
  let content = writeSoulMd(soul);
  let over = Buffer.byteLength(content, "utf8") - MAX_SOUL_FILE_BYTES;
  if (over <= 0) return content;
  const genesisChanged = changedKeys === undefined || changedKeys.includes("genesisPromptOriginal");
  if (genesisChanged || !soul.genesisPromptOriginal) return null;
  let genesis = soul.genesisPromptOriginal;
  while (over > 0 && genesis.length > 0) {
    // Cut by UTF-8 bytes, not UTF-16 units: a CJK unit is 3 bytes.
    genesis = truncateUtf8(genesis, Buffer.byteLength(genesis, "utf8") - over).trimEnd();
    content = writeSoulMd({ ...soul, genesisPromptOriginal: genesis });
    over = Buffer.byteLength(content, "utf8") - MAX_SOUL_FILE_BYTES;
  }
  // An empty copy would turn alignment checks off for good: refuse instead.
  if (over > 0 || genesis.length === 0) return null;
  logger.warn(`Genesis Prompt copy in SOUL.md shortened to ${genesis.length} chars to stay under the size cap`);
  return content;
}

/** The longest prefix of text whose UTF-8 encoding fits in maxBytes. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Back up to the start of a character (continuation bytes are 10xxxxxx).
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function isStateSoulPath(p: string): boolean {
  const home = process.env.HOME || "/root";
  return path.resolve(p) === path.resolve(home, ".automaton", "SOUL.md");
}

function oneLineReason(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
}

// ─── View Soul ──────────────────────────────────────────────────

/**
 * View the current soul model.
 */
export function viewSoul(
  db: BetterSqlite3.Database,
  soulPath?: string,
): SoulModel | null {
  return loadCurrentSoul(db, soulPath);
}

// ─── View Soul History ──────────────────────────────────────────

/**
 * View soul change history.
 */
export function viewSoulHistory(
  db: BetterSqlite3.Database,
  limit?: number,
): SoulHistoryRow[] {
  return getSoulHistory(db, limit);
}
