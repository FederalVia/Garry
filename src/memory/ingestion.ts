/**
 * Memory Ingestion Pipeline
 *
 * Post-turn pipeline that automatically extracts and stores memories.
 * Classifies turns, generates summaries, extracts facts,
 * updates relationships, and manages working memory.
 *
 * All operations are wrapped in try/catch: ingestion failures
 * must never block the agent loop.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AgentTurn, ToolCallResult } from "../types.js";
import { WorkingMemoryManager } from "./working.js";
import { EpisodicMemoryManager } from "./episodic.js";
import { SemanticMemoryManager } from "./semantic.js";
import { RelationshipMemoryManager } from "./relationship.js";
import { classifyTurn } from "./types.js";
import { EventStream, estimateTokens } from "./event-stream.js";
import {
  KnowledgeStore,
  type KnowledgeCategory,
  type KnowledgeEntry,
} from "./knowledge-store.js";
import { createLogger } from "../observability/logger.js";
import { isIsolatedTurn, normalizeSenderAddress } from "../agent/inbox-isolation.js";
const logger = createLogger("memory.ingestion");

type Database = BetterSqlite3.Database;

// ─── Error Normalization ────────────────────────────────────────

const ERROR_PATTERNS: [RegExp, string][] = [
  [/path.traversal/i, "PATH_TRAVERSAL"],
  [/permission.denied|access.denied|forbidden/i, "PERMISSION_DENIED"],
  [/timeout|timed?\s*out/i, "TIMEOUT"],
  [/not.found|no.such|does.not.exist|enoent/i, "NOT_FOUND"],
  [/rate.limit|too.many.requests|429/i, "RATE_LIMIT"],
  [/eaddrinuse|address.already.in.use/i, "ADDRESS_IN_USE"],
  [/econnrefused|connection.refused/i, "CONNECTION_REFUSED"],
  [/out.of.memory|oom|enomem/i, "OUT_OF_MEMORY"],
  [/syntax.error|parse.error|unexpected.token/i, "SYNTAX_ERROR"],
  [/policy|blocked|denied.by.policy/i, "POLICY_BLOCKED"],
];

/**
 * Normalize a tool error string into a short, consistent type label.
 * Matches known patterns first, then falls back to a sanitized prefix.
 */
export function normalizeErrorType(error: string): string {
  for (const [pattern, label] of ERROR_PATTERNS) {
    if (pattern.test(error)) return label;
  }
  // Fallback: first 50 chars, alphanumeric + underscores only
  return error
    .slice(0, 50)
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase() || "UNKNOWN";
}

export interface MarketSignal {
  type: string;
  signal: string;
  source: string;
  confidence: number;
  extractedAt: string;
}

export interface ExtractedFact {
  category: KnowledgeCategory;
  key: string;
  value: string;
  source: string;
  confidence: number;
}

export interface Contradiction {
  existingEntry: KnowledgeEntry;
  newFact: ExtractedFact;
  description: string;
}

/** Only this much of each tool result is scanned for market signals. */
const MAX_SIGNAL_SCAN_CHARS = 20_000;
const MAX_SIGNALS_PER_TOOL_CALL = 20;
const MAX_SIGNALS_PER_TURN = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Auto-generated working-memory rows (sleep notes, self-mod decisions). */
const AUTO_WORKING_ROW_TTL_MS = DAY_MS;
// Line prefixes that say nothing about what a fact is about.
const GENERIC_KEY_PREFIXES = new Set([
  "stdout", "stderr", "output", "result", "error", "warning", "info", "note",
  "http", "https", "line", "data",
]);

/** Below the 0.3 threshold that memory retrieval uses for trusted entities. */
const INBOX_SENDER_TRUST = 0.2;

/** A sender of an inbox batch, from the inbox rows (never from message text). */
export interface InboxSender {
  address: string;
  /** Whether the sender's signature was checked at ingest. */
  verified: boolean;
}

export class MemoryIngestionPipeline {
  private working: WorkingMemoryManager;
  private episodic: EpisodicMemoryManager;
  private semantic: SemanticMemoryManager;
  private relationships: RelationshipMemoryManager;
  private knowledgeStore: KnowledgeStore;
  private eventStream: EventStream;
  private enhancementsChecked = false;
  private hasKnowledgeStoreTable = false;
  private hasEventStreamTable = false;

