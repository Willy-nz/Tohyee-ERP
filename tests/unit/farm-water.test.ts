import { describe, expect, it } from "vitest";
import { nominalInsideMm, pipeFlow, sizeOptions } from "@/lib/farming/water-rules";

describe("farm water: sizing a pipe", () => {
  it("FW1 velocity and friction for a flow down a pipe", () => {
    // 110 L/min through 450 m of pipe with a 40.8 mm hole, on the flat.
    const result = pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 0 })!;
    expect(result.velocity).toBe(1.4);
    expect(result.fast).toBe(false);
    // Worked by hand: Re about 50,200, friction factor about 0.021, so about 5.2 m lost in each 100 m.
    expect(result.per100M).toBeGreaterThan(5.0);
    expect(result.per100M).toBeLessThan(5.4);
    expect(result.frictionM).toBeCloseTo(result.per100M * 4.5, 0);
    expect(result.totalM).toBe(result.frictionM);
    expect(result.totalKpa).toBe(Math.round(result.frictionM * 9.80665));
  });

  it("FW2 a rise adds to what's needed and a fall takes away", () => {
    const flat = pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 0 })!;
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: 20 })!.totalM).toBeCloseTo(flat.frictionM + 20, 5);
    // A fall bigger than the friction: gravity does it, and the figure is negative.
    const down = pipeFlow({ insideMm: 40.8, flowLpm: 110, lengthM: 450, riseM: -40 })!;
    expect(down.totalM).toBeCloseTo(flat.frictionM - 40, 5);
    expect(down.totalM).toBeLessThan(0);
    expect(down.frictionM).toBe(flat.frictionM);
  });

  it("FW3 friction climbs fast as the pipe gets smaller or the flow bigger", () => {
    const loss = (insideMm: number, flowLpm: number) => pipeFlow({ insideMm, flowLpm, lengthM: 100, riseM: 0 })!;
    // Twice the flow is between three and four times the friction.
    const ratio = loss(40.8, 220).frictionM / loss(40.8, 110).frictionM;
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(4);
    expect(loss(40.8, 220).fast).toBe(true);
    // A smaller hole loses far more.
    expect(loss(26.2, 110).frictionM).toBeGreaterThan(loss(40.8, 110).frictionM * 6);
    // A trickle is laminar: 64/Re. 1 L/min in a 40.8 mm pipe, Re about 457.
    const trickle = loss(40.8, 1);
    expect(trickle.velocity).toBe(0.01);
    expect(trickle.frictionM).toBe(0);
    // Nothing to work out without every figure, or outside what's sensible.
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 0, lengthM: 100, riseM: 0 })).toBeNull();
    expect(pipeFlow({ insideMm: 2, flowLpm: 10, lengthM: 100, riseM: 0 })).toBeNull();
    expect(pipeFlow({ insideMm: 40.8, flowLpm: Number.NaN, lengthM: 100, riseM: 0 })).toBeNull();
    expect(pipeFlow({ insideMm: 40.8, flowLpm: 10, lengthM: 100, riseM: 5000 })).toBeNull();
  });

  it("FW4 a nominal inside diameter from the outside diameter and SDR", () => {
    expect(nominalInsideMm(50, 11)).toBe(40.9);
    expect(nominalInsideMm(63, 11)).toBe(51.5);
    expect(nominalInsideMm(63, 17)).toBe(55.6);
    expect(nominalInsideMm(32, 13.6)).toBe(27.3);
  });

  it("FW5 every size for the job, and the smallest that keeps the water under 1.5 m/s", () => {
    const { options, suggested } = sizeOptions({ flowLpm: 110, lengthM: 450, riseM: 0 }, 11);
    expect(options.map((option) => option.outsideMm)).toEqual([20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 160]);
    const speeds = Object.fromEntries(options.map((option) => [option.outsideMm, option.result.velocity]));
    expect(speeds[40]).toBeGreaterThan(1.5);
    expect(speeds[50]).toBe(1.4);
    expect(suggested).toBe(50);
    // Each bigger size loses less.
    for (let index = 1; index < options.length; index += 1) expect(options[index].result.frictionM).toBeLessThan(options[index - 1].result.frictionM);
    // A flow no listed size can carry slowly enough has no suggestion.
    expect(sizeOptions({ flowLpm: 5000, lengthM: 100, riseM: 0 }, 11).suggested).toBeNull();
  });
});
