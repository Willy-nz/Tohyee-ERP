import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichText, SignoffItemView, valueLookup } from "@/components/analytics/items";
import { BUTTON_ACTIONS, parseButton, parseImage, parseShape, parseSignoff } from "@/lib/analytics/items";
import { fillText, parseInline, parseRichText, safeHref, valueNames } from "@/lib/analytics/rich-text";
import type { QueryResult } from "@/lib/analytics/query";

const result: QueryResult = {
  columns: [
    { key: "m0", label: "Sales", format: "money", role: "measure" },
    { key: "m1", label: "Invoices", format: "integer", role: "measure" },
  ],
  rows: [{ m0: "12345.6", m1: "42" }],
  truncated: false,
};

const render = (text: string) => renderToStaticMarkup(createElement(RichText, { blocks: parseRichText(text), value: valueLookup(result) }));

describe("rich text templating", () => {
  it("fills in {Value} with the value's figure, formatted, and keeps unknown names as typed", () => {
    const blocks = parseRichText("Sales this month: {Sales} from {invoices} invoices. {Nope}");
    expect(valueNames(blocks)).toEqual(["Sales", "invoices", "Nope"]);
    expect(fillText(blocks, valueLookup(result))).toBe("Sales this month: $12,345.60 from 42 invoices. {Nope}");
  });

  it("formats bold, italic, links and lists", () => {
    const html = render("**Big** and *small* [our site](https://example.com/a?b=1)\n\n- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<strong>Big</strong>");
    expect(html).toContain("<em>small</em>");
    expect(html).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">our site</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("never lets typed text become HTML", () => {
    const html = render('<script>alert(1)</script> <img src=x onerror="alert(2)"> **<b>bold</b>** {<i>}');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<strong>&lt;b&gt;bold&lt;/b&gt;</strong>");
  });

  it("only makes web and email links, leaving the rest as text", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("mailto:jade@example.com")).toBe("mailto:jade@example.com");
    const html = render("[click](javascript:alert(1)) [x](JAVASCRIPT:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).toContain("[click](javascript:alert(1))");
    // A value's figure is text too, even if a column were named oddly.
    const odd = renderToStaticMarkup(createElement(RichText, { blocks: parseRichText("{A}"), value: () => "<b>1</b>" }));
    expect(odd).toContain("&lt;b&gt;1&lt;/b&gt;");
  });

  it("keeps unmatched markers and escaped ones as typed, and line breaks inside a paragraph", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
    expect(parseInline("\\*not italic\\* and \\{Sales\\}")).toEqual([{ kind: "text", text: "*not italic* and {Sales}" }]);
    expect(parseInline("account_name and other_field")).toEqual([{ kind: "text", text: "account_name and other_field" }]);
    expect(render("one\ntwo")).toContain("one<br/>two");
  });
});

describe("item settings", () => {
  it("checks images, shapes and buttons", () => {
    expect(parseImage({ id: "12", alt: " Our logo ", fit: "cover" }, "Logo")).toEqual({ id: "12", alt: "Our logo", fit: "cover" });
    expect(() => parseImage({ id: "../x" }, "Logo")).toThrow(/upload an image/);
    expect(parseShape({ kind: "rounded", fill: "#ABCDEF", strokeWidth: "3", text: "Costs", direction: "down" }, "Box")).toEqual({ kind: "rounded", fill: "#abcdef", strokeWidth: 3, text: "Costs" });
    expect(parseShape({ kind: "arrow", fill: "#abcdef", direction: "diagonal", text: "x" }, "Arrow")).toEqual({ kind: "arrow", direction: "diagonal" });
    expect(() => parseShape({ kind: "star" }, "Star")).toThrow(/choose a shape/);
    expect(() => parseShape({ kind: "line", strokeWidth: 20 }, "Line")).toThrow(/0 to 12/);
    expect(parseButton({ label: " Reset ", action: "reset_filters" }, "Reset")).toEqual({ label: "Reset", action: "reset_filters" });
    // Pages and bookmarks: the page or bookmark must be the report's own.
    expect(BUTTON_ACTIONS.go_to_page.available).toBe(true);
    const targets = { pages: new Set(["detail"]), bookmarks: new Set(["otago"]) };
    expect(parseButton({ label: "Next", action: "go_to_page", target: "detail" }, "Next", targets)).toEqual({ label: "Next", action: "go_to_page", target: "detail" });
    expect(parseButton({ label: "Otago", action: "bookmark", target: "otago" }, "Otago", targets)).toEqual({ label: "Otago", action: "bookmark", target: "otago" });
    expect(parseButton({ label: "Back", action: "back", target: "ignored" }, "Back", targets)).toEqual({ label: "Back", action: "back" });
    expect(() => parseButton({ label: "Next", action: "go_to_page", target: "elsewhere" }, "Next", targets)).toThrow(/choose the page/);
    expect(() => parseButton({ label: "Next", action: "bookmark" }, "Next", targets)).toThrow(/choose the bookmark/);
    expect(() => parseButton({ label: "Go", action: "launch" }, "Go")).toThrow(/what the button does/);
  });
});

describe("a sign-off", () => {
  it("keeps the statement and who signs, trimmed, with a date line unless turned off", () => {
    expect(parseSignoff({ statement: " Approved on 30 June. ", signatories: [{ name: " Alex Example ", role: " Chair " }, { name: "Sam Sample" }] }, "Sign-off")).toEqual({
      statement: "Approved on 30 June.",
      signatories: [{ name: "Alex Example", role: "Chair" }, { name: "Sam Sample" }],
    });
    expect(parseSignoff({ signatories: [{ name: "Alex" }], dated: false }, "Sign-off")).toEqual({ statement: "", signatories: [{ name: "Alex" }], dated: false });
  });

  it("needs one to eight people, each with a name", () => {
    expect(() => parseSignoff({ statement: "x", signatories: [] }, "Sign-off")).toThrow("at least one person");
    expect(() => parseSignoff({ signatories: [{ name: " " }] }, "Sign-off")).toThrow("needs a name");
    expect(() => parseSignoff({ signatories: Array.from({ length: 9 }, () => ({ name: "A" })) }, "Sign-off")).toThrow("up to 8 people");
    expect(() => parseSignoff({ statement: "x".repeat(1001), signatories: [{ name: "A" }] }, "Sign-off")).toThrow("1,000 characters");
    expect(() => parseSignoff({ signatories: [{ name: "A" }], dated: "no" }, "Sign-off")).toThrow("true or false");
  });

  it("draws a line to sign and a date line for each person", () => {
    const html = renderToStaticMarkup(createElement(SignoffItemView, { signoff: { statement: "Approved.", signatories: [{ name: "Alex Example", role: "Chair" }, { name: "Sam Sample" }] } }));
    expect(html).toContain("Approved.");
    expect(html).toContain("Signature of Alex Example");
    expect(html).toContain("Chair");
    expect(html.match(/aria-label="Date"/g)).toHaveLength(2);
    const undated = renderToStaticMarkup(createElement(SignoffItemView, { signoff: { statement: "", signatories: [{ name: "Alex" }], dated: false } }));
    expect(undated).not.toContain("Date");
  });
});