  constructor(private db: Database) {
    this.working = new WorkingMemoryManager(db);
    this.episodic = new EpisodicMemoryManager(db);
    this.semantic = new SemanticMemoryManager(db);
    this.relationships = new RelationshipMemoryManager(db);
    this.knowledgeStore = new KnowledgeStore(db);
    this.eventStream = new EventStream(db);
  }

  /**
   * Ingest a completed turn into the memory system.
   * Never throws -- all errors are caught and logged.
   */
  ingest(
    sessionId: string,
    turn: AgentTurn,
    toolCallResults: ToolCallResult[],
    options?: { inboxSenders?: InboxSender[] },
  ): void {
    try {
      // An inbox turn read untrusted text, so its thinking, tool arguments and
      // tool results are not stored anywhere a later turn reads. Only the
      // senders, taken from the inbox rows rather than the text, are recorded.
      if (isIsolatedTurn(turn)) {
        this.recordInboxSenders(options?.inboxSenders ?? []);
        return;
      }

      const classification = classifyTurn(toolCallResults, turn.thinking);

      // 1. Record episodic memory for the turn
      this.recordEpisodic(sessionId, turn, toolCallResults, classification);

      // 2. Extract semantic facts from tool results
      this.extractSemanticFacts(sessionId, turn, toolCallResults);

      // 3. Update relationship memory from inbox interactions
      this.updateRelationships(sessionId, turn, toolCallResults);

      // 4. Update working memory (goals, tasks)
      this.updateWorkingMemory(sessionId, turn, toolCallResults);

      // 5. Drop expired rows, then prune working memory if over limit
      this.working.clearExpired();
      this.working.prune(sessionId, 20);

      // 6. Enhanced ingestion: market signals + knowledge updates
      this.ingestKnowledgeEnhancements(sessionId, toolCallResults);
    } catch (error) {
      logger.error("Ingestion failed", error instanceof Error ? error : undefined);
      // Never throw -- memory failure must not block the agent loop
    }
  }

  /**
   * Market signals from this turn's tool results. Bounded: only the first
   * MAX_SIGNAL_SCAN_CHARS of each result are read, and at most
   * MAX_SIGNALS_PER_TOOL_CALL per call and MAX_SIGNALS_PER_TURN in all are
   * kept, so one huge result cannot make ingestion slow.
   */
  extractMarketSignals(toolCalls: ToolCallResult[]): MarketSignal[] {
    const extractedAt = new Date().toISOString();
    const signals: MarketSignal[] = [];
    const seen = new Set<string>();

    for (const tc of toolCalls) {
      if (signals.length >= MAX_SIGNALS_PER_TURN) break;
      if (tc.error || !tc.result) continue;
      const scanned: ToolCallResult = tc.result.length > MAX_SIGNAL_SCAN_CHARS
        ? { ...tc, result: tc.result.slice(0, MAX_SIGNAL_SCAN_CHARS) }
        : tc;
      if (!this.isMarketSource(scanned)) continue;

      const source = this.resolveSource(scanned);
      const recency = this.resolveRecency(scanned);
      const fragments = this.splitSignalCandidates(scanned.result);
      let fromThisCall = 0;

      fragmentLoop:
      for (const fragment of fragments) {
        const signalTypes = this.classifySignalTypes(fragment);
        if (signalTypes.length === 0) continue;

        for (const type of signalTypes) {
          if (fromThisCall >= MAX_SIGNALS_PER_TOOL_CALL || signals.length >= MAX_SIGNALS_PER_TURN) {
            break fragmentLoop;
          }
          const signalText = fragment.length > 240
            ? `${fragment.slice(0, 237)}...`
            : fragment;
          const dedupeKey = `${type}|${source}|${signalText.toLowerCase()}`;
          if (seen.has(dedupeKey)) continue;

          seen.add(dedupeKey);
          fromThisCall++;
          signals.push({
            type,
            signal: signalText,
            source,
            confidence: this.scoreConfidence(source, recency),
            extractedAt,
          });
        }
      }
    }

    return signals;
  }

