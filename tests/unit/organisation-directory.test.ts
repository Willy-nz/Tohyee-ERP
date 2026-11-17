import { describe, expect, it } from "vitest";
import { parseDirectoryItem } from "@/lib/analytics/items";
import { directoryPage, EMPTY_DIRECTORY, parseDirectory } from "@/lib/organisations/directory";

describe("the organisation's directory", () => {
  it("keeps the details, trimmed, and drops rows left blank", () => {
    expect(
      parseDirectory({
        registeredOffice: " 1 High Street, Dunedin ",
        numbers: [{ label: "NZBN", value: " 9429000000000 " }, { label: "", value: "" }],
        officers: [{ label: "Chair", value: "Alex Example" }, { label: "", value: "Sam Sample" }],
        advisers: [{ label: "Accountant", value: "Example & Co" }],
      }),
    ).toEqual({
      registeredOffice: "1 High Street, Dunedin",
      numbers: [{ label: "NZBN", value: "9429000000000" }],
      officers: [{ label: "Chair", value: "Alex Example" }, { label: "", value: "Sam Sample" }],
      advisers: [{ label: "Accountant", value: "Example & Co" }],
    });
    expect(parseDirectory(undefined)).toEqual(EMPTY_DIRECTORY);
  });

  it("refuses a label with nothing beside it, and lists that are too long", () => {
    expect(() => parseDirectory({ numbers: [{ label: "NZBN", value: "" }] })).toThrow("needs a name or number");
    expect(() => parseDirectory({ advisers: Array.from({ length: 11 }, () => ({ label: "Bank", value: "A" })) })).toThrow("up to 10");
    expect(() => parseDirectory({ registeredOffice: 12 })).toThrow("is text");
    expect(() => parseDirectory({ officers: "Alex" })).toThrow("is a list");
  });

  it("lays out the page: details, then officers, then advisers, leaving out what's empty", () => {
    const organisation = { displayName: "Example Trust", postalAddress: "PO Box 1, Dunedin", gstNumber: "123456789", financialYearEndMonth: 3 };
    const page = directoryPage(organisation, parseDirectory({ registeredOffice: "1 High Street", numbers: [{ label: "Charity number", value: "CC12345" }], officers: [{ label: "Chair", value: "Alex Example" }] }));
    expect(page).toEqual({
      name: "Example Trust",
      sections: [
        {
          title: "Details",
          lines: [
            { label: "Registered office", value: "1 High Street" },
            { label: "Postal address", value: "PO Box 1, Dunedin" },
            { label: "Charity number", value: "CC12345" },
            { label: "GST number", value: "123456789" },
            { label: "Balance date", value: "31 March" },
          ],
        },
        { title: "Directors, trustees and officers", lines: [{ label: "Chair", value: "Alex Example" }] },
      ],
    });
    // With nothing filled in there's still the balance date, and a June year ends on the 30th.
    expect(directoryPage({ ...organisation, postalAddress: null, gstNumber: null, financialYearEndMonth: 6 }, EMPTY_DIRECTORY).sections).toEqual([{ title: "Details", lines: [{ label: "Balance date", value: "30 June" }] }]);
  });

  it("a directory item keeps a report's own extra lines", () => {
    expect(parseDirectoryItem({ extra: [{ label: " Auditor ", value: " Audit & Co " }, { label: "", value: "" }] }, "Directory")).toEqual({ extra: [{ label: "Auditor", value: "Audit & Co" }] });
    expect(parseDirectoryItem({}, "Directory")).toEqual({ extra: [] });
    expect(() => parseDirectoryItem({ extra: [{ label: "Auditor", value: "" }] }, "Directory")).toThrow("needs a label and what goes beside it");
    expect(() => parseDirectoryItem({ extra: Array.from({ length: 13 }, () => ({ label: "a", value: "b" })) }, "Directory")).toThrow("up to 12");
  });
});
