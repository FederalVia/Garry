/**
 * Edge credentials stay secret end to end: a DNS provider that echoes the
 * token into its error text, through the tool, the logs and the system
 * prompt (standalone and Conway); the child environment of tools; and the
 * tunnel, which gets its own token and nothing else.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeCloudflare } from "../fixtures/edge/fake-cloudflare.js";
import { createEdge, installEdge, withEdge, type Edge } from "../../edge/index.js";
import { TunnelExposer } from "../../edge/ports.js";
import { parsePublicAccess } from "../../edge/config.js";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { buildSystemPrompt } from "../../agent/system-prompt.js";
import { resolveRuntime } from "../../providers/mode.js";
import { visibleTools } from "../../providers/features.js";
import { createStandaloneClient } from "../../providers/standalone-client.js";
import { childProcessEnv } from "../../security/child-env.js";
import { redactSecrets } from "../../security/secret-redaction.js";
import { StructuredLogger } from "../../observability/logger.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";
import type { AutomatonConfig, FinancialState, LogEntry, ToolContext } from "../../types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_TUNNEL = path.join(HERE, "..", "fixtures", "edge", "fake-tunnel.mjs");
const savedHome = process.env.HOME;
let home: string;
let cf: FakeCloudflare;
const logs: LogEntry[] = [];
const edges: Edge[] = [];
const exposers: TunnelExposer[] = [];

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edge-secrets-")));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  fs.writeFileSync(path.join(home, ".automaton", "constitution.md"), "Constitution (test copy)");
  cf = await new FakeCloudflare({ token: "cf-secret-token-" + "Z".repeat(24), zones: ["example.com"] }).start();
  StructuredLogger.setSink((e) => logs.push(e));
});

afterAll(async () => {
  StructuredLogger.resetSink();
  await cf.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(async () => {
  installEdge(null);
  await Promise.allSettled([...edges.splice(0).map((e) => e.close(1_000)), ...exposers.splice(0).map((e) => e.close(2_000))]);
});

function dnsBlock() {
  return { dns: { provider: "cloudflare", zone: "example.com", apiToken: cf.token, apiUrl: cf.url } };
}

function setup(config: AutomatonConfig) {
  const runtime = resolveRuntime(config);
  const db = createTestDb();
  const identity = { ...createTestIdentity(), sandboxId: config.sandboxId };
  const inner = runtime.mode === "standalone" ? createStandaloneClient() : new MockConwayClient();
  const edge = createEdge({ config, runtime, db, inner, env: {}, identity });
  edges.push(edge);
  installEdge(edge);
  const ctx: ToolContext = { identity, config, db, conway: withEdge(inner, edge, runtime.mode), inference: new MockInferenceClient() };
  const tools = visibleTools(createBuiltinTools(config.sandboxId, { standalone: runtime.mode === "standalone" }), runtime.features);
  return { ctx, tools, edge, db, identity, runtime };
}

const FINANCIAL = { creditsCents: 1000, usdcBalance: 0, credits: "fixed", usdc: "unknown", fixedTier: "normal", lastChecked: new Date().toISOString() } as FinancialState;

describe("DNS token security", () => {
  for (const mode of ["standalone", "conway"] as const) {
    it(`never appears in a tool result, a log line or the system prompt (${mode})`, async () => {
      const config =
        mode === "standalone"
          ? createTestConfig({ conwayApiKey: "", sandboxId: "", providers: { mode: "standalone" }, openaiApiKey: "sk-test", publicAccess: dnsBlock() })
          : createTestConfig({ sandboxId: "", publicAccess: dnsBlock() });
      const { ctx, tools, edge, db, identity } = setup(config);
      logs.length = 0;
      await edge.start();
      // The provider echoes the credential in its error text.
      cf.respondNext(
        { status: 400, body: { success: false, errors: [{ code: 9109, message: `Invalid request with Authorization: Bearer ${cf.token}` }], result: null } },
        (r) => r.method === "POST",
      );
      const r = await executeTool("manage_dns", { action: "add", domain: "example.com", type: "A", host: "app", value: "93.184.216.34" }, tools, ctx);
      expect(r.error).toBeTruthy();
      expect(r.error).not.toContain(cf.token);
      const ok = await executeTool("manage_dns", { action: "list", domain: "example.com" }, tools, ctx);
      expect(JSON.stringify(ok)).not.toContain(cf.token);
      const prompt = buildSystemPrompt({ identity, config, financial: FINANCIAL, state: "running", db, tools, skills: [], isFirstRun: false });
      expect(prompt).toContain("--- PUBLIC ACCESS ---");
      expect(prompt).toContain("DNS: records under example.com via cloudflare");
      expect(prompt).not.toContain(cf.token);
      expect(JSON.stringify(logs)).not.toContain(cf.token);
      // The request did carry it: the check above is not vacuous.
      expect(cf.requests.some((q) => q.headers.authorization === `Bearer ${cf.token}`)).toBe(true);
    });
  }

  it("is stripped from tool children with the run-together credential names", () => {
    const env = childProcessEnv({
      PATH: "/usr/bin",
      AUTOMATON_DNS_API_TOKEN: "a".repeat(30),
      AUTOMATON_REGISTRAR_SECRET_API_KEY: "b".repeat(30),
      NGROK_AUTHTOKEN: "c".repeat(30),
      PORKBUN_SECRETAPIKEY: "d".repeat(30),
      PORKBUN_APIKEY: "e".repeat(30),
      GITHUB_ACCESSTOKEN: "f".repeat(30),
      STRIPE_SECRETKEY: "g".repeat(30),
      TUNNEL_TOKEN: "h".repeat(30),
      CF_API_TOKEN: "i".repeat(30),
      MONKEY: "keep",
    });
    expect(env).toEqual({ PATH: "/usr/bin", MONKEY: "keep" });
  });
});

describe("tunnel environment security", () => {
  it("naming a proxy, certificate or locale variable in passEnv does not take it from tool children or mask it", () => {
    const host: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.internal.example:3128",
      NO_PROXY: "localhost,127.0.0.1",
      SSL_CERT_FILE: "/etc/ssl/certs/owner-ca-bundle.pem",
      LC_ALL: "C.UTF-8",
      SHARED_TUNNEL_CRED: "cred-" + "s".repeat(30),
    };
    const parsed = parsePublicAccess(
      {
        ports: {
          mode: "tunnel",
          tunnel: {
            preset: "ngrok",
            command: process.execPath,
            passEnv: ["HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "LC_ALL", "SHARED_TUNNEL_CRED"],
          },
        },
      },
      host,
    );
    const { SHARED_TUNNEL_CRED: _cred, ...shared } = host;
    expect(childProcessEnv(host)).toEqual(shared);
    const text = `via ${host.HTTPS_PROXY} with ${host.SSL_CERT_FILE} and ${host.SHARED_TUNNEL_CRED}`;
    const shown = redactSecrets(text);
    expect(shown).toContain(host.HTTPS_PROXY);
    expect(shown).toContain(host.SSL_CERT_FILE);
    expect(shown).not.toContain(host.SHARED_TUNNEL_CRED);
    // The tunnel gets all of them.
    expect(new TunnelExposer(parsed!.ports!, { env: host }).tunnelEnv()).toMatchObject(host);
  });

  it("a passEnv variable is kept from tool children even when its name does not look like a credential", () => {
    const host: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      CF_TUNNEL_CRED: "cred-" + "c".repeat(30),
      TUNNEL_PASS: "pass-" + "p".repeat(30),
      NGROK_AUTHTOKEN: "ngrok-" + "n".repeat(30),
      OTHER_SETTING: "keep",
    };
    const parsed = parsePublicAccess(
      {
        ports: {
          mode: "tunnel",
          tunnel: { preset: "ngrok", command: process.execPath, passEnv: ["CF_TUNNEL_CRED", "TUNNEL_PASS", "NGROK_AUTHTOKEN"] },
        },
      },
      host,
    );
    expect(childProcessEnv(host)).toEqual({ PATH: "/usr/bin", OTHER_SETTING: "keep" });
    // The tunnel itself still gets them.
    const ex = new TunnelExposer(parsed!.ports!, { env: host });
    expect(ex.tunnelEnv()).toMatchObject({
      CF_TUNNEL_CRED: host.CF_TUNNEL_CRED,
      TUNNEL_PASS: host.TUNNEL_PASS,
      NGROK_AUTHTOKEN: host.NGROK_AUTHTOKEN,
    });
  });


  it("the tunnel gets its own env value and passEnv values; tools and the tunnel never get the DNS token", async () => {
    const dir = fs.mkdtempSync(path.join(home, "tun-"));
    const dump = path.join(dir, "env.json");
    const own = "mytunnel-own-" + "T".repeat(24);
    const host: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      AUTOMATON_DNS_API_TOKEN: cf.token,
      OPENAI_API_KEY: "sk-" + "o".repeat(30),
      NGROK_AUTHTOKEN: "ngrok-" + "n".repeat(30),
    };
    const ex = new TunnelExposer(
      {
        mode: "tunnel",
        gateway: { host: "127.0.0.1", port: 8480 },
        maxExposed: 3,
        allowedPorts: { min: 1024, max: 65535 },
        deniedPorts: [],
        restoreOnStart: false,
        tunnel: {
          preset: "custom",
          command: process.execPath,
          args: [FAKE_TUNNEL, "--port", "{port}", "--env-dump", dump],
          urlPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
          env: { MYTUNNEL_TOKEN: own },
          passEnv: ["NGROK_AUTHTOKEN"],
          startTimeoutMs: 10_000,
          restart: { maxRestarts: 0, windowMs: 600_000 },
        },
      },
      { env: host, probe: async () => true },
    );
    exposers.push(ex);
    await ex.start();
    await ex.expose(5200);
    const tunnelEnv = JSON.parse(fs.readFileSync(dump, "utf8"));
    expect(tunnelEnv.MYTUNNEL_TOKEN).toBe(own);
    expect(tunnelEnv.NGROK_AUTHTOKEN).toBe(host.NGROK_AUTHTOKEN);
    expect(JSON.stringify(tunnelEnv)).not.toContain(cf.token);
    expect(tunnelEnv.OPENAI_API_KEY).toBeUndefined();
    // The tunnel's own token lives only in the tunnel's environment.
    expect(process.env.MYTUNNEL_TOKEN).toBeUndefined();
    expect(JSON.stringify(childProcessEnv(host))).not.toContain(host.NGROK_AUTHTOKEN!);
  });
});
