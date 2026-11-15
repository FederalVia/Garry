/**
 * financial: the owner's budget commands (automaton-cli budget add|remove|show).
 * Grants go to the owner database only (created 0755/0644 with a rollback
 * journal), need --yes or a terminal y, work while the agent runs, and
 * `show` reports what the runtime's meter computes without writing state.db.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const savedHome = process.env.HOME;
let home: string;
let dir: string;
let budgetOps: typeof import("../operator/budget.js");
let config: typeof import("../config.js");
let database: typeof import("../state/database.js");
let meterMod: typeof import("../budget/meter.js");
let ownerDb: typeof import("../budget/owner-db.js");
let budgetConfig: typeof import("../budget/config.js");
let instanceLock: typeof import("../state/instance-lock.js");

const NOW = Date.parse("2026-11-14T12:00:00Z");
const PERIOD_START = Date.parse("2026-11-01T00:00:00Z");

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "operator-budget-")));
  process.env.HOME = home;
  dir = path.join(home, ".automaton");
  const { vi } = await import("vitest");
  vi.resetModules();
  budgetOps = await import("../operator/budget.js");
  config = await import("../config.js");
  database = await import("../state/database.js");
  meterMod = await import("../budget/meter.js");
  ownerDb = await import("../budget/owner-db.js");
  budgetConfig = await import("../budget/config.js");
  instanceLock = await import("../state/instance-lock.js");
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "automaton.json"),
    JSON.stringify({
      name: "agent",
      walletAddress: "0x" + "1".repeat(40),
      creatorAddress: "0x" + "2".repeat(40),
      openaiApiKey: "sk-test",
      providers: { mode: "standalone" },
      budget: { allowanceCents: 2500, period: "monthly", resetDay: 1 },
      ...extra,
    }),
  );
}

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  writeConfig();
});

function ctx() {
  return budgetOps.budgetContext(config.loadConfig()!);
}

function io(answer: boolean | null = null) {
  const lines: string[] = [];
  const asked: string[] = [];
  return {
    lines,
    asked,
    text: () => lines.join("\n"),
    io: {
      log: (l: string) => lines.push(l),
      confirm: async (q: string) => {
        asked.push(q);
        return answer;
      },
      now: () => NOW,
    },
  };
}

const ownerPath = () => path.join(dir, "owner", "owner.db");

function grantsInDb(): Array<{ amount_cents: number; note: string | null; created_at_ms: number }> {
  const db = new Database(ownerPath(), { readonly: true });
  try {
    return db.prepare("SELECT amount_cents, note, created_at_ms FROM budget_grants ORDER BY id").all() as any;
  } finally {
    db.close();
  }
}

describe("financial: budget amount parsing", () => {
  it("takes positive dollars with at most two decimals, up to $10,000", () => {
    expect(budgetOps.parseGrantAmount("10")).toEqual({ ok: true, cents: 1000 });
    expect(budgetOps.parseGrantAmount("2.5")).toEqual({ ok: true, cents: 250 });
    expect(budgetOps.parseGrantAmount("10000")).toEqual({ ok: true, cents: 1_000_000 });
    for (const bad of ["0", "-5", "$5", "1e3", "10000.01", "0.001", "abc", ""]) {
      expect(budgetOps.parseGrantAmount(bad).ok, bad).toBe(false);
    }
  });
});

describe("financial: budget add / remove", () => {
  it("refuses without --yes when there is no terminal, and writes nothing", async () => {
    const t = io(null);
    expect(await budgetOps.runBudgetCli(["add", "10"], t.io, ctx())).toBe(1);
    expect(t.text()).toMatch(/Refusing without confirmation/);
    expect(fs.existsSync(ownerPath())).toBe(false);
  });

  it("an interactive no cancels; an interactive yes writes", async () => {
    const no = io(false);
    expect(await budgetOps.runBudgetCli(["add", "10"], no.io, ctx())).toBe(1);
    expect(fs.existsSync(ownerPath())).toBe(false);
    const yes = io(true);
    expect(await budgetOps.runBudgetCli(["add", "10"], yes.io, ctx())).toBe(0);
    expect(yes.asked[0]).toMatch(/Add \$10\.00\?/);
    expect(grantsInDb()).toEqual([{ amount_cents: 1000, note: null, created_at_ms: NOW }]);
  });

  it("creates the owner database with folder 0755, file 0644 and a rollback journal", async () => {
    const t = io();
    expect(await budgetOps.runBudgetCli(["add", "12.50", "--yes", "--note", "for March"], t.io, ctx())).toBe(0);
    expect(fs.statSync(path.dirname(ownerPath())).mode & 0o777).toBe(0o755);
    expect(fs.statSync(ownerPath()).mode & 0o777).toBe(0o644);
    const db = new Database(ownerPath(), { readonly: true });
    expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("delete");
    db.close();
    expect(fs.existsSync(ownerPath() + "-wal")).toBe(false);
    expect(grantsInDb()).toEqual([{ amount_cents: 1250, note: "for March", created_at_ms: NOW }]);
    expect(t.text()).toMatch(/Remaining now: \$37\.50 of \$37\.50/);
  });

  it("remove writes a negative grant", async () => {
    await budgetOps.runBudgetCli(["add", "10", "--yes"], io().io, ctx());
    const t = io();
    expect(await budgetOps.runBudgetCli(["remove", "4", "--yes"], t.io, ctx())).toBe(0);
    expect(grantsInDb().map((g) => g.amount_cents)).toEqual([1000, -400]);
    expect(t.text()).toMatch(/Remove \$4\.00 from this period's budget/);
  });

  it("warns when no budget is configured, or when Conway mode ignores it", async () => {
    writeConfig({ budget: undefined });
    let t = io();
    expect(await budgetOps.runBudgetCli(["add", "5", "--yes"], t.io, ctx())).toBe(0);
    expect(t.text()).toMatch(/no budget block: the grant is stored but nothing uses it/);

    writeConfig({ providers: { mode: "conway" }, conwayApiKey: "cnwy_k_x" });
    t = io();
    expect(await budgetOps.runBudgetCli(["add", "5", "--yes"], t.io, ctx())).toBe(0);
    expect(t.text()).toMatch(/Conway mode, which ignores the budget/);
  });

  it("works while the agent holds the instance lock (a top-up must reach a running agent)", async () => {
    const c = ctx();
    const lock = instanceLock.acquireInstanceLock(`${c.dbPath}.lock`);
    try {
      expect(await budgetOps.runBudgetCli(["add", "3", "--yes"], io().io, c)).toBe(0);
      expect(await budgetOps.runBudgetCli(["show"], io().io, c)).toBe(0);
    } finally {
      lock.release();
    }
    expect(grantsInDb()).toHaveLength(1);
  });

  it("rejects bad arguments with the usage text", async () => {
    for (const args of [["add"], ["add", "5", "6"], ["add", "5", "--json"], ["give", "5"], ["add", "5", "--bogus"], []]) {
      const t = io();
      expect(await budgetOps.runBudgetCli(args, t.io, ctx()), args.join(" ")).toBe(1);
      expect(t.text()).toMatch(/Usage:/);
    }
  });
});

/** 1 cent = 10,000 micro-USD. state.db as the agent leaves it: AI spend this period (one call in flight), last month, and a payment. */
function seedState(): void {
  const db = database.createDatabase(path.join(dir, "state.db"));
  const raw = db.raw;
  const ins = raw.prepare(
    `INSERT INTO inference_ledger (id, call_id, attempt, status, budget_class, caller, provider, model,
       price_in_usd_per_m, price_out_usd_per_m, est_input_tokens, max_output_tokens, reserved_micro_usd,
       cost_micro_usd, boot_id, created_at_ms)
     VALUES (?, ?, 1, ?, ?, 'test', 'openai', 'gpt', 1, 1, 10, 10, ?, ?, 'b', ?)`,
  );
  ins.run("c1", "c1", "committed", "main", 300_000, 250_000, NOW - 3_600_000); // 25c
  ins.run("c2", "c2", "reserved", "orchestration", 100_000, null, NOW - 60_000); // 10c in flight
  ins.run("c3", "c3", "released", "main", 900_000, null, NOW - 60_000); // 0
  ins.run("c4", "c4", "committed", "survival", 50_000, 40_000, NOW - 120_000); // 4c
  ins.run("old", "old", "committed", "main", 5_000_000, 5_000_000, PERIOD_START - 1); // last period
  raw
    .prepare(
      `INSERT INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents, debits_credits,
         counterparty, dedupe_key, origin_type, created_at_ms, updated_at_ms)
       VALUES ('t1', 'k1', 'x402_payment', 'x402', 'committed', 100, 0, 'payee', 'd1', 'tool', ?, ?)`,
    )
    .run(NOW - 1000, NOW - 1000);
  db.setKV("agent_state", "low_compute");
  db.close();
}

