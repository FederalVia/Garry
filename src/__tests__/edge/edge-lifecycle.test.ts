/**
 * The edge at boot and shutdown: bootEdge gives the runtime the routed
 * client and the shutdown step, edge.close stops tunnels (and their
 * grandchildren), the gateway and the card server, and index.ts wires both.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootEdge, createEdge, currentEdge, installEdge, type Edge } from "../../edge/index.js";
import { resolveRuntime } from "../../providers/mode.js";
import { createStandaloneClient } from "../../providers/standalone-client.js";
import { createTestConfig, createTestDb, createTestIdentity } from "../mocks.js";
import type { AutomatonConfig } from "../../types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "..", "fixtures", "edge", "fake-tunnel.mjs");
const savedHome = process.env.HOME;
let home: string;
const edges: Edge[] = [];
const pidFiles: string[] = [];

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edge-life-")));
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});
afterEach(async () => {
  installEdge(null);
  await Promise.allSettled(edges.splice(0).map((e) => e.close(2_000)));
  for (const f of pidFiles.splice(0)) {
    if (!fs.existsSync(f)) continue;
    const { pid, grandchild } = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const p of [pid, grandchild]) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
});

function standalone(publicAccess: Record<string, unknown>): AutomatonConfig {
  return createTestConfig({ name: "life-test", conwayApiKey: "", sandboxId: "", providers: { mode: "standalone" }, publicAccess });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie is dead for our purposes.
  try {
    return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z");
  } catch {
    return true;
  }
}

async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(() => r(undefined)));
  return port;
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

describe("bootEdge", () => {
  it("installs the edge, routes the client's ports through it and gives the shutdown step", async () => {
    const gw = await freePort();
    const config = standalone({ ports: { mode: "proxy", urlTemplate: "https://{name}.agents.example.com", gateway: { port: gw } } });
    const runtime = resolveRuntime(config);
    const inner = createStandaloneClient();
    const boot = bootEdge({ config, runtime, db: createTestDb(), inner, env: {}, deps: { probe: async () => true } });
    edges.push(boot.edge);
    expect(currentEdge()).toBe(boot.edge);
    expect(boot.conway).not.toBe(inner);
    boot.start();
    await waitFor(() => boot.edge.ports!.available().ok);
    expect((await boot.conway.exposePort(3000, { name: "api" })).publicUrl).toBe("https://api.agents.example.com");
    expect(await accepts(gw)).toBe(true);
    await boot.closeEdge(2_000);
    expect(await accepts(gw)).toBe(false);
  });

  it("without publicAccess hands back the inner client and starts nothing", async () => {
    const config = createTestConfig({ conwayApiKey: "", sandboxId: "", providers: { mode: "standalone" } });
    const inner = createStandaloneClient();
    const boot = bootEdge({ config, runtime: resolveRuntime(config), db: createTestDb(), inner, env: {} });
    edges.push(boot.edge);
    expect(boot.conway).toBe(inner);
    boot.start();
    await expect(boot.closeEdge(500)).resolves.toBeUndefined();
  });
});

describe("edge.close security: nothing left running", () => {
  it("tunnel mode: stops the agent's tunnel, the card's tunnel, their grandchildren and the card server", async () => {
    const dir = fs.mkdtempSync(path.join(home, "tun-"));
    const config = standalone({
      ports: {
        mode: "tunnel",
        tunnel: {
          preset: "custom",
          command: process.execPath,
          args: [FAKE, "--port", "{port}", "--grandchild", "--pid-file", path.join(dir, "pids-{port}.json")],
          urlPattern: "https://[a-z0-9-]+\\.trycloudflare\\.com",
        },
      },
      agentCard: { publish: true },
    });
    const edge = createEdge({
      config,
      runtime: resolveRuntime(config),
      db: createTestDb(),
      inner: createStandaloneClient(),
      env: { PATH: process.env.PATH },
      identity: { ...createTestIdentity(), sandboxId: "" },
      deps: { probe: async () => true },
    });
    edges.push(edge);
    await edge.start();
    const cardPort = edge.ports!.list().find((e) => e.managedBy === "runtime")!.port;
    await edge.ports!.expose(5200);
    const files = [cardPort, 5200].map((p) => path.join(dir, `pids-${p}.json`));
    pidFiles.push(...files);
    await waitFor(() => files.every((f) => fs.existsSync(f)));
    const pids = files.flatMap((f) => {
      const { pid, grandchild } = JSON.parse(fs.readFileSync(f, "utf8"));
      return [pid as number, grandchild as number];
    });
    expect(pids.every(alive)).toBe(true);
    expect(await accepts(cardPort)).toBe(true);

    await edge.close(3_000);
    await waitFor(() => pids.every((p) => !alive(p)), 3_000);
    expect(await accepts(cardPort)).toBe(false);
    expect(edge.ports!.list()).toEqual([]);
  });
});

describe("index.ts wiring", () => {
  it("hands the edge-routed client to the runtime and closeEdge to the shutdown sequence", () => {
    const src = fs.readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const run = src.slice(src.indexOf("async function run()"));
    expect(run).toMatch(/const edgeBoot = bootEdge\(\{[^}]*inner: baseConway[^}]*\}\);/);
    // A stop request reaches a tunnel start that a tool call is waiting on.
    expect(run).toMatch(/const edgeBoot = bootEdge\(\{[^}]*shutdownSignal: ctl\.signal[^}]*\}\);/);
    expect(run).toContain("const conway = edgeBoot.conway;");
    expect(run).toContain("edgeBoot.start();");
    const shutdown = run.slice(run.indexOf("await finishShutdown({"));
    expect(shutdown.slice(0, shutdown.indexOf("});"))).toContain("closeEdge: edgeBoot.closeEdge,");
    // No second client bypasses the edge.
    expect(run).not.toMatch(/const conway = baseConway/);
  });
});