  /**
   * Store facts in order, so a later fact in the batch sees an earlier one.
   * Returns the facts that were stored or refreshed.
   */
  updateKnowledgeStore(
    knowledgeStore: KnowledgeStore,
    facts: ExtractedFact[],
    sessionId: string = "default",
  ): ExtractedFact[] {
    const now = new Date().toISOString();
    const applied: ExtractedFact[] = [];
    for (const fact of facts) {
      if (this.applyFact(knowledgeStore, fact, now, sessionId)) applied.push(fact);
    }
    return applied;
  }

  /**
   * One fact against the stored entry with the same category and key (one
   * indexed lookup): a new key is inserted; the same value is refreshed; a
   * different value with equal or higher confidence (or over an expired
   * entry) replaces the old one and logs one 'knowledge' event; a
   * lower-confidence value is dropped. Returns whether anything was written.
   */
  private applyFact(store: KnowledgeStore, fact: ExtractedFact, now: string, sessionId: string): boolean {
    if (!fact.key.trim() || !fact.value.trim()) return false;
    if (!(fact.confidence >= 0.5)) return false;

    const key = this.normalizeKey(fact.key);
    const existing = store.getByKey(fact.category, key);
    if (!existing) {
      store.add({
        category: fact.category,
        key,
        content: fact.value,
        source: fact.source,
        confidence: fact.confidence,
        lastVerified: now,
        tokenCount: estimateTokens(fact.value),
        expiresAt: this.factExpiry(fact.confidence),
      });
      return true;
    }

    if (this.normalizeValue(existing.content) === this.normalizeValue(fact.value)) {
      const confidence = Math.max(existing.confidence, fact.confidence);
      store.update(existing.id, {
        content: fact.value,
        source: fact.source,
        confidence,
        lastVerified: now,
        tokenCount: estimateTokens(fact.value),
        expiresAt: this.factExpiry(confidence),
      });
      return true;
    }

    const expired = existing.expiresAt !== null && Date.parse(existing.expiresAt) < Date.now();
    if (!expired && fact.confidence < existing.confidence) return false;

    store.update(existing.id, {
      content: fact.value,
      source: fact.source,
      confidence: fact.confidence,
      lastVerified: now,
      tokenCount: estimateTokens(fact.value),
      expiresAt: this.factExpiry(fact.confidence),
    });
    this.emitKnowledgeUpdate(sessionId, key, existing.content, fact.value);
    return true;
  }

  /** Every ingested fact expires: 30 days below 0.7 confidence, else 90. */
  private factExpiry(confidence: number): string {
    const days = confidence < 0.7 ? 30 : 90;
    return new Date(Date.now() + days * DAY_MS).toISOString();
  }

  detectContradictions(newFact: ExtractedFact, existing: KnowledgeEntry[]): Contradiction[] {
    const contradictions: Contradiction[] = [];
    const newFactKey = this.normalizeKey(newFact.key);
    const newFactValue = this.normalizeValue(newFact.value);

    for (const entry of existing) {
      if (this.normalizeKey(entry.key) !== newFactKey) continue;
      if (this.normalizeValue(entry.content) === newFactValue) continue;

      contradictions.push({
        existingEntry: entry,
        newFact,
        description:
          `Conflicting values for "${newFact.key}": ` +
          `"${entry.content}" (existing, ${entry.source}) vs "${newFact.value}" (new, ${newFact.source})`,
      });
    }

    return contradictions;
  }

  scoreConfidence(source: string, recency: string): number {
    const sourceLower = source.toLowerCase();
    let sourceScore = 0.55;

    if (
      /official|docs|documentation|registry|conway|api|github\.com|wikipedia|\.gov\b|\.edu\b/.test(
        sourceLower,
      )
    ) {
      sourceScore = 0.9;
    } else if (/search|discover|domain|web|market|news|report/.test(sourceLower)) {
      sourceScore = 0.72;
    } else if (/social|reddit|forum|x\.com|twitter/.test(sourceLower)) {
      sourceScore = 0.45;
    } else if (/exec|shell|unknown/.test(sourceLower)) {
      sourceScore = 0.35;
    }

    const recencyScore = this.scoreRecency(recency);
    const weighted = (sourceScore * 0.65) + (recencyScore * 0.35);
    return Math.max(0, Math.min(1, Number(weighted.toFixed(2))));
  }

