import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FarmHero, HeroEmpty, HeroTile, HeroTiles } from "@/components/farm-hero";

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
});
