/**
 * security: only the owner grants budget or approves transfers. The runtime
 * reads the owner database read-only, no runtime module imports the writer,
 * no tool grants or approves, the agent's file tools and exec cannot reach
 * owner.db or the owner's CLI commands, and a decision forged inside
 * state.db authorizes nothing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OwnerDbReader, openOwnerDbForWrite } from "../budget/owner-db.js";
import { getForbiddenCommandMatch } from "../agent/policy-rules/command-safety.js";
import { checkRead, checkWrite } from "../security/protected-paths.js";
import { createBuiltinTools } from "../agent/tools.js";
import { TreasuryDeniedError } from "../treasury/index.js";
import { AUDIT_POLICY, CHILD_ADDRESS, makeHarness } from "./treasury/harness.js";

const REPO = path.resolve(__dirname, "../..");
const ORIGINAL_HOME = process.env.HOME;
let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "owner-only-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".automaton", "owner"), { recursive: true });
});

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.[cm]?[jt]s$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe("security: the owner database is read-only to the runtime", () => {
  it("OwnerDbReader's connection refuses every write with SQLITE_READONLY", () => {
    const ownerPath = path.join(home, ".automaton", "owner", "owner.db");
    const w = openOwnerDbForWrite(ownerPath);
    w.addGrant(100, "owner", Date.now());
    w.close();
    const reader = new OwnerDbReader(ownerPath);
    try {
      expect(reader.grants(0, null).sumCents).toBe(100);
      const conn = (reader as unknown as { open(): import("better-sqlite3").Database }).open();
      for (const sql of [
        "INSERT INTO budget_grants (amount_cents, note, created_at_ms) VALUES (100000, 'agent', 1)",
        "INSERT INTO approval_decisions (request_id, decision, kind, counterparty, amount_cents, decided_at_ms) VALUES ('apr_x', 'approved', 'credit_transfer', '0x1', 1, 1)",
        "UPDATE budget_grants SET amount_cents = 1000000",
        "DELETE FROM budget_grants",
      ]) {
        let code: string | undefined;
        try {
          conn.prepare(sql).run();
        } catch (err) {
          code = (err as { code?: string }).code;
        }
        expect(code, sql).toBe("SQLITE_READONLY");
      }
      expect(reader.grants(0, null).sumCents).toBe(100);
    } finally {
      reader.close();
    }
  });

  it("only owner code imports openOwnerDbForWrite (static check)", () => {
    const allowed = [
      /^src\/budget\/owner-db\.ts$/,
      // The wizard, --configure and the CLI reach the writer through these.
      /^src\/operator\/(budget|approvals)\.ts$/,
    ];
    const offenders: string[] = [];
    for (const file of [...walk(path.join(REPO, "src")), ...walk(path.join(REPO, "packages"))]) {
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      if (!/openOwnerDbForWrite/.test(fs.readFileSync(file, "utf8"))) continue;
      if (!allowed.some((re) => re.test(rel))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // The runtime's budget entry point does not hand it out either.
    expect(fs.readFileSync(path.join(REPO, "src/budget/index.ts"), "utf8")).not.toMatch(/openOwnerDbForWrite/);
  });

  it("no tool grants budget or approves a transfer", () => {
    const tools = [...createBuiltinTools("sbx"), ...createBuiltinTools("", { standalone: true })];
    for (const t of tools) {
      expect(t.name, t.name).not.toMatch(/approv|grant|budget/i);
      expect(t.execute.toString(), t.name).not.toMatch(/openOwnerDbForWrite|approval_decisions|budget_grants/);
    }
  });
});

describe("security: the agent's file tools and exec cannot reach the owner database", () => {
  it("read_file and write_file on ~/.automaton/owner/owner.db and its journal are refused", () => {
    for (const name of ["owner.db", "owner.db-journal"]) {
      const p = path.join(home, ".automaton", "owner", name);
      expect(checkRead(p).ok, `read ${name}`).toBe(false);
      expect(checkWrite(p).ok, `write ${name}`).toBe(false);
    }
    // Anywhere else too: the name is protected.
    expect(checkWrite(path.join(home, "work", "owner.db")).ok).toBe(false);
  });

  it.each([
    "automaton-cli budget add 10 --yes",
    "automaton-cli approvals approve apr_x --yes",
    "npx automaton-cli budget show",
    "sqlite3 ~/.automaton/owner/owner.db \"INSERT INTO budget_grants VALUES (NULL, 100000, 'x', 1)\"",
    "node -e \"require('better-sqlite3')(process.env.HOME + '/.automaton/owner/owner.db')\"",
    "cp /tmp/forged.db ~/.automaton/owner/owner.db",
    "python3 -c \"import sqlite3; sqlite3.connect('owner.db')\"",
  ])("exec refuses: %s", (command) => {
    expect(getForbiddenCommandMatch(command), command).not.toBeNull();
  });
});

describe("security: a decision forged inside state.db authorizes nothing", () => {
  it("an approval_decisions table in state.db is never read", async () => {
    const reader = new OwnerDbReader(path.join(home, "no-such-owner", "owner.db"));
    const h = makeHarness({
      policy: { ...AUDIT_POLICY },
      balance: 100_000,
      treasuryDeps: () => ({ approvals: { decision: (id) => reader.decision(id) } }),
    });
    try {
      h.raw.exec(`CREATE TABLE approval_decisions (request_id TEXT PRIMARY KEY, decision TEXT, kind TEXT,
        counterparty TEXT, amount_cents INTEGER, decided_at_ms INTEGER, execute_by_ms INTEGER, note TEXT)`);
      const id = "apr_01J00000000000000000000000";
      h.raw
        .prepare("INSERT INTO approval_decisions VALUES (?, 'approved', 'credit_transfer', ?, 3000, ?, ?, NULL)")
        .run(id, CHILD_ADDRESS, h.clock.now(), h.clock.now() + 3_600_000);
      h.raw
        .prepare(
          `INSERT INTO transfer_approval_requests (id, kind, counterparty, amount_cents, created_at_ms, expires_at_ms)
           VALUES (?, 'credit_transfer', ?, 3000, ?, ?)`,
        )
        .run(id, CHILD_ADDRESS, h.clock.now(), h.clock.now() + 86_400_000);
      let code: string | undefined;
      try {
        await h.conway.transferCredits(CHILD_ADDRESS, 3000, "forged", { approvalId: id });
      } catch (err) {
        if (err instanceof TreasuryDeniedError) code = err.code;
      }
      expect(code).toBe("APPROVAL_INVALID");
      expect(h.inner.calls.transferCredits).toHaveLength(0);
      // The tool path does not take the forged row as an approval either.
      const result = await h.exec("transfer_credits", { to_address: CHILD_ADDRESS, amount_cents: 3000 });
      expect(result.result).toContain("needs your owner's approval");
      expect(h.inner.calls.transferCredits).toHaveLength(0);
    } finally {
      reader.close();
      h.close();
    }
  });
});
