import { describe, expect, it } from "vitest";
import { dec, toFixedString } from "@/lib/money/decimal";
import { balancingEarnings, inRoundedUnits, isReportRounding, roundedGroups, roundingCaption, roundToUnit } from "@/lib/reports/rounding";

const rounded = (value: string, rounding: "whole" | "thousands" | "millions") => toFixedString(roundToUnit(dec(value), rounding), 2);

describe("rounded figures (RND1-RND5)", () => {
  it("rounds to the unit, a half going away from zero, and stays in dollars", () => {
    expect(rounded("1400.40", "whole")).toBe("1400.00");
    expect(rounded("2500.50", "whole")).toBe("2501.00");
    expect(rounded("-2500.50", "whole")).toBe("-2501.00");
    expect(rounded("1499.99", "thousands")).toBe("1000.00");
    expect(rounded("1500.00", "thousands")).toBe("2000.00");
    expect(rounded("-499.99", "thousands")).toBe("0.00");
    expect(rounded("2500000", "millions")).toBe("3000000.00");
  });

  it("shows a rounded amount in its unit", () => {
    expect(inRoundedUnits("12000.00", "thousands")).toBe("12");
    expect(inRoundedUnits("-2421.00", "whole")).toBe("-2421");
    expect(inRoundedUnits("3000000.00", "millions")).toBe("3");
    expect(inRoundedUnits("0.00", "thousands")).toBe("0");
  });

  it("knows its choices and says what the figures are in", () => {
    expect(isReportRounding("thousands")).toBe(true);
    expect(isReportRounding("hundreds")).toBe(false);
    expect(roundingCaption("thousands", "NZD")).toBe("Figures are in NZD thousands. Each total is added from the rounded lines above it.");
    expect(roundingCaption("whole", "NZD")).toContain("rounded to whole NZD");
  });

  it("RND4: the current year's earnings make a rounded balance sheet balance", () => {
    const leaves = [
      { sign: 1 as const, amount: dec("10899.70") },
      { sign: 1 as const, amount: dec("2500.40") },
      { sign: -1 as const, amount: dec("1500.50") },
      { sign: -1 as const, amount: dec("10000.00") },
    ];
    expect(toFixedString(balancingEarnings(leaves, dec("1899.60"), "whole")!, 2)).toBe("1899.00");
    expect(toFixedString(balancingEarnings(leaves, dec("1899.60"), "thousands")!, 2)).toBe("2000.00");
    // Lines that don't balance before rounding (an account left out) aren't adjusted.
    expect(balancingEarnings(leaves.slice(1), dec("1899.60"), "whole")).toBeNull();
  });

  it("RND6: groups of lines add up to their target through the profit line", () => {
    const amounts: Record<string, string> = { profit: "1899.60", "account:1600": "-2500.40", "account:2800": "1500.50", "account:3000": "10000.00" };
    const amountOf = (ref: string) => dec(amounts[ref] ?? "0");
    const groups = [
      { id: "op", refs: ["profit"], showLines: false },
      { id: "inv", refs: ["account:1600"], showLines: false },
      { id: "fin", refs: ["account:2800", "account:3000"], showLines: true },
    ];
    const exact = roundedGroups(groups, amountOf, undefined, dec("10900"));
    expect(toFixedString(exact.total, 2)).toBe("10899.70");
    const whole = roundedGroups(groups, amountOf, "whole", dec("10900"));
    expect([...whole.rows].map(([id, row]) => [id, toFixedString(row.value, 0)])).toEqual([["op", "1899"], ["inv", "-2500"], ["fin", "11501"]]);
    expect(toFixedString(whole.rows.get("op")!.lines.get("profit")!, 0)).toBe("1899");
    expect(toFixedString(whole.total, 0)).toBe("10900");
    // With nothing to add up to, each row is just rounded.
    expect(toFixedString(roundedGroups(groups, amountOf, "whole").total, 0)).toBe("10901");
    // A listed group is the sum of its rounded lines; as one figure it's rounded once.
    const pair = (showLines: boolean) => toFixedString(roundedGroups([{ id: "g", refs: ["a", "b"], showLines }], () => dec("0.40"), "whole").total, 0);
    expect(pair(true)).toBe("0");
    expect(pair(false)).toBe("1");
  });
});
