/**
 * Agent Context Aggregator
 *
 * Prevents parent-context explosion by triaging and aggregating child updates.
 */

export interface AgentStatusUpdate {
  agentAddress: string;
  department?: string;
  role?: string;
  status?: string;
  kind?: string;
  message?: string;
  taskId?: string;
  error?: string;
  blocked?: boolean;
  financialAmount?: number;
  dailyBudget?: number;
  budgetImpactPercent?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AggregatedSummaryEntry {
  group: string;
  count: number;
  completed: number;
  progress: number;
  other: number;
  highlight: string | null;
}

export interface AggregatedUpdate {
  summary: string;
  fullUpdates: AgentStatusUpdate[];
  summaryEntries: AggregatedSummaryEntry[];
  heartbeatCount: number;
  triageCounts: {
    full: number;
    summary: number;
    count: number;
  };
  estimatedTokens: number;
}

interface GroupAccumulator {
  count: number;
  completed: number;
  progress: number;
  other: number;
  highlights: string[];
}

const HEARTBEAT_PATTERNS = ["heartbeat", "alive", "ping", "health", "healthy"];
const ERROR_PATTERNS = ["error", "failed", "failure", "exception", "fatal"];
const BLOCKED_PATTERNS = ["blocked", "stalled", "waiting_on_dependency"];
const COMPLETED_PATTERNS = ["completed", "done", "finished", "resolved"];
const PROGRESS_PATTERNS = ["progress", "running", "in_progress", "working"];

export class AgentContextAggregator {
  aggregateChildUpdates(
    updates: AgentStatusUpdate[],
    budgetTokens: number,
  ): AggregatedUpdate {
    const fullUpdates: AgentStatusUpdate[] = [];
    const groupedSummaries = new Map<string, GroupAccumulator>();
    let heartbeatCount = 0;

    const triageCounts = {
      full: 0,
      summary: 0,
      count: 0,
    };

    for (const update of updates) {
      const mode = this.triageUpdate(update);
      triageCounts[mode] += 1;

      if (mode === "full") {
        fullUpdates.push(update);
        continue;
      }

      if (mode === "count") {
        heartbeatCount += 1;
        continue;
      }

      const group = update.department ?? update.role ?? "general";
      const current = groupedSummaries.get(group) ?? {
        count: 0,
        completed: 0,
        progress: 0,
        other: 0,
        highlights: [],
      };

      current.count += 1;

      if (matchesAny(update.status, COMPLETED_PATTERNS) || matchesAny(update.kind, COMPLETED_PATTERNS)) {
        current.completed += 1;
      } else if (
        matchesAny(update.status, PROGRESS_PATTERNS) ||
        matchesAny(update.kind, PROGRESS_PATTERNS)
      ) {
        current.progress += 1;
      } else {
        current.other += 1;
      }

      const highlight = normalizeMessage(update.message);
      if (highlight) {
        current.highlights.push(highlight);
      }

      groupedSummaries.set(group, current);
    }

    const summaryEntries: AggregatedSummaryEntry[] = [...groupedSummaries.entries()].map(
      ([group, value]) => ({
        group,
        count: value.count,
        completed: value.completed,
        progress: value.progress,
        other: value.other,
        highlight: value.highlights[0] ?? null,
      }),
    );

    const summary = this.renderSummary({
      summaryEntries,
      fullUpdates,
      heartbeatCount,
      triageCounts,
      budgetTokens,
    });

    return {
      summary,
      fullUpdates,
      summaryEntries,
      heartbeatCount,
      triageCounts,
      estimatedTokens: estimateTokens(summary),
    };
  }

  triageUpdate(update: AgentStatusUpdate): "full" | "summary" | "count" {
    if (this.isError(update)) return "full";
    if (this.isLargeFinancialEvent(update)) return "full";
    if (this.isBlocked(update)) return "full";
    if (this.isCompleted(update)) return "summary";
    if (this.isProgress(update)) return "summary";
    if (this.isHeartbeat(update)) return "count";
    return "summary";
  }

