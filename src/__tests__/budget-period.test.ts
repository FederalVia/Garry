/**
 * Budget periods (UTC) and budget config validation.
 */

import { describe, expect, it } from "vitest";
import { currentPeriod } from "../budget/period.js";
import { BudgetConfigError, defaultDailyCapCents, parseStartDate, resolveBudget, resolveOwnerDbPath } from "../budget/config.js";

const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) => Date.UTC(y, m - 1, d, h, min, s, ms);

function monthly(resetDay: number) {
  return resolveBudget({ allowanceCents: 2500, period: "monthly", resetDay })!;
}

describe("monthly periods", () => {
  it("reset day 1: the calendar month, UTC", () => {
    expect(currentPeriod(monthly(1), utc(2026, 3, 10, 12))).toEqual({ startMs: utc(2026, 3, 1), endMs: utc(2026, 4, 1) });
  });

  it("reset day 15: before the 15th belongs to the period that started last month", () => {
    expect(currentPeriod(monthly(15), utc(2026, 3, 14, 23, 59, 59, 999))).toEqual({
      startMs: utc(2026, 2, 15),
      endMs: utc(2026, 3, 15),
    });
    expect(currentPeriod(monthly(15), utc(2026, 3, 20))).toEqual({ startMs: utc(2026, 3, 15), endMs: utc(2026, 4, 15) });
  });

  it("reset day 28 works in February, and January 31 lies in the Jan 28 - Feb 28 period", () => {
    expect(currentPeriod(monthly(28), utc(2026, 1, 31, 8))).toEqual({ startMs: utc(2026, 1, 28), endMs: utc(2026, 2, 28) });
    expect(currentPeriod(monthly(28), utc(2026, 2, 27))).toEqual({ startMs: utc(2026, 1, 28), endMs: utc(2026, 2, 28) });
    expect(currentPeriod(monthly(28), utc(2026, 3, 1))).toEqual({ startMs: utc(2026, 2, 28), endMs: utc(2026, 3, 28) });
  });

  it("January 31 with reset day 1 ends at February 1; a leap February runs to March 1", () => {
    expect(currentPeriod(monthly(1), utc(2026, 1, 31, 23))).toEqual({ startMs: utc(2026, 1, 1), endMs: utc(2026, 2, 1) });
    const leap = currentPeriod(monthly(1), utc(2028, 2, 29, 12));
    expect(leap).toEqual({ startMs: utc(2028, 2, 1), endMs: utc(2028, 3, 1) });
    expect(leap.endMs! - leap.startMs).toBe(29 * 86_400_000);
  });

  it("a December period runs into January of the next year", () => {
    expect(currentPeriod(monthly(10), utc(2026, 12, 31))).toEqual({ startMs: utc(2026, 12, 10), endMs: utc(2027, 1, 10) });
    expect(currentPeriod(monthly(10), utc(2027, 1, 5))).toEqual({ startMs: utc(2026, 12, 10), endMs: utc(2027, 1, 10) });
  });

  it("the exact boundary millisecond belongs to the new period", () => {
    const b = monthly(1);
    expect(currentPeriod(b, utc(2026, 4, 1) - 1).startMs).toBe(utc(2026, 3, 1));
    expect(currentPeriod(b, utc(2026, 4, 1))).toEqual({ startMs: utc(2026, 4, 1), endMs: utc(2026, 5, 1) });
  });
});

describe("one-off budgets", () => {
  it("start at the start date, 00:00 UTC, and never end", () => {
    const b = resolveBudget({ allowanceCents: 5000, period: "one-off", startDate: "2026-02-03" })!;
    expect(b.startMs).toBe(utc(2026, 2, 3));
    expect(currentPeriod(b, utc(2026, 9, 1))).toEqual({ startMs: utc(2026, 2, 3), endMs: null });
  });

  it("cannot start after today (UTC): spending before a later start would fall outside every period", () => {
    const raw = { allowanceCents: 1000, period: "one-off", startDate: "2026-12-01" };
    expect(() => resolveBudget(raw, utc(2026, 11, 14))).toThrow(/startDate 2026-12-01 is after today \(UTC\)/);
    expect(() => resolveBudget(raw, utc(2026, 12, 1) - 1)).toThrow(BudgetConfigError);
    expect(resolveBudget(raw, utc(2026, 12, 1))!.startMs).toBe(utc(2026, 12, 1));
    expect(parseStartDate("2026-11-14", utc(2026, 11, 14) + 5)).toEqual({ ms: utc(2026, 11, 14) });
    expect(parseStartDate("2026-11-15", utc(2026, 11, 14) + 5)).toHaveProperty("error");
  });
});

