import { describe, expect, it } from "vitest";
import { standardCashFlowLayout, standardEquityLayout, type CashFlowLayout, type CashFlowSection } from "@/lib/reports/custom-layout";
import { cashFlowGroups, equityGroups, moveCashFlowLine, moveEquityLine, stepLine } from "@/lib/reports/move-lines";

function cashFlow(): CashFlowLayout {
  const layout = standardCashFlowLayout("2026-03-31");
  const [operating, investing] = layout.blocks as CashFlowSection[];
  operating.rows.push({ id: "g-receipts", kind: "group", label: "Receipts", lines: ["account:1100", "account:2100", "account:2200"], showLines: true });
  investing.rows.push({ id: "h-1", kind: "heading", label: "Plant" }, { id: "g-plant", kind: "group", label: "Plant and equipment", lines: ["account:1500"], showLines: true });
  return layout;
}
const linesOf = (layout: CashFlowLayout, groupId: string) => {
  for (const block of layout.blocks) if (block.kind === "section") for (const row of block.rows) if (row.kind === "group" && row.id === groupId) return row.lines;
  return null;
};

describe("moving a line on a cash flow or equity layout", () => {
  it("names each group with its section", () => {
    expect(cashFlowGroups(cashFlow())).toEqual([
      { id: "profit", label: "Operating activities › Net profit" },
      { id: "g-receipts", label: "Operating activities › Receipts" },
      { id: "g-plant", label: "Investing activities › Plant and equipment" },
    ]);
  });

  it("moves a line from Operating to Investing in one step, to the end or before another line", () => {
    const layout = cashFlow();
    expect(moveCashFlowLine(layout, "account:2100", "g-plant")).toBe(true);
    expect(linesOf(layout, "g-receipts")).toEqual(["account:1100", "account:2200"]);
    expect(linesOf(layout, "g-plant")).toEqual(["account:1500", "account:2100"]);
    expect(moveCashFlowLine(layout, "account:2200", "g-plant", "account:1500")).toBe(true);
    expect(linesOf(layout, "g-plant")).toEqual(["account:2200", "account:1500", "account:2100"]);
    // A line that was in no group (it showed in its usual place) can be put in one.
    expect(moveCashFlowLine(layout, "adjust:depreciation", "g-receipts")).toBe(true);
    expect(linesOf(layout, "g-receipts")).toEqual(["account:1100", "adjust:depreciation"]);
  });

  it("reorders within a group, and changes nothing for a move to where it already is or to a group that isn't there", () => {
    const layout = cashFlow();
    expect(moveCashFlowLine(layout, "account:2200", "g-receipts", "account:1100")).toBe(true);
    expect(linesOf(layout, "g-receipts")).toEqual(["account:2200", "account:1100", "account:2100"]);
    const before = JSON.stringify(layout);
    expect(moveCashFlowLine(layout, "account:2100", "g-receipts")).toBe(false);
    expect(moveCashFlowLine(layout, "account:2200", "g-receipts", "account:1100")).toBe(false);
    expect(moveCashFlowLine(layout, "account:2200", "g-receipts", "account:2200")).toBe(false);
    expect(moveCashFlowLine(layout, "account:2200", "h-1")).toBe(false);
    expect(moveCashFlowLine(layout, "account:2200", "nope")).toBe(false);
    expect(JSON.stringify(layout)).toBe(before);
  });

  it("does the same on Changes in equity", () => {
    const layout = standardEquityLayout("2026-03-31");
    layout.blocks.push({ id: "g-owners", kind: "group", label: "Owners", lines: ["account:3100", "account:3200"], showLines: true }, { id: "n-1", kind: "text", text: "A note." });
    expect(equityGroups(layout)).toEqual([
      { id: "profit", label: "Net profit" },
      { id: "g-owners", label: "Owners" },
    ]);
    expect(moveEquityLine(layout, "account:3200", "profit")).toBe(true);
    expect(layout.blocks[0]).toMatchObject({ lines: ["profit", "account:3200"] });
    expect(layout.blocks[1]).toMatchObject({ lines: ["account:3100"] });
    expect(moveEquityLine(layout, "account:3200", "n-1")).toBe(false);
  });

  it("steps a line up or down, stopping at the ends", () => {
    expect(stepLine(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(stepLine(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(stepLine(["a", "b", "c"], "a", -1)).toBeNull();
    expect(stepLine(["a", "b", "c"], "c", 1)).toBeNull();
    expect(stepLine(["a"], "x", 1)).toBeNull();
  });
});