  private ingestKnowledgeEnhancements(
    sessionId: string,
    toolCallResults: ToolCallResult[],
  ): void {
    try {
      this.ensureEnhancementTableState();
      if (!this.hasKnowledgeStoreTable) return;

      const marketSignals = this.extractMarketSignals(toolCallResults);
      if (marketSignals.length === 0) return;

      // One transaction for the whole turn; expired rows are removed by the
      // memory_maintenance heartbeat task, not here.
      this.db.transaction(() => {
        const now = new Date().toISOString();
        const kept: MarketSignal[] = [];
        for (const signal of marketSignals) {
          if (this.applyFact(this.knowledgeStore, this.toExtractedFact(signal), now, sessionId)) {
            kept.push(signal);
          }
        }
        this.emitMarketSignals(sessionId, kept);
      })();
    } catch (error) {
      logger.error("Enhanced ingestion failed", error instanceof Error ? error : undefined);
    }
  }

  private toExtractedFact(signal: MarketSignal): ExtractedFact {
    const category: KnowledgeCategory = signal.type === "pricing" ? "financial" : "market";

    return {
      category,
      key: this.buildFactKey(signal),
      value: signal.signal,
      source: signal.source,
      confidence: signal.confidence,
    };
  }

  private buildFactKey(signal: MarketSignal): string {
    const prefixMatch = signal.signal.match(/^([a-z0-9._-]{2,64})\s*:/i);
    if (prefixMatch && !GENERIC_KEY_PREFIXES.has(prefixMatch[1].toLowerCase())) {
      return `${signal.type}:${prefixMatch[1].toLowerCase()}`;
    }

    const domainMatch = signal.signal.match(/\b([a-z0-9-]+\.[a-z]{2,})\b/i);
    if (domainMatch) {
      return `${signal.type}:${domainMatch[1].toLowerCase()}`;
    }

    // A generic first word would make unrelated facts collide, so the
    // source is part of the key.
    const keyword = signal.signal
      .toLowerCase()
      .match(/\b[a-z][a-z0-9_-]{2,32}\b/g)
      ?.find((word) => !GENERIC_KEY_PREFIXES.has(word));
    return `${signal.type}:${signal.source.toLowerCase().slice(0, 64)}:${keyword || "general"}`;
  }

  private emitMarketSignals(sessionId: string, marketSignals: MarketSignal[]): void {
    if (!this.hasEventStreamTable) return;

    for (const signal of marketSignals) {
      try {
        this.eventStream.append({
          type: "market_signal",
          agentAddress: sessionId,
          goalId: null,
          taskId: null,
          content: `${signal.type} | ${signal.source} | ${signal.signal}`,
          tokenCount: estimateTokens(signal.signal),
          compactedTo: null,
        });
      } catch (error) {
        logger.error("Market signal event append failed", error instanceof Error ? error : undefined);
      }
    }
  }

  private emitKnowledgeUpdate(sessionId: string, key: string, oldValue: string, newValue: string): void {
    if (!this.hasEventStreamTable) return;
    const clip = (v: string) => (v.length > 120 ? `${v.slice(0, 117)}...` : v);
    const content = `updated: ${key}: "${clip(oldValue)}" -> "${clip(newValue)}"`;
    try {
      this.eventStream.append({
        type: "knowledge",
        agentAddress: sessionId,
        goalId: null,
        taskId: null,
        content,
        tokenCount: estimateTokens(content),
        compactedTo: null,
      });
    } catch (error) {
      logger.error("Knowledge update event append failed", error instanceof Error ? error : undefined);
    }
  }

  private isMarketSource(tc: ToolCallResult): boolean {
    const toolName = tc.name.toLowerCase();
    if (/search|discover|fetch|domain|market|price|api/.test(toolName)) {
      return true;
    }

    if (typeof tc.arguments.url === "string" || typeof tc.arguments.endpoint === "string") {
      return true;
    }

    return /\$[\d,.]+|\b(usd|usdc|price|pricing|demand|competitor|alternative|rival)\b/i.test(tc.result);
  }

