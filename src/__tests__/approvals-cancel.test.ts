/**
 * treasury: an approved transfer executed by the heartbeat step while its
 * task is cancelled. Real Conway client, Treasury and owner database; fetch
 * is stubbed. Whatever lands after the transfer was handed to the network,
 * the approval never causes a second send.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerDbReader, openOwnerDbForWrite } from "../budget/owner-db.js";
import { createConwayClient } from "../conway/client.js";
import { TaskAbortedError, runWithCancellation } from "../runtime/cancellation.js";
import {
  executeApprovedTransfers,
  getApprovalRequest,
  listApprovalViews,
  resetTreasuryForTests,
  runWithTreasuryOrigin,
  transferWithApproval,
} from "../treasury/index.js";
import type { ConwayClient } from "../types.js";
import { AUDIT_POLICY, CHILD_ADDRESS, deferred, makeHarness, type Harness } from "./treasury/harness.js";

const API = "https://api.conway.tech";
const HOUR = 3_600_000;

interface Env {
  h: Harness;
  reader: OwnerDbReader;
  client: ConwayClient;
  sent: Array<{ idempotencyKey: string | undefined }>;
  onTransfer: (init: RequestInit | undefined) => Promise<Response> | Response;
  close(): void;
}

let envs: Env[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const e of envs) e.close();
  envs = [];
  resetTreasuryForTests();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Never answers; rejects when the request's signal aborts, as Node's fetch does. */
function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const fail = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** A run scope as the scheduler builds it: per-run signal, shutdown root. */
function scope() {
  const root = new AbortController();
  const run = new AbortController();
  root.signal.addEventListener("abort", () => run.abort(root.signal.reason), { once: true });
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return runWithCancellation(run.signal, fn, { shutdownSignal: root.signal, state: { shielded: 0 } });
    },
    timeout: () => run.abort(new TaskAbortedError("timeout", "cancelled: timed out")),
    shutdown: () => root.abort(new TaskAbortedError("shutdown", "cancelled: runtime shutdown")),
  };
}

function setup(): Env {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approvals-cancel-"));
  const ownerPath = path.join(tmp, "owner", "owner.db");
  let clockRef: (() => number) | undefined;
  const reader = new OwnerDbReader(ownerPath, { now: () => clockRef!() });
  const h = makeHarness({
    policy: AUDIT_POLICY,
    balance: 100_000,
    install: false,
    treasuryDeps: () => ({ approvals: { decision: (id) => reader.decision(id) } }),
  });
  clockRef = h.clock.now;
  const env: Env = {
    h,
    reader,
    client: createConwayClient({ apiUrl: API, apiKey: "k", sandboxId: "", treasury: h.treasury }),
    sent: [],
    onTransfer: () => json(200, { transfer_id: "t-1", status: "completed", amount_cents: 3000 }),
    close() {
      reader.close();
      h.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (new URL(url).pathname !== "/v1/credits/transfer") throw new Error(`unexpected request ${url}`);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      env.sent.push({ idempotencyKey: headers["Idempotency-Key"] ?? headers["idempotency-key"] });
      return env.onTransfer(init);
    }),
  );
  envs.push(env);
  return env;
}

/** A pending request from a tool call, approved by the owner as the CLI writes it. */
async function approved(e: Env, amount = 3000): Promise<string> {
  const r = await runWithTreasuryOrigin({ type: "tool", name: "transfer_credits" }, () =>
    transferWithApproval({
      conway: e.client,
      db: e.h.raw,
      owner: e.reader,
      policy: e.h.policy,
      to: CHILD_ADDRESS,
      amountCents: amount,
      now: e.h.clock.now,
    }),
  );
  expect(r.status).toBe("approval_pending");
  const id = (r as { requestId: string }).requestId;
  const req = getApprovalRequest(e.h.raw, id)!;
  const writer = openOwnerDbForWrite(e.reader.path);
  try {
    writer.decide({
      requestId: id,
      decision: "approved",
      kind: "credit_transfer",
      counterparty: req.counterparty,
      amountCents: req.amountCents,
      executeByMs: e.h.clock.now() + 2 * HOUR,
      note: null,
      nowMs: e.h.clock.now(),
    });
  } finally {
    writer.close();
  }
  expect(e.sent).toHaveLength(0);
  return id;
}

