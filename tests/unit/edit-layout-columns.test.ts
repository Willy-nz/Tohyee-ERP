import { describe, expect, it } from "vitest";
import { editLayoutColumns } from "@/lib/reports/custom-layout";

/** Example CR24 in docs/ACCOUNTING-EXAMPLES.md. */
describe("Edit layout keeps the dates on screen (CR24)", () => {
  const pl = (from: string | null, to: string, extra: Partial<{ compare: number; compareBy: "month" | "quarter" | "year"; ytd: boolean }> = {}) =>
    editLayoutColumns("profit_and_loss", { from, to, compare: 0, compareBy: "month", ...extra });

  it("a year stays a year, not March alone", () => {
    expect(pl("2025-04-01", "2026-03-31")).toEqual({ columns: { periodEnd: "2026-03-31", periodLength: "year", periodCount: 1, yearToDate: false } });
  });

  it("keeps the comparison and year to date", () => {
    expect(pl("2025-04-01", "2026-03-31", { compare: 1, compareBy: "year" })).toEqual({ columns: { periodEnd: "2026-03-31", periodLength: "year", periodCount: 2, yearToDate: false } });
    expect(pl("2026-03-01", "2026-03-31", { ytd: true })).toEqual({ columns: { periodEnd: "2026-03-31", periodLength: "month", periodCount: 1, yearToDate: true } });
  });

  it("a quarter and a month keep their length", () => {
    expect(pl("2026-01-01", "2026-03-31")).toMatchObject({ columns: { periodLength: "quarter", periodCount: 1 } });
    expect(pl("2026-03-01", "2026-03-31")).toMatchObject({ columns: { periodLength: "month", periodCount: 1 } });
  });

  it("dates the editor can't show say why instead of becoming one month", () => {
    expect(pl("2025-04-01", "2026-03-15")).toHaveProperty("problem");
    expect(pl("2025-04-01", "2025-07-31")).toHaveProperty("problem");
    expect(pl("2025-04-15", "2026-03-31")).toHaveProperty("problem");
    expect(pl("2026-01-01", "2026-03-31", { compare: 2, compareBy: "month" })).toHaveProperty("problem");
  });

  it("a balance sheet keeps its comparisons", () => {
    expect(editLayoutColumns("balance_sheet", { from: null, to: "2026-03-31", compare: 2, compareBy: "quarter" })).toEqual({
      columns: { periodEnd: "2026-03-31", periodLength: "quarter", periodCount: 3, yearToDate: false },
    });
  });
});
