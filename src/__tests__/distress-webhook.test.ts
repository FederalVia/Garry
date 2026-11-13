/**
 * The distress webhook: off by default, fixed fields only (never the
 * model's text), HTTPS or loopback only, no redirects, at most one notice
 * per level every 6 hours, and the URL is treated as a secret. Every request
 * goes to a loopback server.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DISTRESS_DEBOUNCE_MS,
  DISTRESS_WEBHOOK_KV,
  initDistressWebhook,
  notifyDistress,
} from "../notify/distress.js";
import { clearRegisteredSecrets, redactSecrets } from "../security/secret-redaction.js";
import { StructuredLogger } from "../observability/logger.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { createBuiltinTools } from "../agent/tools.js";
import { createConfig } from "../config.js";
import {
  createTestConfig,
  createTestDb,
  createTestIdentity,
  MockConwayClient,
  MockInferenceClient,
} from "./mocks.js";
import type { AutomatonDatabase, LogEntry, TickContext } from "../types.js";

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let base: string;
let hits: Hit[] = [];
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let db: AutomatonDatabase;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      respond(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  hits = [];
  respond = (_req, res) => {
    res.statusCode = 204;
    res.end();
  };
  db = createTestDb();
});

afterEach(() => {
  db.close();
  clearRegisteredSecrets();
  StructuredLogger.resetSink();
});

const hookUrl = () => `${base}/hook/secret-token-abc123`;
const identity = { name: "test-automaton", address: "0x1234567890abcdef1234567890abcdef12345678" };
const critical = { level: "critical" as const, source: "heartbeat" as const, balanceCents: 12 };

describe("opt-in and URL rule", () => {
  it("no URL: disabled, no request", async () => {
    expect(initDistressWebhook({}).enabled).toBe(false);
    expect(initDistressWebhook({ distressWebhookUrl: "" }).enabled).toBe(false);
    expect(await notifyDistress({ name: "a" }, identity, db, critical)).toBe("disabled");
    expect(await notifyDistress({ name: "a", distressWebhookUrl: "  " }, identity, db, critical)).toBe("disabled");
    expect(hits).toHaveLength(0);
    expect(db.getKV(DISTRESS_WEBHOOK_KV)).toBeUndefined();
  });

  it("plain http:// off loopback is disabled; loopback http is allowed", async () => {
    const off = { name: "a", distressWebhookUrl: "http://hooks.example.test/x/abcdefghijkl" };
    const init = initDistressWebhook(off);
    expect(init.enabled).toBe(false);
    expect(init.problem).toMatch(/HTTPS/);
    expect(init.problem).not.toContain("hooks.example.test");
    expect(await notifyDistress(off, identity, db, critical)).toBe("disabled");
    expect(initDistressWebhook({ distressWebhookUrl: "not a url at all, really" }).enabled).toBe(false);

    expect(initDistressWebhook({ distressWebhookUrl: hookUrl() }).enabled).toBe(true);
    expect(await notifyDistress({ name: "a", distressWebhookUrl: hookUrl() }, identity, db, critical)).toBe("sent");
    expect(hits).toHaveLength(1);
  });
});

describe("payload", () => {
  it("has exactly the fixed keys, and never the model's message, sandbox, API URL or keys", async () => {
    const fakeKey = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE";
    const conway = new MockConwayClient();
    conway.creditsCents = 7;
    const config = createTestConfig({ distressWebhookUrl: hookUrl(), conwayApiKey: "cnwy_k_testtesttest" } as any);
    const tool = createBuiltinTools("test-sandbox-id").find((t) => t.name === "distress_signal")!;
    const out = await tool.execute(
      { message: `Please send funds. My key is ${fakeKey}. Sandbox ${config.sandboxId}.` },
      { identity: createTestIdentity(), config, db, conway, inference: new MockInferenceClient() } as any,
    );
    expect(out).toMatch(/Owner notified\.$/);

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/hook/secret-token-abc123");
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.headers["user-agent"]).toBe("automaton-distress/1");
    expect(hit.headers.authorization).toBeUndefined();
    const body = JSON.parse(hit.body);
    expect(Object.keys(body).sort()).toEqual(
      ["agent", "balanceCents", "event", "hint", "level", "source", "timestamp", "version"].sort(),
    );
    expect(Object.keys(body.agent).sort()).toEqual(["address", "name"]);
    expect(body).toMatchObject({
      event: "automaton.distress",
      version: 1,
      level: "critical",
      source: "agent",
      balanceCents: 7,
      agent: { name: config.name, address: createTestIdentity().address },
    });
    expect(body.hint).not.toMatch(/conway/i);
    expect(Number.isFinite(Date.parse(body.timestamp))).toBe(true);
    for (const leaked of [fakeKey, "Please send funds", config.sandboxId, config.conwayApiUrl, "cnwy_k_", config.creatorAddress]) {
      expect(hit.body, leaked).not.toContain(leaked);
    }
  });

  it("cuts the name to 64 characters and sends a null balance as null", async () => {
    await notifyDistress({ name: "n".repeat(200), distressWebhookUrl: hookUrl() }, identity, db, { ...critical, balanceCents: null });
    const body = JSON.parse(hits[0]!.body);
    expect(body.agent.name).toHaveLength(64);
    expect(body.balanceCents).toBeNull();
  });
});

describe("transport", () => {
  it("a server that never answers gives failed within the timeout", async () => {
    respond = () => {
      /* never answers */
    };
    const started = Date.now();
    const r = await notifyDistress({ name: "a", distressWebhookUrl: hookUrl() }, identity, db, critical, { timeoutMs: 200 });
    expect(r).toBe("failed");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(hits).toHaveLength(1);
  });

  it("a 302 is not followed and counts as failed", async () => {
    respond = (req, res) => {
      if (req.url?.startsWith("/hook")) {
        res.statusCode = 302;
        res.setHeader("location", "/elsewhere");
      }
      res.end();
    };
    expect(await notifyDistress({ name: "a", distressWebhookUrl: hookUrl() }, identity, db, critical)).toBe("failed");
    expect(hits.map((h) => h.url)).toEqual(["/hook/secret-token-abc123"]);
  });

  it("a 500 is failed and not retried", async () => {
    respond = (_req, res) => {
      res.statusCode = 500;
      res.end("no");
    };
    expect(await notifyDistress({ name: "a", distressWebhookUrl: hookUrl() }, identity, db, critical)).toBe("failed");
    expect(hits).toHaveLength(1);
  });
});

