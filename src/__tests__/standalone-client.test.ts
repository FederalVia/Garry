/**
 * The standalone ConwayClient: local commands, files and ports work as in
 * local mode; every Conway-only call throws FEATURE_DISABLED naming the
 * setting, before any I/O, with no fetch and no treasury row. The Conway
 * egress fence refuses topups and provisioning once a standalone runtime is
 * installed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStandaloneClient, FeatureDisabledError } from "../providers/standalone-client.js";
import { installRuntime, resolveRuntime } from "../providers/mode.js";
import { classifyBalanceError, readCredits } from "../conway/balance.js";
import { createTestConfig, createTestDb } from "./mocks.js";
import { Treasury, installTreasury, normalizeTreasuryPolicy } from "../treasury/index.js";

let fetchSpy: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("no network in this test");
  });
  globalThis.fetch = fetchSpy as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  installRuntime(null);
  installTreasury(undefined as any);
});

describe("standalone client", () => {
  it("runs commands, files and ports on this machine", async () => {
    const client = createStandaloneClient();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-client-"));
    try {
      const r = await client.exec("echo hello");
      expect(r.stdout.trim()).toBe("hello");
      expect(r.exitCode).toBe(0);
      const file = path.join(dir, "a.txt");
      await client.writeFile(file, "content");
      expect(await client.readFile(file)).toBe("content");
      expect(await client.exposePort(8080)).toEqual({ port: 8080, publicUrl: "http://localhost:8080", sandboxId: "local" });
      await client.removePort(8080);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("every Conway-only method throws FEATURE_DISABLED naming providers.conway.apiKey, with no I/O", async () => {
    const db = createTestDb();
    const treasury = new Treasury({
      db: db.raw,
      policy: normalizeTreasuryPolicy({}),
      selfAddress: "0x" + "1".repeat(40),
      readCreditBalance: async () => 0,
    });
    installTreasury(treasury);
    const client = createStandaloneClient();
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["createSandbox", () => client.createSandbox({ name: "x" })],
      ["deleteSandbox", () => client.deleteSandbox("sbx")],
      ["listSandboxes", () => client.listSandboxes()],
      ["getCreditsBalance", () => client.getCreditsBalance()],
      ["getCreditsPricing", () => client.getCreditsPricing()],
      ["transferCredits", () => client.transferCredits("0x" + "2".repeat(40), 100)],
      ["registerAutomaton", () => client.registerAutomaton({} as any)],
      ["searchDomains", () => client.searchDomains("x")],
      ["registerDomain", () => client.registerDomain("x.com")],
      ["listDnsRecords", () => client.listDnsRecords("x.com")],
      ["addDnsRecord", () => client.addDnsRecord("x.com", "A", "@", "1.2.3.4")],
      ["deleteDnsRecord", () => client.deleteDnsRecord("x.com", "r")],
      ["listModels", () => client.listModels()],
    ];
    for (const [name, call] of calls) {
      const err = await call().then(
        () => null,
        (e) => e,
      );
      expect(err, name).toBeInstanceOf(FeatureDisabledError);
      expect(err.code, name).toBe("FEATURE_DISABLED");
      expect(err.message, name).toContain("providers.conway.apiKey");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM treasury_ledger").get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  it("createScopedClient refuses every id", () => {
    const client = createStandaloneClient();
    for (const id of ["", " ", "undefined", "null", "sbx-real"]) {
      expect(() => client.createScopedClient(id), id).toThrow(FeatureDisabledError);
    }
  });

  it("a balance read reports disabled, not an outage", async () => {
    const read = await readCredits(createStandaloneClient());
    expect(read).toMatchObject({ known: false, reason: "disabled" });
    expect(classifyBalanceError(new FeatureDisabledError("x", "y"))).toBe("disabled");
  });
});

describe("Conway egress fence", () => {
  const account = { address: "0x" + "3".repeat(40) } as any;

  it("topups are skipped in standalone mode, before any request", async () => {
    installRuntime(resolveRuntime(createTestConfig({ conwayApiKey: "", openaiApiKey: "sk" })));
    const topup = await import("../conway/topup.js");
    const r = await topup.topupCredits("https://api.conway.tech", account, 5);
    expect(r.success).toBe(false);
    expect(r.error).toContain("FEATURE_DISABLED");
    expect(await topup.bootstrapTopup({ apiUrl: "https://api.conway.tech", account, creditsCents: 0 })).toBeNull();
    expect(
      await topup.topupForSandbox({
        apiUrl: "https://api.conway.tech",
        account,
        error: Object.assign(new Error("402"), { status: 402 }),
      }),
    ).toBeNull();
    const outcome = await topup.startupBootstrapTopup({
      apiUrl: "https://api.conway.tech",
      account,
      readCreditBalance: async () => 0,
    });
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("provisioning is refused while a standalone runtime is installed", async () => {
    installRuntime(resolveRuntime(createTestConfig({ conwayApiKey: "", openaiApiKey: "sk" })));
    const { provision } = await import("../identity/provision.js");
    await expect(provision("https://api.conway.tech")).rejects.toThrow(/FEATURE_DISABLED/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("nothing installed counts as Conway (embedded use is unchanged)", async () => {
    const { conwayEgressBlocked } = await import("../providers/mode.js");
    expect(conwayEgressBlocked("x")).toBeNull();
    installRuntime(resolveRuntime(createTestConfig()));
    expect(conwayEgressBlocked("x")).toBeNull();
  });
});
