import { describe, expect, it } from "vitest";
import { dec, toFixedString } from "@/lib/money/decimal";
import { type Payment } from "@/lib/tax/income/rules";
import { estimationSchedule, optionRequirements, ratioInstalmentPeriods, ratioSchedule } from "@/lib/tax/income/provisional-options";
import { underpaymentInterest } from "@/lib/tax/income/uomi";

const paid = (date: string, amount: string, instalment: number): Payment => ({ date, amount: dec(amount), allocations: [{ appliesTo: instalment, amount: dec(amount), status: "confirmed" }] });

describe("provisional tax options (TXF15, TXF16)", () => {
  it("TXF15: estimation instalments are estimate × n ÷ 3 less the earlier instalments, and a new estimate changes the later ones", () => {
    const estimates = [
      { estimatedOn: "2026-08-01", amount: dec("30000") },
      { estimatedOn: "2027-01-10", amount: dec("60000") },
    ];
    const schedule = estimationSchedule({ year: 2027, instalmentCount: 3, estimates, standardTargets: null, payments: [], today: "2027-01-12" });
    expect(schedule.kind).toBe("schedule");
    if (schedule.kind !== "schedule") return;
    expect(schedule.instalments.map((entry) => [entry.dueDate, entry.amount])).toEqual([
      ["2026-08-28", "10000.00"],
      ["2027-01-15", "30000.00"],
      ["2027-05-07", "20000.00"],
    ]);
    expect(schedule.total).toBe("60000.00");
    expect(schedule.instalments[1].basis).toContain("60,000.00");
    // Six-monthly GST filers: two instalments of half.
    const two = estimationSchedule({ year: 2027, instalmentCount: 2, estimates: estimates.slice(0, 1), standardTargets: null, payments: [], today: "2026-09-01" });
    expect(two.kind === "schedule" && two.instalments.map((entry) => [entry.dueDate, entry.amount])).toEqual([
      ["2026-10-28", "15000.00"],
      ["2027-05-07", "15000.00"],
    ]);
  });

  it("TXF15: an instalment before the first estimate keeps its standard amount; with no estimate, nothing is worked out", () => {
    const late = estimationSchedule({
      year: 2027,
      instalmentCount: 3,
      estimates: [{ estimatedOn: "2026-12-01", amount: dec("60000") }],
      standardTargets: [dec("8000"), dec("16000"), dec("24000")],
      payments: [],
      today: "2026-12-02",
    });
    expect(late.kind === "schedule" && late.instalments.map((entry) => entry.amount)).toEqual(["8000.00", "32000.00", "20000.00"]);
    expect(late.kind === "schedule" && late.instalments[0].basis).toContain("standard option");
    expect(estimationSchedule({ year: 2027, instalmentCount: 3, estimates: [], standardTargets: null, payments: [], today: "2026-12-02" }).kind).toBe("unknown");
  });

  it("TXF15: interest on the actual RIT's equal shares from each instalment date, with no $60,000 rule: 309.65", () => {
    const instalments = [{ due: "2026-08-28" }, { due: "2027-01-15" }, { due: "2027-05-07" }];
    const due = optionRequirements({ option: "estimation", rit: dec("57000"), instalmentDates: instalments.map((entry) => entry.due), standardInstalments: null, endOfYearDue: "2028-02-07" });
    expect(due!.map((entry) => [entry.due, toFixedString(entry.amount, 2)])).toEqual([
      ["2026-08-28", "19000.00"],
      ["2027-01-15", "19000.00"],
      ["2027-05-07", "19000.00"],
    ]);
    const result = underpaymentInterest({
      requirements: due!,
      payments: [
        { date: "2026-08-28", amount: dec("10000") },
        { date: "2027-01-15", amount: dec("30000") },
        { date: "2027-05-07", amount: dec("20000") },
      ],
      asAt: "2028-03-01",
      today: "2028-03-01",
    });
    expect(result.interest).toBe("309.65");
    expect(result.periods).toEqual([{ from: "2026-08-29", to: "2027-01-15", days: 140, outstanding: "9000.00", rate: "8.97", interest: "309.65" }]);
  });

  it("TXF16, TXF17: ratio interest only after the end-of-year date; AIM has none worked out", () => {
    const ratio = optionRequirements({ option: "ratio", rit: dec("30000"), instalmentDates: [], standardInstalments: null, endOfYearDue: "2028-02-07" });
    expect(ratio!.map((entry) => [entry.due, toFixedString(entry.amount, 2)])).toEqual([["2028-02-07", "30000.00"]]);
    const interest = underpaymentInterest({ requirements: ratio!, payments: [{ date: "2027-05-07", amount: dec("26000") }], asAt: "2028-02-09", today: "2028-02-09" });
    expect(interest.periods[0]).toMatchObject({ from: "2028-02-08", outstanding: "4000.00" });
    expect(optionRequirements({ option: "aim", rit: dec("30000"), instalmentDates: [], standardInstalments: null, endOfYearDue: "2028-02-07" })).toBeNull();
  });

  it("TXF16: six ratio instalments for a 31 March balance date, each for the two months before", () => {
    expect(ratioInstalmentPeriods(2027).map((entry) => [entry.dueDate, entry.periodStart, entry.periodEnd])).toEqual([
      ["2026-06-28", "2026-04-01", "2026-05-31"],
      ["2026-08-28", "2026-06-01", "2026-07-31"],
      ["2026-10-28", "2026-08-01", "2026-09-30"],
      ["2027-01-15", "2026-10-01", "2026-11-30"],
      ["2027-02-28", "2026-12-01", "2027-01-31"],
      ["2027-05-07", "2027-02-01", "2027-03-31"],
    ]);
  });

  it("TXF16: each instalment is the ratio × Box 5 for its two months; later ones aren't known yet", () => {
    const periods = ratioInstalmentPeriods(2027);
    const supplies = periods.map((period, index) => ({ ...period, box5: index === 0 ? dec("13000") : index === 1 ? dec("-500") : null, source: index < 2 ? ("filed" as const) : null }));
    const schedule = ratioSchedule({ year: 2027, ratioPercent: dec("8"), supplies, payments: [paid("2026-06-29", "1040", 1)], today: "2026-08-10" });
    expect(schedule.kind).toBe("schedule");
    if (schedule.kind !== "schedule") return;
    expect(schedule.instalments[0]).toMatchObject({ amount: "1040.00", paid: "1040.00", remaining: "0.00", onTimeBy: { date: "2026-06-29" } });
    expect(schedule.instalments[0].basis).toContain("8% × 13,000.00");
    expect(schedule.instalments[1]).toMatchObject({ amount: "0.00" });
    expect(schedule.notes.join(" ")).toContain("negative");
    expect(schedule.instalments[2]).toMatchObject({ amount: "0.00", notKnownYet: true });
    expect(schedule.total).toBe("1040.00");
  });
});