const heartbeat = (e: Env) =>
  executeApprovedTransfers({ db: e.h.raw, owner: e.reader, conway: e.client, now: e.h.clock.now });
const state = (e: Env, id: string) =>
  listApprovalViews(e.h.raw, e.reader, e.h.clock.now(), { all: true }).find((v) => v.id === id)!.state;
// The APPROVAL_REQUIRED denial that made the request leaves a denied row.
const transferRows = (e: Env) => e.h.rows("transfer").filter((r) => r.status !== "denied");

describe("treasury: a cancelled execute_approved_transfers never sends twice", () => {
  it("shutdown after the transfer was sent: the row ends unknown, the approval is not executable again", async () => {
    const e = setup();
    const id = await approved(e);
    e.onTransfer = (init) => hangUntilAborted(init);

    const s = scope();
    const run = s.run(() => heartbeat(e)).catch((err) => err);
    await vi.waitFor(() => expect(e.sent).toHaveLength(1));
    s.shutdown();
    const err = await run;
    expect(err).toMatchObject({ name: "AbortError" });

    const rows = transferRows(e);
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(rows[0]!.approval_id).toBe(id);
    expect(state(e, id)).toBe("outcome_unknown");

    // Later ticks report it and never send it again.
    e.onTransfer = () => json(200, { transfer_id: "t-2", status: "completed", amount_cents: 3000 });
    const msgs = await heartbeat(e);
    expect(msgs.join(" ")).toContain(`Approved transfer ${id}`);
    expect(msgs.join(" ")).toContain("outcome is unknown");
    expect(await heartbeat(e)).toEqual([]);
    expect(e.sent).toHaveLength(1);
    expect(transferRows(e).map((r) => r.status)).toEqual(["unknown"]);
  });

  it("cancelled before anything was sent: released, and the next tick sends it once", async () => {
    const e = setup();
    const id = await approved(e);
    const balance = deferred();
    e.h.inner.gates.balance = balance.promise;

    const s = scope();
    const run = s.run(() => heartbeat(e)).catch((err) => err);
    await vi.waitFor(() => expect(e.h.inner.balanceReads).toBeGreaterThan(0));
    s.timeout();
    balance.resolve();
    expect(await run).toMatchObject({ name: "AbortError" });
    expect(e.sent).toHaveLength(0);
    expect(transferRows(e).map((r) => r.status)).toEqual(["released"]);
    expect(state(e, id)).toBe("approved");

    e.h.inner.gates.balance = undefined;
    const msgs = await heartbeat(e);
    expect(msgs.join(" ")).toContain("executed");
    expect(e.sent).toHaveLength(1);
    expect(await heartbeat(e)).toEqual([]);
    expect(e.sent).toHaveLength(1);
  });

  it("a timeout while the transfer is in flight lets it commit once; the next tick reports it", async () => {
    const e = setup();
    const id = await approved(e);
    const answer = deferred<Response>();
    e.onTransfer = (init) => Promise.race([answer.promise, hangUntilAborted(init)]);

    const s = scope();
    const run = s.run(() => heartbeat(e)).catch((err) => err);
    await vi.waitFor(() => expect(e.sent).toHaveLength(1));
    s.timeout();
    await new Promise((r) => setTimeout(r, 20));
    answer.resolve(json(200, { transfer_id: "t-1", status: "completed", amount_cents: 3000 }));
    expect(await run).toMatchObject({ name: "AbortError" });

    expect(transferRows(e).map((r) => r.status)).toEqual(["committed"]);
    expect(state(e, id)).toBe("executed");
    const msgs = await heartbeat(e);
    expect(msgs.join(" ")).toContain(`Approved transfer ${id}`);
    expect(msgs.join(" ")).toContain("executed");
    expect(await heartbeat(e)).toEqual([]);
    expect(e.sent).toHaveLength(1);
  });
});
