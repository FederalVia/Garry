/**
 * treasury: large-transfer approvals. Conway-mode harness with the mock
 * transfer primitive: a transfer in the approval band is recorded as a
 * pending request; the owner decides in the owner database; the approved
 * transfer runs through the treasury with every cap, exactly once.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerDbReader, openOwnerDbForWrite, type ApprovalDecision } from "../budget/owner-db.js";
import {
  APPROVED_TRANSFER_ORIGIN,
  MAX_APPROVALS_PER_DAY,
  OutcomeUnknownError,
  TreasuryDeniedError,
  approvalStatus,
  executeApprovedTransfers,
  getApprovalRequest,
  listApprovalViews,
  runWithTreasuryOrigin,
  transferWithApproval,
  type ApprovalRequest,
} from "../treasury/index.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { lifecycleInsertEvent } from "../state/database.js";
import { AUDIT_POLICY, CHILD_ADDRESS, OTHER_ADDRESS, deferred, makeHarness, type Harness } from "./treasury/harness.js";
import { createTestConfig, createTestIdentity } from "./mocks.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Env {
  h: Harness;
  ownerPath: string;
  reader: OwnerDbReader;
  /** The owner's decision, written as the CLI writes it (counterparty and amount copied from the request). */
  decide(id: string, decision: "approved" | "rejected", over?: Partial<ApprovalDecision>): ApprovalDecision;
  pending(): ApprovalRequest[];
  close(): void;
}

let envs: Env[] = [];
afterEach(() => {
  for (const e of envs) e.close();
  envs = [];
});

function setup(policy: Record<string, number> = {}, balance = 100_000): Env {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approvals-"));
  const ownerPath = path.join(tmp, "owner", "owner.db");
  let clockRef: (() => number) | undefined;
  const reader = new OwnerDbReader(ownerPath, { now: () => clockRef!() });
  const h = makeHarness({
    policy: { ...AUDIT_POLICY, ...policy },
    balance,
    treasuryDeps: () => ({ approvals: { decision: (id) => reader.decision(id) } }),
  });
  clockRef = h.clock.now;
  const env: Env = {
    h,
    ownerPath,
    reader,
    decide(id, decision, over = {}) {
      const r = getApprovalRequest(h.raw, id)!;
      const w = openOwnerDbForWrite(ownerPath);
      try {
        return w.decide({
          requestId: id,
          decision,
          kind: "credit_transfer",
          counterparty: r.counterparty,
          amountCents: r.amountCents,
          executeByMs: decision === "approved" ? h.clock.now() + 2 * HOUR : null,
          note: null,
          nowMs: h.clock.now(),
          ...over,
        });
      } finally {
        w.close();
      }
    },
    pending: () => listApprovalViews(h.raw, reader, h.clock.now()).filter((v) => v.state === "pending"),
    close() {
      reader.close();
      h.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  envs.push(env);
  return env;
}

const sends = (e: Env) => e.h.inner.calls.transferCredits.length;
const committed = (e: Env) => e.h.rows("transfer", "committed").length;

async function ask(e: Env, amount: number, to = CHILD_ADDRESS, turnCount = 0) {
  return e.h.exec("transfer_credits", { to_address: to, amount_cents: amount, reason: "pay the contractor" }, { turnCount });
}

/** The tool path with a tool origin, outside the policy engine. */
function toolTransfer(e: Env, amount: number, to = CHILD_ADDRESS, inputSource?: string) {
  return runWithTreasuryOrigin({ type: "tool", name: "transfer_credits", inputSource }, () =>
    transferWithApproval({
      conway: e.h.conway,
      db: e.h.raw,
      owner: e.reader,
      policy: e.h.policy,
      to,
      amountCents: amount,
      now: e.h.clock.now,
    }),
  );
}

function heartbeat(e: Env) {
  return executeApprovedTransfers({ db: e.h.raw, owner: e.reader, conway: e.h.conway, now: e.h.clock.now });
}

async function deniedCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TreasuryDeniedError) return err.code;
    throw err;
  }
  return "ok";
}

