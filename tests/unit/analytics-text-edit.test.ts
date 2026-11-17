import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichText } from "@/components/analytics/items";
import { TextColourControl, TextInspector } from "@/components/analytics/text-inspector";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { cardStyle } from "@/lib/analytics/chart-spec";
import type { Tile } from "@/lib/analytics/dashboards";
import { colourSpan, fillText, parseInline, parseRichText, valueNames, withoutColours } from "@/lib/analytics/rich-text";
import {
  clearColourSelection,
  colourSelection,
  draftProblems,
  escapeMarkers,
  finishDraft,
  hasChanged,
  listLines,
  setBodyStyle,
  setHeading,
  startEdit,
  themeSwatches,
  withDraft,
  wrapSelection,
  type InPlaceEdit,
} from "@/lib/analytics/text-edit";

// : text boxes and headings changed in place, with Save and Cancel.

const note: Tile = { id: "t1", title: "About this report", visual: "text", width: "full", query: null, text: "Sales are **up**.", textFormat: "rich" };
const chart: Tile = {
  id: "t2",
  title: "Sales by month",
  visual: "column",
  width: "half",
  query: { table: "tohyee_invoices", groupBy: null, measures: [{ label: "Sales", aggregate: "sum", field: "total" }], filters: [], dateField: null, sort: { by: "category", direction: "asc" }, limit: null },
  format: { series: [{ color: "#123456" }] } as unknown as Tile["format"],
};

describe("opening and cancelling", () => {
  it("opening a box changes nothing, and Cancel leaves the report as it was", () => {
    const tiles = [note, chart];
    const edit = startEdit(note, "text", "new");
    expect(hasChanged(edit)).toBe(false);
    const typed: InPlaceEdit = { ...edit, draft: { ...edit.draft, text: "Something else" } };
    expect(hasChanged(typed)).toBe(true);
    // The report's tiles are only changed by withDraft, which only Save calls.
    expect(tiles).toEqual([note, chart]);
    expect(withDraft(tiles, typed.draft)[0].text).toBe("Something else");
  });

  it("a new box isn't in the report until it's saved, and can't be saved empty", () => {
    const edit = startEdit(null, "text", "tnew");
    expect(edit.original).toBeNull();
    expect(edit.draft).toMatchObject({ id: "tnew", visual: "text", textFormat: "rich" });
    expect(draftProblems(edit)).toEqual(["Type some text first, or Cancel to leave without adding a box."]);
    expect(withDraft([note], edit.draft).map((tile) => tile.id)).toEqual(["t1", "tnew"]);
  });

  it("plain notes open as rich text that reads the same, and opening alone isn't a change", () => {
    const plain: Tile = { ...note, text: "2 * 3 = 6 {not a value} [x]", textFormat: undefined };
    const edit = startEdit(plain, "text", "x");
    expect(edit.draft.textFormat).toBe("rich");
    expect(hasChanged(edit)).toBe(false);
    expect(fillText(parseRichText(edit.draft.text), () => null)).toBe("2 * 3 = 6 {not a value} [x]");
    expect(escapeMarkers("a*b")).toBe("a\\*b");
  });

  it("an over-long draft can't be saved but never blocks Cancel", () => {
    const edit = startEdit(note, "text", "x");
    const long = { ...edit, draft: { ...edit.draft, text: "a".repeat(4001), title: "h".repeat(101) } };
    expect(draftProblems(long)).toHaveLength(2);
  });

  it("finishing trims the words and gives a blank heading a name", () => {
    const edit = startEdit(note, "text", "x");
    const done = finishDraft({ ...edit, draft: { ...edit.draft, title: "  ", text: "  Hello  " } });
    expect(done.title).toBe("Text");
    expect(done.text).toBe("Hello");
  });
});

