import { describe, expect, it } from "vitest";
import { dec, toFixedString } from "@/lib/money/decimal";
import { addBackAmount, LEAVE_ADD_BACK_LABEL, LEAVE_REVERSAL_LABEL, leaveAddBack, leaveAddBackNotes, reversalAmount } from "@/lib/tax/income/leave-add-back";

/** TXF4: leave owed at balance date and the 63-day rule (s EA 4), suggested only. */
describe("leave add-back (TXF4)", () => {
  const account = { code: "2310", name: "Employee entitlements" };

  it("suggests adding back leave owed at balance date less what's paid by the 63rd day", () => {
    const suggestion = leaveAddBack({ account, yearEnd: "2026-03-31", owedAtYearEnd: dec("6327.45"), lastYearAdjustments: [], thisYearAdjustments: [] });
    expect(suggestion).toMatchObject({ payBy: "2026-06-02", owedAtYearEnd: "6327.45", lastYearAddBack: "0.00", addBackAdded: false, reversalAdded: false });
    expect(toFixedString(addBackAmount(dec("6327.45"), dec("1840.00")), 2)).toBe("4487.45");
    expect(toFixedString(addBackAmount(dec("6327.45"), dec("7000.00")), 2)).toBe("0.00");
    expect(toFixedString(addBackAmount(dec("6327.45"), dec("0")), 2)).toBe("6327.45");
    const notes = leaveAddBackNotes(suggestion);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("2026-06-02");
    expect(notes[0]).toContain("s EA 4");
  });

  it("the next year, deducts last year's add-back, and stops nagging once each is added", () => {
    const lastYear = [{ description: LEAVE_ADD_BACK_LABEL, amount: dec("4487.45") }];
    const suggestion = leaveAddBack({ account, yearEnd: "2027-03-31", owedAtYearEnd: dec("5100.00"), lastYearAdjustments: lastYear, thisYearAdjustments: [] })!;
    expect(suggestion.payBy).toBe("2027-06-02");
    expect(toFixedString(reversalAmount(suggestion), 2)).toBe("-4487.45");
    expect(leaveAddBackNotes(suggestion)).toHaveLength(2);
    const done = leaveAddBack({
      account,
      yearEnd: "2027-03-31",
      owedAtYearEnd: dec("5100.00"),
      lastYearAdjustments: lastYear,
      thisYearAdjustments: [
        { description: LEAVE_ADD_BACK_LABEL, amount: dec("5100.00") },
        { description: LEAVE_REVERSAL_LABEL, amount: dec("-4487.45") },
      ],
    });
    expect(leaveAddBackNotes(done)).toEqual([]);
  });

  it("says nothing when no leave is owed and nothing was added back last year", () => {
    expect(leaveAddBack({ account, yearEnd: "2026-03-31", owedAtYearEnd: dec("0"), lastYearAdjustments: [], thisYearAdjustments: [] })).toBeNull();
  });
});