  private resolveSource(tc: ToolCallResult): string {
    const candidate = tc.arguments.url
      || tc.arguments.endpoint
      || tc.arguments.domain
      || tc.arguments.query;

    if (typeof candidate === "string" && candidate.trim()) {
      const trimmed = candidate.trim();
      try {
        const parsed = new URL(trimmed);
        return parsed.hostname;
      } catch {
        return trimmed.toLowerCase();
      }
    }

    return tc.name;
  }

  private resolveRecency(tc: ToolCallResult): string {
    const rawRecency = tc.arguments.date
      || tc.arguments.timestamp
      || tc.arguments.as_of
      || tc.arguments.since
      || tc.arguments.updated_at
      || tc.arguments.published_at;

    if (typeof rawRecency === "string" && rawRecency.trim()) {
      return rawRecency;
    }

    const resultDate = tc.result.match(/\b(20\d{2}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]*)?)\b/);
    if (resultDate?.[1]) {
      return resultDate[1];
    }

    if (/\byesterday\b/i.test(tc.result)) return "yesterday";
    if (/\btoday\b/i.test(tc.result)) return "today";

    return new Date().toISOString();
  }

  private splitSignalCandidates(result: string): string[] {
    const normalized = result.replace(/\r/g, "").trim();
    if (!normalized) return [];

    const lineSplit = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lineSplit.length > 1) return lineSplit;

    return normalized
      .split(/(?<=[.!?])\s+/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  private classifySignalTypes(fragment: string): string[] {
    const types: string[] = [];
    const lower = fragment.toLowerCase();

    if (
      /\$[\d,.]+|\b\d+(?:\.\d+)?\s*(?:usd|usdc|cents)\b|\((?:\$\d+(?:\.\d{1,2})?\/yr)\)/i.test(
        fragment,
      ) ||
      /\b(price|pricing|cost|fee|subscription|rate|revenue)\b/.test(lower)
    ) {
      types.push("pricing");
    }

    if (
      /\b(demand|trend|trending|growth|growing|volume|traffic|adoption|users?|waitlist|backlog|orders?)\b/.test(
        lower,
      )
    ) {
      types.push("demand");
    }

    if (
      /\b(competitor|competitors|rival|rivals|alternative|alternatives|vs\.?|market leader)\b/.test(
        lower,
      )
    ) {
      types.push("competitor");
    }

    return types;
  }

  private scoreRecency(recency: string): number {
    const normalized = recency.trim().toLowerCase();
    if (!normalized) return 0.5;
    if (normalized.includes("today") || normalized.includes("just now")) return 1;
    if (normalized.includes("yesterday")) return 0.95;

    const relativeMatch = normalized.match(
      /(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/,
    );
    if (relativeMatch) {
      const amount = Number(relativeMatch[1]);
      const unit = relativeMatch[2];
      const days = unit === "minute"
        ? amount / 1440
        : unit === "hour"
          ? amount / 24
          : unit === "day"
            ? amount
            : unit === "week"
              ? amount * 7
              : unit === "month"
                ? amount * 30
                : amount * 365;
      return this.daysToRecencyScore(days);
    }

    const parsed = Date.parse(recency);
    if (!Number.isNaN(parsed)) {
      const now = Date.now();
      const ageMs = Math.max(0, now - parsed);
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      return this.daysToRecencyScore(ageDays);
    }

    return 0.45;
  }

  private daysToRecencyScore(ageDays: number): number {
    if (ageDays <= 1) return 1;
    if (ageDays <= 7) return 0.9;
    if (ageDays <= 30) return 0.78;
    if (ageDays <= 90) return 0.62;
    if (ageDays <= 365) return 0.48;
    return 0.3;
  }

  private normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/\s+/g, "_");
  }

  private normalizeValue(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private ensureEnhancementTableState(): void {
    if (this.enhancementsChecked) return;

    const knowledgeRow = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("knowledge_store") as { ok?: number } | undefined;
    this.hasKnowledgeStoreTable = Boolean(knowledgeRow?.ok);

    const eventRow = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("event_stream") as { ok?: number } | undefined;
    this.hasEventStreamTable = Boolean(eventRow?.ok);

    this.enhancementsChecked = true;
  }

  private recordEpisodic(
    sessionId: string,
    turn: AgentTurn,
    toolCallResults: ToolCallResult[],
    classification: string,
  ): void {
    try {
      const toolNames = toolCallResults.map((tc) => tc.name).join(", ");
      const hasErrors = toolCallResults.some((tc) => tc.error);
      const summary = this.generateTurnSummary(turn, toolCallResults);

      const outcome = hasErrors
        ? "failure" as const
        : toolCallResults.length > 0
          ? "success" as const
          : "neutral" as const;

      // Importance based on classification
      const importanceMap: Record<string, number> = {
        strategic: 0.9,
        productive: 0.7,
        communication: 0.6,
        maintenance: 0.3,
        idle: 0.1,
        error: 0.8,
      };

      this.episodic.record({
        sessionId,
        eventType: toolCallResults.length > 0 ? `tool:${toolNames.split(",")[0]?.trim() || "unknown"}` : "thinking",
        summary,
        detail: turn.thinking.length > 200 ? turn.thinking.slice(0, 500) : null,
        outcome,
        importance: importanceMap[classification] ?? 0.5,
        classification: classification as any,
      });
    } catch (error) {
      logger.error("Episodic recording failed", error instanceof Error ? error : undefined);
    }
  }

  private generateTurnSummary(turn: AgentTurn, toolCallResults: ToolCallResult[]): string {
    const parts: string[] = [];

    if (toolCallResults.length > 0) {
      const toolSummaries = toolCallResults.map((tc) => {
        const status = tc.error ? "FAILED" : "ok";
        return `${tc.name}(${status})`;
      });
      parts.push(`Tools: ${toolSummaries.join(", ")}`);
    }

    if (turn.thinking) {
      parts.push(turn.thinking.slice(0, 150));
    }

    return parts.join(" | ") || "No activity";
  }

  private extractSemanticFacts(
    sessionId: string,
    turn: AgentTurn,
    toolCallResults: ToolCallResult[],
  ): void {
    try {
      for (const tc of toolCallResults) {
        // Learn from errors instead of ignoring them
        if (tc.error) {
          try {
            const errorType = normalizeErrorType(tc.error);
            const key = `tool_error:${tc.name}:${errorType}`;

            // Check for existing entry to track repetition count
            const existing = this.semantic.get("environment", key);
            let count = 1;
            if (existing) {
              const countMatch = existing.value.match(/\((\d+)x\)/);
              count = countMatch ? parseInt(countMatch[1], 10) + 1 : 2;
            }

            const truncatedError = tc.error.length > 200 ? tc.error.slice(0, 200) + "..." : tc.error;
            this.semantic.store({
              category: "environment",
              key,
              value: `${tc.name} fails with ${errorType} (${count}x) — last: ${truncatedError}`,
              confidence: Math.min(1.0, 0.5 + count * 0.1),
              source: sessionId,
            });
          } catch (errLearn) {
            logger.error("Error learning failed", errLearn instanceof Error ? errLearn : undefined);
          }
          continue;
        }

        // Extract facts from specific tool results
        if (tc.name === "check_credits" && tc.result) {
          this.semantic.store({
            category: "financial",
            key: "last_known_balance",
            value: tc.result,
            confidence: 1.0,
            source: sessionId,
          });
        }

        if (tc.name === "system_synopsis" && tc.result) {
          this.semantic.store({
            category: "self",
            key: "system_synopsis",
            value: tc.result.slice(0, 500),
            confidence: 1.0,
            source: sessionId,
          });
        }

        if (tc.name === "check_usdc_balance" && tc.result) {
          this.semantic.store({
            category: "financial",
            key: "usdc_balance",
            value: tc.result,
            confidence: 1.0,
            source: sessionId,
          });
        }

        if (tc.name === "discover_agents" && tc.result) {
          // Card names and descriptions come from attacker-hosted URIs; only
          // the on-chain ids and owners are kept.
          const summary = summarizeDiscoveredAgents(tc.result);
          if (summary) {
            this.semantic.store({
              category: "environment",
              key: "known_agents",
              value: summary,
              confidence: 0.8,
              source: sessionId,
            });
          }
        }
      }
    } catch (error) {
      logger.error("Semantic extraction failed", error instanceof Error ? error : undefined);
    }
  }

  private updateRelationships(
    sessionId: string,
    turn: AgentTurn,
    toolCallResults: ToolCallResult[],
  ): void {
    try {
      // Track outbound message interactions
      for (const tc of toolCallResults) {
        if (tc.error) continue;

        if (tc.name === "send_message") {
          const toAddress = tc.arguments.to_address as string | undefined;
          if (toAddress) {
            const existing = this.relationships.get(toAddress);
            if (existing) {
              this.relationships.recordInteraction(toAddress);
            } else {
              this.relationships.record({
                entityAddress: toAddress,
                relationshipType: "contacted",
                trustScore: 0.5,
              });
            }
          }
        }
      }

    } catch (error) {
      logger.error("Relationship update failed", error instanceof Error ? error : undefined);
    }
  }

  /**
   * Record each distinct, well-formed, verified sender of an inbox batch.
   * An unsigned sender's address is only what the relay reported, so it
   * earns no relationship record or interaction count.
   */
  private recordInboxSenders(senders: InboxSender[]): void {
    try {
      const seen = new Set<string>();
      for (const sender of senders) {
        if (!sender || sender.verified !== true) continue;
        const key = normalizeSenderAddress(sender.address);
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = this.relationships.get(sender.address);
        if (existing) {
          this.relationships.recordInteraction(sender.address);
        } else {
          this.relationships.record({
            entityAddress: sender.address,
            relationshipType: "messaged_us",
            trustScore: INBOX_SENDER_TRUST,
          });
        }
      }
    } catch (error) {
      logger.error("Relationship update failed", error instanceof Error ? error : undefined);
    }
  }

  private updateWorkingMemory(
    sessionId: string,
    turn: AgentTurn,
    toolCallResults: ToolCallResult[],
  ): void {
    try {
      for (const tc of toolCallResults) {
        if (tc.error) continue;

        // Track sleep as an observation
        if (tc.name === "sleep") {
          this.working.add({
            sessionId,
            content: `Agent chose to sleep: ${(tc.result || "").slice(0, 200)}`,
            contentType: "observation",
            priority: 0.3,
            expiresAt: new Date(Date.now() + AUTO_WORKING_ROW_TTL_MS).toISOString(),
            sourceTurn: turn.id,
          });
        }

        // Track strategic decisions
        if (tc.name === "edit_own_file" || tc.name === "update_genesis_prompt") {
          this.working.add({
            sessionId,
            content: `Self-modification: ${tc.name} - ${(tc.result || "").slice(0, 200)}`,
            contentType: "decision",
            priority: 0.9,
            expiresAt: new Date(Date.now() + AUTO_WORKING_ROW_TTL_MS).toISOString(),
            sourceTurn: turn.id,
          });
        }
      }
    } catch (error) {
      logger.error("Working memory update failed", error instanceof Error ? error : undefined);
    }
  }
}

