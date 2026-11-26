import { describe, expect, it } from "vitest";
import { matchPump, stockDemand, stockFromMobs, STOCK_WATER_CLASSES, waterClassFor } from "@/lib/farming/water-demand-rules";
import { pipeFlow, pipeMaterials } from "@/lib/farming/water-rules";

describe("farm water: what the stock drink", () => {
  it("FW7 a day's water, and the flow that delivers it in the peak hours", () => {
    const litres = (key: string) => STOCK_WATER_CLASSES.find((each) => each.key === key)!.litres;
    expect([litres("dairy_milking"), litres("beef"), litres("calves"), litres("sheep"), litres("deer")]).toEqual([70, 45, 25, 6, 20]);
    // 300 milking cows at 70 L: 21,000 L a day. Over five hours that's 4,200 L an hour, 14 L a cow an hour.
    expect(stockDemand([{ head: 300, litresEach: 70 }])).toEqual({ litresPerDay: 21000, peakLpm: 70, steadyLpm: 14.6 });
    // With 80 calves and 1,200 sheep: 21,000 + 2,000 + 7,200.
    expect(stockDemand([{ head: 300, litresEach: 70 }, { head: 80, litresEach: 25 }, { head: 1200, litresEach: 6 }])).toEqual({ litresPerDay: 30200, peakLpm: 100.7, steadyLpm: 21 });
    // Fewer peak hours is a bigger flow.
    expect(stockDemand([{ head: 300, litresEach: 70 }], 4)!.peakLpm).toBe(87.5);
    expect(stockDemand([])).toBeNull();
    expect(stockDemand([{ head: 0, litresEach: 70 }])).toBeNull();
    expect(stockDemand([{ head: -5, litresEach: 70 }])).toBeNull();
    expect(stockDemand([{ head: 300, litresEach: Number.NaN }])).toBeNull();
    expect(stockDemand([{ head: 300, litresEach: 70 }], 0)).toBeNull();
    expect(stockDemand([{ head: 300, litresEach: 70 }], 30)).toBeNull();
  });
});

describe("farm water: matching a pump to a pipe", () => {
  const pump = [
    { flowLpm: 20, headM: 62 },
    { flowLpm: 60, headM: 55 },
    { flowLpm: 100, headM: 42 },
    { flowLpm: 140, headM: 22 },
  ];
  const pipe = { insideMm: 40.8, lengthM: 450, riseM: 12, endHeadM: 10 };

  it("FW8 the pump and the pipe meet where the pump's head is what the pipe needs", () => {
    // At 100 L/min the pipe loses 20.0 m to friction, climbs 12 m and wants 10 m at the end: 42 m, which is what the pump gives there.
    expect(pipeFlow({ insideMm: 40.8, lengthM: 450, riseM: 12, flowLpm: 100 })!.totalM).toBe(32);
    expect(matchPump(pump, pipe)).toEqual({ kind: "meets", flowLpm: 100, headM: 42, velocity: 1.27, fast: false });
    // The order the points are typed in doesn't matter.
    expect(matchPump([...pump].reverse(), pipe)).toEqual(matchPump(pump, pipe));
    // Less wanted at the end moves the meeting point up the curve: more flow, less head.
    const easier = matchPump(pump, { ...pipe, endHeadM: 0 })!;
    expect(easier.kind).toBe("meets");
    if (easier.kind === "meets") {
      expect(easier.flowLpm).toBeGreaterThan(100);
      expect(easier.flowLpm).toBeLessThan(140);
      expect(easier.headM).toBeLessThan(42);
    }
  });

  it("FW9 a pump too small for the climb, and a pipe so easy the answer is past the end of the curve", () => {
    // A 60 m climb: even at 20 L/min the pipe needs 71.2 m and the pump gives 62.
    expect(matchPump(pump, { ...pipe, riseM: 60 })).toEqual({ kind: "too_small", flowLpm: 20, pumpHeadM: 62, neededM: 71.2 });
    // 100 m of 90 mm pipe on the flat needs 0.2 m at 140 L/min and the pump still gives 22.
    expect(matchPump(pump, { insideMm: 90, lengthM: 100, riseM: 0, endHeadM: 0 })).toEqual({ kind: "off_curve", flowLpm: 140, pumpHeadM: 22, neededM: 0.2 });
  });

  it("FW10 needs two points of a falling curve and a pipe it can work out", () => {
    expect(matchPump([pump[0]], pipe)).toBeNull();
    expect(matchPump([{ flowLpm: 20, headM: 30 }, { flowLpm: 60, headM: 40 }], pipe)).toBeNull();
    expect(matchPump([{ flowLpm: 20, headM: 30 }, { flowLpm: 20, headM: 25 }], pipe)).toBeNull();
    expect(matchPump([{ flowLpm: 0, headM: 70 }, { flowLpm: 60, headM: 40 }], pipe)).toBeNull();
    expect(matchPump(pump, { ...pipe, insideMm: 2 })).toBeNull();
    expect(matchPump(pump, { ...pipe, endHeadM: -1 })).toBeNull();
  });
});

