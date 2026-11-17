import { describe, expect, it } from "vitest";
import { groupAccounts, inGroupOrder, moveAccounts, moveRow, orderAccount, standardLayout } from "@/lib/reports/custom-layout";

describe("editing a layout", () => {
  it("starts from the standard report's labels", () => {
    const layout = standardLayout("profit_and_loss", "2026-06-30");
    const rows = layout.blocks[0].kind === "table" ? layout.blocks[0].rows : [];
    expect(rows.map((row) => row.label)).toEqual(["Trading income", "Cost of sales", "Gross profit", "Other income", "Operating expenses", "Net profit"]);
    const sheet = standardLayout("balance_sheet", "2026-06-30");
    expect(sheet.blocks[0].kind === "table" ? sheet.blocks[0].rows.map((row) => row.label) : []).toContain("Net assets");
  });

  it("groups accounts without changing any total (CR16)", () => {
    const layout = standardLayout("profit_and_loss", "2026-06-30");
    const { layout: grouped, rowId } = groupAccounts(layout, "main", "expenses", ["6120"], "Vehicle costs", "vehicle");
    const rows = grouped.blocks[0].kind === "table" ? grouped.blocks[0].rows : [];
    expect(rowId).toBe("vehicle");
    expect(rows.map((row) => row.id)).toEqual(["revenue", "cost_of_sales", "gross_profit", "other_income", "expenses", "vehicle", "net_profit"]);
    expect(rows.find((row) => row.id === "expenses")).toMatchObject({ accountTypes: ["expense", "depreciation"], exceptCodes: ["6120"] });
    expect(rows.find((row) => row.id === "vehicle")).toMatchObject({ kind: "group", accountCodes: ["6120"] });
    expect(rows.find((row) => row.id === "net_profit")).toMatchObject({
      terms: [
        { rowId: "gross_profit", sign: 1 },
        { rowId: "other_income", sign: 1 },
        { rowId: "expenses", sign: -1 },
        { rowId: "vehicle", sign: -1 },
      ],
    });
    // The original isn't changed.
    expect(layout.blocks[0].kind === "table" ? layout.blocks[0].rows.length : 0).toBe(6);
  });

  describe("moving accounts between groups (CR21)", () => {
    const rowsOf = (layout: ReturnType<typeof standardLayout>) => (layout.blocks[0].kind === "table" ? layout.blocks[0].rows : []);
    const row = (layout: ReturnType<typeof standardLayout>, id: string) => rowsOf(layout).find((entry) => entry.id === id);

    it("moves an account from one group by type to another, and no formula changes", () => {
      const layout = standardLayout("profit_and_loss", "2026-06-30");
      const moved = moveAccounts(layout, "main", "expenses", ["6060"], "cost_of_sales");
      expect(row(moved, "expenses")).toMatchObject({ accountTypes: ["expense", "depreciation"], exceptCodes: ["6060"] });
      expect(row(moved, "cost_of_sales")).toMatchObject({ accountTypes: ["direct_costs"], alsoCodes: ["6060"] });
      expect(row(moved, "net_profit")).toEqual(row(layout, "net_profit"));
      expect(rowsOf(moved).map((entry) => entry.id)).toEqual(rowsOf(layout).map((entry) => entry.id));
      // The original isn't changed.
      expect(row(layout, "expenses")).not.toHaveProperty("exceptCodes");
    });

    it("moving it back undoes the move", () => {
      const layout = standardLayout("profit_and_loss", "2026-06-30");
      const there = moveAccounts(layout, "main", "expenses", ["6060"], "cost_of_sales");
      const back = moveAccounts(there, "main", "cost_of_sales", ["6060"], "expenses");
      expect(row(back, "expenses")).not.toHaveProperty("exceptCodes");
      expect(row(back, "expenses")).not.toHaveProperty("alsoCodes");
      expect(row(back, "cost_of_sales")).not.toHaveProperty("alsoCodes");
      // Left out of cost of sales by code, which changes nothing: it isn't a cost of sales account.
      expect(row(back, "cost_of_sales")).toMatchObject({ exceptCodes: ["6060"] });
    });

    it("moves into and out of a group of chosen accounts", () => {
      const layout = standardLayout("profit_and_loss", "2026-06-30");
      const { layout: grouped } = groupAccounts(layout, "main", "expenses", ["6120", "6080"], "Vehicle costs", "vehicle");
      const added = moveAccounts(grouped, "main", "expenses", ["6060"], "vehicle");
      expect(row(added, "vehicle")).toMatchObject({ accountCodes: ["6120", "6080", "6060"] });
      expect(row(added, "expenses")).toMatchObject({ exceptCodes: ["6120", "6080", "6060"] });
      const out = moveAccounts(added, "main", "vehicle", ["6080"], "expenses");
      expect(row(out, "vehicle")).toMatchObject({ accountCodes: ["6120", "6060"] });
      expect(row(out, "expenses")).toMatchObject({ exceptCodes: ["6120", "6060"] });
      expect(row(out, "expenses")).not.toHaveProperty("alsoCodes");
    });

    it("refuses to empty a group of chosen accounts, or to move to something that isn't a group", () => {
      const layout = standardLayout("profit_and_loss", "2026-06-30");
      const { layout: grouped } = groupAccounts(layout, "main", "expenses", ["6120"], "Vehicle costs", "vehicle");
      expect(() => moveAccounts(grouped, "main", "vehicle", ["6120"], "expenses")).toThrow("Vehicle costs would have no accounts left");
      expect(() => moveAccounts(layout, "main", "expenses", ["6060"], "gross_profit")).toThrow("from one group to another group");
      expect(() => moveAccounts(layout, "main", "expenses", [], "cost_of_sales")).toThrow("at least one account");
    });

    it("moving to the group it's already in changes nothing", () => {
      const layout = standardLayout("profit_and_loss", "2026-06-30");
      expect(moveAccounts(layout, "main", "expenses", ["6060"], "expenses")).toEqual(layout);
    });
  });

  it("moves a row to another place", () => {
    const layout = standardLayout("profit_and_loss", "2026-06-30");
    const moved = moveRow(layout, "main", "expenses", 1);
    expect(moved.blocks[0].kind === "table" ? moved.blocks[0].rows.map((row) => row.id) : []).toEqual([
      "revenue",
      "expenses",
      "cost_of_sales",
      "gross_profit",
      "other_income",
      "net_profit",
    ]);
  });

  describe("putting accounts in order within a group (CR26)", () => {
    const row = (layout: ReturnType<typeof standardLayout>, id: string) => (layout.blocks[0].kind === "table" ? layout.blocks[0].rows : []).find((entry) => entry.id === id);

    it("moves one account to a new place and remembers the group's order", () => {
      const layout = standardLayout("profit_and_loss", "2026-06-30");
      const ordered = orderAccount(layout, "main", "expenses", ["6010", "6060", "6120"], "6120", 0);
      expect(row(ordered, "expenses")).toMatchObject({ order: ["6120", "6010", "6060"] });
      expect(orderAccount(ordered, "main", "expenses", ["6120", "6010", "6060"], "6120", 9)).toMatchObject({});
      expect(row(orderAccount(ordered, "main", "expenses", ["6120", "6010", "6060"], "6120", 9), "expenses")).toMatchObject({ order: ["6010", "6060", "6120"] });
      // The original isn't changed, and an account that isn't listed is refused.
      expect(row(layout, "expenses")).not.toHaveProperty("order");
      expect(() => orderAccount(layout, "main", "expenses", ["6010"], "6120", 0)).toThrow(/isn't in Operating expenses/);
      expect(() => orderAccount(layout, "main", "gross_profit", ["6010"], "6010", 0)).toThrow(/inside a group/);
    });

    it("lists the chosen order first, then any other accounts in code order", () => {
      const lines = ["6010", "6060", "6120", "6200"].map((code) => ({ code }));
      expect(inGroupOrder(lines, ["6120", "6010"]).map((line) => line.code)).toEqual(["6120", "6010", "6060", "6200"]);
      expect(inGroupOrder(lines, undefined)).toBe(lines);
      expect(inGroupOrder(lines, ["9999"]).map((line) => line.code)).toEqual(["6010", "6060", "6120", "6200"]);
    });

    it("moving an account to another group takes it out of the order", () => {
      const layout = orderAccount(standardLayout("profit_and_loss", "2026-06-30"), "main", "expenses", ["6010", "6120"], "6120", 0);
      const moved = moveAccounts(layout, "main", "expenses", ["6120"], "cost_of_sales");
      expect(row(moved, "expenses")).toMatchObject({ order: ["6010"] });
      const all = moveAccounts(moved, "main", "expenses", ["6010"], "cost_of_sales");
      expect(row(all, "expenses")).not.toHaveProperty("order");
    });
  });
});