  private renderSummary(params: {
    summaryEntries: AggregatedSummaryEntry[];
    fullUpdates: AgentStatusUpdate[];
    heartbeatCount: number;
    triageCounts: { full: number; summary: number; count: number };
    budgetTokens: number;
  }): string {
    const lines: string[] = [];

    if (params.fullUpdates.length > 0) {
      lines.push("Full-detail updates:");
      for (const update of params.fullUpdates) {
        const status = update.status ?? update.kind ?? "update";
        const message = normalizeMessage(update.message, 180) ?? "(no message)";
        lines.push(`- ${update.agentAddress} [${status}] ${message}`);
      }
    }

    if (params.summaryEntries.length > 0) {
      lines.push("Grouped summaries:");
      for (const entry of params.summaryEntries) {
        const highlight = entry.highlight ? ` | ${entry.highlight}` : "";
        lines.push(
          `- ${entry.group}: ${entry.count} updates (${entry.completed} completed, ${entry.progress} progress, ${entry.other} other)${highlight}`,
        );
      }
    }

    if (params.heartbeatCount > 0) {
      lines.push(`Heartbeat-only updates: ${params.heartbeatCount} agents alive.`);
    }

    lines.push(
      `Triage counts: full=${params.triageCounts.full}, summary=${params.triageCounts.summary}, count=${params.triageCounts.count}.`,
    );

    let rendered = lines.join("\n");
    if (params.budgetTokens <= 0) return "";

    // Same ratio as estimateTokens(), so the result is within the budget.
    const maxChars = Math.floor(params.budgetTokens * CHARS_PER_TOKEN);
    if (rendered.length <= maxChars) return rendered;

    // Preserve highest-signal updates by clipping from the end.
    if (maxChars >= TRUNCATION_MARKER.length) {
      return `${rendered.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
    }
    return SHORT_TRUNCATION_MARKER.length <= maxChars ? SHORT_TRUNCATION_MARKER : "";
  }

  private isError(update: AgentStatusUpdate): boolean {
    if (typeof update.error === "string" && update.error.trim().length > 0) return true;
    return (
      matchesAny(update.status, ERROR_PATTERNS) ||
      matchesAny(update.kind, ERROR_PATTERNS) ||
      matchesAny(update.message, ERROR_PATTERNS)
    );
  }

  private isLargeFinancialEvent(update: AgentStatusUpdate): boolean {
    if (typeof update.budgetImpactPercent === "number") {
      return update.budgetImpactPercent > 10;
    }

    if (
      typeof update.financialAmount === "number" &&
      typeof update.dailyBudget === "number" &&
      update.dailyBudget > 0
    ) {
      return (Math.abs(update.financialAmount) / update.dailyBudget) > 0.1;
    }

    return false;
  }

  private isBlocked(update: AgentStatusUpdate): boolean {
    if (update.blocked === true) return true;
    return (
      matchesAny(update.status, BLOCKED_PATTERNS) ||
      matchesAny(update.kind, BLOCKED_PATTERNS) ||
      matchesAny(update.message, BLOCKED_PATTERNS)
    );
  }

  private isCompleted(update: AgentStatusUpdate): boolean {
    return (
      matchesAny(update.status, COMPLETED_PATTERNS) ||
      matchesAny(update.kind, COMPLETED_PATTERNS)
    );
  }

  private isProgress(update: AgentStatusUpdate): boolean {
    return (
      matchesAny(update.status, PROGRESS_PATTERNS) ||
      matchesAny(update.kind, PROGRESS_PATTERNS)
    );
  }

  private isHeartbeat(update: AgentStatusUpdate): boolean {
    return (
      matchesAny(update.status, HEARTBEAT_PATTERNS) ||
      matchesAny(update.kind, HEARTBEAT_PATTERNS) ||
      matchesAny(update.message, HEARTBEAT_PATTERNS)
    );
  }
}

/**
 * Whole-word match: 'ping' must not match 'sleeping', nor 'done' 'abandoned'.
 * '_' separates words, so the event kind 'task_failed' matches 'failed'; a
 * pattern with '_' ('in_progress') matches those words in sequence. A
 * plain plural of the last word counts ('3 errors').
 */
function matchesAny(value: string | undefined, patterns: string[]): boolean {
  if (!value) return false;
  const words = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return patterns.some((pattern) => {
    const parts = pattern.split("_");
    for (let i = 0; i + parts.length <= words.length; i++) {
      const last = parts.length - 1;
      if (parts.every((part, j) => words[i + j] === part || (j === last && words[i + j] === `${part}s`))) return true;
    }
    return false;
  });
}

function normalizeMessage(input: string | undefined, maxChars: number = 120): string | null {
  if (!input) return null;
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return null;
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

const CHARS_PER_TOKEN = 3.5;
const TRUNCATION_MARKER = "\n[TRUNCATED FOR TOKEN BUDGET]";
const SHORT_TRUNCATION_MARKER = "[TRUNCATED]";

function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / CHARS_PER_TOKEN);
}