const MAX_SUMMARIZED_AGENTS = 20;

/**
 * "<n> agents: #id owner, ..." from a discover_agents result (its JSON or
 * text format). Only digit ids and well-formed owner addresses are kept, so
 * no card text reaches stored memory. Null when nothing parses.
 */
export function summarizeDiscoveredAgents(result: string): string | null {
  const agents: Array<{ id: string; owner: string }> = [];
  const add = (id: unknown, owner: unknown): void => {
    const idStr = typeof id === "number" ? String(id) : id;
    if (typeof idStr !== "string" || !/^\d{1,30}$/.test(idStr)) return;
    const normalized = normalizeSenderAddress(owner);
    if (!normalized) return;
    agents.push({ id: idStr, owner: normalized });
  };
  const trimmed = result.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) for (const a of parsed) add(a?.agentId, a?.owner);
    } catch {
      // Not JSON after all; fall through to the text format.
    }
  }
  if (agents.length === 0) {
    // Text format: "#<id> (<owner>) <name>: <description>" per line. Only
    // the prefix is read; card text follows it and cannot move it.
    for (const line of trimmed.split("\n")) {
      const m = /^#(\d{1,30}) \((0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\) /.exec(line);
      if (m) add(m[1], m[2]);
    }
  }
  if (agents.length === 0) return null;
  const shown = agents.slice(0, MAX_SUMMARIZED_AGENTS).map((a) => `#${a.id} ${a.owner}`);
  const more = agents.length > shown.length ? `, +${agents.length - shown.length} more` : "";
  return `${agents.length} agents: ${shown.join(", ")}${more}`;
}
