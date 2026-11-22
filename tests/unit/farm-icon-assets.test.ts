import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ICON_NAMES = [
  "farm-walk", "mob-in", "mob-out", "cover-reading", "feed", "rain-gauge", "move-mob",
  "births", "deaths", "treatment", "hazard", "near-miss", "incident", "irrigation", "pond-level",
  "log", "more", "pasture", "fertiliser", "rainfall", "soil-test", "tractor", "medicines",
  "animal-tag", "stock-truck", "vet", "delivery", "contractor", "meeting", "deadline",
  "sun", "cloud", "rain", "wind", "frost",
] as const;

function iconFile(folder: string, name: string) {
  return path.resolve(import.meta.dirname, "../../", folder, name + ".png");
}

function pngDimensionsAndType(filename: string) {
  const header = Buffer.alloc(26);
  const fd = fs.openSync(filename, "r");
  try {
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    expect(bytes).toBe(header.length);
  } finally {
    fs.closeSync(fd);
  }
  expect(header.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(header.toString("ascii", 12, 16)).toBe("IHDR");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20), colourType: header[25] };
}

// The app's copies are 192px: four times the largest size they're shown at (48px), and about 1.5 MB for all 35
// where 512px was 6 MB for a phone to fetch and keep offline. The 1024px working copies are what they're made from.
describe("farm illustration export files", () => {
  it("has 35 corresponding transparent RGBA assets at both export sizes", () => {
    expect(ICON_NAMES).toHaveLength(35);
    for (const name of ICON_NAMES) {
      expect(pngDimensionsAndType(iconFile("public/illustrations/icons", name))).toEqual({
        width: 192, height: 192, colourType: 6,
      });
      expect(pngDimensionsAndType(iconFile("design-assets/farm-icons/masters-1024", name))).toEqual({
        width: 1024, height: 1024, colourType: 6,
      });
    }
  });
});
