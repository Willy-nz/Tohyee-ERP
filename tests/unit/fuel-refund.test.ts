import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { claimDueDate, claimTiming, guessFuelType, guessLitres, isFuelAccountName, previousQuarterEnd, quarterEnd, quarterStart, workOutRefund } from "@/lib/farming/fuel-refund-rules";

/** The fuel excise refund's rules (FUEL1-FUEL12, following common practice, not yet reviewed). */
describe("fuel excise refund rules", () => {
  it("FUEL2: petrol, diesel or not sure from the description, and fuel accounts by name", () => {
    expect(guessFuelType("ULP 91 bulk delivery")).toBe("petrol");
    expect(guessFuelType("Unleaded petrol")).toBe("petrol");
    expect(guessFuelType("Premium 95")).toBe("petrol");
    expect(guessFuelType("Diesel 1000L")).toBe("diesel");
    expect(guessFuelType("DSL farm tank")).toBe("diesel");
    expect(guessFuelType("Diesel and petrol")).toBe("unsure");
    expect(guessFuelType("Fuel")).toBe("unsure");
    expect(guessFuelType("Invoice 9100")).toBe("unsure");
    expect(isFuelAccountName("Fuel and oil")).toBe(true);
    expect(isFuelAccountName("Vehicle expenses")).toBe(false);
  });

  it("FUEL3: litres from the description, or the quantity over 1", () => {
    expect(guessLitres("Petrol 400L", "1")).toBe("400.00");
    expect(guessLitres("Unleaded 250 litres", "1")).toBe("250.00");
    expect(guessLitres("Petrol 91", "312.5")).toBe("312.50");
    expect(guessLitres("Petrol", "1")).toBeNull();
  });

  it("FUEL5-FUEL7: tank, shares and the refund at 80.5276c", () => {
    const result = workOutRefund({
      opening: dec("200"),
      closing: dec("300"),
      petrolLitres: [dec("600"), dec("400")],
      shares: [
        { percent: dec("60"), roadLicensed: false },
        { percent: dec("10"), roadLicensed: false },
        { percent: dec("30"), roadLicensed: true },
      ],
    });
    expect(result).toMatchObject({ bought: "1000.00", used: "900.00", claimedPercent: "70.00", offRoadLitres: "630.00", refund: "507.32", gst: "66.17", excise: "441.15", problems: [], notes: [] });
  });

  it("FUEL5, FUEL6: shares under or over 100%, and a tank that doesn't add up", () => {
    const under = workOutRefund({ opening: dec("0"), closing: dec("0"), petrolLitres: [dec("100")], shares: [{ percent: dec("80"), roadLicensed: false }] });
    expect(under.notes[0]).toContain("other 20.00%");
    expect(under.offRoadLitres).toBe("80.00");
    const over = workOutRefund({ opening: dec("0"), closing: dec("0"), petrolLitres: [dec("100")], shares: [{ percent: dec("80"), roadLicensed: false }, { percent: dec("30"), roadLicensed: true }] });
    expect(over.problems[0]).toContain("110.00%");
    expect(over.refund).toBe("0.00");
    const tank = workOutRefund({ opening: dec("0"), closing: dec("500"), petrolLitres: [dec("100")], shares: [{ percent: dec("100"), roadLicensed: false }] });
    expect(tank.problems[0]).toContain("tank");
  });

  it("FUEL9: quarters, due dates, late and too old", () => {
    expect(quarterEnd("2026-11-21")).toBe("2026-12-31");
    expect(quarterStart("2026-09-30")).toBe("2026-07-01");
    expect(previousQuarterEnd("2026-03-31")).toBe("2025-12-31");
    expect(claimDueDate("2026-03-31")).toBe("2026-06-30");
    expect(claimDueDate("2026-12-31")).toBe("2027-03-31");
    expect(claimTiming("2026-09-30", "2026-11-21")).toBe("open");
    expect(claimTiming("2026-06-30", "2026-11-21")).toBe("late");
    expect(claimTiming("2024-09-30", "2026-11-21")).toBe("too_old");
    expect(claimTiming("2026-12-31", "2026-11-21")).toBe("not_ended");
  });
});