describe("treasury: requesting approval", () => {
  it("a transfer above the threshold is denied APPROVAL_REQUIRED and recorded as a pending request; nothing is sent", async () => {
    const e = setup();
    const result = await ask(e, 3000);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatch(/needs your owner's approval\. Request apr_[0-9A-Z]{26} is pending until .* UTC/);
    expect(result.result).toContain("automaton-cli approvals approve apr_");
    expect(sends(e)).toBe(0);
    const pending = e.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ counterparty: CHILD_ADDRESS, amountCents: 3000, reason: "pay the contractor", originName: "transfer_credits" });
    expect(pending[0]!.expiresAtMs).toBe(e.h.clock.now() + DAY);
    const denied = e.h.rows("transfer", "denied");
    expect(denied.map((r) => r.deny_code)).toEqual(["APPROVAL_REQUIRED"]);
  });

  it("at or below the threshold the transfer runs without approval", async () => {
    const e = setup();
    const result = await ask(e, 1000);
    expect(result.result).toContain("Credit transfer submitted");
    expect(sends(e)).toBe(1);
    expect(e.pending()).toHaveLength(0);
  });

  it("an identical request is reused, not duplicated", async () => {
    const e = setup();
    const first = await toolTransfer(e, 3000);
    const second = await toolTransfer(e, 3000);
    expect(first.status).toBe("approval_pending");
    expect(second.status).toBe("approval_pending");
    expect((second as { requestId: string }).requestId).toBe((first as { requestId: string }).requestId);
    expect(e.pending()).toHaveLength(1);
  });

  it("refuses a fourth open request, an eleventh in 24 hours, and an identical one within 24 hours of a rejection", async () => {
    const e = setup();
    for (const amount of [2000, 2100, 2200]) expect((await toolTransfer(e, amount)).status).toBe("approval_pending");
    const fourth = await toolTransfer(e, 2300);
    expect(fourth.status).toBe("approval_refused");
    expect((fourth as { message: string }).message).toMatch(/already waiting/);

    const daily = setup();
    for (let i = 0; i < MAX_APPROVALS_PER_DAY; i++) {
      const r = await toolTransfer(daily, 2000 + i);
      expect(r.status).toBe("approval_pending");
      daily.decide((r as { requestId: string }).requestId, "rejected");
      daily.h.clock.advance(60_000);
    }
    const eleventh = await toolTransfer(daily, 4000);
    expect(eleventh.status).toBe("approval_refused");
    expect((eleventh as { message: string }).message).toMatch(/last 24 hours/);

    const rej = setup();
    const r = await toolTransfer(rej, 3000);
    rej.decide((r as { requestId: string }).requestId, "rejected");
    const again = await toolTransfer(rej, 3000);
    expect(again.status).toBe("approval_refused");
    expect((again as { message: string }).message).toMatch(/rejected an identical transfer/);
    rej.h.clock.advance(DAY + 1);
    expect((await toolTransfer(rej, 3000)).status).toBe("approval_pending");
  });

  it("an inbox-driven turn gets UNTRUSTED_SOURCE and makes no request", async () => {
    const e = setup();
    expect(await deniedCode(toolTransfer(e, 3000, CHILD_ADDRESS, "social"))).toBe("UNTRUSTED_SOURCE");
    const viaTool = await e.h.exec("transfer_credits", { to_address: CHILD_ADDRESS, amount_cents: 3000 }, { source: "social" });
    expect(viaTool.result ?? "").not.toContain("apr_");
    expect(e.pending()).toHaveLength(0);
    expect(sends(e)).toBe(0);
  });

  it("an automatic origin gets APPROVAL_REQUIRED and makes no request", async () => {
    const e = setup();
    const p = runWithTreasuryOrigin({ type: "auto", name: "orchestrator.fund_child" }, () =>
      transferWithApproval({ conway: e.h.conway, db: e.h.raw, owner: e.reader, policy: e.h.policy, to: CHILD_ADDRESS, amountCents: 3000 }),
    );
    expect(await deniedCode(p)).toBe("APPROVAL_REQUIRED");
    expect(e.pending()).toHaveLength(0);
  });

  it("above maxSingleTransferCents the transfer is refused outright (SPEND_LIMIT_EXCEEDED), no request", async () => {
    const e = setup();
    expect(await deniedCode(toolTransfer(e, 5001))).toBe("SPEND_LIMIT_EXCEEDED");
    const viaTool = await ask(e, 6000);
    expect(viaTool.error ?? viaTool.result).toMatch(/SPEND_LIMIT_EXCEEDED/);
    expect(e.pending()).toHaveLength(0);
  });

  it("with the default policy (single = threshold = $10) there is no approval band", async () => {
    const e = setup({ maxSingleTransferCents: 1000, requireConfirmationAboveCents: 1000 });
    expect(await deniedCode(toolTransfer(e, 1001))).toBe("SPEND_LIMIT_EXCEEDED");
    expect(e.pending()).toHaveLength(0);
  });
});

