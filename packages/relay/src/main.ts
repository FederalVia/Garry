#!/usr/bin/env node
/**
 * automaton-relay entry point: read RELAY_* settings, open the DB, listen,
 * prune on a timer, and shut down cleanly on SIGTERM/SIGINT.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRelayEnv, startupWarnings, RelayEnvError, type RelayEnvConfig } from "./env.js";
import { createRelay, type LogLevel } from "./server.js";

const PRUNE_INTERVAL_MS = 10 * 60_000;

function log(level: LogLevel, msg: string): void {
  if (level === "debug" && process.env.RELAY_DEBUG !== "1") return;
  const line = `${new Date().toISOString()} ${level} ${msg}\n`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
}

async function main(): Promise<void> {
  let config: RelayEnvConfig;
  try {
    config = parseRelayEnv();
  } catch (err) {
    process.stderr.write(`automaton-relay: ${err instanceof RelayEnvError ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const dir = path.dirname(config.options.dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const relay = createRelay({ ...config.options, log });
  relay.prune();
  const url = await relay.listen(config.port, config.host);
  log("info", `automaton-relay listening on ${url}`);
  const agentDir = path.join(os.homedir(), ".automaton");
  for (const warning of startupWarnings(config, fs.existsSync(agentDir) ? agentDir : undefined)) {
    log("warn", warning);
  }

  const timer = setInterval(() => {
    try {
      relay.prune();
    } catch (err) {
      log("error", `prune failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, PRUNE_INTERVAL_MS);
  timer.unref();

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log("info", `${signal}: shutting down`);
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`automaton-relay: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
