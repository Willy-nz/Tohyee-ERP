import { describe, expect, it } from "vitest";
import { hasCover, MOST_SHEETS_A_PAGE, PAPERS, PaperError, parsePaper, printSheets, SMALLEST_SHEET_SCALE, sheetCarriesOn, sheetScale, sheetSlices, sheetTotal } from "@/lib/analytics/paper";

describe("a report page on a sheet of paper", () => {
  it("prints at full size when the page fits", () => {
    expect(sheetScale(700, 500)).toBe(1);
    expect(sheetScale(700, 700)).toBe(1);
  });

  it("shrinks a longer page by the share the sheet has room for", () => {
    expect(sheetScale(600, 800)).toBe(0.75);
    expect(sheetScale(700, 1000)).toBe(0.7);
  });

  it("shrinks no further than 50%: a longer page carries on over more sheets", () => {
    expect(sheetScale(100, 1000)).toBe(SMALLEST_SHEET_SCALE);
    expect(sheetCarriesOn(100, 1000)).toBe(true);
    expect(sheetCarriesOn(700, 1000)).toBe(false);
    expect(sheetCarriesOn(500, 1000)).toBe(false);
    expect(sheetCarriesOn(400, 1000)).toBe(true);
    expect(sheetCarriesOn(700, 500)).toBe(false);
  });

  it("leaves a sheet that hasn't been measured yet alone", () => {
    expect(sheetScale(0, 900)).toBe(1);
    expect(sheetCarriesOn(0, 900)).toBe(false);
  });

  it("offers A4 both ways round, landscape first", () => {
    expect(PAPERS.map((paper) => paper.value)).toEqual(["landscape", "portrait"]);
  });
});

describe("a report's saved paper and its contents sheet", () => {
  const pages = [
    { id: "cover", name: "Cover" },
    { id: "pl", name: "Profit and loss" },
    { id: "bs", name: "Balance sheet" },
  ];

  it("keeps a size and where the contents go, and stores nothing for the default", () => {
    expect(parsePaper(undefined)).toBeUndefined();
    expect(parsePaper({ size: "landscape" })).toBeUndefined();
    expect(parsePaper({ size: "landscape", contents: "none" })).toBeUndefined();
    expect(parsePaper({ size: "portrait" })).toEqual({ size: "portrait" });
    expect(parsePaper({ contents: "first" })).toEqual({ size: "landscape", contents: "first" });
    expect(parsePaper({ size: "portrait", contents: "after_cover", extra: 1 })).toEqual({ size: "portrait", contents: "after_cover" });
  });

  it("keeps a running header and a cover, and knows when the first page is a cover", () => {
    expect(parsePaper({ header: true })).toEqual({ size: "landscape", header: true });
    expect(parsePaper({ size: "portrait", cover: true, header: false })).toEqual({ size: "portrait", cover: true });
    expect(parsePaper({ header: false, cover: false })).toBeUndefined();
    expect(() => parsePaper({ header: "yes" })).toThrow(PaperError);
    expect(hasCover({ cover: true }, 3)).toBe(true);
    expect(hasCover({ contents: "after_cover" }, 3)).toBe(true);
    expect(hasCover({ contents: "first" }, 3)).toBe(false);
    // A one-page report has no cover: the page is the report.
    expect(hasCover({ cover: true }, 1)).toBe(false);
    expect(hasCover(undefined, 3)).toBe(false);
  });

  it("refuses a size or a contents place that isn't one of the choices", () => {
    expect(() => parsePaper({ size: "a3" })).toThrow(PaperError);
    expect(() => parsePaper({ size: "portrait", contents: "last" })).toThrow(PaperError);
    expect(() => parsePaper("portrait")).toThrow(PaperError);
  });

  it("prints one sheet a page when there's no contents", () => {
    expect(printSheets(pages, undefined).map((sheet) => [sheet.kind, sheet.number])).toEqual([["page", 1], ["page", 2], ["page", 3]]);
  });

  it("puts the contents first, listing every page with its sheet number", () => {
    const sheets = printSheets(pages, "first");
    expect(sheets.map((sheet) => sheet.kind)).toEqual(["contents", "page", "page", "page"]);
    expect(sheets[0]).toMatchObject({ number: 1, entries: [{ name: "Cover", number: 2 }, { name: "Profit and loss", number: 3 }, { name: "Balance sheet", number: 4 }] });
  });

  it("puts the contents behind a cover, listing only what follows", () => {
    const sheets = printSheets(pages, "after_cover");
    expect(sheets.map((sheet) => sheet.kind)).toEqual(["page", "contents", "page", "page"]);
    expect(sheets[1]).toMatchObject({ number: 2, entries: [{ name: "Profit and loss", number: 3 }, { name: "Balance sheet", number: 4 }] });
  });

  it("gives a one-page report no contents sheet", () => {
    expect(printSheets([pages[0]], "first").map((sheet) => sheet.kind)).toEqual(["page"]);
  });
});

