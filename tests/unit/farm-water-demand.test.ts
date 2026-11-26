import { describe, expect, it } from "vitest";
import { matchPump, stockDemand, STOCK_WATER_CLASSES } from "@/lib/farming/water-demand-rules";
import { pipeFlow } from "@/lib/farming/water-rules";

describe("farm water: what the stock drink", () => {
  it("FW7 a day's water, and the flow that delivers it in the peak hours", () => {
    const litres = (key: string) => STOCK_WATER_CLASSES.find((each) => each.key === key)!.litres;
    expect([litres("dairy_milking"), litres("beef"), litres("calves"), litres("sheep")]).toEqual([70, 45, 25, 6]);
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
