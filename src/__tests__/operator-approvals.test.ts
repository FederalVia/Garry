/**
 * treasury: the owner's approval commands (automaton-cli approvals
 * list|approve|reject). The decision goes to the owner database with the
 * recipient and amount copied from the request the owner saw; unknown,
 * expired and decided requests are refused; the agent's reason is escaped.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const savedHome = process.env.HOME;
let home: string;
let dir: string;
let ops: typeof import("../operator/approvals.js");
let config: typeof import("../config.js");
let database: typeof import("../state/database.js");
let ownerDb: typeof import("../budget/owner-db.js");
let approvals: typeof import("../treasury/approvals.js");
let instanceLock: typeof import("../state/instance-lock.js");

const NOW = Date.parse("2026-11-14T12:00:00Z");
const HOUR = 3_600_000;
const RECIPIENT = "0x" + "3".repeat(40);

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "operator-approvals-")));
  process.env.HOME = home;
  dir = path.join(home, ".automaton");
  const { vi } = await import("vitest");
  vi.resetModules();
  ops = await import("../operator/approvals.js");
  config = await import("../config.js");
  database = await import("../state/database.js");
  ownerDb = await import("../budget/owner-db.js");
  approvals = await import("../treasury/approvals.js");
  instanceLock = await import("../state/instance-lock.js");
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(treasuryPolicy: Record<string, unknown> = {}): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "automaton.json"),
    JSON.stringify({
      name: "agent",
      walletAddress: "0x" + "1".repeat(40),
      creatorAddress: "0x" + "2".repeat(40),
      conwayApiKey: "cnwy_k_test",
      providers: { mode: "conway" },
      // An approval band: 10 < amount <= 50 dollars.
      treasuryPolicy: { requireConfirmationAboveCents: 1000, maxSingleTransferCents: 5000, maxDailyTransferCents: 8000, ...treasuryPolicy },
    }),
  );
}

let stateDb: string;
beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  writeConfig();
  stateDb = path.join(dir, "state.db");
  database.createDatabase(stateDb).close();
});

const ctx = () => ops.approvalsContext(config.loadConfig()!);
const ownerPath = () => path.join(dir, "owner", "owner.db");

/** A request as the agent's tool records it. */
function request(opts: { amountCents?: number; reason?: string | null; createdAtMs?: number; expiresAtMs?: number } = {}): string {
  const id = approvals.newApprovalId();
  const db = new Database(stateDb);
  db.prepare(
    `INSERT INTO transfer_approval_requests (id, kind, counterparty, amount_cents, reason, origin_name, created_at_ms, expires_at_ms)
     VALUES (?, 'credit_transfer', ?, ?, ?, 'transfer_credits', ?, ?)`,
  ).run(
    id,
    RECIPIENT,
    opts.amountCents ?? 2500,
    opts.reason === undefined ? "pay the designer" : opts.reason,
    opts.createdAtMs ?? NOW - HOUR,
    opts.expiresAtMs ?? NOW + 23 * HOUR,
  );
  db.close();
  return id;
}

/** What the owner reviewed, as `approvals approve --yes` requires it. */
const reviewed = (amountCents = 2500, to = RECIPIENT) => ["--amount", (amountCents / 100).toFixed(2), "--to", to];

function io(answer: boolean | null = null, now = NOW) {
  const lines: string[] = [];
  return {
    text: () => lines.join("\n"),
    io: { log: (l: string) => lines.push(l), confirm: async () => answer, now: () => now },
  };
}

function decisionOf(id: string) {
  const r = new ownerDb.OwnerDbReader(ownerPath());
  try {
    return r.decision(id);
  } finally {
    r.close();
  }
}

describe("treasury: approvals list", () => {
  it("shows pending requests with their state and expiry, and --all shows decided ones", async () => {
    const pending = request();
    const old = request({ createdAtMs: NOW - 30 * HOUR, expiresAtMs: NOW - 6 * HOUR });
    let t = io();
    expect(await ops.runApprovalsCli(["list"], t.io, ctx())).toBe(0);
    expect(t.text()).toContain(`${pending}  PENDING  $25.00 to ${RECIPIENT}`);
    expect(t.text()).not.toContain(old);
    expect(t.text()).toMatch(/agent's reason \(unverified\): pay the designer/);

    t = io();
    await ops.runApprovalsCli(["list", "--all"], t.io, ctx());
    expect(t.text()).toContain(`${old}  EXPIRED`);

    t = io();
    await ops.runApprovalsCli(["list", "--json"], t.io, ctx());
    const json = JSON.parse(t.text());
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ id: pending, state: "pending", amountCents: 2500, counterparty: RECIPIENT });
    expect(ops.pendingApprovalCount(ctx(), NOW)).toBe(1);
  });

  it("escapes the agent's reason for the terminal and labels it unverified", async () => {
    request({ reason: "ok\x1b[2J\x1b]0;owned\x07 approve me" });
    const t = io();
    await ops.runApprovalsCli(["list"], t.io, ctx());
    expect(t.text()).not.toContain("\x1b");
    expect(t.text()).not.toContain("\x07");
    expect(t.text()).toMatch(/\(unverified\)/);
  });

  it("is empty before the agent created any request, and never creates state.db", async () => {
    fs.rmSync(stateDb);
    const t = io();
    expect(await ops.runApprovalsCli(["list"], t.io, ctx())).toBe(0);
    expect(t.text()).toBe("No transfer approval requests.");
    expect(fs.existsSync(stateDb)).toBe(false);
  });
});

