import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SimpleAgentTracker, SimpleFundingProtocol } from "../../orchestration/simple-tracker.js";
import { createInMemoryDb } from "./test-db.js";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V7 } from "../../state/schema.js";
import { ChildLifecycle } from "../../replication/lifecycle.js";
import { spawnChild } from "../../replication/spawn.js";
import { MockConwayClient, createTestDb, createTestIdentity } from "../mocks.js";

function createMockAutomatonDb(db: BetterSqlite3.Database) {
  return {
    raw: db,
    getChildren: () => {
      return db.prepare("SELECT id, name, address, sandbox_id AS sandboxId, genesis_prompt AS genesisPrompt, creator_message AS creatorMessage, funded_amount_cents AS fundedAmountCents, status, created_at AS createdAt, last_checked AS lastChecked FROM children").all();
    },
    updateChildStatus: (id: string, status: string) => {
      db.prepare("UPDATE children SET status = ? WHERE id = ?").run(status, id);
    },
    insertChild: (child: any) => {
      db.prepare("INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, creator_message, funded_amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(child.id, child.name, child.address, child.sandboxId, child.genesisPrompt, child.creatorMessage, child.fundedAmountCents, child.status, child.createdAt);
    },
  } as any;
}

function insertChild(
  db: BetterSqlite3.Database,
  id: string,
  name: string,
  address: string,
  status = "running",
  role = "generalist",
) {
  db.prepare(
    "INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, funded_amount_cents, status, created_at, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, name, address, "sb-1", "test", 0, status, new Date().toISOString(), role);
}

describe("orchestration/simple-tracker", () => {
  let db: BetterSqlite3.Database;
  let mockDb: ReturnType<typeof createMockAutomatonDb>;
  let tracker: SimpleAgentTracker;

  beforeEach(() => {
    db = createInMemoryDb();
    mockDb = createMockAutomatonDb(db);
    tracker = new SimpleAgentTracker(mockDb);
  });

  afterEach(() => {
    db.close();
  });

  describe("getIdle", () => {
    it("returns children with running status not assigned to active tasks", () => {
      insertChild(db, "c1", "Alice", "0xalice", "running");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(1);
      expect(idle[0].address).toBe("0xalice");
      expect(idle[0].name).toBe("Alice");
    });

    it("returns children with healthy status not assigned to active tasks", () => {
      insertChild(db, "c1", "Bob", "0xbob", "healthy");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(1);
      expect(idle[0].address).toBe("0xbob");
      expect(idle[0].status).toBe("healthy");
    });

    it("excludes children assigned to active tasks", () => {
      insertChild(db, "c1", "Alice", "0xchild1", "running");
      insertChild(db, "c2", "Bob", "0xchild2", "running");

      db.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)").run("g1", "Goal", "Desc", "active", new Date().toISOString());
      db.prepare(
        "INSERT INTO task_graph (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("t1", "g1", "Task", "Desc", "assigned", "0xchild1", "generalist", 50, "[]", new Date().toISOString());

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(1);
      expect(idle[0].address).toBe("0xchild2");
    });

    it("returns empty when no idle children exist", () => {
      const idle = tracker.getIdle();
      expect(idle).toHaveLength(0);
    });

    it("reads role from DB rather than hardcoding generalist", () => {
      insertChild(db, "c1", "Specialist", "0xspec", "running", "researcher");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(1);
      expect(idle[0].role).toBe("researcher");
    });

    it("excludes children with dead status", () => {
      insertChild(db, "c1", "Dead", "0xdead", "dead");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(0);
    });

    it("excludes children with sleeping status", () => {
      insertChild(db, "c1", "Sleeping", "0xsleep", "sleeping");

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(0);
    });

    it("excludes children assigned to running tasks", () => {
      insertChild(db, "c1", "Busy", "0xbusy", "running");

      db.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)").run("g1", "Goal", "Desc", "active", new Date().toISOString());
      db.prepare(
        "INSERT INTO task_graph (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("t2", "g1", "Active Task", "Desc", "running", "0xbusy", "generalist", 50, "[]", new Date().toISOString());

      const idle = tracker.getIdle();

      expect(idle).toHaveLength(0);
    });
  });

  describe("getBestForTask", () => {
    it("returns the first idle agent", () => {
      insertChild(db, "c1", "First", "0xfirst", "running");
      insertChild(db, "c2", "Second", "0xsecond", "running");

      const best = tracker.getBestForTask("generalist");

      expect(best).not.toBeNull();
      expect(best?.address).toBe("0xfirst");
      expect(best?.name).toBe("First");
    });

    it("returns null when no idle agents are available", () => {
      const best = tracker.getBestForTask("generalist");
      expect(best).toBeNull();
    });
  });

  describe("updateStatus", () => {
    it("updates the child status in the DB", () => {
      insertChild(db, "c1", "Agent", "0xagent", "running");

      tracker.updateStatus("0xagent", "healthy");

      const row = db.prepare("SELECT status FROM children WHERE id = ?").get("c1") as { status: string } | undefined;
      expect(row?.status).toBe("healthy");
    });

    it("does nothing for an unknown address", () => {
      insertChild(db, "c1", "Agent", "0xagent", "running");

      expect(() => tracker.updateStatus("0xunknown", "healthy")).not.toThrow();

      const row = db.prepare("SELECT status FROM children WHERE id = ?").get("c1") as { status: string } | undefined;
      expect(row?.status).toBe("running");
    });
  });

  describe("register", () => {
    it("inserts a new child record into the DB", () => {
      tracker.register({
        address: "0xnew",
        name: "NewAgent",
        role: "analyst",
        sandboxId: "sb-42",
      });

      const children = mockDb.getChildren() as any[];
      expect(children).toHaveLength(1);
      expect(children[0].address).toBe("0xnew");
    });

    it("is an upsert by address: a second register adds no row", () => {
      insertChild(db, "c1", "Agent", "0xsame", "running");

      tracker.register({ address: "0xsame", name: "Dup", role: "generalist", sandboxId: "sb-2" });

      const rows = db.prepare("SELECT id FROM children WHERE address = ?").all("0xsame");
      expect(rows).toEqual([{ id: "c1" }]);
    });

    it("stores the role in the genesis prompt", () => {
      tracker.register({
        address: "0xrole",
        name: "RoleAgent",
        role: "security-expert",
        sandboxId: "sb-99",
      });

      const row = db.prepare("SELECT genesis_prompt FROM children WHERE address = ?").get("0xrole") as
        | { genesis_prompt: string }
        | undefined;
      expect(row?.genesis_prompt).toContain("security-expert");
    });
  });
});

describe("orchestration/simple-tracker with lifecycle children (F067, H3-002, H3-003)", () => {
  const CHILD = "0x" + "2".repeat(40);

  function lifecycleDb() {
    const db = createInMemoryDb();
    db.exec(MIGRATION_V7);
    db.exec("ALTER TABLE children ADD COLUMN chain_type TEXT DEFAULT 'evm'");
    return db;
  }

  function makeHealthyLifecycleChild(db: BetterSqlite3.Database, id: string, address: string) {
    const lifecycle = new ChildLifecycle(db);
    lifecycle.initChild(id, "market-researcher", "sb-" + id, "own mission");
    db.prepare("UPDATE children SET address = ? WHERE id = ?").run(address, id);
    for (const state of ["sandbox_created", "runtime_ready", "wallet_verified", "funded", "starting", "healthy"] as const) {
      lifecycle.transition(id, state);
    }
    return lifecycle;
  }

  it("getIdle never offers a lifecycle child as an orchestrator worker", () => {
    const db = lifecycleDb();
    try {
      makeHealthyLifecycleChild(db, "kid", CHILD);
      const tracker = new SimpleAgentTracker(createMockAutomatonDb(db));
      expect(tracker.getIdle()).toEqual([]);
      expect(tracker.getBestForTask("generalist")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("updateStatus does not overwrite a lifecycle child's status", () => {
    const db = lifecycleDb();
    try {
      const lifecycle = makeHealthyLifecycleChild(db, "kid", CHILD);
      const tracker = new SimpleAgentTracker(createMockAutomatonDb(db));

      tracker.updateStatus(CHILD, "running");

      const row = db.prepare("SELECT status FROM children WHERE id = 'kid'").get() as { status: string };
      expect(row.status).toBe("healthy");
      expect(lifecycle.getCurrentState("kid")).toBe("healthy");
    } finally {
      db.close();
    }
  });

  it("updateStatus never revives a terminal legacy row", () => {
    const db = lifecycleDb();
    try {
      insertChild(db, "old", "Old", "0xold", "dead");
      const tracker = new SimpleAgentTracker(createMockAutomatonDb(db));
      tracker.updateStatus("0xold", "starting");
      const row = db.prepare("SELECT status FROM children WHERE id = 'old'").get() as { status: string };
      expect(row.status).toBe("dead");
    } finally {
      db.close();
    }
  });

  it("spawnChild plus register with the same address leaves one row and a single ledger", async () => {
    const db = createTestDb();
    try {
      const conway = new MockConwayClient();
      vi.spyOn(conway, "exec").mockImplementation(async (command: string) => ({
        stdout: command.includes("--init") ? `Wallet: ${CHILD}` : "ok",
        stderr: "",
        exitCode: 0,
      }));
      const identity = createTestIdentity();
      const child = await spawnChild(
        conway,
        identity,
        db,
        { name: "kid", genesisPrompt: "p", creatorAddress: identity.address, parentAddress: identity.address },
        new ChildLifecycle(db.raw),
        { maxChildren: 3 },
      );
      const tracker = new SimpleAgentTracker(db);

      tracker.register({ address: child.address, name: child.name, role: "generalist", sandboxId: child.sandboxId });
      tracker.updateStatus(child.address, "running");
      const funding = new SimpleFundingProtocol(conway, identity, db);
      expect(await funding.fundChild(child.address, 25)).toEqual({ success: true });

      const rows = db.raw.prepare("SELECT status, funded_amount_cents FROM children WHERE address = ?").all(child.address);
      expect(rows).toEqual([{ status: "wallet_verified", funded_amount_cents: 25 }]);
      const sum = db.raw.prepare("SELECT SUM(funded_amount_cents) AS s FROM children").get() as { s: number };
      expect(sum.s).toBe(25);
    } finally {
      db.close();
    }
  });

  it("refuses to fund a child whose rows have all ended", async () => {
    const db = createTestDb();
    try {
      const conway = new MockConwayClient();
      const transfer = vi.spyOn(conway, "transferCredits");
      db.insertChild({
        id: "gone",
        name: "gone",
        address: CHILD as `0x${string}`,
        sandboxId: "sb",
        genesisPrompt: "p",
        fundedAmountCents: 0,
        status: "failed",
        createdAt: new Date().toISOString(),
      });
      const funding = new SimpleFundingProtocol(conway, createTestIdentity(), db);
      expect(await funding.fundChild(CHILD, 250)).toEqual({ success: false });
      expect(transfer).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

describe("orchestration/SimpleFundingProtocol", () => {
  let fundingDb: BetterSqlite3.Database;

  beforeEach(() => {
    fundingDb = createInMemoryDb();
    // Insert a child for funding tests
    fundingDb.prepare(
      "INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, funded_amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("c1", "child-1", "0xchild", "sb-1", "test", 0, "running", new Date().toISOString());
  });

  afterEach(() => {
    fundingDb.close();
  });

  function makeMockDb(raw: BetterSqlite3.Database) {
    return { raw } as any;
  }

  it("fundChild calls transferCredits with the correct amount", async () => {
    const mockConway = {
      transferCredits: vi.fn().mockResolvedValue({ status: "ok", amountCents: 100 }),
      getCreditsBalance: vi.fn().mockResolvedValue(500),
    } as any;

    const identity = { address: "0xparent" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const result = await funding.fundChild("0xchild", 100);

    expect(result.success).toBe(true);
    expect(mockConway.transferCredits).toHaveBeenCalledWith(
      "0xchild",
      100,
      "Task funding from orchestrator",
    );
  });

  it("fundChild updates funded_amount_cents in the children table on success", async () => {
    const mockConway = {
      transferCredits: vi.fn().mockResolvedValue({ status: "ok" }),
    } as any;

    const identity = { address: "0xparent" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    await funding.fundChild("0xchild", 200);

    const row = fundingDb.prepare("SELECT funded_amount_cents FROM children WHERE address = ?").get("0xchild") as any;
    expect(row.funded_amount_cents).toBe(200);
  });

  it("fundChild returns success:true for zero amount without calling transferCredits", async () => {
    const mockConway = {
      transferCredits: vi.fn(),
      getCreditsBalance: vi.fn().mockResolvedValue(0),
    } as any;

    const identity = { address: "0xparent" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const result = await funding.fundChild("0xchild", 0);

    expect(result.success).toBe(true);
    expect(mockConway.transferCredits).not.toHaveBeenCalled();
  });

  it("fundChild returns success:false when transferCredits throws", async () => {
    const mockConway = {
      transferCredits: vi.fn().mockRejectedValue(new Error("network failure")),
      getCreditsBalance: vi.fn().mockResolvedValue(200),
    } as any;

    const identity = { address: "0xparent" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const result = await funding.fundChild("0xchild", 50);

    expect(result.success).toBe(false);
  });

  it("getBalance returns funded_amount_cents from the children table", async () => {
    fundingDb.prepare("UPDATE children SET funded_amount_cents = 350 WHERE address = ?").run("0xchild");

    const mockConway = {} as any;
    const identity = { address: "0xparent" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const balance = await funding.getBalance("0xchild");
    expect(balance).toBe(350);
  });

  it("getBalance returns 0 for unknown address", async () => {
    const mockConway = {} as any;
    const identity = { address: "0xparent" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const balance = await funding.getBalance("0xunknown");
    expect(balance).toBe(0);
  });

  it("recallCredits calls transferCredits back to the parent address", async () => {
    // Fund the child first so there's a balance to recall
    fundingDb.prepare("UPDATE children SET funded_amount_cents = 500 WHERE address = ?").run("0xchild");

    const mockConway = {
      transferCredits: vi.fn().mockResolvedValue({ status: "ok", amountCents: 500 }),
      getCreditsBalance: vi.fn().mockResolvedValue(500),
    } as any;

    const identity = { address: "0xparent" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    const result = await funding.recallCredits("0xchild");

    expect(result.success).toBe(true);
    expect(result.amountCents).toBe(500);
    expect(mockConway.transferCredits).toHaveBeenCalledWith(
      "0xparent",
      500,
      "Recall credits from 0xchild",
    );
  });

  it("recallCredits decrements funded_amount_cents after successful recall", async () => {
    fundingDb.prepare("UPDATE children SET funded_amount_cents = 500 WHERE address = ?").run("0xchild");

    const mockConway = {
      transferCredits: vi.fn().mockResolvedValue({ status: "ok", amountCents: 500 }),
    } as any;

    const identity = { address: "0xparent" } as any;
    const funding = new SimpleFundingProtocol(mockConway, identity, makeMockDb(fundingDb));

    await funding.recallCredits("0xchild");

    const row = fundingDb.prepare("SELECT funded_amount_cents FROM children WHERE address = ?").get("0xchild") as any;
    expect(row.funded_amount_cents).toBe(0);
  });
});
