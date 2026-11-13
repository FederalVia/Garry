/**
 * The configured log level reaches loggers created at import time, before
 * the configuration was loaded.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  StructuredLogger,
  createLogger,
  getGlobalLogLevel,
  parseLogLevel,
  setGlobalLogLevel,
} from "../observability/logger.js";
import type { LogEntry } from "../types.js";

const initialLevel = getGlobalLogLevel();

afterEach(() => {
  setGlobalLogLevel(initialLevel);
  StructuredLogger.resetSink();
});

function capture(): LogEntry[] {
  const entries: LogEntry[] = [];
  StructuredLogger.setSink((e) => entries.push(e));
  return entries;
}

describe("F204: global log level applies to existing loggers", () => {
  it("emits debug from a logger created before setGlobalLogLevel('debug')", () => {
    const logger = createLogger("early");
    const child = logger.child("sub");
    const entries = capture();
    setGlobalLogLevel("debug");
    logger.debug("visible");
    child.debug("visible too");
    expect(entries.map((e) => e.message)).toEqual(["visible", "visible too"]);
  });

  it("suppresses info after setGlobalLogLevel('error')", () => {
    const logger = createLogger("early");
    const entries = capture();
    setGlobalLogLevel("error");
    logger.info("hidden");
    logger.warn("hidden");
    logger.error("shown");
    expect(entries.map((e) => e.message)).toEqual(["shown"]);
  });

  it("keeps an explicit per-logger level", () => {
    const logger = new StructuredLogger("pinned", "warn");
    const entries = capture();
    setGlobalLogLevel("debug");
    logger.info("hidden");
    logger.child("c").info("hidden");
    logger.warn("shown");
    expect(entries.map((e) => e.message)).toEqual(["shown"]);
  });

  it("parseLogLevel accepts known names only", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel(" warn ")).toBe("warn");
    expect(parseLogLevel("verbose")).toBeUndefined();
    expect(parseLogLevel("toString")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });

  it("is applied in run() right after the config is loaded", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const run = src.slice(src.indexOf("async function run()"));
    const load = run.indexOf("await loadRunConfig()");
    const apply = run.indexOf('setGlobalLogLevel(parseLogLevel(config.logLevel) ?? "info")');
    expect(load).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(load);
    expect(apply - load).toBeLessThan(200);
  });
});