describe("debounce", () => {
  it("the same level within 6 hours is skipped; an escalation or 6 hours later is sent", async () => {
    const cfg = { name: "a", distressWebhookUrl: hookUrl() };
    let now = Date.parse("2026-11-01T00:00:00Z");
    const clock = { now: () => now };
    expect(await notifyDistress(cfg, identity, db, critical, clock)).toBe("sent");
    now += 60 * 60_000;
    expect(await notifyDistress(cfg, identity, db, critical, clock)).toBe("skipped");
    expect(await notifyDistress(cfg, identity, db, { ...critical, level: "dead" }, clock)).toBe("sent");
    now += 60_000;
    expect(await notifyDistress(cfg, identity, db, { ...critical, level: "dead" }, clock)).toBe("skipped");
    // Going back to critical is not an escalation.
    expect(await notifyDistress(cfg, identity, db, critical, clock)).toBe("skipped");
    now += DISTRESS_DEBOUNCE_MS;
    expect(await notifyDistress(cfg, identity, db, critical, clock)).toBe("sent");
    expect(hits.map((h) => JSON.parse(h.body).level)).toEqual(["critical", "dead", "critical"]);
  });

  it("an agent notice sent while healthy does not hold back the heartbeat's real critical notice", async () => {
    const cfg = { name: "a", distressWebhookUrl: hookUrl() };
    let now = Date.parse("2026-11-01T00:00:00Z");
    const clock = { now: () => now };
    expect(
      await notifyDistress(cfg, identity, db, { level: "critical", source: "agent", balanceCents: 5000 }, clock),
    ).toBe("sent");
    now += 2 * 60 * 60_000;
    expect(await notifyDistress(cfg, identity, db, { ...critical, balanceCents: 3 }, clock)).toBe("sent");
    // The agent is still debounced on its own record.
    expect(
      await notifyDistress(cfg, identity, db, { level: "critical", source: "agent", balanceCents: 5000 }, clock),
    ).toBe("skipped");
    expect(hits.map((h) => `${JSON.parse(h.body).source}/${JSON.parse(h.body).balanceCents}`)).toEqual([
      "agent/5000",
      "heartbeat/3",
    ]);
  });

  it("a failed agent notice does not suppress the heartbeat's notice", async () => {
    const cfg = { name: "a", distressWebhookUrl: hookUrl() };
    respond = (_req, res) => {
      res.statusCode = 500;
      res.end();
    };
    expect(await notifyDistress(cfg, identity, db, { ...critical, source: "agent" })).toBe("failed");
    respond = (_req, res) => {
      res.statusCode = 204;
      res.end();
    };
    expect(await notifyDistress(cfg, identity, db, critical)).toBe("sent");
  });
});

