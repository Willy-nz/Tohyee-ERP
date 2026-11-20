import { describe, expect, it } from "vitest";
import { expiryState, MEDICINE_KINDS, MEDICINE_SHAPES, soonestExpiry, STARTER_LISTS, stockBadge } from "@/lib/farming/medicine-rules";
import { STOCK_UNITS } from "@/lib/farming/treatment-rules";

/** The medicine cabinet's rules (MED1-MED10, following common practice, not yet reviewed). */
describe("medicine cabinet rules", () => {
  it("MED2, MED3, MED8: every kind has a drawing and a stock unit, and the lists use known kinds", () => {
    for (const info of Object.values(MEDICINE_KINDS)) {
      expect(MEDICINE_SHAPES).toContain(info.shape);
      expect(STOCK_UNITS).toContain(info.unit);
    }
    for (const list of Object.values(STARTER_LISTS)) {
      for (const kind of list) expect(Object.keys(MEDICINE_KINDS)).toContain(kind);
      expect(new Set(list).size).toBe(list.length);
    }
    expect(STARTER_LISTS.dairy).toContain("dry_cow");
    expect(STARTER_LISTS.sheep).not.toContain("dry_cow");
  });

  it("MED6: running low at or below the reorder level, out at nil, count it below nil", () => {
    expect(stockBadge(null, "2")).toBe("none");
    expect(stockBadge("3", "2")).toBe("ok");
    expect(stockBadge("2", "2")).toBe("low");
    expect(stockBadge("0", "2")).toBe("out");
    expect(stockBadge("-0.5", null)).toBe("count");
    expect(stockBadge("1", null)).toBe("ok");
  });

  it("MED7: the soonest expiry of stock received since the last count", () => {
    expect(expiryState("2026-12-15", "2026-11-21")).toBe("soon");
    expect(expiryState("2026-11-20", "2026-11-21")).toBe("expired");
    expect(expiryState("2027-01-01", "2026-11-21")).toBe("ok");
    expect(expiryState(null, "2026-11-21")).toBeNull();
    const moves = [
      { kind: "received", expiresOn: "2026-12-01" },
      { kind: "counted", expiresOn: "2027-03-01" },
      { kind: "received", expiresOn: "2027-02-01" },
      { kind: "treatment" },
    ];
    expect(soonestExpiry(moves, "4")).toBe("2027-02-01");
    expect(soonestExpiry(moves.slice(0, 2), "4")).toBe("2027-03-01");
    expect(soonestExpiry(moves.slice(0, 1), "4")).toBe("2026-12-01");
    expect(soonestExpiry(moves, "0")).toBeNull();
  });
});
