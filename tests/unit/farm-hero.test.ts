import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FarmHero, HeroEmpty, HeroTile, HeroTiles } from "@/components/farm-hero";
import { EarTagArt, FeedWedgeArt, PenArt, PinnedNoteArt, RainGaugeArt, SoilCoreArt } from "@/components/farm-hero-art";

/** The dark panel farm pages open with: purely how it looks, so the checks are on what's read and what can be tapped. */
describe("farm panel", () => {
  const panel = (children: unknown, stats = [{ value: 4, label: "mobs" }, { value: 1, label: "not in a paddock", tone: "attention" as const }]) =>
    renderToStaticMarkup(createElement(FarmHero, { eyebrow: "Stock / mobs", title: "Home farm", label: "Home farm mobs", heading: "On the farm now", footer: "Stock yards", stats }, children as never));

  it("names the panel for a screen reader and shows the farm and its figures", () => {
    const html = panel(createElement(HeroEmpty, null, "No mobs yet."));
    expect(html).toContain('aria-label="Home farm mobs"');
    expect(html).toContain("<h2>Home farm</h2>");
    expect(html).toContain("<strong>4</strong> mobs");
    expect(html).toContain("<strong>1</strong> not in a paddock");
    expect(html).toContain("No mobs yet.");
  });

  it("keeps the decorative small capitals away from a screen reader", () => {
    const html = panel(null);
    expect(html).toMatch(/aria-hidden="true"[^>]*><span>On the farm now<\/span>/);
    expect(html).toMatch(/aria-hidden="true"[^>]*>.*Stock yards/);
  });

  it("makes a tile a button only when it opens something", () => {
    const tiles = renderToStaticMarkup(
      createElement(HeroTiles, null, createElement(HeroTile, { title: "Milkers", figure: "300", unit: "head", lines: ["Paddock 9"], pressed: true, onOpen: () => undefined }), createElement(HeroTile, { title: "House gauge", figure: "12.5", unit: "mm" })),
    );
    expect(tiles.match(/<button/g)).toHaveLength(1);
    expect(tiles).toContain('aria-pressed="true"');
    expect(tiles).toContain("Milkers");
    expect(tiles).toContain("300<small> head</small>");
    expect(tiles).toContain("Paddock 9");
    expect(tiles).toMatch(/<div class="[^"]*">.*House gauge/);
  });

  it("draws the tile pictures from the data, hidden from a screen reader", () => {
    const draw = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
    // A pen holds a dot per fifty head: at least one for any stock, twelve at most, none when empty.
    const dots = (head: number) => (draw(createElement(PenArt, { head })).match(/<ellipse/g) ?? []).length;
    expect([0, 6, 300, 5000].map(dots)).toEqual([0, 1, 6, 12]);
    // The gauge's water is as tall as the reading, out of 50 mm, and never taller than the tube.
    const water = (mm: number | null) => Number(/<rect[^>]*height="(\d+)"/.exec(draw(createElement(RainGaugeArt, { mm })))?.[1]);
    expect([null, 0, 25, 50, 120].map(water)).toEqual([0, 0, 20, 40, 40]);
    // A tag takes the mob's colour when it knows it, and is yellow otherwise.
    expect(draw(createElement(EarTagArt, { colour: "Blue" }))).toContain("#6fa8dc");
    expect(draw(createElement(EarTagArt, { colour: "tartan" }))).toContain("#f2c94c");
    expect(draw(createElement(PinnedNoteArt, { overdue: true }))).toContain("#e0604c");
    for (const art of [createElement(PenArt, { head: 1 }), createElement(RainGaugeArt, { mm: 1 }), createElement(EarTagArt, {}), createElement(PinnedNoteArt, { overdue: false }), createElement(SoilCoreArt)]) {
      expect(draw(art)).toContain('aria-hidden="true"');
    }
  });

  it("draws the feed wedge as a bar per paddock, tallest for the highest cover, with the average as a line", () => {
    const html = renderToStaticMarkup(createElement(FeedWedgeArt, { bars: [{ name: "9", cover: 3000 }, { name: "4", cover: 1500 }, { name: "14", cover: 0 }], average: 1500 }));
    const heights = [...html.matchAll(/<rect[^>]*height="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(heights).toEqual([84, 42, 0]);
    // The average line sits at the same height as the middle bar's top, and the ends are named.
    expect(html).toContain('d="M0 50h300"');
    expect(html).toMatch(/<text[^>]*>9<\/text>/);
    expect(html).toMatch(/<text[^>]*>14<\/text>/);
    expect(html).toContain('aria-hidden="true"');
    // No readings: no bars, no line, and nothing divides by zero.
    const empty = renderToStaticMarkup(createElement(FeedWedgeArt, { bars: [], average: null }));
    expect(empty).not.toContain("<rect");
    expect(empty).not.toContain("NaN");
  });
});
