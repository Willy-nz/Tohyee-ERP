import { describe, expect, it } from "vitest";
import { FIT_LEAST, FIT_WIDTH, fitBox } from "@/components/office/powerpoint-addin";

describe("fitting a report page to the slide", () => {
  it("shrinks a page a little so all of it shows, centred, with no scrolling", () => {
    const box = fitBox(1280, 900, 1000);
    expect(box.scale).toBe(0.9);
    expect(box.scrolls).toBe(false);
    expect(box.left).toBe((1280 - FIT_WIDTH * 0.9) / 2);
    expect(box.height).toBe(900);
  });

  it("doesn't squeeze a long page: it fills the width and scrolls instead", () => {
    const box = fitBox(1280, 720, 3000);
    expect(box.scale).toBe(1);
    expect(box.scrolls).toBe(true);
    expect(box.left).toBe(0);
    expect(box.height).toBe(3000);
  });

  it("shrinks right down to the limit before it scrolls", () => {
    expect(fitBox(1280, 700, 1000)).toMatchObject({ scale: 0.7, scrolls: false });
    expect(fitBox(1280, 690, 1000)).toMatchObject({ scale: 1, scrolls: true });
    expect(FIT_LEAST).toBe(0.7);
  });

  it("scales by width when the page is short, and grows on a big slide to at most twice its size", () => {
    expect(fitBox(640, 2000, 900)).toMatchObject({ scale: 0.5, left: 0, scrolls: false });
    expect(fitBox(5120, 4000, 500).scale).toBe(2);
  });
});
