import { describe, expect, it } from "vitest";
import { addMonths, catchUp, daysByMonth, endEarly, monthEndDate, monthsBegun, respread, spreadPosting, spreadSchedule, splitAt } from "@/lib/spreading/rules";

const amounts = (rows: Array<{ amount: string }>) => rows.map((row) => row.amount);
const total = (rows: Array<{ amount: string }>) => rows.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;

describe("spreading: which months an amount lands in (SW1-SW5, SW12, SW13)", () => {
  it("SW1: 1,200.00 for 1 Jul 2026 to 30 Jun 2027 is 100.00 a month, July to June", () => {
    const schedule = spreadSchedule({ amount: "1200.00", method: "by_month", startDate: "2026-07-01", endDate: "2027-06-30" });
    expect(schedule).toHaveLength(12);
    expect(schedule[0]).toEqual({ month: "2026-07", amount: "100.00" });
    expect(schedule[11]).toEqual({ month: "2027-06", amount: "100.00" });
    expect(new Set(amounts(schedule))).toEqual(new Set(["100.00"]));
  });

  it("SW2: 1,000.00 over 12 months is 83.33 eleven times and 83.37 last, 1,000.00 exactly", () => {
    const schedule = spreadSchedule({ amount: "1000.00", method: "by_month", startDate: "2026-07-01", endDate: "2027-06-30" });
    expect(amounts(schedule).slice(0, 11)).toEqual(Array(11).fill("83.33"));
    expect(schedule[11].amount).toBe("83.37");
    expect(total(schedule)).toBe(1000);
  });

  it("SW3: 15 Jul 2026 to 14 Jul 2027 by month is twelve months, July to June", () => {
    expect(monthsBegun("2026-07-15", "2027-07-14")).toEqual([
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
    ]);
    // One more day begins a thirteenth month.
    expect(monthsBegun("2026-07-15", "2027-07-15")).toHaveLength(13);
    // A start on the 31st begins on the last day of a shorter month.
    expect(monthsBegun("2026-01-31", "2026-02-28")).toEqual(["2026-01", "2026-02"]);
    expect(monthsBegun("2026-01-31", "2026-02-27")).toEqual(["2026-01"]);
  });

  it("SW3: the same days by days give each calendar month its days out of 365", () => {
    expect(daysByMonth("2026-07-15", "2027-07-14").map((entry) => entry.days)).toEqual([17, 31, 30, 31, 30, 31, 31, 28, 31, 30, 31, 30, 14]);
    const schedule = spreadSchedule({ amount: "1200.00", method: "by_days", startDate: "2026-07-15", endDate: "2027-07-14" });
    expect(amounts(schedule)).toEqual(["55.89", "101.92", "98.63", "101.92", "98.63", "101.92", "101.92", "92.05", "101.92", "98.63", "101.92", "98.63", "46.02"]);
    expect(total(schedule)).toBe(1200);
  });

  it("SW5: all in one month", () => {
    expect(spreadSchedule({ amount: "500.00", method: "one_month", month: "2027-03" })).toEqual([{ month: "2027-03", amount: "500.00" }]);
    expect(() => spreadSchedule({ amount: "500.00", method: "one_month" })).toThrow(/Choose the month/);
  });

  it("SW12: when it's done has no months until it's finished, then all of it lands in that month", () => {
    expect(spreadSchedule({ amount: "3000.00", method: "when_done" })).toEqual([]);
    expect(spreadSchedule({ amount: "3000.00", method: "when_done", month: "2027-02" })).toEqual([{ month: "2027-02", amount: "3000.00" }]);
  });

  it("SW13: your own amounts must add up to the amount", () => {
    const rows = [
      { month: "2026-12", amount: "600.00" },
      { month: "2026-10", amount: "250.00" },
      { month: "2026-11", amount: "150.00" },
    ];
    expect(spreadSchedule({ amount: "1000.00", method: "own_amounts", ownAmounts: rows }).map((row) => row.month)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(() => spreadSchedule({ amount: "1000.00", method: "own_amounts", ownAmounts: rows.slice(0, 2) })).toThrow("Your amounts add up to 850.00, not 1000.00.");
    expect(() => spreadSchedule({ amount: "500.00", method: "own_amounts", ownAmounts: [rows[0], { month: "2026-12", amount: "1.00" }] })).toThrow(/there twice/);
  });

  it("refuses an amount that isn't money, dates the wrong way round, and more than ten years", () => {
    expect(() => spreadSchedule({ amount: "0", method: "one_month", month: "2026-07" })).toThrow(/more than zero/);
    expect(() => spreadSchedule({ amount: "10.005", method: "one_month", month: "2026-07" })).toThrow(/dollars and cents/);
    expect(() => spreadSchedule({ amount: "abc", method: "one_month", month: "2026-07" })).toThrow(/Give the amount/);
    expect(() => spreadSchedule({ amount: "100.00", method: "by_month", startDate: "2026-07-02", endDate: "2026-07-01" })).toThrow(/can't be before/);
    expect(() => spreadSchedule({ amount: "100.00", method: "by_month", startDate: "2026-07-01", endDate: "2037-07-01" })).toThrow(/ten years/);
    expect(() => spreadSchedule({ amount: "100.00", method: "by_days", startDate: "2026-07-01", endDate: "2037-07-01" })).toThrow(/ten years/);
  });

  it("a cent over many months still adds up: the last month takes it", () => {
    const schedule = spreadSchedule({ amount: "0.01", method: "by_month", startDate: "2026-07-01", endDate: "2026-09-30" });
    expect(amounts(schedule)).toEqual(["0.00", "0.00", "0.01"]);
  });
});

describe("spreading: changes and directions", () => {
  const insurance = spreadSchedule({ amount: "1200.00", method: "by_month", startDate: "2026-07-01", endDate: "2027-06-30" });

  it("SW8: ending early moves what's left into one month and leaves posted months alone", () => {
    const ended = endEarly(insurance, "2027-02", "2027-03");
    expect(ended).toHaveLength(9);
    expect(ended.slice(0, 8)).toEqual(insurance.slice(0, 8));
    expect(ended[8]).toEqual({ month: "2027-03", amount: "400.00" });
    expect(() => endEarly(insurance, "2027-02", "2027-02")).toThrow(/after the last one posted/);
    // Nothing posted yet: all of it lands in the month chosen.
    expect(endEarly(insurance, null, "2026-08")).toEqual([{ month: "2026-08", amount: "1200.00" }]);
  });

  it("SW18: months already posted are caught up in the next month to post", () => {
    const late = catchUp(insurance, "2026-10");
    expect(late.caughtUp).toEqual({ months: 4, amount: "400.00", into: "2026-11" });
    expect(late.schedule).toHaveLength(8);
    expect(late.schedule[0]).toEqual({ month: "2026-11", amount: "500.00" });
    expect(late.schedule[1]).toEqual({ month: "2026-12", amount: "100.00" });
    expect(total(late.schedule)).toBe(1200);
    // Nothing posted, or it starts later: unchanged.
    expect(catchUp(insurance, null)).toEqual({ schedule: insurance, caughtUp: null });
    expect(catchUp(insurance, "2026-06").caughtUp).toBeNull();
    // All of it is in posted months: one amount in the next month.
    expect(catchUp(insurance, "2027-08").schedule).toEqual([{ month: "2027-09", amount: "1200.00" }]);
  });

  it("SW11: what has landed and what's left after a month", () => {
    expect(splitAt(insurance, "2026-09")).toEqual({ through: "300.00", after: "900.00" });
    expect(splitAt(insurance, null)).toEqual({ through: "0.00", after: "1200.00" });
  });

  it("each kind's journal runs the right way (SW1, SW4, SW6, SW7)", () => {
    expect(spreadPosting("prepayment")).toEqual({ holding: "credit", target: "debit" });
    expect(spreadPosting("income_in_advance")).toEqual({ holding: "debit", target: "credit" });
    expect(spreadPosting("accrued_expense")).toEqual({ holding: "credit", target: "debit" });
    expect(spreadPosting("accrued_income")).toEqual({ holding: "debit", target: "credit" });
  });

  it("months and month ends", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(monthEndDate("2027-02")).toBe("2027-02-28");
    expect(monthEndDate("2028-02")).toBe("2028-02-29");
  });
});

describe("spreading: a new last day, or a new amount still to come (SW29, SW30)", () => {
  const amounts = (rows: Array<{ month: string; amount: string }> | null) => rows?.map((row) => [row.month, row.amount]) ?? null;

  it("by month: what's left is shared evenly over the months still to come", () => {
    // 1,200.00 over a year, three months posted: 900.00 left.
    const plan = { method: "by_month" as const, startDate: "2026-07-01", left: "900.00", through: "2026-09" };
    expect(amounts(respread({ ...plan, endDate: "2026-12-31" }))).toEqual([["2026-10", "300.00"], ["2026-11", "300.00"], ["2026-12", "300.00"]]);
    expect(respread({ ...plan, endDate: "2027-09-30" })?.map((row) => row.amount)).toEqual(Array.from({ length: 12 }, () => "75.00"));
    // The cents that won't share out go in the last month.
    expect(amounts(respread({ ...plan, left: "100.00", endDate: "2026-12-31" }))).toEqual([["2026-10", "33.33"], ["2026-11", "33.33"], ["2026-12", "33.34"]]);
    // Nothing posted yet: the whole thing, from its first month.
    expect(amounts(respread({ ...plan, through: null, left: "1200.00", endDate: "2026-08-31" }))).toEqual([["2026-07", "600.00"], ["2026-08", "600.00"]]);
    // A last day inside the months already posted leaves nothing to come.
    expect(respread({ ...plan, endDate: "2026-09-30" })).toBeNull();
    expect(respread({ ...plan, endDate: "2026-06-30" })).toBeNull();
  });

  it("by month: a cover that starts mid-month still counts its months from the first day", () => {
    // 12 Nov to 11 Feb is three months (Nov, Dec, Jan); moved out to 11 Mar it's four.
    const plan = { method: "by_month" as const, startDate: "2026-11-12", left: "800.00", through: "2026-11" };
    expect(amounts(respread({ ...plan, endDate: "2027-03-11" }))).toEqual([["2026-12", "266.66"], ["2027-01", "266.66"], ["2027-02", "266.68"]]);
  });

  it("by days: each month still to come takes its days", () => {
    // 1,000.00 over 1 Jan to 10 Apr 2027; January's 310.00 has posted, 690.00 is left.
    const plan = { method: "by_days" as const, startDate: "2027-01-01", left: "690.00", through: "2027-01" };
    // To 31 Mar: February 28 days and March 31, 59 in all.
    expect(amounts(respread({ ...plan, endDate: "2027-03-31" }))).toEqual([["2027-02", "327.46"], ["2027-03", "362.54"]]);
    // Nothing posted: from its own first day.
    expect(amounts(respread({ ...plan, through: null, left: "590.00", startDate: "2027-01-01", endDate: "2027-02-28" }))).toEqual([["2027-01", "310.00"], ["2027-02", "280.00"]]);
    expect(respread({ ...plan, endDate: "2027-01-31" })).toBeNull();
  });
});
