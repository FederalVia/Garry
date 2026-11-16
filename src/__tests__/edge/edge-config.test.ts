/**
 * The publicAccess block: every shape rule for ports and the agent card,
 * mode applicability (Conway with a sandbox id ignores ports and the
 * registrar), secrets registered from config and environment, and saveConfig
 * round-tripping the block without writing an env-sourced token.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfig } from "../mocks.js";

const savedHome = process.env.HOME;
let home: string;
let dir: string;
let cfg: typeof import("../../config.js");
let edgeCfg: typeof import("../../edge/config.js");
let redaction: typeof import("../../security/secret-redaction.js");

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edge-config-")));
  process.env.HOME = home;
  dir = path.join(home, ".automaton");
  vi.resetModules();
  cfg = await import("../../config.js");
  edgeCfg = await import("../../edge/config.js");
  redaction = await import("../../security/secret-redaction.js");
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  redaction.clearRegisteredSecrets();
});

const NODE = process.execPath;

function parse(block: unknown, env: NodeJS.ProcessEnv = {}) {
  return edgeCfg.parsePublicAccess(block, env);
}
function proxy(urlTemplate: unknown, extra: Record<string, unknown> = {}) {
  return parse({ ports: { mode: "proxy", urlTemplate, ...extra } });
}
function tunnel(t: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parse({ ports: { mode: "tunnel", tunnel: t, ...extra } });
}

describe("ports: proxy", () => {
  it("accepts a template with {name} as the whole leftmost label and derives the suffix", () => {
    const p = proxy("https://{name}.agents.example.com")!.ports!;
    expect(p).toMatchObject({ mode: "proxy", suffix: "agents.example.com", gateway: { host: "127.0.0.1", port: 8480 }, maxExposed: 3, restoreOnStart: false });
    expect(proxy("https://{name}.example.com:8443/")!.ports!.suffix).toBe("example.com");
  });

  it.each([
    ["https://x{name}.example.com", /exactly|leftmost/],
    ["https://app.{name}.example.com", /leftmost/],
    ["https://{name}.{name}.example.com", /exactly once/],
    ["https://{name}.example.com/{port}", /exactly once/],
    ["https://{name}.com", /two valid labels/],
    ["http://{name}.example.com", /https/],
    ["https://{name}.example.com/sub", /leftmost|path/],
    ["https://{name}.example.com?x=1", /leftmost|query/],
    ["https://u@{name}.example.com", /leftmost|user/],
    ["https://{name}.1.2.3.4", /IP address/],
    ["https://{name}.corp.internal", /public domain/],
    ["https://{name}.my.localhost", /public domain/],
    ["https://{name}.exa_mple.com", /two valid labels/],
    ["", /required/],
    [42, /required/],
  ])("refuses %s", (t, why) => {
    expect(() => proxy(t)).toThrow(why);
  });

  it("errors carry the config path", () => {
    expect(() => proxy("https://{name}.com")).toThrow(/^publicAccess\.ports\.urlTemplate: /);
  });

  it("validates the gateway; a non-loopback host is a warning", () => {
    expect(() => proxy("https://{name}.example.com", { gateway: { host: "gw.example.com" } })).toThrow(/gateway\.host/);
    expect(() => proxy("https://{name}.example.com", { gateway: { port: 80 } })).toThrow(/gateway\.port: must be a whole number from 1024 to 65535/);
    const r = proxy("https://{name}.example.com", { gateway: { host: "0.0.0.0", port: 9000 } })!;
    expect(r.ports!.gateway).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(r.warnings.join("\n")).toMatch(/not a loopback address/);
    expect(proxy("https://{name}.example.com", { gateway: { host: "localhost" } })!.warnings).toEqual([]);
  });

  it("validates ranges of maxExposed, allowedPorts, deniedPorts and restoreOnStart", () => {
    const t = "https://{name}.example.com";
    expect(() => proxy(t, { maxExposed: 0 })).toThrow(/maxExposed/);
    expect(() => proxy(t, { maxExposed: 11 })).toThrow(/maxExposed/);
    expect(() => proxy(t, { allowedPorts: { min: 5000, max: 4000 } })).toThrow(/min must not be greater/);
    expect(() => proxy(t, { allowedPorts: { min: 0, max: 4000 } })).toThrow(/allowedPorts\.min/);
    expect(() => proxy(t, { allowedPorts: "all" })).toThrow(/allowedPorts/);
    expect(() => proxy(t, { deniedPorts: [70000] })).toThrow(/deniedPorts\[0\]/);
    expect(() => proxy(t, { restoreOnStart: "yes" })).toThrow(/restoreOnStart/);
    expect(proxy(t, { allowedPorts: [3000, 3001], deniedPorts: [3001] })!.ports).toMatchObject({ allowedPorts: [3000, 3001], deniedPorts: [3001] });
    expect(() => parse({ ports: { mode: "public" } })).toThrow(/ports\.mode/);
    expect(parse({ ports: {} })!.ports!.mode).toBe("local");
  });
});

describe("ports: tunnel", () => {
  it("presets fix args and patterns; only command, env and passEnv come from config", () => {
    const r = tunnel({ preset: "cloudflared", command: NODE, args: ["evil"] })!;
    expect(r.ports!.tunnel!.args).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:{port}"]);
    expect(r.ports!.tunnel!.readyPattern?.source).toContain("Registered tunnel connection");
    expect(r.warnings.join("\n")).toMatch(/fixed by the cloudflared preset/);
    expect(tunnel({ preset: "ngrok", command: NODE })!.ports!.tunnel!.urlPattern.test("https://ab.ngrok-free.app")).toBe(true);
  });

  it("needs an absolute command", () => {
    expect(() => tunnel({ preset: "cloudflared", command: "cloudflared" })).toThrow(/command: must be an absolute path/);
    expect(() => tunnel({ preset: "frp", command: NODE })).toThrow(/preset/);
    expect(() => parse({ ports: { mode: "tunnel" } })).toThrow(/tunnel: is required/);
  });

  it("a custom tunnel needs {port} in args and a valid urlPattern", () => {
    expect(() => tunnel({ preset: "custom", command: NODE, args: ["--to", "127.0.0.1"], urlPattern: "https://x" })).toThrow(/\{port\}/);
    expect(() => tunnel({ preset: "custom", command: NODE, args: ["{port}"] })).toThrow(/urlPattern/);
    expect(() => tunnel({ preset: "custom", command: NODE, args: ["{port}"], urlPattern: "([" })).toThrow(/not a valid regular expression/);
    expect(() => tunnel({ preset: "custom", command: NODE, args: Array(33).fill("{port}"), urlPattern: "x" })).toThrow(/1 to 32/);
    expect(() => tunnel({ preset: "custom", command: NODE, args: ["x".repeat(257), "{port}"], urlPattern: "x" })).toThrow(/256/);
    const ok = tunnel({ preset: "custom", command: NODE, args: ["--to", "127.0.0.1:{port}"], urlPattern: "https://[a-z]+\\.example\\.net" })!;
    expect(ok.ports!.tunnel!.urlPattern.test("https://abc.example.net")).toBe(true);
  });

  it("refuses env names that change what runs, in env and passEnv", () => {
    for (const name of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
      expect(() => tunnel({ preset: "cloudflared", command: NODE, env: { [name]: "x" } }), name).toThrow(/cannot be set/);
      expect(() => tunnel({ preset: "cloudflared", command: NODE, passEnv: [name] }), name).toThrow(/cannot be passed/);
    }
    expect(() => tunnel({ preset: "cloudflared", command: NODE, env: { lower: "x" } })).toThrow(/upper-case/);
    expect(() => tunnel({ preset: "cloudflared", command: NODE, env: { TOKEN: 5 } })).toThrow(/must be a string/);
  });

  it("validates the start timeout and the restart policy", () => {
    const base = { preset: "cloudflared", command: NODE };
    expect(() => tunnel({ ...base, startTimeoutMs: 1000 })).toThrow(/startTimeoutMs/);
    expect(() => tunnel({ ...base, startTimeoutMs: 200_000 })).toThrow(/startTimeoutMs/);
    expect(() => tunnel({ ...base, restart: { maxRestarts: 21 } })).toThrow(/maxRestarts/);
    const t = tunnel(base)!.ports!.tunnel!;
    expect(t.startTimeoutMs).toBe(30_000);
    expect(t.restart).toEqual({ maxRestarts: 5, windowMs: 600_000 });
  });
});

describe("agentCard", () => {
  it("defaults to not published under the name agent", () => {
    expect(parse({})!.agentCard).toEqual({ publish: false, name: "agent" });
    expect(() => parse({ agentCard: { name: "Agent Card" } })).toThrow(/agentCard\.name/);
    expect(() => parse({ agentCard: { publish: "yes" } })).toThrow(/agentCard\.publish/);
  });
});

describe("mode applicability", () => {
  const block = {
    ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com" },
    dns: { provider: "cloudflare", zone: "example.com", apiToken: "cf-token-" + "a".repeat(30) },
    registrar: { provider: "porkbun", enabled: true, apiKey: "pk1_" + "k".repeat(30), secretApiKey: "sk1_" + "s".repeat(30) },
    agentCard: { publish: true },
  };

  it("no block: not configured in either mode", () => {
    const c = createTestConfig();
    expect(edgeCfg.summarizeEdge(c, "standalone", {})).toEqual({ configured: false, ports: "local", agentCard: false, ignored: [] });
    expect(edgeCfg.summarizeEdge(c, "conway", {})).toEqual({ configured: false, ports: "conway", agentCard: false, ignored: [] });
  });

  it("standalone honours everything", () => {
    const s = edgeCfg.summarizeEdge(createTestConfig({ sandboxId: "", publicAccess: block } as any), "standalone", {});
    expect(s).toMatchObject({ configured: true, ports: "proxy", dns: { provider: "cloudflare", zone: "example.com" }, registrar: { provider: "porkbun" }, agentCard: true, ignored: [] });
    expect(JSON.stringify(s)).not.toContain("a".repeat(30));
  });

  it("Conway with a sandbox id ignores ports, the card and the registrar, with reasons; DNS stays", () => {
    const s = edgeCfg.summarizeEdge(createTestConfig({ sandboxId: "sbx-1", publicAccess: block } as any), "conway", {});
    expect(s.ports).toBe("conway");
    expect(s.dns?.zone).toBe("example.com");
    expect(s.registrar).toBeUndefined();
    expect(s.agentCard).toBe(false);
    expect(s.ignored.join("\n")).toMatch(/^ports: /m);
    expect(s.ignored.join("\n")).toMatch(/^registrar: /m);
    expect(s.ignored.join("\n")).toMatch(/^agentCard: /m);
  });

  it("Conway with an empty sandbox id honours ports", () => {
    const s = edgeCfg.summarizeEdge(createTestConfig({ sandboxId: "", publicAccess: block } as any), "conway", {});
    expect(s).toMatchObject({ ports: "proxy", agentCard: true, configured: true });
    expect(s.registrar).toBeUndefined();
  });

  it("a disabled registrar is off and not ignored noisily", () => {
    const s = edgeCfg.summarizeEdge(
      createTestConfig({ publicAccess: { registrar: { ...block.registrar, enabled: false } } } as any),
      "standalone",
      {},
    );
    expect(s).toMatchObject({ configured: false, ignored: [] });
  });
});

describe("secrets security", () => {
  it("tunnel env values, passEnv values and edge env variables are registered for redaction", () => {
    const own = "tunnel-own-" + "t".repeat(30);
    const passed = "ngrok-pass-" + "n".repeat(30);
    edgeCfg.parsePublicAccess(
      { ports: { mode: "tunnel", tunnel: { preset: "ngrok", command: NODE, env: { MY_TUNNEL_SECRET: own }, passEnv: ["NGROK_AUTHTOKEN"] } } },
      { NGROK_AUTHTOKEN: passed },
    );
    const env = {
      AUTOMATON_DNS_API_TOKEN: "dns-env-" + "d".repeat(30),
      AUTOMATON_REGISTRAR_SECRET_API_KEY: "reg-env-" + "r".repeat(30),
      TUNNEL_TOKEN: "cf-tunnel-" + "c".repeat(30),
    };
    edgeCfg.registerEdgeEnvSecrets(env);
    const text = [own, passed, ...Object.values(env)].join(" | ");
    const red = redaction.redactSecrets(text);
    for (const v of [own, passed, ...Object.values(env)]) expect(red).not.toContain(v);
  });

  it("loadConfig refuses a bad block with ConfigError and registers a DNS token from config and env", () => {
    const base = { name: "a", genesisPrompt: "g", creatorAddress: "0x" + "1".repeat(40), sandboxId: "" };
    fs.writeFileSync(path.join(dir, "automaton.json"), JSON.stringify({ ...base, publicAccess: { ports: { mode: "proxy" } } }));
    expect(() => cfg.loadConfig({})).toThrow(cfg.ConfigError);
    expect(() => cfg.loadConfig({})).toThrow(/automaton\.json: publicAccess\.ports\.urlTemplate: is required/);

    const fileToken = "cf-file-" + "f".repeat(30);
    fs.writeFileSync(
      path.join(dir, "automaton.json"),
      JSON.stringify({ ...base, publicAccess: { dns: { provider: "cloudflare", zone: "example.com", apiToken: fileToken } } }),
    );
    cfg.loadConfig({});
    expect(redaction.redactSecrets(`x ${fileToken} y`)).not.toContain(fileToken);
    const envOnly = "cf-env-only-" + "e".repeat(30);
    cfg.loadConfig({ NGROK_AUTHTOKEN: envOnly });
    expect(redaction.redactSecrets(envOnly)).not.toContain(envOnly);
  });

  it("saveConfig round-trips the block and never writes an env-sourced token", () => {
    const base = { name: "a", genesisPrompt: "g", creatorAddress: "0x" + "1".repeat(40), sandboxId: "" };
    const block = {
      ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com", maxExposed: 2 },
      dns: { provider: "cloudflare", zone: "example.com" },
      agentCard: { publish: true, name: "card" },
    };
    fs.writeFileSync(path.join(dir, "automaton.json"), JSON.stringify({ ...base, publicAccess: block }));
    const token = "cf-env-token-" + "z".repeat(30);
    const loaded = cfg.loadConfig({ AUTOMATON_DNS_API_TOKEN: token })!;
    expect(edgeCfg.summarizeEdge(loaded, "standalone", { AUTOMATON_DNS_API_TOKEN: token }).dns?.zone).toBe("example.com");
    cfg.saveConfig(loaded);
    const text = fs.readFileSync(path.join(dir, "automaton.json"), "utf8");
    expect(JSON.parse(text).publicAccess).toEqual(block);
    expect(text).not.toContain(token);
  });
});
