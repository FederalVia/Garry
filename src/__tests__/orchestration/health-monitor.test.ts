import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HealthMonitor,
  unhealthySignature,
  type HealthReport,
} from "../../orchestration/health-monitor.js";
import { createInMemoryDb } from "./test-db.js";

// ---------------------------------------------------------------------------
// Mock AutomatonDatabase
// ---------------------------------------------------------------------------

function createMockAutomatonDb(db: BetterSqlite3.Database) {
  return {
    raw: db,
    getChildren: () => {
      return db
        .prepare(
          `SELECT
             id,
             name,
             address,
             sandbox_id        AS sandboxId,
             genesis_prompt    AS genesisPrompt,
             creator_message   AS creatorMessage,
             funded_amount_cents AS fundedAmountCents,
             status,
             created_at        AS createdAt,
             last_checked      AS lastChecked
           FROM children`,
        )
        .all();
    },
    getUnprocessedInboxMessages: () => [],
    markInboxMessageProcessed: vi.fn(),
    getIdentity: () => "0xparent",
    updateChildStatus: (id: string, status: string) => {
      db.prepare("UPDATE children SET status = ? WHERE id = ?").run(status, id);
    },
  } as any;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertChild(
  db: BetterSqlite3.Database,
  opts: {
    id: string;
    name: string;
    address: string;
    status: string;
    lastChecked?: string | null;
    funded?: number;
  },
) {
  db.prepare(
    `INSERT INTO children
       (id, name, address, sandbox_id, genesis_prompt, funded_amount_cents, status, created_at, last_checked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.name,
    opts.address,
    "sb-1",
    "test",
    opts.funded ?? 0,
    opts.status,
    new Date().toISOString(),
    opts.lastChecked ?? null,
  );
}

function insertGoal(db: BetterSqlite3.Database, id: string) {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, "Test Goal", "Test goal description", "active", new Date().toISOString());
}

function insertTask(
  db: BetterSqlite3.Database,
  opts: {
    id: string;
    goalId: string;
    assignedTo: string;
    status: string;
    startedAt?: string | null;
    completedAt?: string | null;
    timeoutMs?: number;
    retryCount?: number;
    maxRetries?: number;
    createdAt?: string;
  },
) {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO task_graph
       (id, goal_id, title, description, status, assigned_to, started_at, completed_at,
        timeout_ms, retry_count, max_retries, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.goalId,
    `Task ${opts.id}`,
    "Description",
    opts.status,
    opts.assignedTo,
    opts.startedAt ?? null,
    opts.completedAt ?? null,
    opts.timeoutMs ?? 300000,
    opts.retryCount ?? 0,
    opts.maxRetries ?? 3,
    createdAt,
  );
}

// ---------------------------------------------------------------------------
// Mock FundingProtocol (reads the real children ledger)
// ---------------------------------------------------------------------------

function createLedgerFunding(db: BetterSqlite3.Database, fundSuccess = true) {
  return {
    getBalance: vi.fn(async (address: string) => {
      const row = db.prepare("SELECT funded_amount_cents AS f FROM children WHERE address = ?").get(address) as
        | { f: number }
        | undefined;
      return row?.f ?? 0;
    }),
    fundChild: vi.fn().mockResolvedValue({ success: fundSuccess }),
    recallCredits: vi.fn().mockResolvedValue({ success: true, amountCents: 0 }),
  };
}

const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);
const WALLET_C = "0x" + "c".repeat(40);

function snapshot(db: BetterSqlite3.Database) {
  return {
    children: db.prepare("SELECT id, status, funded_amount_cents FROM children ORDER BY id").all(),
    tasks: db.prepare("SELECT id, status, assigned_to, retry_count, result FROM task_graph ORDER BY id").all(),
    inbox: db.prepare("SELECT COUNT(*) AS n FROM inbox_messages").get(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orchestration/health-monitor (report only)", () => {
  let db: BetterSqlite3.Database;
  let mockDb: ReturnType<typeof createMockAutomatonDb>;
  let funding: ReturnType<typeof createLedgerFunding>;
  let monitor: HealthMonitor;

  beforeEach(() => {
    db = createInMemoryDb();
    mockDb = createMockAutomatonDb(db);
    funding = createLedgerFunding(db);
    monitor = new HealthMonitor(mockDb, funding);
  });

  afterEach(() => {
    db.close();
  });

  describe("checkAll", () => {
    it("returns empty report when no children", async () => {
      const report = await monitor.checkAll();

      expect(report.totalAgents).toBe(0);
      expect(report.healthyAgents).toBe(0);
      expect(report.unhealthyAgents).toBe(0);
      expect(report.deadAgents).toBe(0);
      expect(report.agents).toEqual([]);
      expect(report.timestamp).toBeTruthy();
    });

    it("reports a healthy child with recent activity", async () => {
      insertChild(db, {
        id: "c1",
        name: "Agent1",
        address: WALLET_A,
        status: "healthy",
        lastChecked: new Date(Date.now() - 60_000).toISOString(),
        funded: 500,
      });

      const report = await monitor.checkAll();

      expect(report.totalAgents).toBe(1);
      expect(report.healthyAgents).toBe(1);
      const agent = report.agents[0];
      expect(agent.healthy).toBe(true);
      expect(agent.issues).toEqual([]);
      expect(agent.creditBalance).toBe(500);
    });

    it("skips ended, terminal, empty-address and local worker rows (F071)", async () => {
      insertChild(db, { id: "dead", name: "d", address: "0xdead", status: "dead", funded: 0 });
      insertChild(db, { id: "clean", name: "c", address: "0xclean", status: "cleaned_up", funded: 0 });
      insertChild(db, { id: "failed", name: "f", address: "", status: "failed", funded: 0 });
      insertChild(db, { id: "stopped", name: "s", address: "0xstopped", status: "stopped", funded: 0 });
      insertChild(db, { id: "local", name: "l", address: "local://local-worker-1", status: "running", funded: 0 });

      const report = await monitor.checkAll();

      expect(report.totalAgents).toBe(0);
      expect(funding.getBalance).not.toHaveBeenCalled();
    });

    it("reports legacy rows that may still run (no lifecycle events)", async () => {
      insertChild(db, { id: "legacy", name: "legacy", address: WALLET_B, status: "running", lastChecked: new Date().toISOString(), funded: 500 });

      const report = await monitor.checkAll();

      expect(report.agents.map((a) => a.address)).toEqual([WALLET_B]);
    });

    it("reports pre-start children without credit or activity issues", async () => {
      insertChild(db, { id: "wv", name: "wv", address: WALLET_A, status: "wallet_verified", funded: 0 });

      const report = await monitor.checkAll();

      expect(report.agents).toHaveLength(1);
      expect(report.agents[0].healthy).toBe(true);
    });

    it("flags an unhealthy lifecycle child", async () => {
      insertChild(db, {
        id: "u",
        name: "u",
        address: WALLET_A,
        status: "unhealthy",
        lastChecked: new Date().toISOString(),
        funded: 500,
      });

      const report = await monitor.checkAll();

      expect(report.unhealthyAgents).toBe(1);
      expect(report.agents[0].issues).toContain("process_unhealthy");
    });

    it("flags stale activity only after 45 minutes", async () => {
      insertChild(db, {
        id: "old",
        name: "old",
        address: WALLET_A,
        status: "healthy",
        lastChecked: new Date(Date.now() - 50 * 60_000).toISOString(),
        funded: 500,
      });
      insertChild(db, {
        id: "recent",
        name: "recent",
        address: WALLET_B,
        status: "healthy",
        lastChecked: new Date(Date.now() - 40 * 60_000).toISOString(),
        funded: 500,
      });

      const report = await monitor.checkAll();
      const byAddress = new Map(report.agents.map((a) => [a.address, a]));

      expect(byAddress.get(WALLET_A)?.issues).toContain("activity_stale");
      expect(byAddress.get(WALLET_B)?.issues).toEqual([]);
    });

    it("reads zone-less SQLite timestamps as UTC (H3-005)", async () => {
      insertChild(db, { id: "c1", name: "c1", address: WALLET_A, status: "healthy", funded: 500 });
      // datetime('now', '-2 minutes') is UTC without a zone.
      db.prepare("UPDATE children SET last_checked = datetime('now', '-2 minutes') WHERE id = 'c1'").run();

      const report = await monitor.checkAll();

      expect(report.agents[0].issues).toEqual([]);
      const ms = Date.parse(report.agents[0].lastHeartbeat!);
      expect(Math.abs(Date.now() - 2 * 60_000 - ms)).toBeLessThan(5_000);
    });

    it("detects out_of_credits for a live child with an empty ledger", async () => {
      insertChild(db, {
        id: "broke",
        name: "broke",
        address: WALLET_A,
        status: "healthy",
        lastChecked: new Date().toISOString(),
        funded: 5,
      });

      const report = await monitor.checkAll();

      expect(report.agents[0].issues).toContain("out_of_credits");
      expect(report.agents[0].creditBalance).toBe(5);
    });
  });

  describe("autoHeal", () => {
    async function brokeChildReport(): Promise<HealthReport> {
      insertChild(db, {
        id: "broke",
        name: "broke",
        address: WALLET_A,
        status: "healthy",
        lastChecked: new Date().toISOString(),
        funded: 0,
      });
      return monitor.checkAll();
    }

    it("does nothing by default: auto-funding is off", async () => {
      const report = await brokeChildReport();
      expect(report.agents[0].issues).toContain("out_of_credits");

      const actions = await monitor.autoHeal(report);

      expect(actions).toEqual([]);
      expect(funding.fundChild).not.toHaveBeenCalled();
    });

    it("funds a live child when autoFund is on", async () => {
      monitor = new HealthMonitor(mockDb, funding, { autoFund: true });
      const report = await brokeChildReport();

      const actions = await monitor.autoHeal(report);

      expect(actions).toEqual([
        expect.objectContaining({ type: "fund", agentAddress: WALLET_A, success: true }),
      ]);
      expect(funding.fundChild).toHaveBeenCalledWith(WALLET_A, 250);
    });

    it("never funds a child whose row has ended, even when a stale report says so", async () => {
      monitor = new HealthMonitor(mockDb, funding, { autoFund: true });
      const report = await brokeChildReport();
      db.prepare("UPDATE children SET status = 'failed' WHERE id = 'broke'").run();
      insertChild(db, { id: "empty", name: "empty", address: "", status: "failed", funded: 0 });
      const forged: HealthReport = {
        ...report,
        agents: [
          ...report.agents,
          { ...report.agents[0], address: "", name: "empty", status: "healthy" },
        ],
      };

      const actions = await monitor.autoHeal(forged);

      expect(actions).toEqual([]);
      expect(funding.fundChild).not.toHaveBeenCalled();
    });

    it("reports a funding failure without throwing", async () => {
      funding = createLedgerFunding(db, false);
      monitor = new HealthMonitor(mockDb, funding, { autoFund: true });
      const report = await brokeChildReport();

      const actions = await monitor.autoHeal(report);

      expect(actions).toEqual([expect.objectContaining({ type: "fund", success: false })]);
    });

    it("never restarts, stops or messages children and never touches tasks (F071, F072, H3-007)", async () => {
      monitor = new HealthMonitor(mockDb, funding, { autoFund: true });
      // The H3-007 fixture: an error-loop agent holding a task, plus the
      // F071 terminal rows and a task created 20 minutes before assignment.
      insertChild(db, { id: "x", name: "x", address: WALLET_A, status: "healthy", lastChecked: null, funded: 500 });
      insertChild(db, { id: "dead", name: "d", address: "0xdead", status: "dead" });
      insertChild(db, { id: "clean", name: "c", address: "0xclean", status: "cleaned_up" });
      insertChild(db, { id: "nf", name: "nf", address: "", status: "failed" });
      insertChild(db, { id: "busy", name: "busy", address: WALLET_C, status: "healthy", lastChecked: new Date().toISOString(), funded: 500 });
      insertGoal(db, "g1");
      insertTask(db, { id: "f1", goalId: "g1", assignedTo: WALLET_A, status: "failed", completedAt: new Date().toISOString() });
      insertTask(db, { id: "f2", goalId: "g1", assignedTo: WALLET_A, status: "failed", completedAt: new Date().toISOString() });
      insertTask(db, { id: "ok", goalId: "g1", assignedTo: WALLET_A, status: "completed", completedAt: new Date().toISOString() });
      insertTask(db, { id: "current", goalId: "g1", assignedTo: WALLET_A, status: "assigned" });
      insertTask(db, {
        id: "late",
        goalId: "g1",
        assignedTo: WALLET_C,
        status: "assigned",
        createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      });
      const before = snapshot(db);

      const report = await monitor.checkAll();
      const actions = await monitor.autoHeal(report);

      expect(actions.every((a) => a.type === "fund")).toBe(true);
      expect(snapshot(db)).toEqual(before);
      expect(report.agents.map((a) => a.address).sort()).toEqual([WALLET_A, WALLET_C].sort());
    });
  });

  describe("unhealthySignature", () => {
    it("ignores healthy agents and ordering", () => {
      const a = { address: "0xa", name: "a", status: "unhealthy", healthy: false, lastHeartbeat: null, currentTaskId: null, creditBalance: null, errorRate: 0, issues: ["x", "y"] };
      const b = { ...a, address: "0xb", issues: ["y", "x"] };
      const ok = { ...a, address: "0xc", healthy: true, issues: [] };
      expect(unhealthySignature({ agents: [a, b, ok] })).toBe(unhealthySignature({ agents: [b, { ...a, issues: ["y", "x"] }] }));
      expect(unhealthySignature({ agents: [ok] })).toBe("[]");
    });
  });
});