describe("formatting without Markdown", () => {
  it("wraps the chosen words and keeps them chosen", () => {
    expect(wrapSelection("Sales are up", 10, 12, "**", "**")).toEqual({ text: "Sales are **up**", start: 12, end: 14 });
  });

  it("makes the chosen lines a list", () => {
    expect(listLines("one\ntwo\nthree", 0, 7, false).text).toBe("- one\n- two\nthree");
    expect(listLines("- one\n- two", 0, 11, true).text).toBe("1. one\n2. two");
  });

  it("colours the chosen words and takes the colour off again", () => {
    const coloured = colourSelection("Sales are up", 10, 12, "#C0392B");
    expect(coloured.text).toBe("Sales are {color=#c0392b}up{/color}");
    expect(coloured.text.slice(coloured.start, coloured.end)).toBe("up");
    // Choosing another colour replaces the first.
    const again = colourSelection(coloured.text, 10, coloured.text.length, "#2a6f97");
    expect(again.text).toBe("Sales are {color=#2a6f97}up{/color}");
    expect(clearColourSelection(again.text, 10, again.text.length).text).toBe("Sales are up");
    expect(withoutColours("{color=#111111}a{/color} b")).toBe("a b");
  });

  it("draws coloured words as a coloured span, inside bold and with values", () => {
    const blocks = parseRichText("**{color=#c0392b}Sales {Sales}{/color}** now");
    expect(valueNames(blocks)).toEqual(["Sales"]);
    const html = renderToStaticMarkup(createElement(RichText, { blocks, value: () => "$10.00" }));
    expect(html).toMatch(/<strong><span style="color:light-dark\(#c0392b, #[0-9a-f]{6}\)">Sales <span[^>]*>\$10.00<\/span><\/span><\/strong> now/);
  });

  it("only takes a whole hex colour, and an unfinished mark stays as typed", () => {
    expect(parseInline("{color=red}x{/color}")).toEqual([{ kind: "value", name: "color=red" }, { kind: "text", text: "x" }, { kind: "value", name: "/color" }]);
    expect(parseInline("{color=#123456}x")).toEqual([{ kind: "value", name: "color=#123456" }, { kind: "text", text: "x" }]);
    expect(colourSpan("x", "#ABCDEF")).toBe("{color=#abcdef}x{/color}");
  });

  it("sets and resets the whole box's size, weight, colour and alignment", () => {
    const big = setBodyStyle(note, { size: 24, bold: true, color: "#2a6f97", align: "center" });
    expect(big.format?.card?.body).toEqual({ size: 24, bold: true, color: "#2a6f97", align: "center" });
    expect(cardStyle(big.format).body).toMatchObject({ fontSize: "24px", fontWeight: 700, textAlign: "center" });
    expect(String(cardStyle(big.format).body.color)).toMatch(/^light-dark\(#2a6f97, #[0-9a-f]{6}\)$/);
    const back = setBodyStyle(big, { size: undefined, bold: undefined, color: undefined, align: undefined });
    expect(back.format).toBeUndefined();
  });

  it("the box's look is checked like any other format", () => {
    expect(parseChartFormat({ card: { body: { size: 24, color: "#2A6F97", align: "right" } } })?.card?.body).toEqual({ size: 24, color: "#2a6f97", align: "right" });
    expect(() => parseChartFormat({ card: { body: { color: "blue" } } })).toThrow();
    expect(() => parseChartFormat({ card: { body: { size: 400 } } })).toThrow();
  });
});

describe("headings", () => {
  it("changes a chart's heading words and colour without touching its data or series colours", () => {
    const changed = setHeading(chart, { title: "Monthly sales", color: "#c0392b" });
    expect(changed.title).toBe("Monthly sales");
    expect(changed.format?.card?.title?.color).toBe("#c0392b");
    expect(changed.query).toBe(chart.query);
    expect((changed.format as { series?: unknown }).series).toEqual([{ color: "#123456" }]);
    const bigger = setHeading(changed, { size: 24 });
    expect(bigger.format?.card?.title).toEqual({ color: "#c0392b", size: 24 });
    expect(cardStyle(bigger.format).title).toMatchObject({ fontSize: "24px" });
    expect(setHeading(bigger, { size: null }).format?.card?.title).toEqual({ color: "#c0392b" });
    const reset = setHeading(changed, { color: null, show: false });
    expect(reset.format?.card).toEqual({ showTitle: false });
    expect(setHeading(reset, { show: true }).format).toEqual({ series: [{ color: "#123456" }] });
  });

  it("offers the theme's colours with one click", () => {
    expect(themeSwatches({ text: "#1A1A1A", mutedText: "#555555", series: ["#2a6f97", "#1a1a1a", "#c0392b", "#27ae60", "#f39c12", "#8e44ad", "#16a085", "#999999"] })).toEqual([
      "#1a1a1a",
      "#555555",
      "#2a6f97",
      "#c0392b",
      "#27ae60",
      "#f39c12",
      "#8e44ad",
    ]);
  });
});

describe("the editor beside the report", () => {
  const render = (edit: InPlaceEdit, extra: Partial<Parameters<typeof TextInspector>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(TextInspector, {
        edit,
        swatches: ["#1a1a1a", "#c0392b"],
        tables: [],
        saving: false,
        error: null,
        problems: draftProblems(edit),
        changed: hasChanged(edit),
        onChange: () => undefined,
        onSave: () => undefined,
        onCancel: () => undefined,
        ...extra,
      }),
    );

  it("has labelled controls for size, bold, colour, alignment and links, and no sharing settings", () => {
    const html = render(startEdit(note, "text", "x"));
    for (const words of ["Edit text", "Text size", "Alignment", "Text colour", "Reset to theme", "Link", "Heading colour", "Show the heading", "Width"]) expect(html).toContain(words);
    expect(html).toContain('aria-label="Bold (the whole box)"');
    expect(html).toContain('aria-label="Text colour: #C0392B"');
    expect(html).toContain('aria-label="Text colour: any colour"');
    expect(html).not.toMatch(/Share|Bookmark/);
  });

  it("Save waits for a change; Cancel always works, even with a problem", () => {
    const unchanged = render(startEdit(note, "text", "x"));
    expect(unchanged).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    const empty = render(startEdit(null, "text", "x"));
    expect(empty).toContain("New text box");
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(empty).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
  });

  it("a failed save shows its error with the draft still there", () => {
    const edit = startEdit(note, "text", "x");
    const html = render({ ...edit, draft: { ...edit.draft, text: "Kept" } }, { error: "Network down. Your changes haven't been saved; they're still here, so you can try again." });
    expect(html).toContain("Network down.");
    expect(html).toContain(">Kept</textarea>");
    expect(html).toContain("Draft: shown on the report, not saved yet.");
  });

  it("a heading has its own small editor that says the data stays as it is", () => {
    const html = render(startEdit(chart, "heading", "x"));
    expect(html).toContain("Heading: Sales by month");
    expect(html).toContain("The chart&#x27;s data, fields and series colours stay as they are.");
    expect(html).not.toContain("Text size");
    expect(html).toContain("Heading size");
  });

  it("the colour control shows the theme's colour until one is chosen", () => {
    const html = renderToStaticMarkup(createElement(TextColourControl, { label: "Text colour", value: undefined, swatches: ["#1a1a1a"], target: "the whole box", onChoose: () => undefined, onReset: () => undefined }));
    expect(html).toContain("Theme colour");
    expect(html).toContain("Applies to the whole box.");
  });
});