describe("farm water: fittings, mobs and materials", () => {
  it("FW11 a tenth on the pipe's friction for bends and fittings", () => {
    // FW1's pipe loses 23.7 m on its own. A tenth more is 26.1 m; the speed is the same.
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 0 })!.frictionM).toBe(23.7);
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 0, fittingsPct: 0 })!.frictionM).toBe(23.7);
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 0, fittingsPct: 10 })).toEqual({ velocity: 1.4, fast: false, frictionM: 26.1, per100M: 5.8, totalM: 26.1, totalKpa: 256 });
    // The allowance is on the friction, not the rise: 28.5 + 12.
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 12, fittingsPct: 20 })!.totalM).toBe(40.5);
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 0, fittingsPct: -5 })).toBeNull();
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 0, fittingsPct: 150 })).toBeNull();
    // FW8's pump meets the same pipe a little lower with the allowance on.
    const pump = [{ flowLpm: 20, headM: 62 }, { flowLpm: 60, headM: 55 }, { flowLpm: 100, headM: 42 }, { flowLpm: 140, headM: 22 }];
    expect(matchPump(pump, { insideMm: 40.8, lengthM: 450, riseM: 12, endHeadM: 10, fittingsPct: 10 })).toEqual({ kind: "meets", flowLpm: 97.2, headM: 42.9, velocity: 1.24, fast: false });
  });

  it("FW12 a farm's mobs as head in each water class", () => {
    expect(waterClassFor("dairy_cattle", "ma_cows")).toBe("dairy_milking");
    expect(waterClassFor("dairy_cattle", "breeding_bulls")).toBe("dairy_dry");
    expect(waterClassFor("beef_cattle", "ma_cows")).toBe("beef");
    expect(waterClassFor("beef_cattle", "r1_steers_bulls")).toBe("calves");
    expect(waterClassFor("sheep", "two_tooth_ewes")).toBe("ewes_milk");
    expect(waterClassFor("sheep", "ewe_hoggets")).toBe("sheep");
    expect(waterClassFor("deer_other", "r1_hinds")).toBe("deer");
    expect(waterClassFor("goats_dairy", "does")).toBeNull();
    const stock = stockFromMobs([
      { kind: "dairy_cattle", classCode: "ma_cows", head: 280 },
      { kind: "dairy_cattle", classCode: "r2_heifers", head: 60 },
      { kind: "dairy_cattle", classCode: "r1_heifers", head: 70 },
      { kind: "dairy_cattle", classCode: "breeding_bulls", head: 6 },
      { kind: "sheep", classCode: "ma_ewes", head: 400 },
      { kind: "sheep", classCode: "ram_wether_hoggets", head: 150 },
      { kind: "deer_red", classCode: "ma_hinds", head: 90 },
      { kind: "pigs", classCode: "weaners", head: 12 },
      { kind: "beef_cattle", classCode: "r2_steers_bulls", head: 40 },
    ]);
    expect(stock).toEqual({
      classes: [
        { key: "dairy_milking", head: 340 },
        { key: "dairy_dry", head: 6 },
        { key: "beef", head: 40 },
        { key: "calves", head: 70 },
        { key: "ewes_milk", head: 400 },
        { key: "sheep", head: 150 },
        { key: "deer", head: 90 },
      ],
      leftOutHead: 12,
    });
    // 340 x 70 + 6 x 45 + 40 x 45 + 70 x 25 + 400 x 15 + 150 x 6 + 90 x 20 = 36,320 L a day.
    const litres = Object.fromEntries(STOCK_WATER_CLASSES.map((each) => [each.key, each.litres]));
    expect(stockDemand(stock.classes.map((each) => ({ head: each.head, litresEach: litres[each.key] })))!.litresPerDay).toBe(36320);
    expect(stockFromMobs([])).toEqual({ classes: [], leftOutHead: 0 });
  });

  it("FW13 the metres of each size of pipe", () => {
    expect(pipeMaterials([{ lengthM: 642, insideMm: 40.8 }, { lengthM: 193, insideMm: 26.2 }, { lengthM: 120, insideMm: 40.8 }, { lengthM: 75, insideMm: null }])).toEqual({
      sizes: [
        { insideMm: 26.2, lengthM: 193, pipes: 1 },
        { insideMm: 40.8, lengthM: 762, pipes: 2 },
      ],
      unsized: { lengthM: 75, pipes: 1 },
    });
    expect(pipeMaterials([])).toEqual({ sizes: [], unsized: { lengthM: 0, pipes: 0 } });
  });
});