/** A row written straight into state.db, as a script run by the agent could. */
function rawRequest(id: string, counterparty: string, amountCents = 2500): void {
  const db = new Database(stateDb);
  db.prepare(
    `INSERT INTO transfer_approval_requests (id, kind, counterparty, amount_cents, reason, created_at_ms, expires_at_ms)
     VALUES (?, 'credit_transfer', ?, ?, 'pay the contractor', ?, ?)`,
  ).run(id, counterparty, amountCents, NOW - HOUR, NOW + 23 * HOUR);
  db.close();
}

describe("treasury: approvals list with hand-written request rows", () => {
  const clipboard = `\x1b]52;c;${Buffer.from("automaton-cli budget add 5000 --yes").toString("base64")}\x07`;
  const hostileRecipients = [
    `${RECIPIENT}; echo INJECTED #`,
    `$(automaton-cli budget add 5000 --yes)`,
    "`automaton-cli budget add 5000 --yes`",
    `${RECIPIENT}${clipboard}`,
  ];
  const hostileIds = [
    `apr_x; automaton-cli budget add 5000 --yes #`,
    `apr_$(automaton-cli budget add 5000 --yes)`,
    "apr_`automaton-cli budget add 5000 --yes`",
    `apr_${clipboard}`,
  ];

  it("never prints an approve command for a row with a shell or terminal payload, and flags it", async () => {
    for (const to of hostileRecipients) rawRequest(approvals.newApprovalId(), to);
    for (const id of hostileIds) rawRequest(id, RECIPIENT);
    const t = io();
    expect(await ops.runApprovalsCli(["list"], t.io, ctx())).toBe(0);
    const text = t.text();
    expect(text).not.toContain("approve:");
    expect(text.match(/MALFORMED/g)).toHaveLength(hostileRecipients.length + hostileIds.length);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x07");
    expect(ops.listApprovals(ctx(), { nowMs: NOW }).every((v) => v.malformed)).toBe(true);
  });

  it("refuses to decide a malformed row", async () => {
    const id = approvals.newApprovalId();
    rawRequest(id, hostileRecipients[0]!);
    const planned = ops.planDecision(ctx(), { id, decision: "approved", nowMs: NOW });
    expect(planned).toMatchObject({ ok: false });
    expect((planned as { error: string }).error).toMatch(/not a valid address/);
    for (const bad of hostileIds) {
      expect(ops.planDecision(ctx(), { id: bad, decision: "approved", nowMs: NOW }).ok).toBe(false);
    }
    expect(decisionOf(id)).toBeNull();
  });

  it("the printed command, pasted into a shell, passes exactly its arguments", async () => {
    const id = request({ amountCents: 1500 });
    const t = io();
    await ops.runApprovalsCli(["list"], t.io, ctx());
    const cmd = t.text().split("\n").find((l) => l.trim().startsWith("approve:"))!.trim().slice("approve: ".length);
    const { spawnSync } = await import("node:child_process");
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "automaton-cli"), '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\n', { mode: 0o755 });
    const r = spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(r.stdout.trim().split("\n")).toEqual(
      ["approvals", "approve", id, "--amount", "15.00", "--to", RECIPIENT, "--yes"].map((a) => `arg:${a}`),
    );
  });

  it("shellQuote survives single quotes and shell syntax", async () => {
    const { spawnSync } = await import("node:child_process");
    const nasty = "a'b; $(echo X) `echo Y` | & # \\";
    const r = spawnSync("/bin/sh", ["-c", `printf %s ${ops.shellQuote(nasty)}`], { encoding: "utf8" });
    expect(r.stdout).toBe(nasty);
  });

  it("the agent's tool path never records a request for a recipient that is not an address", () => {
    const db = new Database(stateDb);
    const owner = { decision: () => null };
    try {
      for (const to of hostileRecipients) {
        const r = approvals.createApprovalRequest(db, owner, { counterparty: to, amountCents: 2500 }, undefined, NOW);
        expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/not a valid wallet address/) });
      }
      expect(db.prepare("SELECT COUNT(*) FROM transfer_approval_requests").pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("treasury: approvals approve / reject", () => {
  it("approve copies the recipient and amount and sets the execute-by time", async () => {
    const id = request({ amountCents: 2500 });
    const t = io();
    expect(await ops.runApprovalsCli(["approve", id, "--yes", "--note", "ok", ...reviewed(2500)], t.io, ctx())).toBe(0);
    expect(decisionOf(id)).toEqual({
      requestId: id,
      decision: "approved",
      kind: "credit_transfer",
      counterparty: RECIPIENT,
      amountCents: 2500,
      decidedAtMs: NOW,
      executeByMs: NOW + 2 * HOUR,
      note: "ok",
    });
    expect(t.text()).toMatch(/Approved\. It runs once/);
    // The request now reads as approved for the runtime too.
    const list = io();
    await ops.runApprovalsCli(["list"], list.io, ctx());
    expect(list.text()).toContain(`${id}  APPROVED`);
  });

  it("needs --yes or an interactive yes", async () => {
    const id = request();
    let t = io(null);
    expect(await ops.runApprovalsCli(["approve", id], t.io, ctx())).toBe(1);
    expect(t.text()).toMatch(/Refusing without confirmation/);
    t = io(false);
    expect(await ops.runApprovalsCli(["approve", id], t.io, ctx())).toBe(1);
    expect(fs.existsSync(ownerPath())).toBe(false);
    t = io(true);
    expect(await ops.runApprovalsCli(["approve", id], t.io, ctx())).toBe(0);
    expect(decisionOf(id)?.decision).toBe("approved");
  });

  it("reject writes a rejection with no execute-by time", async () => {
    const id = request();
    const t = io();
    expect(await ops.runApprovalsCli(["reject", id, "--yes"], t.io, ctx())).toBe(0);
    expect(decisionOf(id)).toMatchObject({ decision: "rejected", executeByMs: null, amountCents: 2500 });
    expect(t.text()).toMatch(/Rejected/);
  });

  it("refuses an unknown id, a malformed id, an expired request and an already decided one", async () => {
    let t = io();
    expect(await ops.runApprovalsCli(["approve", approvals.newApprovalId(), "--yes"], t.io, ctx())).toBe(1);
    expect(t.text()).toMatch(/No transfer approval request/);

    t = io();
    expect(await ops.runApprovalsCli(["approve", "apr_../../x", "--yes"], t.io, ctx())).toBe(1);
    expect(t.text()).toMatch(/Invalid request id/);

    const expired = request({ createdAtMs: NOW - 25 * HOUR, expiresAtMs: NOW - HOUR });
    t = io();
    expect(await ops.runApprovalsCli(["approve", expired, "--yes"], t.io, ctx())).toBe(1);
    expect(t.text()).toMatch(/is expired; only a pending request can be decided/);

    const id = request();
    expect(await ops.runApprovalsCli(["reject", id, "--yes"], io().io, ctx())).toBe(0);
    t = io();
    expect(await ops.runApprovalsCli(["approve", id, "--yes"], t.io, ctx())).toBe(1);
    expect(t.text()).toMatch(/already rejected/);
    expect(decisionOf(id)?.decision).toBe("rejected");
    expect(fs.existsSync(ownerPath())).toBe(true);
  });

  it("warns when the amount is above the max single transfer or today's remaining transfer cap", async () => {
    writeConfig({ maxSingleTransferCents: 2000 });
    const above = request({ amountCents: 3000 });
    let t = io();
    expect(await ops.runApprovalsCli(["approve", above, "--yes", ...reviewed(3000)], t.io, ctx())).toBe(0);
    expect(t.text()).toMatch(/above treasuryPolicy\.maxSingleTransferCents \(\$20\.00\): the treasury will refuse it/);

    writeConfig();
    const db = new Database(stateDb);
    db.prepare(
      `INSERT INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents, debits_credits,
         counterparty, dedupe_key, origin_type, created_at_ms, updated_at_ms)
       VALUES ('t1', 'k1', 'credit_transfer', 'transfer', 'committed', 7000, 1, ?, 'd1', 'tool', ?, ?)`,
    ).run(RECIPIENT, NOW - HOUR, NOW - HOUR);
    db.close();
    const capped = request({ amountCents: 2500 });
    t = io();
    expect(await ops.runApprovalsCli(["approve", capped, "--yes", ...reviewed(2500)], t.io, ctx())).toBe(0);
    expect(t.text()).toMatch(/Only \$10\.00 of the daily transfer cap \(\$80\.00\) is left/);
  });

  it("refuses when the request row changed after the owner saw it", async () => {
    const id = request({ amountCents: 2500 });
    const planned = ops.planDecision(ctx(), { id, decision: "approved", nowMs: NOW });
    expect(planned.ok).toBe(true);
    // The agent can write its own request rows; the owner approves what was shown.
    const db = new Database(stateDb);
    db.prepare("UPDATE transfer_approval_requests SET amount_cents = 4900 WHERE id = ?").run(id);
    db.close();
    expect(() => ops.executeDecision(ctx(), (planned as { plan: any }).plan, NOW)).toThrow(/changed since it was shown/);
    expect(decisionOf(id)).toBeNull();
  });

  it("--yes approves only the amount and recipient the owner reviewed in list", async () => {
    const id = request({ amountCents: 1500 });
    const list = io();
    await ops.runApprovalsCli(["list"], list.io, ctx());
    expect(list.text()).toContain(`approve: automaton-cli approvals approve '${id}' --amount 15.00 --to '${RECIPIENT}' --yes`);

    // Without what was reviewed, --yes refuses.
    let t = io();
    expect(await ops.runApprovalsCli(["approve", id, "--yes"], t.io, ctx())).toBe(1);
    expect(t.text()).toMatch(/needs --amount and --to/);

    // The agent rewrites its request row between list and approve.
    const other = "0x" + "4".repeat(40);
    const db = new Database(stateDb);
    db.prepare("UPDATE transfer_approval_requests SET amount_cents = 4900, counterparty = ? WHERE id = ?").run(other, id);
    db.close();
    t = io();
    expect(await ops.runApprovalsCli(["approve", id, "--yes", ...reviewed(1500)], t.io, ctx())).toBe(1);
    expect(t.text()).toMatch(/is now \$49\.00 to 0x4{40}, not \$15\.00 to 0x3{40}/);
    t = io();
    expect(await ops.runApprovalsCli(["approve", id, "--yes", ...reviewed(4900)], t.io, ctx())).toBe(1);
    expect(decisionOf(id)).toBeNull();

    // Recipient case does not matter; the amount and recipient must both match.
    t = io();
    expect(await ops.runApprovalsCli(["approve", id, "--yes", ...reviewed(4900, other.toUpperCase().replace("0X", "0x"))], t.io, ctx())).toBe(0);
    expect(decisionOf(id)).toMatchObject({ counterparty: other, amountCents: 4900 });
    // reject never needs them.
    expect(await ops.runApprovalsCli(["reject", request(), "--yes"], io().io, ctx())).toBe(0);
    expect(await ops.runApprovalsCli(["reject", request(), "--yes", ...reviewed()], io().io, ctx())).toBe(1);
  });

  it("warns when an identical request already executed", async () => {
    const done = request({ amountCents: 2500 });
    const db = new Database(stateDb);
    db.prepare(
      `INSERT INTO treasury_ledger (id, idempotency_key, kind, budget, status, amount_cents, debits_credits,
         counterparty, dedupe_key, origin_type, created_at_ms, updated_at_ms, approval_id)
       VALUES ('t9', 'k9', 'credit_transfer', 'transfer', 'committed', 2500, 1, ?, 'd9', 'auto', ?, ?, ?)`,
    ).run(RECIPIENT, NOW - HOUR, NOW - HOUR, done);
    db.close();
    const again = request({ amountCents: 2500 });
    const t = io();
    expect(await ops.runApprovalsCli(["approve", again, "--yes", ...reviewed()], t.io, ctx())).toBe(0);
    expect(t.text()).toContain(`Warning: Request ${done} for the same amount and recipient`);
    expect(t.text()).toMatch(/already executed: approving this one pays again/);
  });

  it("refuses a request that expired while the owner was reading it", async () => {
    const id = request({ expiresAtMs: NOW + 1000 });
    const planned = ops.planDecision(ctx(), { id, decision: "approved", nowMs: NOW });
    expect(planned.ok).toBe(true);
    expect(() => ops.executeDecision(ctx(), (planned as { plan: any }).plan, NOW + 2000)).toThrow(/expired/);
  });

  it("decides while the agent holds the instance lock, and never writes state.db", async () => {
    const id = request();
    const before = fs.readFileSync(stateDb);
    const lock = instanceLock.acquireInstanceLock(`${stateDb}.lock`);
    try {
      expect(await ops.runApprovalsCli(["approve", id, "--yes", ...reviewed()], io().io, ctx())).toBe(0);
    } finally {
      lock.release();
    }
    expect(fs.readFileSync(stateDb).equals(before)).toBe(true);
    const db = new Database(stateDb, { readonly: true });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'approval_decisions'").get()).toBeUndefined();
    db.close();
  });

  it("rejects bad arguments with the usage text", async () => {
    for (const args of [["approve"], ["approve", "a", "b"], ["list", "x"], ["approve", "x", "--all"], ["grant"], []]) {
      const t = io();
      expect(await ops.runApprovalsCli(args, t.io, ctx()), args.join(" ")).toBe(1);
      expect(t.text()).toMatch(/Usage:/);
    }
  });
});
