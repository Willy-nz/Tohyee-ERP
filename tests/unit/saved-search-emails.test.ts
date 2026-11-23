import { describe, expect, it } from "vitest";
import { emailDue, searchEmailText, shouldSend } from "@/lib/saved-searches/emails";
import type { SearchResult } from "@/lib/saved-searches/service";

describe("saved search emails", () => {
  it("checks once a day, once in each week from Monday, or once in each month", () => {
    expect(emailDue("daily", null, "2026-11-24")).toBe(true);
    expect(emailDue("daily", "2026-11-24", "2026-11-24")).toBe(false);
    expect(emailDue("daily", "2026-11-23", "2026-11-24")).toBe(true);
    // Monday 23 November starts a week; Sunday the 22nd was the week before.
    expect(emailDue("weekly", "2026-11-23", "2026-11-27")).toBe(false);
    expect(emailDue("weekly", "2026-11-22", "2026-11-23")).toBe(true);
    // The server was off on Monday: Tuesday still counts as that week's.
    expect(emailDue("weekly", "2026-11-20", "2026-11-24")).toBe(true);
    expect(emailDue("monthly", "2026-11-01", "2026-11-30")).toBe(false);
    expect(emailDue("monthly", "2026-11-30", "2026-12-01")).toBe(true);
    expect(emailDue("monthly", "2026-12-01", "2027-01-03")).toBe(true);
  });

  it("sends every time, only with something in it, or only with something new", () => {
    expect(shouldSend("always", [], [])).toBe(true);
    expect(shouldSend("has_rows", [], ["1"])).toBe(false);
    expect(shouldSend("has_rows", ["1"], ["1"])).toBe(true);
    expect(shouldSend("new_rows", ["1", "2"], ["1", "2", "3"])).toBe(false);
    expect(shouldSend("new_rows", ["1", "4"], ["1", "2"])).toBe(true);
    expect(shouldSend("new_rows", [], ["1"])).toBe(false);
  });

  it("writes the count, the rows in words, and the totals", () => {
    const result: SearchResult = {
      recordType: "invoice",
      columns: [
        { key: "number", label: "Number", type: "text" },
        { key: "due", label: "Due date", type: "date" },
        { key: "status", label: "Status", type: "choice", choices: { approved: "Approved" } },
        { key: "owing", label: "Still owing", type: "money" },
      ],
      rows: [{ id: "7", href: "/operations/invoices/7", cells: ["INV-0007", "2026-10-20", "approved", "1150.00"] }],
      matches: 1,
      totals: [null, null, null, "1150.00"],
      nextOffset: null,
    };
    const message = searchEmailText({ name: "Overdue", organisation: "Kōwhai Dairies", result, newCount: 1 });
    expect(message.subject).toBe("Overdue: 1 found");
    expect(message.text).toBe(
      [
        "Overdue: 1 found in Kōwhai Dairies (1 new).",
        "",
        "Number | Due date | Status | Still owing",
        "INV-0007 | 20 Oct 2026 | Approved | 1,150.00",
        "",
        "Totals of all that match: Still owing 1,150.00.",
        "",
        "Open it in Tohyee under Reports, Saved searches.",
        "You asked for this email on that page, and can stop it there.",
      ].join("\n"),
    );
  });
});
