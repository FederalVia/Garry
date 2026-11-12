/**
 * The redaction layer only knows the secrets the loaders register. Load the
 * wallet and config the way the runtime does (no manual registerSecret) and
 * check both chokepoints: inference messages and the logger sink.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../types.js";

const PRIVATE_KEY_HEX = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const PRIVATE_KEY = `0x${PRIVATE_KEY_HEX}`;
const CONWAY_KEY = "cnwy_k_REGISTRATION_TEST_0123456789";
const OPENAI_KEY = "sk-registration-openai-0123456789abcdef";

const ORIGINAL_ENV = { ...process.env };
let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secret-registration-"));
  process.env.HOME = tmp;
  delete process.env.CONWAY_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const dir = path.join(tmp, ".automaton");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "wallet.json"),
    JSON.stringify({ chainType: "evm", privateKey: PRIVATE_KEY, createdAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(dir, "automaton.json"),
    JSON.stringify({ name: "t", conwayApiKey: CONWAY_KEY, openaiApiKey: OPENAI_KEY }),
    { mode: 0o600 },
  );
  // wallet.ts fixes its paths at import time, so import after HOME is set.
  vi.resetModules();
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
  fs.rmSync(tmp, { recursive: true, force: true });
});

function leaks(text: string): string[] {
  return [PRIVATE_KEY_HEX, CONWAY_KEY, OPENAI_KEY].filter((s) => text.toLowerCase().includes(s.toLowerCase()));
}

const LEAKY = `wallet ${PRIVATE_KEY} bare ${PRIVATE_KEY_HEX} conway ${CONWAY_KEY} openai ${OPENAI_KEY}`;

describe("loading the wallet and config registers their secrets", () => {
  it("loadWalletAccount and loadConfig feed redactChatMessages and the logger sink", async () => {
    const { redactChatMessages } = await import("../security/secret-redaction.js");
    const { StructuredLogger, createLogger } = await import("../observability/logger.js");

    // Nothing is registered yet.
    const [before] = redactChatMessages([{ role: "tool", content: LEAKY }]);
    expect(leaks(String(before.content))).toHaveLength(3);

    const { loadWalletAccount } = await import("../identity/wallet.js");
    const { loadConfig } = await import("../config.js");
    expect(loadWalletAccount()?.address).toMatch(/^0x/);
    expect(loadConfig()).not.toBeNull();

    const [after] = redactChatMessages([{ role: "tool", content: LEAKY }]);
    expect(leaks(String(after.content))).toEqual([]);
    expect(String(after.content)).toContain("[REDACTED:wallet]");
    expect(String(after.content)).toContain("[REDACTED:conway-api-key]");

    const entries: LogEntry[] = [];
    StructuredLogger.setSink((e) => entries.push(e));
    try {
      createLogger("test").error(LEAKY, new Error(LEAKY), { detail: LEAKY });
    } finally {
      StructuredLogger.resetSink();
    }
    expect(entries).toHaveLength(1);
    expect(leaks(JSON.stringify(entries[0]))).toEqual([]);
  });

  it("redacts custom provider and local provider keys taken from the environment", async () => {
    const { redactChatMessages } = await import("../security/secret-redaction.js");
    process.env.AUTOMATON_PROVIDER_DEEPSEEK_API_KEY = "dsk-0123456789abcdefSECRETVALUE";
    process.env.LOCAL_API_KEY = "local-0123456789abcdefSECRET";
    try {
      const [msg] = redactChatMessages([
        {
          role: "tool",
          content: `env: ${process.env.AUTOMATON_PROVIDER_DEEPSEEK_API_KEY} ${process.env.LOCAL_API_KEY}`,
        },
      ]);
      expect(String(msg.content)).not.toContain("SECRETVALUE");
      expect(String(msg.content)).not.toContain("abcdefSECRET");
      expect(String(msg.content)).toContain("[REDACTED:api-key]");
    } finally {
      delete process.env.AUTOMATON_PROVIDER_DEEPSEEK_API_KEY;
      delete process.env.LOCAL_API_KEY;
    }
  });
});
