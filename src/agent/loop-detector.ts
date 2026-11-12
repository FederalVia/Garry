import { isIdleOnlyTool } from "./idle-only-tools.js";

export interface LoopDetectorConfig {
  maxIdenticalCalls: number;
  maxIdleOnlyTurns: number;
  windowSize: number;
  /**
   * Tools that are expected to repeat (waits). They never count toward a loop,
   * and they break a run: calls or turns on either side of one are not
   * consecutive, so "wait, then check the same task" is never a loop.
   */
  exemptTools: readonly string[];
}

export interface LoopCheckResult {
  blocked: boolean;
  reason: string;
}

export class LoopDetector {
  private readonly config: LoopDetectorConfig;
  private readonly exempt: ReadonlySet<string>;
  private callHistory: Array<{ name: string; argsHash: string }> = [];
  /** Per turn: sorted name:argsHash of its calls. Only these can block. */
  private turnPatterns: string[] = [];
  /** Per turn: sorted tool names. A repetition of names alone only warns. */
  private turnNamePatterns: string[] = [];
  private currentTurnCalls: Array<{ name: string; argsHash: string }> = [];
  private patternWarningIssued: string | null = null;
  private nameWarningIssued: string | null = null;
  private consecutiveIdleOnlyTurns = 0;
  private currentTurnIsIdleOnly = true;
  private currentTurnHasCalls = false;
  private currentTurnHasExempt = false;

  constructor(config?: Partial<LoopDetectorConfig>) {
    this.config = {
      maxIdenticalCalls: config?.maxIdenticalCalls ?? 3,
      maxIdleOnlyTurns: config?.maxIdleOnlyTurns ?? 3,
      windowSize: config?.windowSize ?? 10,
      exemptTools: config?.exemptTools ?? [],
    };
    this.exempt = new Set(this.config.exemptTools);
  }

  recordToolCall(name: string, args: string): LoopCheckResult {
    if (this.exempt.has(name)) {
      // A deliberate wait is work, not an idle status check.
      this.currentTurnIsIdleOnly = false;
      this.currentTurnHasCalls = true;
      this.currentTurnHasExempt = true;
      if (this.callHistory[this.callHistory.length - 1] !== SEPARATOR_CALL) {
        this.callHistory.push(SEPARATOR_CALL);
      }
      return { blocked: false, reason: "" };
    }

    const argsHash = simpleHash(args);
    this.callHistory.push({ name, argsHash });
    this.currentTurnCalls.push({ name, argsHash });
    this.currentTurnHasCalls = true;

    if (!isIdleOnlyTool(name)) {
      this.currentTurnIsIdleOnly = false;
    }

    const maxHistory = this.config.windowSize * 10;
    if (this.callHistory.length > maxHistory) {
      this.callHistory = this.callHistory.slice(-maxHistory);
    }

    const threshold = this.config.maxIdenticalCalls;
    if (this.callHistory.length >= threshold) {
      const recent = this.callHistory.slice(-threshold);
      const allIdentical = recent.every(
        (call) => call.name === name && call.argsHash === argsHash,
      );
      if (allIdentical) {
        return {
          blocked: true,
          reason:
            `You have called "${name}" with identical arguments ${threshold} times in a row. ` +
            "This is a loop. You MUST try a different approach, use a different tool, " +
            "or call task_done to report that you cannot complete this task.",
        };
      }
    }

    return { blocked: false, reason: "" };
  }

