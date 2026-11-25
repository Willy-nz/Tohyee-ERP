import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { errorReference, RouteError } from "@/components/route-error";
import GlobalError from "@/app/global-error";
import OperationsError from "@/app/operations/error";
import FarmError from "@/app/operations/farm/error";
import SignError from "@/app/sign/error";

const secret = Object.assign(new Error("relation \"invoices\" does not exist at db-host:5432"), { digest: "4021987311" });
const retry = () => undefined;

describe("error pages", () => {
  it("show plain words and Try again, never the error's own text", () => {
    for (const page of [GlobalError, OperationsError, FarmError, SignError]) {
      const html = renderToStaticMarkup(createElement(page, { error: secret, retry }));
      expect(html).toContain("Try again");
      expect(html).toContain("still saved");
      expect(html).not.toContain("relation");
      expect(html).not.toContain("db-host");
      expect(html).toContain("Reference: 4021987311");
    }
  });

  it("keep a way back: Today on farm pages, nothing about Tohyee for customers signing", () => {
    expect(renderToStaticMarkup(createElement(FarmError, { error: secret, retry }))).toContain('href="/operations/farm"');
    const sign = renderToStaticMarkup(createElement(SignError, { error: secret, retry }));
    expect(sign).not.toContain("Tohyee");
    expect(sign).toContain("business that sent you the link");
  });

  it("global-error brings its own page, as it replaces the root layout", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: "a thrown string", retry }));
    expect(html.startsWith("<html")).toBe(true);
    expect(html).toContain("<body");
    expect(html).not.toContain("a thrown string");
  });

  it("takes only a short, plain reference from what was thrown", () => {
    expect(errorReference({ digest: "abc-123" })).toBe("abc-123");
    expect(errorReference({ digest: "<script>" })).toBeNull();
    expect(errorReference("text")).toBeNull();
    expect(errorReference(null)).toBeNull();
    expect(renderToStaticMarkup(createElement(RouteError, { error: new Error("x"), retry }))).not.toContain("Reference");
  });
});
