import { describe, expect, it } from "vitest";
import { recordType } from "@/lib/saved-searches/catalogue";
import { savedSearchFromList, startFromAddress } from "@/lib/saved-searches/from-list";
import { parseDefinition } from "@/lib/saved-searches/query";

describe("Save this view", () => {
  const read = (href: string) => startFromAddress(new URL(href, "http://x").searchParams.get("start"));

  it("carries the tab and the sort into a search the server accepts", () => {
    const awaiting = savedSearchFromList("invoice", { status: null, awaitingPayment: true, sort: { column: "due", direction: "asc" } });
    expect(awaiting.startsWith("/operations/saved-searches?type=invoice&start=")).toBe(true);
    const start = read(awaiting)!;
    expect(start).toEqual({ filters: [{ field: "status", op: "is", value: "approved" }, { field: "owing", op: "gt", value: "0" }], sort: { field: "due", direction: "asc" } });
    expect(parseDefinition(recordType("invoice")!, start).filters).toHaveLength(2);
    expect(read(savedSearchFromList("bill", { status: "draft", awaitingPayment: false, sort: null }))).toEqual({ filters: [{ field: "status", op: "is", value: "draft" }], sort: null });
    expect(read(savedSearchFromList("bill", { status: null, awaitingPayment: false, sort: { column: "salesperson", direction: "desc" } }))).toEqual({ filters: [], sort: null });
  });

  it("carries what's typed in the list's search box", () => {
    const start = read(savedSearchFromList("invoice", { status: "draft", awaitingPayment: false, sort: null, search: "  hill " }))!;
    expect(start.filters).toEqual([{ field: "anyText", op: "contains", value: "hill" }, { field: "status", op: "is", value: "draft" }]);
    expect(parseDefinition(recordType("invoice")!, start).filters).toHaveLength(2);
    expect(parseDefinition(recordType("bill")!, read(savedSearchFromList("bill", { status: null, awaitingPayment: false, sort: null, search: "fuel" }))!).filters).toHaveLength(1);
  });

  it("reads a tampered address as nothing, or as plain text for the server to check", () => {
    expect(startFromAddress("not json")).toBeNull();
    expect(startFromAddress(null)).toBeNull();
    expect(startFromAddress('{"filters":[{"field":{"x":1},"op":7,"value":{}}, 5],"sort":"date"}')).toEqual({ filters: [{ field: "[object Object]", op: "7" }], sort: null });
  });
});
