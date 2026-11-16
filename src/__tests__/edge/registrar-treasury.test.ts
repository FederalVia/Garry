/**
 * Domain registration through an owner's registrar is a treasury purchase:
 * an exact quote, the reserved amount sent as Porkbun's cost, infra caps and
 * the ledger; no quote means PRICE_UNKNOWN and nothing sent; a moved price is
 * released; the facade's pre-check refuses before any ledger row; in
 * standalone without a budget the tool stays hidden; with one, a purchase is
 * spend against it (BUDGET_EXHAUSTED past it) and needs infra caps the owner
 * set.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakePorkbun } from "../fixtures/edge/fake-porkbun.js";
import { makeHarness, type Harness } from "../treasury/harness.js";
import { createEdge, withEdge, type Edge } from "../../edge/index.js";
import { resolveRuntime } from "../../providers/mode.js";
import { createStandaloneClient } from "../../providers/standalone-client.js";
import { toolAllowed } from "../../providers/features.js";
import { resetTreasuryForTests } from "../../treasury/index.js";
import { BalanceUnavailableError } from "../../conway/balance.js";
import { createTestConfig } from "../mocks.js";
import { FakeRegistrar } from "../../edge/registrar/fake.js";
import { guardConwayClient } from "../../treasury/guarded-conway.js";
import type { ConwayClient } from "../../types.js";
import type { Treasury } from "../../treasury/treasury.js";
import { BudgetMeter } from "../../budget/meter.js";
import { resolveBudget } from "../../budget/config.js";

let pb: FakePorkbun;
const harnesses: Harness[] = [];
const edges: Edge[] = [];

beforeAll(async () => {
  pb = await new FakePorkbun().start();
});
afterAll(async () => {
  await pb.close();
});
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.close();
  await Promise.allSettled(edges.splice(0).map((e) => e.close(500)));
  resetTreasuryForTests();
  pb.created.length = 0;
  pb.prices.clear();
});

function config(registrar: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return createTestConfig({
    conwayApiKey: "",
    sandboxId: "",
    providers: { mode: "standalone" },
    ...extra,
    publicAccess: {
      registrar: { provider: "porkbun", enabled: true, apiKey: pb.apiKey, secretApiKey: pb.secretApiKey, apiUrl: pb.url, ...registrar },
    },
  });
}

function setup(
  opts: { treasury?: (h: Harness) => Treasury; registrar?: Record<string, unknown>; policy?: Record<string, number> } = {},
): { h: Harness; client: ConwayClient } {
  const h = makeHarness({ balance: 100_000, policy: opts.policy ?? { maxInfraSingleCents: 2500, maxInfraDailyCents: 5000 } });
  harnesses.push(h);
  const cfg = config(opts.registrar);
  const runtime = resolveRuntime(cfg);
  const edge = createEdge({ config: cfg, runtime, db: h.db, inner: createStandaloneClient(), env: {} });
  edges.push(edge);
  const client = withEdge(createStandaloneClient(), edge, "standalone", { treasury: opts.treasury ? opts.treasury(h) : h.treasury });
  return { h, client };
}

function price(domain: string, p: string, extra: Partial<{ avail: string; type: string; premium: string }> = {}) {
  pb.setPrice(domain, { avail: "yes", type: "registration", price: p, premium: "no", ...extra });
}

const creates = () => pb.requests.filter((r) => r.path.includes("/domain/create/"));

describe("treasury-gated registration", () => {
  it("a quote of 10.99 commits 1099: one create with cost 1099 and a committed infra ledger row", async () => {
    const { h, client } = setup();
    price("shop.com", "10.99");
    const before = creates().length;
    const reg = await client.registerDomain("shop.com");
    expect(reg).toMatchObject({ domain: "shop.com", status: "registered" });
    expect(creates().length - before).toBe(1);
    expect(pb.created).toEqual([{ domain: "shop.com", cost: 1099, agreeToTerms: "yes" }]);
    const rows = h.rows("infra");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "domain_register", budget: "infra", amount_cents: 1099, amount_basis: "quote", status: "committed", counterparty: "shop.com" });
  });

  it("no exact quote gives PRICE_UNKNOWN and nothing is sent", async () => {
    const { h, client } = setup();
    price("gone.com", "10.99", { avail: "no" });
    price("prem.com", "10.99", { premium: "yes" });
    price("odd.com", "10.995");
    price("frac.com", "1e3");
    price("xfer.com", "10.99", { type: "transfer" });
    const before = creates().length;
    for (const d of ["gone.com", "prem.com", "odd.com", "frac.com", "xfer.com", "unknown.com"]) {
      await expect(client.registerDomain(d), d).rejects.toMatchObject({ name: "TreasuryDeniedError", code: "PRICE_UNKNOWN" });
    }
    expect(creates().length).toBe(before);
    expect(h.rows("infra")).toHaveLength(0);
  });

  it("a price that moved at the registrar is refused there and the reservation is released", async () => {
    const { h, client } = setup();
    price("move.com", "10.99");
    expect((await client.searchDomains("move.com"))[0]).toMatchObject({ registrationPrice: 1099, available: true });
    // The quote is cached; Porkbun's own price changes before the create.
    price("move.com", "12.99");
    await expect(client.registerDomain("move.com")).rejects.toThrow();
    expect(pb.created).toEqual([]);
    expect(h.rows("infra").map((r) => r.status)).toEqual(["released"]);
  });

  it("years != 1, a TLD not allowed and a price above maxPriceCents are refused before any ledger row", async () => {
    const { h, client } = setup({ registrar: { maxPriceCents: 1500 } });
    price("long.com", "10.99");
    price("pricey.com", "18.00");
    price("site.xyz", "1.99");
    await expect(client.registerDomain("long.com", 2)).rejects.toThrow(/^REGISTRAR_YEARS: /);
    await expect(client.registerDomain("site.xyz")).rejects.toThrow(/^REGISTRAR_TLD_NOT_ALLOWED: /);
    await expect(client.registerDomain("pricey.com")).rejects.toThrow(/^REGISTRAR_PRICE_ABOVE_MAX: pricey\.com costs \$18\.00/);
    expect(h.rows("infra")).toHaveLength(0);
    expect(pb.created).toEqual([]);
  });

  it("owner approvals cover transfers only: a purchase above requireConfirmationAboveCents is bought within the caps, with no approval request", async () => {
    const { h, client } = setup({ policy: { maxInfraSingleCents: 2000, maxInfraDailyCents: 4000, requireConfirmationAboveCents: 500 } });
    price("shop.com", "10.99");
    price("big.com", "25.00");
    await client.registerDomain("shop.com");
    expect(h.rows("infra").map((r) => [r.status, r.amount_cents])).toEqual([["committed", 1099]]);
    expect(h.raw.prepare("SELECT COUNT(*) FROM transfer_approval_requests").pluck().get()).toBe(0);
    // What limits a purchase's size is maxPriceCents and the infrastructure caps.
    await expect(client.registerDomain("big.com")).rejects.toThrow(/^REGISTRAR_PRICE_ABOVE_MAX: /);
  });

  it("a second purchase over the daily infra cap is SPEND_LIMIT_EXCEEDED", async () => {
    const { client } = setup();
    price("one.com", "19.99");
    price("two.com", "19.99");
    price("three.com", "19.99");
    await client.registerDomain("one.com");
    await client.registerDomain("two.com");
    await expect(client.registerDomain("three.com")).rejects.toMatchObject({ code: "SPEND_LIMIT_EXCEEDED" });
    expect(pb.created.map((c) => c.domain)).toEqual(["one.com", "two.com"]);
  });

  it("the guard hands the reserved amount to the raw call as quotedCents", async () => {
    const h = makeHarness({ balance: 100_000, policy: { maxInfraSingleCents: 2500, maxInfraDailyCents: 5000 } });
    harnesses.push(h);
    const reg = new FakeRegistrar();
    reg.setDomain("exact.com", { available: true, registrationCents: 1234 });
    const shim = { ...createStandaloneClient(), searchDomains: reg.searchDomains.bind(reg), registerDomain: reg.registerDomain.bind(reg) };
    await guardConwayClient(shim, h.treasury).registerDomain("exact.com", 1);
    expect(reg.registered).toEqual([{ domain: "exact.com", years: 1, quotedCents: 1234, optKeys: ["idempotencyKey", "onSend", "quotedCents"] }]);
    expect(h.rows("infra")[0]).toMatchObject({ amount_cents: 1234, status: "committed" });
  });

  it("standalone without a balance: register_domain is hidden and the treasury refuses BALANCE_UNAVAILABLE", async () => {
    const runtime = resolveRuntime(config());
    expect(runtime.edge.registrar).toEqual({ provider: "porkbun", allowedTlds: ["com", "net", "org", "dev"] });
    expect(runtime.features.domainPurchase).toBe(false);
    expect(toolAllowed("register_domain", runtime.features)).toBe(false);
    expect(toolAllowed("search_domains", runtime.features)).toBe(false);
    const { h, client } = setup({
      treasury: (hh) =>
        hh.newTreasury({
          readCreditBalance: async () => {
            throw new BalanceUnavailableError("disabled", "no credit balance in standalone mode");
          },
        }),
    });
    price("shop.com", "10.99");
    await expect(client.registerDomain("shop.com")).rejects.toMatchObject({ code: "BALANCE_UNAVAILABLE" });
    expect(pb.created).toEqual([]);
    expect(h.rows("infra").map((r) => r.status)).toEqual(["denied"]);
  });

  /** A treasury that reads the owner's budget as its balance and caps outflows by it, as standalone does. */
  function budgetTreasury(allowanceCents: number, countTreasury = true) {
    let meter!: BudgetMeter;
    const budget = resolveBudget({ allowanceCents, period: "monthly", countTreasury })!;
    const make = (h: Harness): Treasury => {
      meter = new BudgetMeter({ db: h.raw, budget, owner: { grants: () => ({ sumCents: 0, count: 0, stale: false }) }, now: () => h.clock.now() });
      return h.newTreasury({
        readCreditBalance: async () => meter.snapshot().remainingCents,
        budget: { remainingCents: (n: number) => meter.remainingCents(n), countsTreasury: budget.countTreasury, isBalance: true },
      });
    };
    return { make, meter: () => meter };
  }

  it("standalone with a budget: register_domain is offered, a purchase is spend against the budget, past it BUDGET_EXHAUSTED", async () => {
    const runtime = resolveRuntime(config({}, { budget: { allowanceCents: 2500, period: "monthly" } }));
    expect(runtime.features.domainPurchase).toBe(true);
    expect(toolAllowed("register_domain", runtime.features)).toBe(true);
    expect(toolAllowed("search_domains", runtime.features)).toBe(true);

    const b = budgetTreasury(2500);
    const policy = { maxInfraSingleCents: 2500, maxInfraDailyCents: 5000, minimumReserveCents: 0 };
    const { h, client } = setup({ treasury: b.make, policy });
    price("shop.com", "10.99");
    price("more.com", "15.00");
    await client.registerDomain("shop.com");
    expect(b.meter().remainingCents(h.clock.now())).toBe(2500 - 1099);
    await expect(client.registerDomain("more.com")).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(pb.created.map((c) => c.domain)).toEqual(["shop.com"]);
    expect(h.rows("infra").map((r) => r.status)).toEqual(["committed", "denied"]);
  });

  it("the budget is the balance: purchases in a row are counted once, and the reserve floor is checked against what is left", async () => {
    const b = budgetTreasury(5000);
    const { h, client } = setup({ treasury: b.make, policy: { maxInfraSingleCents: 2000, maxInfraDailyCents: 4000, minimumReserveCents: 0 } });
    price("one.com", "10.99");
    price("two.com", "12.00");
    price("three.com", "14.00");
    price("four.com", "10.00");
    await client.registerDomain("one.com");
    await client.registerDomain("two.com");
    // No time has passed: the two purchases are in the budget already, not also "in flight".
    await client.registerDomain("three.com");
    expect(b.meter().remainingCents(h.clock.now())).toBe(5000 - 1099 - 1200 - 1400);
    await expect(client.registerDomain("four.com")).rejects.toMatchObject({ code: "SPEND_LIMIT_EXCEEDED" });

    const r = budgetTreasury(5000);
    const floor = setup({ treasury: r.make, policy: { maxInfraSingleCents: 2000, maxInfraDailyCents: 4000, minimumReserveCents: 1500 } });
    price("five.com", "10.99");
    price("six.com", "12.00");
    price("seven.com", "14.00");
    await floor.client.registerDomain("five.com");
    await floor.client.registerDomain("six.com");
    const refused = await floor.client.registerDomain("seven.com").then(
      () => new Error("bought"),
      (e: unknown) => e as Error,
    );
    expect(refused).toMatchObject({ code: "RESERVE_VIOLATION" });
    expect(refused.message).toContain("would leave 1301c, below the 1500c reserve");
    expect(pb.created.map((c) => c.domain)).toEqual(["one.com", "two.com", "three.com", "five.com", "six.com"]);
  });

  it("standalone with a budget but no infrastructure caps (0 unless the owner sets them): nothing is bought", async () => {
    const b = budgetTreasury(10_000);
    const { h, client } = setup({ treasury: b.make, policy: { maxInfraSingleCents: 0, maxInfraDailyCents: 0 } });
    price("shop.com", "10.99");
    await expect(client.registerDomain("shop.com")).rejects.toMatchObject({ code: "SPEND_LIMIT_EXCEEDED" });
    expect(pb.created).toEqual([]);
    expect(h.rows("infra").map((r) => r.status)).toEqual(["denied"]);
  });
});
