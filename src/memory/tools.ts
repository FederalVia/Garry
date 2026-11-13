/**
 * Memory Tool Implementations
 *
 * Provides the execute functions for agent-accessible memory tools.
 * Each function operates on the database directly via memory managers.
 */

import type BetterSqlite3 from "better-sqlite3";
import { WorkingMemoryManager } from "./working.js";
import { EpisodicMemoryManager } from "./episodic.js";
import { SemanticMemoryManager } from "./semantic.js";
import { ProceduralMemoryManager } from "./procedural.js";
import { RelationshipMemoryManager } from "./relationship.js";
import type { SemanticCategory, ProceduralStep, InputSource } from "../types.js";

type Database = BetterSqlite3.Database;

const SEMANTIC_CATEGORIES: readonly SemanticCategory[] = [
  "self", "environment", "financial", "agent", "domain", "procedural_ref", "creator",
];
const MAX_FACT_KEY_CHARS = 200;
const MAX_FACT_VALUE_CHARS = 4000;
const MAX_GOAL_CHARS = 2000;
const MAX_PROCEDURE_STEPS = 50;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A non-empty string of at most `max` characters, or an error message. */
function checkText(value: unknown, name: string, max: number): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return `${name} must be a non-empty string`;
  if (value.length > max) return `${name} is ${value.length} characters (limit ${max})`;
  return null;
}

/**
 * A score argument: absent gives the default; otherwise it must parse as a
 * finite number and is clamped to [0, 1]. Words such as 'high' are refused.
 */
function parseScore(value: unknown, name: string, fallback: number): { value: number } | { error: string } {
  if (value === undefined || value === null || value === "") return { value: fallback };
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return { error: `${name} must be a number between 0 and 1, got ${JSON.stringify(value)}` };
  return { value: Math.max(0, Math.min(1, n)) };
}

/** Procedure steps from a JSON string or an array, or an error message. */
export function parseProcedureSteps(raw: unknown): { steps: ProceduralStep[] } | { error: string } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { error: `steps is not valid JSON: ${errorText(error)}` };
    }
  }
  if (!Array.isArray(value)) return { error: "steps must be a JSON array of step objects" };
  if (value.length === 0) return { error: "steps must contain at least one step" };
  if (value.length > MAX_PROCEDURE_STEPS) return { error: `steps has ${value.length} entries (limit ${MAX_PROCEDURE_STEPS})` };
  const steps: ProceduralStep[] = [];
  for (let i = 0; i < value.length; i++) {
    const step = value[i];
    if (!step || typeof step !== "object" || Array.isArray(step)) return { error: `step ${i + 1} must be an object` };
    const s = step as Record<string, unknown>;
    if (typeof s.description !== "string" || s.description.trim().length === 0) {
      return { error: `step ${i + 1} needs a string description` };
    }
    const order = typeof s.order === "number" && Number.isFinite(s.order) ? s.order : i + 1;
    steps.push({
      order,
      description: s.description,
      tool: typeof s.tool === "string" ? s.tool : null,
      argsTemplate: s.argsTemplate && typeof s.argsTemplate === "object" && !Array.isArray(s.argsTemplate)
        ? (s.argsTemplate as Record<string, string>)
        : null,
      expectedOutcome: typeof s.expectedOutcome === "string" ? s.expectedOutcome : null,
      onFailure: typeof s.onFailure === "string" ? s.onFailure : null,
    });
  }
  return { steps };
}

/**
 * Store a semantic memory (fact).
 *
 * The source comes from the turn, never from tool args. Known Facts shows
 * the creator category as the creator's word, so only a creator-sourced turn
 * may write it; any other turn (one steered by a page, a file or a tool
 * result) is refused, both for new keys and for overwriting existing ones.
 */
export function rememberFact(
  db: Database,
  args: { category: string; key: string; value: string; confidence?: number | string; source?: string },
  inputSource?: InputSource | string,
): string {
  try {
    const semantic = new SemanticMemoryManager(db);
    const fromCreator = inputSource === "creator";
    if (args.category === "creator" && !fromCreator) {
      return "Creator memories are protected: only the creator can set facts in the creator category. Use another category.";
    }
    if (!(SEMANTIC_CATEGORIES as readonly string[]).includes(args.category)) {
      return `Failed to store fact: category must be one of ${SEMANTIC_CATEGORIES.filter((c) => c !== "creator").join(", ")}`;
    }
    const bad = checkText(args.key, "key", MAX_FACT_KEY_CHARS) ?? checkText(args.value, "value", MAX_FACT_VALUE_CHARS);
    if (bad) return `Failed to store fact: ${bad}`;
    const confidence = parseScore(args.confidence, "confidence", 1.0);
    if ("error" in confidence) return `Failed to store fact: ${confidence.error}`;
    const id = semantic.store({
      category: args.category as SemanticCategory,
      key: args.key,
      value: args.value,
      confidence: confidence.value,
      source: fromCreator ? "creator" : "agent",
    });
    return `Fact stored: [${args.category}/${args.key}] = ${args.value} (id: ${id})`;
  } catch (error) {
    return `Failed to store fact: ${errorText(error)}`;
  }
}