describe("treasury: executing an approved transfer exactly once", () => {
  async function approved(e: Env, amount = 3000) {
    const r = (await toolTransfer(e, amount)) as { requestId: string };
    e.decide(r.requestId, "approved");
    return r.requestId;
  }

  it("the agent's retry sends it once; the approval cannot be used again", async () => {
    const e = setup();
    const id = await approved(e);
    expect(listApprovalViews(e.h.raw, e.reader, e.h.clock.now())[0]!.state).toBe("approved");
    const retry = await ask(e, 3000);
    expect(retry.result).toContain("Credit transfer submitted");
    expect(sends(e)).toBe(1);
    expect(committed(e)).toBe(1);
    expect(e.h.rows("transfer", "committed")[0]!.approval_id).toBe(id);
    expect(listApprovalViews(e.h.raw, e.reader, e.h.clock.now(), { all: true })[0]!.state).toBe("executed");

    // The same approval again: APPROVAL_USED, nothing sent.
    expect(await deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "again", { approvalId: id }))).toBe("APPROVAL_USED");
    // A second identical retry is a new transfer: a new request for the owner, nothing sent.
    const second = await toolTransfer(e, 3000);
    expect(second.status).toBe("approval_pending");
    expect((second as { requestId: string }).requestId).not.toBe(id);
    expect(sends(e)).toBe(1);

    // The heartbeat reports the execution once and never sends it again.
    const msgs = await heartbeat(e);
    expect(msgs.join(" ")).toContain(`Approved transfer ${id}`);
    expect(msgs.join(" ")).toContain("executed");
    expect(await heartbeat(e)).toEqual([]);
    expect(sends(e)).toBe(1);
  });

  it("the heartbeat executes it once, from the owner's decision, with its own origin", async () => {
    const e = setup();
    const id = await approved(e);
    const msgs = await heartbeat(e);
    expect(msgs).toEqual([`Approved transfer ${id} ($30.00 to ${CHILD_ADDRESS}) executed. Do not retry it: it has already run.`]);
    expect(sends(e)).toBe(1);
    const row = e.h.rows("transfer", "committed")[0]!;
    expect(row.approval_id).toBe(id);
    expect(row.origin_name).toBe(APPROVED_TRANSFER_ORIGIN);
    expect(await heartbeat(e)).toEqual([]);
    expect(await deniedCode(toolTransfer(e, 3000))).toBe("ok"); // a new pending request, nothing sent
    expect(sends(e)).toBe(1);
  });

  it("an approved fund_child executed by the heartbeat records the child as funded", async () => {
    const e = setup();
    e.h.db.insertChild({
      id: "child-1",
      name: "c",
      address: CHILD_ADDRESS,
      sandboxId: "",
      genesisPrompt: "g",
      fundedAmountCents: 0,
      status: "wallet_verified",
      createdAt: new Date().toISOString(),
    } as never);
    lifecycleInsertEvent(e.h.raw, {
      id: "ev-1",
      childId: "child-1",
      fromState: "spawning",
      toState: "wallet_verified",
      reason: null,
      metadata: "{}",
      createdAt: new Date().toISOString(),
    } as never);
    const asked = await e.h.exec("fund_child", { child_id: "child-1", amount_cents: 3000 }, { source: "agent" } as never);
    const id = /apr_[0-9A-Z]{26}/.exec(asked.result ?? "")?.[0];
    expect(id).toBeTruthy();
    expect(getApprovalRequest(e.h.raw, id!)!.originRef).toBe("child-1");
    e.decide(id!, "approved");
    e.h.clock.advance(60_000);
    const msgs = await heartbeat(e);
    expect(sends(e)).toBe(1);
    expect(msgs.join(" ")).toContain("recorded as funded; do not call fund_child again");
    expect(e.h.raw.prepare("SELECT funded_amount_cents, status FROM children WHERE id = 'child-1'").get()).toEqual({
      funded_amount_cents: 3000,
      status: "funded",
    });
  });

  it("the built-in heartbeat task runs it through the installed treasury", async () => {
    const e = setup();
    const id = await approved(e);
    const result = await BUILTIN_TASKS.execute_approved_transfers!({} as never, {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db: e.h.db,
      conway: e.h.conway,
    });
    expect(result.shouldWake).toBe(true);
    expect(result.message).toContain(id);
    expect(sends(e)).toBe(1);
  });

  it("the tool and the heartbeat racing yield one send", async () => {
    const e = setup();
    const id = await approved(e);
    const gate = deferred();
    e.h.inner.gates.transferCredits = gate.promise;
    const fromTool = ask(e, 3000);
    // Wait until the tool's reservation is in the ledger.
    for (let i = 0; i < 500 && e.h.raw.prepare("SELECT COUNT(*) FROM treasury_ledger WHERE approval_id = ? AND status = 'reserved'").pluck().get(id) === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // The heartbeat step sees it executing and leaves it alone.
    expect(await heartbeat(e)).toEqual([]);
    // A second caller of the same approval (as the heartbeat would send it) loses inside the treasury.
    const second = deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "heartbeat", { approvalId: id }));
    gate.resolve();
    const [result, secondCode] = await Promise.all([fromTool, second]);
    expect(result.result).toContain("Credit transfer submitted");
    expect(secondCode).toBe("APPROVAL_USED");
    expect(sends(e)).toBe(1);
    expect(committed(e)).toBe(1);
  });

  it("released (nothing moved), then a retry: one send", async () => {
    const e = setup();
    await approved(e);
    e.h.inner.failNext("transferCredits", "refused");
    const first = await ask(e, 3000);
    expect(first.error).toBeDefined();
    expect(e.h.rows("transfer", "released")).toHaveLength(1);
    expect(listApprovalViews(e.h.raw, e.reader, e.h.clock.now())[0]!.state).toBe("approved");
    const second = await ask(e, 3000);
    expect(second.result).toContain("Credit transfer submitted");
    expect(committed(e)).toBe(1);
  });

  it("an unknown outcome runs again only as the replay with the same idempotency key", async () => {
    const e = setup();
    const id = await approved(e);
    e.h.inner.failNext("transferCredits", "timeout");
    const first = await ask(e, 3000);
    expect(first.error).toMatch(/Outcome unknown/);
    expect(listApprovalViews(e.h.raw, e.reader, e.h.clock.now())[0]!.state).toBe("outcome_unknown");

    // The heartbeat reports it and does not replay it.
    const msgs = await heartbeat(e);
    expect(msgs.join(" ")).toContain("outcome is unknown");
    expect(sends(e)).toBe(1);

    // The agent's retry replays with the original key.
    const retry = await ask(e, 3000);
    expect(retry.result).toContain("Credit transfer submitted");
    const keys = e.h.inner.calls.transferCredits.map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const rows = e.h.raw.prepare("SELECT status, replay_of FROM treasury_ledger WHERE approval_id = ? ORDER BY created_at_ms, id").all(id);
    expect(rows).toEqual([
      { status: "unknown", replay_of: null },
      { status: "committed", replay_of: expect.any(String) },
    ]);
    expect(await deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "x", { approvalId: id }))).toBe("APPROVAL_USED");
  });

  it("an unknown outcome older than the replay window cannot run again", async () => {
    const e = setup({ approvalExecuteWindowMs: 3 * DAY });
    const r = (await toolTransfer(e, 3000)) as { requestId: string };
    e.decide(r.requestId, "approved", { executeByMs: e.h.clock.now() + 3 * DAY });
    e.h.inner.failNext("transferCredits", "timeout");
    await expect(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "x", { approvalId: r.requestId })).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    e.h.clock.advance(DAY + 1);
    expect(await deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "x", { approvalId: r.requestId }))).toBe("APPROVAL_USED");
  });
});