  endTurn(): LoopCheckResult {
    const calls = this.currentTurnCalls;
    const isIdleOnly = this.currentTurnIsIdleOnly && this.currentTurnHasCalls;
    const hadExempt = this.currentTurnHasExempt;
    this.currentTurnCalls = [];
    this.currentTurnIsIdleOnly = true;
    this.currentTurnHasCalls = false;
    this.currentTurnHasExempt = false;

    if (hadExempt) {
      // A turn that waited separates the turns around it; it is never itself
      // part of a repeated pattern.
      this.turnPatterns = pushWindow(this.turnPatterns, SEPARATOR_TURN, this.config.windowSize);
      this.turnNamePatterns = pushWindow(this.turnNamePatterns, SEPARATOR_TURN, this.config.windowSize);
    } else if (calls.length > 0) {
      const namePattern = calls.map((call) => call.name).sort().join(",");
      const pattern = calls.map((call) => `${call.name}:${call.argsHash}`).sort().join(",");
      this.turnPatterns = pushWindow(this.turnPatterns, pattern, this.config.windowSize);
      this.turnNamePatterns = pushWindow(this.turnNamePatterns, namePattern, this.config.windowSize);

      if (lastThreeEqual(this.turnPatterns, pattern)) {
        if (this.patternWarningIssued === pattern) {
          this.reset();
          return {
            blocked: true,
            reason:
              `LOOP ENFORCEMENT: You were warned about repeating the same tool calls "${namePattern}" ` +
              "with the same arguments but continued. You MUST take a completely different approach " +
              `or call task_done to report failure. Do NOT repeat these calls: ${namePattern}.`,
          };
        }

        this.patternWarningIssued = pattern;
        this.nameWarningIssued = namePattern;
        return {
          blocked: false,
          reason:
            `WARNING: You have repeated the tool pattern "${namePattern}" with the same arguments for 3 consecutive turns. ` +
            "This looks like a loop. On your next turn, you MUST try a different approach. " +
            "If you cannot make progress, call task_done with a failure summary.",
        };
      }

      if (this.patternWarningIssued && pattern !== this.patternWarningIssued) {
        this.patternWarningIssued = null;
      }

      // Same tools with different arguments is normal work (a build, then a
      // test, then a commit): a reminder at most, never a block.
      if (lastThreeEqual(this.turnNamePatterns, namePattern) && this.nameWarningIssued !== namePattern) {
        this.nameWarningIssued = namePattern;
        this.turnNamePatterns = [];
        return {
          blocked: false,
          reason:
            `NOTE: Your last 3 turns all used "${namePattern}". Make sure each call makes progress; ` +
            "if you are stuck, call task_done with a failure summary.",
        };
      }
      if (this.nameWarningIssued && namePattern !== this.nameWarningIssued) {
        this.nameWarningIssued = null;
      }
    }

    if (isIdleOnly) {
      this.consecutiveIdleOnlyTurns++;
    } else {
      this.consecutiveIdleOnlyTurns = 0;
    }

    if (this.consecutiveIdleOnlyTurns >= this.config.maxIdleOnlyTurns) {
      this.consecutiveIdleOnlyTurns = 0;
      return {
        blocked: false,
        reason:
          `IDLE LOOP DETECTED: Your last ${this.config.maxIdleOnlyTurns} turns only used ` +
          "status-check tools. You already know your status. You MUST now execute a CONCRETE " +
          "action: write code, create a file, run a command, or call task_done if the task is complete.",
      };
    }

    return { blocked: false, reason: "" };
  }

  reset(): void {
    this.callHistory = [];
    this.turnPatterns = [];
    this.turnNamePatterns = [];
    this.currentTurnCalls = [];
    this.patternWarningIssued = null;
    this.nameWarningIssued = null;
    this.consecutiveIdleOnlyTurns = 0;
    this.currentTurnIsIdleOnly = true;
    this.currentTurnHasCalls = false;
    this.currentTurnHasExempt = false;
  }
}

// Never equal to a real call or turn pattern (tool names have no NUL).
const SEPARATOR_CALL = { name: "\u0000exempt", argsHash: "" };
const SEPARATOR_TURN = "\u0000exempt";

function pushWindow(list: string[], value: string, windowSize: number): string[] {
  const next = [...list, value];
  return next.length > windowSize ? next.slice(-windowSize) : next;
}

function lastThreeEqual(list: string[], value: string): boolean {
  return list.length >= 3 && list.slice(-3).every((entry) => entry === value);
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}