describe("financial: budget show", () => {
  it("matches the runtime meter, lists this period's grants, and shows what is in flight", async () => {
    seedState();
    const w = ownerDb.openOwnerDbForWrite(ownerPath());
    w.addGrant(500, "October", PERIOD_START - 10); // previous period: not counted
    w.addGrant(1000, "top-up", NOW - 5000);
    w.close();

    const t = io();
    expect(await budgetOps.runBudgetCli(["show", "--json"], t.io, ctx())).toBe(0);
    const json = JSON.parse(t.text());

    const stateDb = new Database(path.join(dir, "state.db"), { readonly: true });
    const owner = new ownerDb.OwnerDbReader(ownerPath());
    const snap = new meterMod.BudgetMeter({
      db: stateDb,
      budget: budgetConfig.resolveBudget(config.loadConfig()!.budget)!,
      owner,
      now: () => NOW,
    }).snapshot(NOW);
    owner.close();
    stateDb.close();

    expect(json.remainingMicroUsd).toBe(snap.remainingMicroUsd);
    expect(json.remainingCents).toBe(snap.remainingCents);
    expect(json.tier).toBe(snap.tier);
    // 2500 + 1000 - (25 + 10 + 4) - 100 = 3361 cents
    expect(json.remainingCents).toBe(3361);
    expect(json.grantsCents).toBe(1000);
    expect(json.grants.map((g: { note: string }) => g.note)).toEqual(["top-up"]);
    expect(json.aiInFlightMicroUsd).toBe(100_000);
    expect(json.treasurySpentCents).toBe(100);
    expect(json.agentState).toBe("low_compute");
    expect(json.periodStartMs).toBe(PERIOD_START);
    // ceil(2500 / 15): the cap the runtime clamps to.
    expect(json.dailyCapCents).toBe(167);

    const text = io();
    await budgetOps.runBudgetCli(["show"], text.io, ctx());
    expect(text.text()).toMatch(/Remaining:\s+\$33\.61 of \$35\.00/);
    expect(text.text()).toMatch(/AI spend:\s+\$0\.39 \(of which \$0\.10 in flight\)/);
    expect(text.text()).toMatch(/Period:\s+2026-11-01 to 2026-12-01 UTC/);
    expect(text.text()).not.toMatch(/October/);
  });

  it("opens state.db read-only: it works under the agent's write lock and changes nothing", async () => {
    seedState();
    const stateFile = path.join(dir, "state.db");
    const writer = new Database(stateFile);
    const before = JSON.stringify(writer.prepare("SELECT * FROM inference_ledger ORDER BY id").all());
    const tables = JSON.stringify(writer.prepare("SELECT name FROM sqlite_master ORDER BY name").all());
    writer.exec("BEGIN IMMEDIATE");
    try {
      const t = io();
      expect(await budgetOps.runBudgetCli(["show"], t.io, ctx())).toBe(0);
      expect(t.text()).toMatch(/Remaining:/);
    } finally {
      writer.exec("ROLLBACK");
    }
    expect(JSON.stringify(writer.prepare("SELECT * FROM inference_ledger ORDER BY id").all())).toBe(before);
    expect(JSON.stringify(writer.prepare("SELECT name FROM sqlite_master ORDER BY name").all())).toBe(tables);
    writer.close();
  });

  it("does not create state.db or the owner database", async () => {
    const t = io();
    expect(await budgetOps.runBudgetCli(["show"], t.io, ctx())).toBe(0);
    expect(fs.existsSync(path.join(dir, "state.db"))).toBe(false);
    expect(fs.existsSync(ownerPath())).toBe(false);
    expect(t.text()).toMatch(/Agent state:\s+not started yet/);
    expect(t.text()).toMatch(/not created yet/);
  });

  it("--init creates only the owner database", async () => {
    const t = io();
    expect(await budgetOps.runBudgetCli(["show", "--init"], t.io, ctx())).toBe(0);
    expect(fs.existsSync(ownerPath())).toBe(true);
    expect(fs.existsSync(path.join(dir, "state.db"))).toBe(false);
    expect(grantsInDb()).toEqual([]);
  });

  it("says when there is no budget, and when Conway mode ignores it", async () => {
    writeConfig({ budget: undefined });
    let t = io();
    await budgetOps.runBudgetCli(["show"], t.io, ctx());
    expect(t.text()).toMatch(/No budget configured/);

    writeConfig({ providers: { mode: "conway" }, conwayApiKey: "cnwy_k_x" });
    t = io();
    await budgetOps.runBudgetCli(["show"], t.io, ctx());
    expect(t.text()).toMatch(/Conway mode ignores the budget/);
    expect(budgetOps.budgetStatusLine(budgetOps.budgetReport(ctx(), NOW))).toBe("ignored in Conway mode");
  });

  it("escapes grant notes for the terminal", async () => {
    const w = ownerDb.openOwnerDbForWrite(ownerPath());
    w.addGrant(100, "evil\x1b[2Jnote", NOW - 10);
    w.close();
    const t = io();
    await budgetOps.runBudgetCli(["show"], t.io, ctx());
    expect(t.text()).not.toContain("\x1b");
  });

  it("prints the agent state only when it is a known state (the agent writes kv)", async () => {
    seedState();
    const db = database.createDatabase(path.join(dir, "state.db"));
    db.setKV("agent_state", `dead\x1b]52;c;${Buffer.from("automaton-cli budget add 5000 --yes").toString("base64")}\x07`);
    db.close();
    const t = io();
    await budgetOps.runBudgetCli(["show"], t.io, ctx());
    expect(t.text()).not.toContain("\x1b");
    expect(t.text()).not.toContain("\x07");
    expect(t.text()).toMatch(/Agent state:\s+unknown/);
  });
});

describe("financial: automaton-cli fund in standalone", () => {
  it("is refused with a pointer to budget add; Conway mode is unchanged", () => {
    expect(budgetOps.standaloneFundRefusal(config.loadConfig()!)).toMatch(/automaton-cli budget add/);
    writeConfig({ providers: { mode: "conway" }, conwayApiKey: "cnwy_k_x", budget: undefined });
    expect(budgetOps.standaloneFundRefusal(config.loadConfig()!)).toBeNull();
  });
});
