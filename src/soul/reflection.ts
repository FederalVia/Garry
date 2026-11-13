/**
 * Soul Reflection — Reflection pipeline for soul evolution.
 *
 * Gathers evidence from recent turns and tool usage to suggest
 * soul updates. Auto-updates non-mutable sections (capabilities,
 * relationships, financial) but only suggests changes to mutable sections.
 *
 * Phase 2.1: Soul System Redesign
 */

import type BetterSqlite3 from "better-sqlite3";
import type { SoulModel, SoulReflection } from "../types.js";
import { loadCurrentSoul, computeGenesisAlignment } from "./model.js";
import { updateSoul } from "./tools.js";
import { createLogger } from "../observability/logger.js";
import { isolatedTurnSql, isValidSenderAddress } from "../agent/inbox-isolation.js";
const logger = createLogger("soul");

// ─── Reflection Pipeline ────────────────────────────────────────

export interface SoulReflectionResult extends SoulReflection {
  /**
   * False when SOUL.md records no genesis prompt (or there is no soul). The
   * alignment is then unknown: currentAlignment is NaN, which never passes a
   * "below threshold" check, and nothing is suggested.
   */
  alignmentKnown: boolean;
  /** Why the auto-updates were not written (autoUpdated is then empty). */
  autoUpdateErrors?: string[];
}

function unknownAlignment(): SoulReflectionResult {
  return { currentAlignment: Number.NaN, alignmentKnown: false, suggestedUpdates: [], autoUpdated: [] };
}

/**
 * Run the soul reflection pipeline.
 *
 * - Gathers evidence from recent turns and tool usage
 * - Auto-updates capabilities, relationships, financial sections
 * - Computes genesis alignment score
 * - Returns suggestions for mutable sections (does NOT auto-apply them)
 */
export async function reflectOnSoul(
  db: BetterSqlite3.Database,
  soulPath?: string,
): Promise<SoulReflectionResult> {
  try {
    const soul = loadCurrentSoul(db, soulPath);
    if (!soul) return unknownAlignment();

    // No recorded genesis means no baseline to drift from: unknown, not 0.
    const alignmentKnown = soul.genesisPromptOriginal.trim().length > 0;
    const alignment = alignmentKnown
      ? computeGenesisAlignment(soul.corePurpose, soul.genesisPromptOriginal)
      : Number.NaN;

    // Gather evidence from recent turns
    const recentTurnsData = gatherRecentEvidence(db);

    // Auto-update non-mutable sections
    let autoUpdated: string[] = [];
    const autoUpdates: Partial<SoulModel> = {};

    // Update capabilities from tool usage
    const capabilitiesSummary = summarizeCapabilities(recentTurnsData.toolsUsed);
    if (capabilitiesSummary && capabilitiesSummary !== soul.capabilities) {
      autoUpdates.capabilities = capabilitiesSummary;
      autoUpdated.push("capabilities");
    }

    // Update relationships from social interactions
    const relationshipsSummary = summarizeRelationships(recentTurnsData.interactions);
    if (relationshipsSummary && relationshipsSummary !== soul.relationships) {
      autoUpdates.relationships = relationshipsSummary;
      autoUpdated.push("relationships");
    }

    // Update financial character from transaction patterns
    const financialSummary = summarizeFinancial(recentTurnsData.financialActivity);
    if (financialSummary && financialSummary !== soul.financialCharacter) {
      autoUpdates.financialCharacter = financialSummary;
      autoUpdated.push("financialCharacter");
    }

    // Apply auto-updates if any; report only what was actually written.
    let autoUpdateErrors: string[] | undefined;
    if (autoUpdated.length > 0) {
      if (alignmentKnown) autoUpdates.genesisAlignment = alignment;
      autoUpdates.lastReflected = new Date().toISOString();
      const result = await updateSoul(db, autoUpdates, "reflection", "Auto-reflection update", soulPath);
      if (!result.success) {
        autoUpdateErrors = result.errors?.length ? result.errors : ["unknown error"];
        logger.warn(`Soul auto-update rejected (${autoUpdated.join(", ")}): ${autoUpdateErrors.join("; ")}`);
        autoUpdated = [];
      }
    }

    // Build suggestions for mutable sections (NOT auto-applied)
    const suggestedUpdates: SoulReflection["suggestedUpdates"] = [];

    if (alignmentKnown && alignment < 0.5) {
      suggestedUpdates.push({
        section: "corePurpose",
        reason: `Genesis alignment is low (${alignment.toFixed(2)}). Purpose may have drifted significantly from original genesis.`,
        suggestedContent: soul.genesisPromptOriginal,
      });
    }

    return {
      currentAlignment: alignment,
      alignmentKnown,
      suggestedUpdates,
      autoUpdated,
      ...(autoUpdateErrors ? { autoUpdateErrors } : {}),
    };
  } catch (error) {
    logger.error("reflectOnSoul failed", error instanceof Error ? error : undefined);
    return unknownAlignment();
  }
}

// ─── Evidence Gathering ─────────────────────────────────────────

interface RecentEvidence {
  toolsUsed: string[];
  interactions: string[];
  financialActivity: string[];
}

function gatherRecentEvidence(db: BetterSqlite3.Database): RecentEvidence {
  const toolsUsed: string[] = [];
  const interactions: string[] = [];
  const financialActivity: string[] = [];

  try {
    // Get recent tool calls. Calls made on inbox turns are left out: the
    // capabilities line is shown in every system prompt.
    const toolRows = db
      .prepare(
        `SELECT DISTINCT tc.name AS name FROM tool_calls tc
         JOIN turns t ON t.id = tc.turn_id
         WHERE NOT ${isolatedTurnSql("t")}
         ORDER BY tc.created_at DESC LIMIT 50`,
      )
      .all() as { name: string }[];
    for (const row of toolRows) {
      toolsUsed.push(row.name);
    }

    // Get recent social interactions: signed senders only, since an
    // unsigned address is whatever the relay reported.
    try {
      const inboxRows = db
        .prepare(
          "SELECT from_address FROM inbox_messages WHERE verified = 1 ORDER BY received_at DESC LIMIT 20",
        )
        .all() as { from_address: string }[];
      for (const row of inboxRows) {
        if (!isValidSenderAddress(row.from_address)) continue;
        if (!interactions.includes(row.from_address)) {
          interactions.push(row.from_address);
        }
      }
    } catch {
      // A database without the verified column has no signed senders.
    }

    // Get recent financial activity
    const txRows = db
      .prepare(
        "SELECT type, description FROM transactions ORDER BY created_at DESC LIMIT 20",
      )
      .all() as { type: string; description: string }[];
    for (const row of txRows) {
      financialActivity.push(`${row.type}: ${row.description}`);
    }
  } catch (error) {
    logger.error("Evidence gathering failed", error instanceof Error ? error : undefined);
  }

  return { toolsUsed, interactions, financialActivity };
}

// ─── Summary Helpers ────────────────────────────────────────────

function summarizeCapabilities(toolsUsed: string[]): string {
  if (toolsUsed.length === 0) return "";
  const unique = [...new Set(toolsUsed)];
  return `Tools used: ${unique.join(", ")}`;
}

function summarizeRelationships(interactions: string[]): string {
  if (interactions.length === 0) return "";
  return `Known contacts: ${interactions.slice(0, 10).join(", ")}`;
}

function summarizeFinancial(activity: string[]): string {
  if (activity.length === 0) return "";
  return `Recent activity: ${activity.slice(0, 5).join("; ")}`;
}
