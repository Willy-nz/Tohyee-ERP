import { describe, expect, it } from "vitest";
import { farmMoveName, farmMoveWarning, MOB_EVENT_LABELS, MOB_EVENT_TYPES, MOVEMENT_FOR_ACTION, naitReminder } from "@/lib/farming/mob-rules";

/** Moving stock to another farm in the same organisation (OPF7-OPF13, following common practice, not yet reviewed). */
describe("moving stock to another farm (OPF7-OPF13)", () => {
  it("OPF7 names the new mob after the mob and the farm it came from", () => {
    expect(farmMoveName("Milkers", "Home")).toBe("Milkers from Home");
    expect(farmMoveName("x".repeat(95), "Home").length).toBe(100);
  });

  it("OPF7 has its own history words, and is never a livestock movement", () => {
    expect(MOB_EVENT_TYPES).toContain("farm_out");
    expect(MOB_EVENT_TYPES).toContain("farm_in");
    expect(MOB_EVENT_LABELS.farm_out).toBe("Moved to another farm");
    expect(MOB_EVENT_LABELS.farm_in).toBe("Came from another farm");
    // Only sales, purchases, deaths, births and class changes touch the books' head count.
    expect(Object.values(MOVEMENT_FOR_ACTION).sort()).toEqual(["birth", "death", "purchase", "reclass", "sale"]);
  });

  it("OPF10 warns when the animals moving are within a withholding period, and says it goes with them", () => {
    const withholding = { meatSafeOn: "2026-12-06", milkSafeFrom: "2026-11-13" };
    expect(farmMoveWarning(withholding, "2026-11-10", "Runoff")).toBe(
      "These animals are within a withholding period (safe for slaughter from 2026-12-06, milk safe from 2026-11-13). It goes with them to Runoff.",
    );
    // Milk is safe again by 20 Nov; meat isn't.
    expect(farmMoveWarning(withholding, "2026-11-20", "Runoff")).toBe("These animals are within a withholding period (safe for slaughter from 2026-12-06). It goes with them to Runoff.");
    expect(farmMoveWarning(withholding, "2026-12-06", "Runoff")).toBeNull();
    expect(farmMoveWarning(null, "2026-11-10", "Runoff")).toBeNull();
  });

  it("OPF13 reminds about NAIT for cattle and deer, without deciding whether it's needed", () => {
    for (const kind of ["dairy_cattle", "beef_cattle", "deer_red", "deer_other"]) {
      expect(naitReminder(kind)).toBe("Tohyee doesn't tell NAIT. If this move needs recording in NAIT, record it with OSPRI.");
    }
    for (const kind of ["sheep", "goats_dairy", "pigs"]) expect(naitReminder(kind)).toBeNull();
  });
});