describe("resolveBudget", () => {
  it("fills the defaults", () => {
    expect(resolveBudget({ allowanceCents: 2500 })).toEqual({
      allowanceCents: 2500,
      period: "monthly",
      resetDay: 1,
      startMs: null,
      countTreasury: true,
      thresholds: { unit: "percent", high: 50, normal: 15, lowCompute: 5 },
      dead: true,
    });
    expect(resolveBudget(undefined)).toBeNull();
    expect(resolveBudget(null)).toBeNull();
  });

  it.each([
    ["not an object", 25],
    ["no allowance", { period: "monthly" }],
    ["negative allowance", { allowanceCents: -1 }],
    ["fractional allowance", { allowanceCents: 10.5 }],
    ["string allowance", { allowanceCents: "2500" }],
    ["unknown period", { allowanceCents: 1, period: "weekly" }],
    ["reset day 29", { allowanceCents: 1, resetDay: 29 }],
    ["reset day 0", { allowanceCents: 1, resetDay: 0 }],
    ["one-off without start", { allowanceCents: 1, period: "one-off" }],
    ["impossible date", { allowanceCents: 1, period: "one-off", startDate: "2026-02-30" }],
    ["badly written date", { allowanceCents: 1, period: "one-off", startDate: "3 Feb 2026" }],
    ["startDate on monthly", { allowanceCents: 1, startDate: "2026-02-03" }],
    ["typo field", { allowanceCents: 1, allowance: 5 }],
    ["countTreasury not boolean", { allowanceCents: 1, countTreasury: "yes" }],
    ["dead not boolean", { allowanceCents: 1, dead: 0 }],
    ["thresholds not descending", { allowanceCents: 1, thresholds: { unit: "percent", high: 10, normal: 15, lowCompute: 5 } }],
    ["threshold zero", { allowanceCents: 1, thresholds: { unit: "percent", high: 50, normal: 15, lowCompute: 0 } }],
    ["percent above 100", { allowanceCents: 1, thresholds: { unit: "percent", high: 150, normal: 15, lowCompute: 5 } }],
    ["fractional cents threshold", { allowanceCents: 1, thresholds: { unit: "cents", high: 500.5, normal: 100, lowCompute: 10 } }],
    ["unknown unit", { allowanceCents: 1, thresholds: { unit: "usd", high: 5, normal: 2, lowCompute: 1 } }],
  ])("rejects %s", (_label, raw) => {
    expect(() => resolveBudget(raw)).toThrow(BudgetConfigError);
  });

  it("the daily cap default is about 1/15 of the allowance", () => {
    expect(defaultDailyCapCents({ allowanceCents: 2500 })).toBe(167);
    expect(defaultDailyCapCents({ allowanceCents: 3000 })).toBe(200);
    expect(defaultDailyCapCents({ allowanceCents: 1 })).toBe(1);
    // Zero allowance: only grants can be spent, so the cap must leave room for them.
    expect(defaultDailyCapCents({ allowanceCents: 0 })).toBe(200);
  });

  it("the owner database defaults to ~/.automaton/owner/owner.db under HOME", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/tmp/budget-home-test";
    try {
      expect(resolveOwnerDbPath({})).toBe("/tmp/budget-home-test/.automaton/owner/owner.db");
      expect(resolveOwnerDbPath({ ownerDbPath: "/srv/owner/owner.db" })).toBe("/srv/owner/owner.db");
    } finally {
      process.env.HOME = prev;
    }
  });
});