describe("a long page cut into sheets", () => {
  // Forty rows of 30, one after another: a statement 1,200 tall.
  const rows = Array.from({ length: 40 }, (_, index) => ({ top: index * 30, bottom: index * 30 + 30 }));

  it("keeps a page that fits as one slice", () => {
    expect(sheetSlices(700, 500, rows)).toEqual([{ from: 0, to: 500 }]);
  });

  it("cuts between rows, never through one, and loses nothing", () => {
    const slices = sheetSlices(500, 1200, rows);
    expect(slices).toEqual([{ from: 0, to: 480 }, { from: 480, to: 960 }, { from: 960, to: 1200 }]);
    for (const slice of slices) expect(slice.to - slice.from).toBeLessThanOrEqual(500);
  });

  it("moves a chart that would be cut onto the next sheet whole", () => {
    const boxes = [{ top: 0, bottom: 300 }, { top: 320, bottom: 620 }, { top: 640, bottom: 800 }];
    expect(sheetSlices(500, 800, boxes)).toEqual([{ from: 0, to: 320 }, { from: 320, to: 800 }]);
  });

  it("starts a thing taller than a sheet on a sheet of its own, and cuts only it at the sheet's edge", () => {
    expect(sheetSlices(500, 1300, [{ top: 100, bottom: 1300 }])).toEqual([{ from: 0, to: 100 }, { from: 100, to: 600 }, { from: 600, to: 1100 }, { from: 1100, to: 1300 }]);
    expect(sheetSlices(500, 1200, [{ top: 0, bottom: 1200 }])).toEqual([{ from: 0, to: 500 }, { from: 500, to: 1000 }, { from: 1000, to: 1200 }]);
  });

  it("leaves a sheet short rather than cut a tile near its top", () => {
    // A tile ends at 80; the next (80 to 560) won't fit, so the first sheet ends at 80, not through the second tile.
    expect(sheetSlices(500, 900, [{ top: 0, bottom: 80 }, { top: 80, bottom: 560 }, { top: 560, bottom: 900 }])).toEqual([{ from: 0, to: 80 }, { from: 80, to: 560 }, { from: 560, to: 900 }]);
  });

  it("never ends a sheet straight after a heading", () => {
    // Rows of 30; the row ending at 480 is a section heading, so the cut moves up to 450.
    const withHeading = rows.map((row) => (row.bottom === 480 ? { ...row, heading: true } : row));
    expect(sheetSlices(500, 1200, withHeading)[0]).toEqual({ from: 0, to: 450 });
    // A heading as the very last thing on the page is fine.
    expect(sheetSlices(500, 480, withHeading)).toEqual([{ from: 0, to: 480 }]);
  });

  it("leaves room for a table's column headings where the table carries on", () => {
    // One table over the whole page: its column headings are the first 30.
    const slices = sheetSlices(500, 1200, rows, [{ top: 0, bottom: 1200, headBottom: 30 }]);
    expect(slices).toEqual([
      { from: 0, to: 480 },
      { from: 480, to: 930, table: 0 },
      { from: 930, to: 1200, table: 0 },
    ]);
    // A slice that starts between tables repeats nothing.
    const two = sheetSlices(500, 900, rows.slice(0, 30), [
      { top: 0, bottom: 480, headBottom: 30 },
      { top: 480, bottom: 900, headBottom: 510 },
    ]);
    expect(two).toEqual([{ from: 0, to: 480 }, { from: 480, to: 900 }]);
  });

  it("stops at the most sheets a page can take", () => {
    expect(sheetSlices(100, 100000, [])).toHaveLength(MOST_SHEETS_A_PAGE);
  });

  it("numbers the sheets after a page that carries on, in the contents too", () => {
    const pages = [{ id: "cover", name: "Cover" }, { id: "pl", name: "Profit and loss" }, { id: "bs", name: "Balance sheet" }];
    const sheets = printSheets(pages, "after_cover", { pl: 3 });
    expect(sheets.map((sheet) => sheet.number)).toEqual([1, 2, 3, 6]);
    expect(sheets[1]).toMatchObject({ kind: "contents", entries: [{ name: "Profit and loss", number: 3 }, { name: "Balance sheet", number: 6 }] });
    expect(sheetTotal(sheets)).toBe(6);
  });
});

describe("tiles in the contents", () => {
  const pages = [
    { id: "cover", name: "Cover" },
    { id: "fs", name: "Financial statements" },
    { id: "notes", name: "Notes" },
  ];
  const outlines = {
    cover: [{ title: "Cover", sheet: 0 }],
    fs: [
      { title: "Profit and loss", sheet: 0 },
      { title: "Balance sheet", sheet: 1 },
      { title: "Cash flows", sheet: 2 },
    ],
    notes: [{ title: "notes", sheet: 0 }, { title: " ", sheet: 0 }],
  };

  it("lists each page's tiles under it, on the sheet each starts on", () => {
    const sheets = printSheets(pages, "after_cover", { fs: 3 }, outlines);
    expect(sheets[1]).toMatchObject({
      kind: "contents",
      entries: [
        { name: "Financial statements", number: 3 },
        { name: "Profit and loss", number: 3, tile: true },
        { name: "Balance sheet", number: 4, tile: true },
        { name: "Cash flows", number: 5, tile: true },
        // A tile named as its page, and one with no title, aren't listed again.
        { name: "Notes", number: 6 },
      ],
    });
  });

  it("never points past the page's last sheet, and lists no tiles unless asked", () => {
    const sheets = printSheets(pages, "first", { fs: 2 }, outlines);
    const entries = sheets[0].kind === "contents" ? sheets[0].entries : [];
    expect(entries.find((entry) => entry.name === "Cash flows")?.number).toBe(4);
    const plain = printSheets(pages, "first", { fs: 2 });
    expect(plain[0].kind === "contents" ? plain[0].entries.map((entry) => entry.name) : []).toEqual(["Cover", "Financial statements", "Notes"]);
  });

  it("keeps the choice only where there's a contents sheet", () => {
    expect(parsePaper({ contents: "first", contentsTiles: true })).toEqual({ size: "landscape", contents: "first", contentsTiles: true });
    expect(parsePaper({ size: "portrait", contentsTiles: true })).toEqual({ size: "portrait" });
  });
});