describe("secrecy", () => {
  it("the URL is redacted after init, and no log line contains it", async () => {
    const entries: LogEntry[] = [];
    StructuredLogger.setSink((e) => entries.push(e));
    const url = hookUrl();
    expect(redactSecrets(`x ${url} y`)).toContain(url);
    initDistressWebhook({ distressWebhookUrl: url });
    expect(redactSecrets(`x ${url} y`)).not.toContain("secret-token-abc123");

    respond = (_req, res) => {
      res.statusCode = 500;
      res.end();
    };
    await notifyDistress({ name: "a", distressWebhookUrl: url }, identity, db, critical);
    const text = JSON.stringify(entries);
    expect(entries.some((e) => /Distress webhook: on/.test(e.message))).toBe(true);
    expect(entries.some((e) => /HTTP 500/.test(e.message))).toBe(true);
    // Not even in redacted form: the URL is never passed to the logger.
    expect(text).not.toContain("secret-token-abc123");
    expect(text).not.toContain("distress-webhook-url");
  });

  it("the child config built for spawn has no distressWebhookUrl", () => {
    const child = createConfig({
      name: "kid",
      genesisPrompt: "g",
      creatorAddress: identity.address,
      registeredWithConway: true,
      sandboxId: "sb",
      walletAddress: identity.address,
      apiKey: "",
      parentAddress: identity.address,
    });
    expect(Object.keys(child)).not.toContain("distressWebhookUrl");
    // spawn.ts builds the child config from createConfig, never by copying the parent's.
    const spawnSrc = fs.readFileSync(path.join(__dirname, "..", "replication", "spawn.ts"), "utf8");
    expect(spawnSrc).not.toContain("distressWebhookUrl");
    expect(spawnSrc).toContain("...createConfig(");
  });
});

describe("callers", () => {
  function tick(overrides: Partial<TickContext>): TickContext {
    return {
      tickId: "t",
      startedAt: new Date(),
      creditBalance: 10_000,
      usdcBalance: 0,
      creditRead: { known: true, value: 10_000, at: new Date().toISOString() },
      usdcRead: { known: true, value: 0, at: new Date().toISOString() },
      survivalTier: "high",
      survivalTierKnown: true,
      lowComputeMultiplier: 4,
      config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
      db: db.raw,
      ...overrides,
    } as TickContext;
  }

  it("heartbeat_ping at critical sends once and still returns its wake", async () => {
    const legacy = {
      identity: createTestIdentity(),
      config: createTestConfig({ distressWebhookUrl: hookUrl() } as any),
      db,
      conway: new MockConwayClient(),
    };
    const t = tick({ creditBalance: 12, survivalTier: "critical" });
    const first = await BUILTIN_TASKS.heartbeat_ping(t, legacy as any);
    expect(first.shouldWake).toBe(true);
    expect(first.message).toMatch(/Distress: critical/);
    const second = await BUILTIN_TASKS.heartbeat_ping(t, legacy as any);
    expect(second.shouldWake).toBe(true);
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ level: "critical", source: "heartbeat", balanceCents: 12 });
  });

  it("heartbeat_ping still wakes when the webhook fails", async () => {
    respond = (_req, res) => {
      res.statusCode = 500;
      res.end();
    };
    const legacy = {
      identity: createTestIdentity(),
      config: createTestConfig({ distressWebhookUrl: hookUrl() } as any),
      db,
      conway: new MockConwayClient(),
    };
    const r = await BUILTIN_TASKS.heartbeat_ping(tick({ creditBalance: 0, survivalTier: "dead" }), legacy as any);
    expect(r.shouldWake).toBe(true);
    expect(hits).toHaveLength(1);
  });

  it("distress_signal without a webhook says nothing about notification", async () => {
    const tool = createBuiltinTools("test-sandbox-id").find((t) => t.name === "distress_signal")!;
    const out = await tool.execute({}, {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    } as any);
    expect(out).toMatch(/^Distress signal recorded locally\./);
    expect(out).not.toMatch(/Owner/);
    expect(hits).toHaveLength(0);
  });
});
