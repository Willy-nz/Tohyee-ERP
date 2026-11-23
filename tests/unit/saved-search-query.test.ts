import { describe, expect, it } from "vitest";
import { recordType } from "@/lib/saved-searches/catalogue";
import { buildSearch, dateRange, parseDefinition } from "@/lib/saved-searches/query";

const invoices = recordType("invoice")!;

describe("saved search definitions", () => {
  it("fills in the usual columns and tidies values", () => {
    const definition = parseDefinition(invoices, { filters: [{ field: "owing", op: "gt", value: " 1,000 " }, { field: "status", op: "is", value: "approved" }] });
    expect(definition.columns).toEqual(["number", "contact", "date", "due", "status", "total", "owing"]);
    expect(definition.filters).toEqual([
      { field: "owing", op: "gt", value: "1000.00" },
      { field: "status", op: "is", value: "approved" },
    ]);
    expect(definition.sort).toBeNull();
  });

  it("refuses what the record type doesn't have", () => {
    expect(() => parseDefinition(invoices, { filters: [{ field: "password", op: "is", value: "x" }] })).toThrow('Invoices have no field "password".');
    expect(() => parseDefinition(invoices, { filters: [{ field: "total", op: "contains", value: "1" }] })).toThrow('Total can\'t be filtered with "contains".');
    expect(() => parseDefinition(invoices, { filters: [{ field: "total", op: "gt", value: "lots" }] })).toThrow('Total: "lots" isn\'t a number.');
    expect(() => parseDefinition(invoices, { filters: [{ field: "date", op: "on", value: "2026-02-30" }] })).toThrow("isn't a date");
    expect(() => parseDefinition(invoices, { filters: [{ field: "status", op: "is", value: "paid" }] })).toThrow("isn't one of its choices");
    expect(() => parseDefinition(invoices, { filters: [{ field: "date", op: "between", value: "2026-01-01" }] })).toThrow("Date: give the second value.");
    expect(() => parseDefinition(invoices, { columns: ["number", "i.total; drop table bills"] })).toThrow("have no field");
    expect(() => parseDefinition(invoices, { filters: Array(13).fill({ field: "number", op: "empty" }) })).toThrow("up to 12 filters");
  });

  it("works out moving date ranges from today", () => {
    expect(dateRange("this_month", "2026-11-24")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(dateRange("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(dateRange("this_month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(dateRange("last_30", "2026-11-24")).toEqual({ from: "2026-10-26", to: "2026-11-24" });
    expect(dateRange("past", "2026-11-24")).toEqual({ from: null, to: "2026-11-23" });
  });
});

describe("saved search SQL", () => {
  it("passes every value as a parameter and names only catalogue fields", () => {
    const definition = parseDefinition(invoices, {
      filters: [
        { field: "contact", op: "contains", value: "50%_off'; drop table x --" },
        { field: "due", op: "within", value: "past" },
        { field: "owing", op: "between", value: "100", value2: "500" },
      ],
      columns: ["number", "owing", "daysOverdue"],
      sort: { field: "daysOverdue", direction: "desc" },
    });
    const built = buildSearch(invoices, definition, { today: "2026-11-24", limit: 50, offset: 100 });
    expect(built.params).toEqual(["2026-11-24", "%50\\%\\_off'; drop table x --%", "2026-11-23", "100.00", "500.00"]);
    expect(built.rowsSql).not.toContain("drop table");
    expect(built.rowsSql).toContain("c.name ilike $2");
    expect(built.rowsSql).toContain("i.due_date <= $3::date");
    expect(built.rowsSql).toContain("between $4::numeric and $5::numeric");
    expect(built.rowsSql).toContain("limit 51 offset 100");
    // Days overdue is worked out from the organisation's today, not the server's clock.
    expect(built.rowsSql).toContain("$1::date - i.due_date");
    expect(built.rowsSql).not.toContain("$today");
    expect(built.summarySql).toContain("as s1");
    expect(built.summarySql).toContain("as s2");
    expect(built.summarySql).not.toContain("as s0");
  });
});
