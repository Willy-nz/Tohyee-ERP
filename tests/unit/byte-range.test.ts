import { describe, expect, it } from "vitest";
import { byteRange } from "@/lib/api/byte-range";

describe("byte ranges for voice notes (FCH9)", () => {
  it("reads the ranges phones ask for", () => {
    expect(byteRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 });
    expect(byteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(byteRange("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
    expect(byteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  it("gives the whole file for no range or one it doesn't read, and refuses one past the end", () => {
    expect(byteRange(null, 100)).toBeNull();
    expect(byteRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(byteRange("bytes=-", 100)).toBeNull();
    expect(byteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=5-2", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 100)).toBe("unsatisfiable");
  });
});