/**
 * Search semantic memory by category and/or query.
 */
export function recallFacts(
  db: Database,
  args: { category?: string; query?: string },
): string {
  try {
    const semantic = new SemanticMemoryManager(db);

    if (args.query) {
      const results = semantic.search(args.query, args.category as SemanticCategory | undefined);
      if (results.length === 0) return "No matching facts found.";
      return results
        .map((r) => `[${r.category}/${r.key}] = ${r.value} (confidence: ${r.confidence})`)
        .join("\n");
    }

    if (args.category) {
      const results = semantic.getByCategory(args.category as SemanticCategory);
      if (results.length === 0) return `No facts in category: ${args.category}`;
      return results
        .map((r) => `[${r.key}] = ${r.value} (confidence: ${r.confidence})`)
        .join("\n");
    }

    return "Please provide a category or query to search.";
  } catch (error) {
    return `Failed to recall facts: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * Create or update a working memory goal.
 */
export function setGoal(
  db: Database,
  args: { sessionId: string; content: string; priority?: number | string },
): string {
  try {
    const bad = checkText(args.content, "content", MAX_GOAL_CHARS);
    if (bad) return `Failed to set goal: ${bad}`;
    const priority = parseScore(args.priority, "priority", 0.8);
    if ("error" in priority) return `Failed to set goal: ${priority.error}`;
    const working = new WorkingMemoryManager(db);
    const id = working.add({
      sessionId: args.sessionId,
      content: args.content,
      contentType: "goal",
      priority: priority.value,
    });
    return `Goal set: "${args.content}" (id: ${id}, priority: ${priority.value})`;
  } catch (error) {
    return `Failed to set goal: ${errorText(error)}`;
  }
}

/**
 * Mark a goal as completed and archive to episodic memory.
 */
export function completeGoal(
  db: Database,
  args: { goalId: string; sessionId: string; outcome?: string },
): string {
  try {
    const working = new WorkingMemoryManager(db);
    const episodic = new EpisodicMemoryManager(db);

    // Get goal content before deleting
    const entries = working.getBySession(args.sessionId);
    const goal = entries.find((e) => e.id === args.goalId);

    if (!goal) {
      return `Goal not found: ${args.goalId}`;
    }

    // Archive to episodic
    episodic.record({
      sessionId: args.sessionId,
      eventType: "goal_completed",
      summary: `Goal completed: ${goal.content}`,
      detail: args.outcome ?? null,
      outcome: "success",
      importance: goal.priority,
      classification: "productive",
    });

    // Remove from working memory
    working.delete(args.goalId);

    return `Goal completed and archived: "${goal.content}"`;
  } catch (error) {
    return `Failed to complete goal: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * Store a learned procedure.
 */
export function saveProcedure(
  db: Database,
  args: { name: string; description: string; steps: ProceduralStep[] | string | unknown },
): string {
  try {
    const bad = checkText(args.name, "name", MAX_FACT_KEY_CHARS) ?? checkText(args.description, "description", MAX_FACT_VALUE_CHARS);
    if (bad) return `Failed to save procedure: ${bad}`;
    const parsed = parseProcedureSteps(args.steps);
    if ("error" in parsed) return `Failed to save procedure: ${parsed.error}`;
    const procedural = new ProceduralMemoryManager(db);
    const id = procedural.save({
      name: args.name,
      description: args.description,
      steps: parsed.steps,
    });
    return `Procedure saved: "${args.name}" with ${parsed.steps.length} step(s) (id: ${id})`;
  } catch (error) {
    return `Failed to save procedure: ${errorText(error)}`;
  }
}

/**
 * Retrieve a stored procedure by name or search query.
 */
export function recallProcedure(
  db: Database,
  args: { name?: string; query?: string },
): string {
  try {
    const procedural = new ProceduralMemoryManager(db);

    if (args.name) {
      const proc = procedural.get(args.name);
      if (!proc) return `Procedure not found: ${args.name}`;
      const stepsStr = proc.steps
        .map((s) => `  ${s.order}. ${s.description}${s.tool ? ` [tool: ${s.tool}]` : ""}`)
        .join("\n");
      return `Procedure: ${proc.name}\nDescription: ${proc.description}\nSuccess: ${proc.successCount}, Failure: ${proc.failureCount}\nSteps:\n${stepsStr}`;
    }

    if (args.query) {
      const results = procedural.search(args.query);
      if (results.length === 0) return "No matching procedures found.";
      return results
        .map((r) => `${r.name}: ${r.description} (${r.steps.length} steps, ${r.successCount}/${r.successCount + r.failureCount} success)`)
        .join("\n");
    }

    return "Please provide a name or query to search.";
  } catch (error) {
    return `Failed to recall procedure: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * Record a note about another agent/entity.
 */
export function noteAboutAgent(
  db: Database,
  args: { entityAddress: string; entityName?: string; relationshipType: string; notes?: string; trustScore?: number | string },
): string {
  try {
    const bad = checkText(args.entityAddress, "entity_address", MAX_FACT_KEY_CHARS)
      ?? checkText(args.relationshipType, "relationship_type", MAX_FACT_KEY_CHARS);
    if (bad) return `Failed to note about agent: ${bad}`;
    if (args.entityName != null && typeof args.entityName !== "string") {
      return "Failed to note about agent: entity_name must be a string";
    }
    if (args.notes != null && (typeof args.notes !== "string" || args.notes.length > MAX_FACT_VALUE_CHARS)) {
      return `Failed to note about agent: notes must be a string of at most ${MAX_FACT_VALUE_CHARS} characters`;
    }
    const trust = parseScore(args.trustScore, "trust_score", 0.5);
    if ("error" in trust) return `Failed to note about agent: ${trust.error}`;
    const rel = new RelationshipMemoryManager(db);
    const id = rel.record({
      entityAddress: args.entityAddress,
      entityName: args.entityName ?? null,
      relationshipType: args.relationshipType,
      trustScore: trust.value,
      notes: args.notes ?? null,
    });
    return `Relationship noted: ${args.entityAddress} (${args.relationshipType}, trust: ${trust.value}, id: ${id})`;
  } catch (error) {
    return `Failed to note about agent: ${errorText(error)}`;
  }
}

/**
 * Review current working memory and recent episodic memory.
 */
export function reviewMemory(
  db: Database,
  args: { sessionId: string },
): string {
  try {
    const working = new WorkingMemoryManager(db);
    const episodic = new EpisodicMemoryManager(db);

    const workingEntries = working.getBySession(args.sessionId);
    const recentEpisodic = episodic.getRecent(args.sessionId, 5);

    const sections: string[] = [];

    if (workingEntries.length > 0) {
      sections.push("=== Working Memory ===");
      for (const e of workingEntries) {
        sections.push(`[${e.contentType}] (p=${e.priority}) ${e.content} [id: ${e.id}]`);
      }
    } else {
      sections.push("=== Working Memory ===\n(empty)");
    }

    if (recentEpisodic.length > 0) {
      sections.push("\n=== Recent History ===");
      for (const e of recentEpisodic) {
        sections.push(`[${e.eventType}] ${e.summary} (${e.outcome || "no outcome"}, ${e.classification})`);
      }
    } else {
      sections.push("\n=== Recent History ===\n(no recent events)");
    }

    return sections.join("\n");
  } catch (error) {
    return `Failed to review memory: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * Forget (remove) a memory entry by id and type.
 * Does not allow removing entries that contain creator-level data.
 */
export function forget(
  db: Database,
  args: { id: string; memoryType: string },
): string {
  try {
    const typeToTable: Record<string, string> = {
      working: "working_memory",
      episodic: "episodic_memory",
      semantic: "semantic_memory",
      procedural: "procedural_memory",
      relationship: "relationship_memory",
    };

    const table = typeToTable[args.memoryType];
    if (!table) {
      return `Unknown memory type: ${args.memoryType}. Use: working, episodic, semantic, procedural, relationship.`;
    }

    // Check for creator-protected entries (semantic category "creator")
    if (args.memoryType === "semantic") {
      const row = db.prepare(
        "SELECT category FROM semantic_memory WHERE id = ?",
      ).get(args.id) as { category: string } | undefined;
      if (row?.category === "creator") {
        return "Cannot forget creator-level memories. These are protected.";
      }
    }

    const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(args.id);
    if (result.changes === 0) {
      return `Memory entry not found: ${args.id}`;
    }
    return `Memory entry forgotten: ${args.id} (${args.memoryType})`;
  } catch (error) {
    return `Failed to forget: ${error instanceof Error ? error.message : error}`;
  }
}
