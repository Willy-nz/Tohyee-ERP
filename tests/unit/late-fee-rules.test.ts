import { describe, expect, it } from "vitest";
import { addDays, chargeable, interestFor, splitFee } from "@/lib/invoices/late-fee-rules";

const settings = { enabled: true, feeAmount: "25.00", interestRate: "12", graceDays: 7, minimumOverdue: "20.00" };

describe("late fees (LATE1-LATE12)", () => {
  it("LATE1, LATE2, LATE11: off, grace, minimum", () => {
    const invoice = { dueDate: "2026-10-31", amountDue: "1150.00" };
    expect(chargeable({ ...settings, enabled: false }, invoice, "2026-11-30")).toBe(false);
    expect(chargeable({ ...settings, feeAmount: null, interestRate: null }, invoice, "2026-11-30")).toBe(false);
    expect(chargeable(settings, invoice, "2026-11-07")).toBe(false);
    expect(chargeable(settings, invoice, "2026-11-08")).toBe(true);
    expect(chargeable(settings, { ...invoice, amountDue: "19.99" }, "2026-11-30")).toBe(false);
    expect(chargeable(settings, { ...invoice, amountDue: "0.00" }, "2026-11-30")).toBe(false);
  });

  it("LATE6: simple interest by the day, from the day after the due date", () => {
    expect(interestFor({ owing: "1150.00", changes: [], from: "2026-11-01", to: "2026-11-30", ratePercent: "12", scale: 2 })).toEqual({
      amount: "11.34", days: 30, balanceDays: "34500.00",
    });
  });

  it("LATE7: part payments count from their date; one voided later counts as never made from then", () => {
    const changes = [{ date: "2026-11-10", amount: "-650.00" }];
    expect(interestFor({ owing: "1150.00", changes, from: "2026-11-01", to: "2026-11-30", ratePercent: "12", scale: 2 }).amount).toBe("6.85");
    // Paid before the period: only what's left.
    expect(interestFor({ owing: "1150.00", changes: [{ date: "2026-10-20", amount: "-1150.00" }], from: "2026-11-01", to: "2026-11-30", ratePercent: "12", scale: 2 }).amount).toBe("0.00");
    // Voided on the 20th: owing again from the 20th.
    const voided = [...changes, { date: "2026-11-20", amount: "650.00" }];
    // 1150 x 9 + 500 x 10 + 1150 x 11 = 10350 + 5000 + 12650 = 28000
    expect(interestFor({ owing: "1150.00", changes: voided, from: "2026-11-01", to: "2026-11-30", ratePercent: "12", scale: 2 })).toMatchObject({ amount: "9.21", balanceDays: "28000.00" });
    // Overpaid: nothing.
    expect(interestFor({ owing: "100.00", changes: [{ date: "2026-11-01", amount: "-150.00" }], from: "2026-11-01", to: "2026-11-30", ratePercent: "12", scale: 2 }).amount).toBe("0.00");
  });

  it("LATE8: no days, no interest", () => {
    expect(interestFor({ owing: "100.00", changes: [], from: "2026-12-01", to: "2026-11-30", ratePercent: "12", scale: 2 })).toMatchObject({ amount: "0.00", days: 0 });
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  });

  it("LATE12: rounded to the currency's smallest unit", () => {
    expect(interestFor({ owing: "100000", changes: [], from: "2026-11-01", to: "2026-11-30", ratePercent: "12", scale: 0 }).amount).toBe("986");
  });

  it("LATE5: the fee follows the sale's tax codes, in shares, odd cents on the largest", () => {
    expect(splitFee("25.00", [{ taxCode: "GST", net: "1000.00" }], 2, "NONE")).toEqual([{ taxCode: "GST", amount: "25.00" }]);
    expect(splitFee("25.00", [{ taxCode: "GST", net: "200.00" }, { taxCode: "ZERO", net: "100.00" }, { taxCode: "GST", net: "-50.00" }], 2, "NONE")).toEqual([
      { taxCode: "GST", amount: "15.00" },
      { taxCode: "ZERO", amount: "10.00" },
    ]);
    // 10 / 3: 3.33 + 3.33 + 3.34 with the odd cent on the first (largest, tie).
    expect(splitFee("10.00", [{ taxCode: "A", net: "1" }, { taxCode: "B", net: "1" }, { taxCode: "C", net: "1" }], 2, null)).toEqual([
      { taxCode: "A", amount: "3.34" }, { taxCode: "B", amount: "3.33" }, { taxCode: "C", amount: "3.33" },
    ]);
    expect(splitFee("25.00", [{ taxCode: "GST", net: "0" }], 2, "NONE")).toEqual([{ taxCode: "NONE", amount: "25.00" }]);
  });
});
