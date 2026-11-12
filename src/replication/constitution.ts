/**
 * Constitution Integrity
 *
 * Propagates and verifies constitution files between parent and child sandboxes.
 * Uses SHA-256 hash verification instead of superficial chmod 444.
 */

import fs from "fs";
import pathLib from "path";
import { createHash } from "crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import type { ConwayClient } from "../types.js";

const NO_FOLLOW_READ =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Compute SHA-256 hash of content.
 */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Propagate the local constitution to a child sandbox.
 * Writes file, computes hash, stores hash in KV.
 */
export async function propagateConstitution(
  conway: ConwayClient,
  sandboxId: string,
  db: DatabaseType,
): Promise<void> {
  const constitutionPath = pathLib.join(
    process.env.HOME || "/root",
    ".automaton",
    "constitution.md",
  );

  // O_NOFOLLOW: a link planted at constitution.md must not copy the file it
  // points at (wallet.json, say) into the child sandbox.
  const constitution = fs.readFileSync(constitutionPath, {
    encoding: "utf-8",
    // Node accepts numeric open flags here; the typings list only strings.
    flag: NO_FOLLOW_READ as unknown as string,
  });
  const hash = sha256(constitution);

  // Write constitution to child sandbox
  await conway.writeFile("/root/.automaton/constitution.md", constitution);

  // Write hash file for the child to verify against
  await conway.writeFile("/root/.automaton/constitution.sha256", hash);

  // Store hash in KV for later verification
  db.prepare(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  ).run(`constitution_hash:${sandboxId}`, hash);

  // chmod 444 as defense-in-depth (not primary verification mechanism)
  try {
    await conway.exec("chmod 444 /root/.automaton/constitution.md", 5000);
  } catch {
    // Non-critical
  }
}

/**
 * Verify a child's constitution integrity by comparing hashes.
 */
export async function verifyConstitution(
  conway: ConwayClient,
  sandboxId: string,
  db: DatabaseType,
): Promise<{ valid: boolean; detail: string }> {
  // Get stored hash
  const storedRow = db
    .prepare("SELECT value FROM kv WHERE key = ?")
    .get(`constitution_hash:${sandboxId}`) as { value: string } | undefined;

  if (!storedRow) {
    return { valid: false, detail: "no stored constitution hash found" };
  }

  try {
    // Read constitution from child sandbox
    const childConstitution = await conway.readFile("/root/.automaton/constitution.md");
    const childHash = sha256(childConstitution);

    if (childHash === storedRow.value) {
      return { valid: true, detail: "constitution hash matches" };
    }

    return {
      valid: false,
      detail: `hash mismatch: expected ${storedRow.value.slice(0, 16)}..., got ${childHash.slice(0, 16)}...`,
    };
  } catch (error) {
    return {
      valid: false,
      detail: `failed to read child constitution: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
