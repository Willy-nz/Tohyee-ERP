import { describe, expect, it } from "vitest";
import { FIT_WIDTH, fitBox } from "@/components/office/powerpoint-addin";

describe("fitting a report page to the slide", () => {
  it("scales a tall page down so all of it shows, centred", () => {
    const { scale, left } = fitBox(1280, 720, 1440);
    expect(scale).toBe(0.5);
    expect(left).toBe((1280 - FIT_WIDTH * 0.5) / 2);
  });

  it("scales by width when the page is short", () => {
    expect(fitBox(640, 2000, 900)).toEqual({ scale: 0.5, left: 0 });
  });

  it("grows a page on a big slide, but at most to twice its size", () => {
    expect(fitBox(5120, 4000, 500).scale).toBe(2);
    expect(fitBox(1920, 1800, 800).scale).toBe(1.5);
  });
});
