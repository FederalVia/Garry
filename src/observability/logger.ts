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

export class StructuredLogger {
  private module: string;
  private minLevel: LogLevel;

  constructor(module: string, minLevel?: LogLevel) {
    this.module = module;
    this.minLevel = minLevel ?? globalLogLevel;
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

      const json = JSON.stringify(entry);
      process.stdout.write(json + "\n");
    } catch {
      // Fallback if JSON serialization fails
      try {
        process.stderr.write(`[logger-fallback] ${message}\n`);
      } catch {
        // Completely silent — never throw from logger
      }
    }
  }
}

export function createLogger(module: string): StructuredLogger {
  return new StructuredLogger(module);
}
