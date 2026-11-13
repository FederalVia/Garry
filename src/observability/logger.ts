/**
 * Structured Logger
 *
 * JSON-formatted structured logging with levels, context, and child loggers.
 * Uses process.stdout.write to avoid console.log recursion.
 * Never throws — all errors are handled gracefully.
 */

import type { LogLevel, LogEntry } from "../types.js";
import { LOG_LEVEL_PRIORITY } from "../types.js";
import { redactKeyMaterial, redactSecrets, redactSecretsDeep } from "../security/secret-redaction.js";
import { escapeForTerminal, escapeJsonForTerminal } from "./terminal-safe.js";

/** Log lines reach stdout/journald and files the agent can read back. */
function scrub(text: string): string {
  return redactKeyMaterial(redactSecrets(text), { keepHex64: true });
}

let globalLogLevel: LogLevel = "info";
let customSink: ((entry: LogEntry) => void) | null = null;

export function setGlobalLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

export function getGlobalLogLevel(): LogLevel {
  return globalLogLevel;
}

/** A known level name (any case), or undefined. */
export function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") return undefined;
  const level = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVEL_PRIORITY, level) ? (level as LogLevel) : undefined;
}

export class StructuredLogger {
  private module: string;
  // Unset means "follow the global level at write time": loggers are created
  // at import, before the configured level is known.
  private minLevel?: LogLevel;

  constructor(module: string, minLevel?: LogLevel) {
    this.module = module;
    this.minLevel = minLevel;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, undefined, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, undefined, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, undefined, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.write("error", message, error, context);
  }

  fatal(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.write("fatal", message, error, context);
  }

  child(subModule: string): StructuredLogger {
    return new StructuredLogger(`${this.module}.${subModule}`, this.minLevel);
  }

  static setSink(sink: (entry: LogEntry) => void): void {
    customSink = sink;
  }

  static resetSink(): void {
    customSink = null;
  }

  private write(
    level: LogLevel,
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
  ): void {
    try {
      const effectiveLevel = this.minLevel ?? globalLogLevel;
      if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[effectiveLevel]) {
        return;
      }

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        module: this.module,
        message: scrub(message),
      };

      if (context && Object.keys(context).length > 0) {
        entry.context = redactSecretsDeep(context);
      }

      if (error) {
        entry.error = {
          message: scrub(error.message),
          stack: error.stack ? scrub(error.stack) : error.stack,
        };
        if ((error as any).code) {
          entry.error.code = (error as any).code;
        }
      }

      if (customSink) {
        customSink(entry);
        return;
      }

      // JSON escapes C0 but leaves C1 and bidi controls raw.
      const json = escapeJsonForTerminal(JSON.stringify(entry));
      process.stdout.write(json + "\n");
    } catch {
      // Fallback if JSON serialization fails
      try {
        process.stderr.write(`[logger-fallback] ${escapeForTerminal(scrub(String(message)), { keepNewlines: false })}\n`);
      } catch {
        // Completely silent — never throw from logger
      }
    }
  }
}

export function createLogger(module: string): StructuredLogger {
  return new StructuredLogger(module);
}
