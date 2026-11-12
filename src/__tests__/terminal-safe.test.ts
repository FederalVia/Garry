/**
 * Text from tool output, web pages and other agents reaches the operator's
 * terminal through the pretty log sink, the JSON log sink and the CLI. Escape
 * sequences in it are shown in visible notation, never emitted raw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prettySink } from "../observability/pretty-sink.js";
import { StructuredLogger, createLogger } from "../observability/logger.js";
import { escapeForTerminal } from "../observability/terminal-safe.js";
import { formatActivityLine, formatTurnLines } from "../operator/turn-log.js";
import type { LogEntry } from "../types.js";

// OSC 52 clipboard write, then erase the line and return to its start.
const PAYLOAD = "ok\x1b]52;c;QUJD\x07\x1b[2K\r";
const C1_CSI = "\u009b";
const RLO = String.fromCharCode(0x202e);
const LINE_SEP = String.fromCharCode(0x2028);

function hasRawControls(text: string): boolean {
  return /[\x1b\x07\x9b\r]/.test(text) || text.includes(RLO) || text.includes(LINE_SEP);
}

/** Drop chalk's own SGR colour codes, which are ours, not the payload's. */
function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

let written: string[];
beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  StructuredLogger.resetSink();
});

function entry(message: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { timestamp: new Date().toISOString(), level: "info", module: "loop", message, ...extra };
}

describe("escapeForTerminal", () => {
  it("shows control characters in visible notation and keeps newlines and tabs", () => {
    const out = escapeForTerminal(`a${PAYLOAD}\n\tb${C1_CSI}${RLO}${LINE_SEP}`);
    expect(out).toBe("aok\\x1b]52;c;QUJD\\x07\\x1b[2K\\x0d\n\tb\\x9b\\u{202e}\\u{2028}");
    expect(hasRawControls(out)).toBe(false);
  });

  it("is idempotent", () => {
    const once = escapeForTerminal(PAYLOAD);
    expect(escapeForTerminal(once)).toBe(once);
  });

  it("escapes newlines too when asked for one line", () => {
    expect(escapeForTerminal("a\nb", { keepNewlines: false })).toBe("a\\x0ab");
  });
});

describe("prettySink", () => {
  it("escapes the message (the OSC 52 tool-result payload)", () => {
    prettySink(entry(`[TOOL RESULT] exec: stdout: ${PAYLOAD}`));
    const out = stripSgr(written.join(""));
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain(C1_CSI);
    expect(out).toContain("\\x1b]52");
  });

  it("keeps one entry on one line, so tool output cannot forge a log line", () => {
    vi.stubEnv("FORCE_COLOR", "0");
    prettySink(entry("[TOOL RESULT] exec: line1\n12:00:00 INFO  loop         [AUTO-TOPUP] Bought $500 credits"));
    vi.unstubAllEnvs();
    const out = stripSgr(written.join(""));
    expect(out.split("\n").filter(Boolean)).toHaveLength(1);
    expect(out).toContain("line1\\x0a12:00:00");
  });

  it("escapes error.message", () => {
    prettySink(entry("x", { level: "error", error: { message: `boom\x1b[2J${C1_CSI}` } }));
    const out = stripSgr(written.join(""));
    expect(out).not.toContain("\x1b[2J");
    expect(out).not.toContain(C1_CSI);
    expect(out).toContain("\\x1b[2J");
  });
});

describe("JSON log sink", () => {
  it("leaves no C1 or bidi control raw and stays valid JSON", () => {
    createLogger("t").info(`m ${C1_CSI}${RLO}\x1b[31m`);
    const line = written.join("").trim();
    expect(line).not.toContain(C1_CSI);
    expect(line).not.toContain(RLO);
    expect(line).not.toContain("\x1b");
    expect(JSON.parse(line).message).toBe(`m ${C1_CSI}${RLO}\x1b[31m`);
  });
});

describe("CLI turn rendering", () => {
  const turn = {
    id: "t1",
    timestamp: "2026-01-01T00:00:00Z",
    state: "normal",
    input: `hello${PAYLOAD}`,
    inputSource: `agent${RLO}`,
    thinking: `thinking${C1_CSI}2J`,
    toolCalls: [
      { name: `exec\x1b[8m`, result: `out${PAYLOAD}` },
      { name: "x402_fetch", result: "", error: `err\x1b]0;title\x07` },
    ],
    tokenUsage: { totalTokens: 10 },
    costCents: 1,
  };

  it("formatTurnLines escapes input, source, thinking, tool names, results and errors", () => {
    const out = stripSgr(formatTurnLines(turn).join("\n"));
    expect(hasRawControls(out)).toBe(false);
    expect(out).toContain("hellook\\x1b]52");
    expect(out).toContain("\\u{202e}");
    expect(out).toContain("thinking\\x9b2J");
    expect(out).toContain("exec\\x1b[8m");
    expect(out).toContain("err\\x1b]0;title\\x07");
  });

  it("formatActivityLine escapes thinking and tool names", () => {
    const out = stripSgr(formatActivityLine(turn));
    expect(hasRawControls(out)).toBe(false);
    expect(out).toContain("thinking\\x9b2J");
  });
});
