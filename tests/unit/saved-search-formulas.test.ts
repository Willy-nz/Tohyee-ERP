import { describe, expect, it } from "vitest";
import { recordType } from "@/lib/saved-searches/catalogue";
import { formulaSql, parseFormulas, withFormulas } from "@/lib/saved-searches/formulas";
import { buildSearch, parseDefinition } from "@/lib/saved-searches/query";

const invoices = recordType("invoice")!;
const sql = (expression: string) => formulaSql(invoices, { label: "Sum", expression });

describe("calculated columns", () => {
  it("writes a sum out from the catalogue's own expressions", () => {
    expect(sql("{total} - {owing}")).toBe("round((coalesce((i.total)::numeric, 0) - coalesce(((case when i.status = 'approved' then i.total - paid.amount - credited.amount else 0 end))::numeric, 0)), 2)");
    // Times and divide before plus and minus; dividing by nothing gives nothing.
    expect(sql("1 + 2 * 3")).toBe("round((1::numeric + (2::numeric * 3::numeric)), 2)");
    expect(sql("(1 + 2) * -3")).toBe("round((((1::numeric + 2::numeric)) * (- 3::numeric)), 2)");
    expect(sql("{owing} / {total} * 100")).toContain("/ nullif(coalesce((i.total)::numeric, 0), 0)");
  });

  it("refuses anything that isn't a sum over number fields", () => {
    expect(() => sql("{total}; drop table bills")).toThrow("isn't something a sum can use");
    expect(() => sql("select 1")).toThrow("isn't something a sum can use");
    expect(() => sql("{contact} + 1")).toThrow("{contact} isn't a number");
    expect(() => sql("{secret} + 1")).toThrow("have no field {secret}");
    expect(() => sql("{total} +")).toThrow("stops part way");
    expect(() => sql("({total} + 1")).toThrow("bracket isn't closed");
    expect(() => sql("{total} {owing}")).toThrow("in the wrong place");
    expect(() => sql("")).toThrow("write the sum");
    expect(() => sql("(".repeat(9) + "1" + ")".repeat(9))).toThrow("too many brackets");
    expect(() => parseFormulas(invoices, [{ key: "f9", label: "X", expression: "1" }])).toThrow("f1 to f5");
    expect(() => parseFormulas(invoices, [{ key: "f1", label: "", expression: "1" }])).toThrow("name");
    // A formula stands on the record's fields, not on another formula.
    expect(() => parseFormulas(invoices, [{ key: "f1", label: "A", expression: "{total}" }, { key: "f2", label: "B", expression: "{f1} * 2" }])).toThrow("have no field {f1}");
  });

  it("can be shown, filtered and sorted like any number", () => {
    const definition = parseDefinition(invoices, {
      formulas: [{ key: "f1", label: "Paid so far", expression: "{total} - {owing}" }],
      filters: [{ field: "f1", op: "gt", value: "100" }],
      columns: ["number", "f1"],
      sort: { field: "f1", direction: "desc" },
    });
    expect(definition.formulas).toEqual([{ key: "f1", label: "Paid so far", expression: "{total} - {owing}" }]);
    const built = buildSearch(invoices, definition, { today: "2026-11-24", limit: 10, offset: 0 });
    expect(built.params).toEqual(["2026-11-24", "100.00"]);
    expect(built.rowsSql).toContain("> $2::numeric");
    expect(built.rowsSql).toContain("order by round(");
    // Money less money is money; a percentage or anything with a plain number in it is a number.
    const kinds = withFormulas(invoices, [
      { key: "f1", label: "Paid", expression: "{total} - {owing}" },
      { key: "f2", label: "Share", expression: "{owing} / {total} * 100" },
      { key: "f3", label: "Plus ten", expression: "{total} + 10" },
    ]).fields.slice(-3).map((field) => field.type);
    expect(kinds).toEqual(["money", "number", "number"]);
    // Without the formula, its key means nothing.
    expect(() => parseDefinition(invoices, { columns: ["f1"] })).toThrow('have no field "f1"');
  });
});