describe("treasury: expiry, rejection and mismatches", () => {
  it("a pending request expires after 24 hours", async () => {
    const e = setup();
    const r = (await toolTransfer(e, 3000)) as { requestId: string };
    const req = getApprovalRequest(e.h.raw, r.requestId)!;
    expect(approvalStatus(req, null, [], req.expiresAtMs)).toBe("pending");
    expect(approvalStatus(req, null, [], req.expiresAtMs + 1)).toBe("expired");
    e.h.clock.set(req.expiresAtMs + 1);
    expect(listApprovalViews(e.h.raw, e.reader, e.h.clock.now(), { all: true })[0]!.state).toBe("expired");
    const msgs = await heartbeat(e);
    expect(msgs.join(" ")).toContain("expired without a decision");
  });

  it("an approval past its execute-by time is expired and the treasury refuses it", async () => {
    const e = setup();
    const r = (await toolTransfer(e, 3000)) as { requestId: string };
    e.decide(r.requestId, "approved");
    e.h.clock.advance(2 * HOUR + 1);
    expect(listApprovalViews(e.h.raw, e.reader, e.h.clock.now(), { all: true })[0]!.state).toBe("expired");
    expect(await deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "x", { approvalId: r.requestId }))).toBe(
      "APPROVAL_INVALID",
    );
    // The tool does not use it: a new request instead, nothing sent.
    expect((await toolTransfer(e, 3000)).status).toBe("approval_pending");
    expect(sends(e)).toBe(0);
    expect((await heartbeat(e)).join(" ")).toContain("expired before it could run");
  });

  it("a rejection is reported once by the heartbeat and blocks the identical request", async () => {
    const e = setup();
    const r = (await toolTransfer(e, 3000)) as { requestId: string };
    e.decide(r.requestId, "rejected");
    const msgs = await heartbeat(e);
    expect(msgs).toEqual([`Your owner rejected transfer ${r.requestId} ($30.00 to ${CHILD_ADDRESS}); do not retry it.`]);
    expect(await heartbeat(e)).toEqual([]);
    expect(await deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "x", { approvalId: r.requestId }))).toBe(
      "APPROVAL_INVALID",
    );
    expect((await toolTransfer(e, 3000)).status).toBe("approval_refused");
    expect(sends(e)).toBe(0);
  });

  it("a decision whose amount or recipient differs from the transfer is APPROVAL_INVALID", async () => {
    const e = setup();
    const a = (await toolTransfer(e, 3000)) as { requestId: string };
    e.decide(a.requestId, "approved", { amountCents: 2000 });
    expect(await deniedCode(toolTransfer(e, 3000))).toBe("APPROVAL_INVALID");
    expect(await deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "x", { approvalId: a.requestId }))).toBe("APPROVAL_INVALID");
    expect(await deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 2000, "x", { approvalId: a.requestId }))).toBe("ok");

    const b = setup();
    const r = (await toolTransfer(b, 3000)) as { requestId: string };
    b.decide(r.requestId, "approved", { counterparty: OTHER_ADDRESS });
    expect(await deniedCode(b.h.conway.transferCredits(CHILD_ADDRESS, 3000, "x", { approvalId: r.requestId }))).toBe("APPROVAL_INVALID");
    // Only the transfer that matches the owner's copy exactly was sent.
    expect(e.h.inner.calls.transferCredits.map((c) => c.args[1])).toEqual([2000]);
    expect(sends(b)).toBe(0);
  });

  it("an approval id with a different dedupe key, or for no decision, is refused", async () => {
    const e = setup();
    const r = (await toolTransfer(e, 3000)) as { requestId: string };
    expect(await deniedCode(e.h.conway.transferCredits(CHILD_ADDRESS, 3000, "x", { approvalId: r.requestId }))).toBe("APPROVAL_INVALID");
    e.decide(r.requestId, "approved");
    await expect(
      e.h.treasury.reserve({
        kind: "credit_transfer",
        amountCents: 3000,
        amountBasis: "exact",
        counterparty: CHILD_ADDRESS,
        dedupeKey: "credit_transfer|other",
        description: "x",
        approvalId: r.requestId,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("an approval lifts only the confirmation threshold: a daily cap still denies", async () => {
    const e = setup({ maxDailyTransferCents: 3500 });
    const r = (await toolTransfer(e, 3000)) as { requestId: string };
    e.decide(r.requestId, "approved");
    await ask(e, 1000);
    expect(await deniedCode(toolTransfer(e, 3000))).toBe("SPEND_LIMIT_EXCEEDED");
    // The heartbeat retries on later ticks and reports the refusal once.
    const first = await heartbeat(e);
    expect(first.join(" ")).toContain("refused for now (SPEND_LIMIT_EXCEEDED");
    expect(await heartbeat(e)).toEqual([]);
    expect(sends(e)).toBe(1);
    // Once the window clears (and still within execute-by), it runs.
    e.h.clock.advance(HOUR + 1);
    e.h.raw.prepare("UPDATE treasury_ledger SET created_at_ms = created_at_ms - ? WHERE approval_id IS NULL").run(DAY);
    const later = await heartbeat(e);
    expect(later.join(" ")).toContain("executed");
    expect(sends(e)).toBe(2);
  });
});
