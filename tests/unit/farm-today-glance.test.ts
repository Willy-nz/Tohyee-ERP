import { describe, expect, it } from "vitest";
import type { PaddockStatus } from "@/lib/farming/paddock-status";
import { todayGlance } from "@/lib/farming/today-glance";

const paddock = (name: string, hectares: string | null, cover: number | null, head?: number | null): PaddockStatus => ({
  paddockId: name,
  name,
  hectares,
  inNow: head === undefined ? null : { grazingId: `g-${name}`, mob: "Milkers", head, inOn: "2026-11-22", mobs: [] } as PaddockStatus["inNow"],
  lastGrazedOn: null,
  cover: cover === null ? null : { cover, measuredOn: "2026-11-20", method: "plate_meter", estimate: false },
  notSafeUntil: null,
});

describe("the figures at the top of a farm's Today", () => {
  it("averages cover by area, and counts the stock in paddocks", () => {
    // 4 ha at 2,400 and 6 ha at 1,900: (9,600 + 11,400) / 10 = 2,100 kg DM/ha.
    const glance = todayGlance("2026-11-23", [paddock("1", "4", 2400, 300), paddock("2", "6", 1900), paddock("3", "5", null, 120)]);
    expect(glance.averageCover).toBe(2100);
    expect(glance.readings).toBe(2);
    expect(glance.paddocksStocked).toBe(2);
    expect(glance.head).toBe(420);
  });

  it("shows no head total when a mob in has no count, and no cover with no readings", () => {
    const glance = todayGlance("2026-11-23", [paddock("1", "4", null, null), paddock("2", "6", null, 80)]);
    expect(glance.averageCover).toBeNull();
    expect(glance.paddocksStocked).toBe(2);
    expect(glance.head).toBeNull();
  });

  it("is zero head with nothing in a paddock", () => {
    expect(todayGlance("2026-11-23", [paddock("1", "4", 2000)]).head).toBe(0);
  });
});
