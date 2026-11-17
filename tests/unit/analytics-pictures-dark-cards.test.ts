import { describe, expect, it } from "vitest";
import { pageStyle } from "@/components/analytics/report-pages";
import { cardStyle, ON_DARK_CARD } from "@/lib/analytics/chart-spec";

/** Issue #9: words on dark cards (DTX1) and pages with a background picture (PBG1). Following common practice, not yet reviewed. */
describe("words on a dark card (DTX1)", () => {
  it("a dark fill gives the card light words, and a chosen title colour still wins", () => {
    const look = cardStyle({ card: { fill: "#1f2a44", title: { color: "#f5d48a" } } });
    expect(look.card).toMatchObject(ON_DARK_CARD);
    expect(look.card["--text-muted"]).toBe("#c9d0dc");
    expect(String(look.title.color)).toContain("#f5d48a");
  });

  it("a chosen body colour is kept on the body", () => {
    const look = cardStyle({ card: { fill: "#1f2a44", body: { color: "#ffcc00" } } });
    expect(String(look.body.color)).toContain("#ffcc00");
  });

  it("a light fill, a see-through dark fill, or no fill keeps the theme's words", () => {
    expect(cardStyle({ card: { fill: "#f7f2e8" } }).card.color).toBeUndefined();
    expect(cardStyle({ card: { fill: "#1f2a44", opacity: 40 } }).card.color).toBeUndefined();
    expect(cardStyle({ card: { radius: 16 } }).card.color).toBeUndefined();
  });
});

describe("a page with a background picture (PBG1)", () => {
  const pictures = { organisationId: "org", dashboardId: "4" };
  it("is marked to be drawn at least about a screen tall", () => {
    expect(pageStyle({ id: "cover", name: "Cover", picture: { id: "7", dim: 50 } }, pictures).pictured).toBe(true);
  });
  it("isn't without a picture, or where pictures aren't shown", () => {
    expect(pageStyle({ id: "money", name: "Money", background: "#ffffff" }, pictures).pictured).toBe(false);
    expect(pageStyle({ id: "cover", name: "Cover", picture: { id: "7" } }).pictured).toBe(false);
  });
});
