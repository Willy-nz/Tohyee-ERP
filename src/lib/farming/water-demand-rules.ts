import { MAX_FLOW_LPM, type PipeInput, pipeFlow } from "@/lib/farming/water-rules";

/*
 * Farm water: how much the stock drink, and matching a pump to a pipe
 * (examples FW7-FW10, following common practice, not yet reviewed). Pure
 * and browser-safe, like water-rules.ts. Estimates, in ordinary floating
 * point: not money or stock quantities. Tested in
 * tests/unit/farm-water-demand.test.ts.
 */

/**
 * Litres a head a day for each class of stock: the daily allowances
 * regional councils' plans use for stock water (the Canterbury figures,
 * which district rural water schemes also publish; deer from the deer
 * industry's drought advice, a supply of at least 20 litres an adult red
 * stag a day). They're a starting point: hot weather and dry feed push them up, so the screen lets each be
 * changed.
 */
export const STOCK_WATER_CLASSES = [
  { key: "dairy_milking", label: "Dairy cows, milking", litres: 70 },
  { key: "dairy_dry", label: "Dairy cows, dry", litres: 45 },
  { key: "beef", label: "Beef cattle", litres: 45 },
  { key: "calves", label: "Calves", litres: 25 },
  { key: "ewes_milk", label: "Ewes with lambs", litres: 15 },
  { key: "sheep", label: "Other sheep", litres: 6 },
  { key: "lambs", label: "Lambs", litres: 2 },
  { key: "deer", label: "Deer", litres: 20 },
  { key: "horses", label: "Horses", litres: 35 },
] as const;
export type StockWaterClass = (typeof STOCK_WATER_CLASSES)[number]["key"];

/**
 * The water class a mob's kind and class most likely is (FW12), or null
 * when there's no allowance for it (goats and pigs). It can't know whether
 * cows are milking or ewes have lambs at foot, so breeding females take
 * the bigger allowance: the line has to cope when they are. The screen
 * shows the head it put in each class, and each can be changed.
 */
export function waterClassFor(kind: string, classCode: string): StockWaterClass | null {
  const young = classCode.startsWith("r1_");
  if (kind === "dairy_cattle") return young ? "calves" : classCode === "ma_cows" || classCode === "r2_heifers" ? "dairy_milking" : "dairy_dry";
  if (kind === "beef_cattle") return young ? "calves" : "beef";
  if (kind === "sheep") return classCode.endsWith("_ewes") ? "ewes_milk" : "sheep";
  if (kind === "deer_red" || kind === "deer_other") return "deer";
  return null;
}

export type MobStock = { classes: { key: StockWaterClass; head: number }[]; leftOutHead: number };

/** A farm's mobs as head in each water class (FW12), in the classes' own order, and the head with no class. */
export function stockFromMobs(mobs: { kind: string; classCode: string; head: number }[]): MobStock {
  const heads = new Map<StockWaterClass, number>();
  let leftOutHead = 0;
  for (const mob of mobs) {
    const key = waterClassFor(mob.kind, mob.classCode);
    if (key === null) leftOutHead += mob.head;
    else heads.set(key, (heads.get(key) ?? 0) + mob.head);
  }
  return { classes: STOCK_WATER_CLASSES.filter((stock) => (heads.get(stock.key) ?? 0) > 0).map((stock) => ({ key: stock.key, head: heads.get(stock.key)! })), leftOutHead };
}

/**
 * Stock drink most of a day's water in a few hours. The dairy welfare
 * code's recommended best practice is a supply that can meet 14 litres a
 * milking cow an hour, which is 70 litres over five hours: the same five
 * hours is used here for every class unless it's changed.
 */
export const PEAK_HOURS = 5;
export const MAX_HEAD = 1000000;
export const MAX_LITRES_EACH = 1000;

export type StockRow = { head: number; litresEach: number };
export type StockDemand = {
  /** Litres the stock drink in a day. */
  litresPerDay: number;
  /** The flow that delivers a day's water in the peak hours, litres a minute. */
  peakLpm: number;
  /** The flow that delivers it evenly over 24 hours, litres a minute: what a tank filling all day needs. */
  steadyLpm: number;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** What a list of stock drink (FW7), or null when a figure isn't sensible or there's no stock. */
export function stockDemand(rows: StockRow[], peakHours: number = PEAK_HOURS): StockDemand | null {
  if (!Number.isFinite(peakHours) || peakHours <= 0 || peakHours > 24) return null;
  let litres = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.head) || !Number.isFinite(row.litresEach)) return null;
    if (row.head < 0 || row.head > MAX_HEAD || row.litresEach < 0 || row.litresEach > MAX_LITRES_EACH) return null;
    litres += row.head * row.litresEach;
  }
  if (litres <= 0) return null;
  return { litresPerDay: Math.round(litres), peakLpm: round1(litres / peakHours / 60), steadyLpm: round1(litres / 1440) };
}

/** A point read off a pump's curve: at this flow it gives this much head. */
export type PumpPoint = { flowLpm: number; headM: number };
export type PumpPipe = Omit<PipeInput, "flowLpm"> & {
  /** Pressure wanted at the far end, metres, on top of the rise and the friction. */
  endHeadM: number;
};
export type PumpMatch =
  /** The pump and the pipe meet here. */
  | { kind: "meets"; flowLpm: number; headM: number; velocity: number; fast: boolean }
  /** Even at the lowest flow on its curve the pump can't make the head the pipe needs. */
  | { kind: "too_small"; flowLpm: number; pumpHeadM: number; neededM: number }
  /** At the highest flow on its curve the pump still has head to spare: it would deliver more than the curve shows. */
  | { kind: "off_curve"; flowLpm: number; pumpHeadM: number; neededM: number };

export const MAX_PUMP_POINTS = 12;

/** Head the pipe needs at a flow: rise, friction and the pressure wanted at the end. */
function needed(pipe: PumpPipe, flowLpm: number): number | null {
  const result = pipeFlow({ ...pipe, flowLpm });
  return result ? result.totalM + pipe.endHeadM : null;
}

/** The pump's head at a flow between two of its points, on a straight line between them. */
function pumpHead(points: PumpPoint[], flowLpm: number): number {
  for (let index = 1; index < points.length; index += 1) {
    const [low, high] = [points[index - 1], points[index]];
    if (flowLpm <= high.flowLpm) return low.headM + ((high.headM - low.headM) * (flowLpm - low.flowLpm)) / (high.flowLpm - low.flowLpm);
  }
  return points.at(-1)!.headM;
}

/**
 * Where a pump and a pipe meet (FW8-FW10): the flow at which the head the
 * pump gives equals the head the pipe needs. The pump's curve is the points
 * typed from its maker's chart, joined by straight lines; nothing is guessed
 * beyond its first and last point. Null when there aren't two usable points
 * or the pipe's figures are out of range.
 */
export function matchPump(given: PumpPoint[], pipe: PumpPipe): PumpMatch | null {
  if (!Number.isFinite(pipe.endHeadM) || pipe.endHeadM < 0 || pipe.endHeadM > 2000) return null;
  if (given.length < 2 || given.length > MAX_PUMP_POINTS) return null;
  if (!given.every((point) => Number.isFinite(point.flowLpm) && Number.isFinite(point.headM) && point.flowLpm > 0 && point.flowLpm <= MAX_FLOW_LPM && point.headM >= 0 && point.headM <= 2000)) return null;
  const points = [...given].sort((left, right) => left.flowLpm - right.flowLpm);
  // A pump gives less head as the flow goes up: two points at one flow, or head that climbs, isn't a curve this can use.
  for (let index = 1; index < points.length; index += 1) if (points[index].flowLpm === points[index - 1].flowLpm || points[index].headM > points[index - 1].headM) return null;
  const [first, last] = [points[0], points.at(-1)!];
  const atFirst = needed(pipe, first.flowLpm);
  const atLast = needed(pipe, last.flowLpm);
  if (atFirst === null || atLast === null) return null;
  if (first.headM < atFirst) return { kind: "too_small", flowLpm: first.flowLpm, pumpHeadM: first.headM, neededM: round1(atFirst) };
  if (last.headM > atLast) return { kind: "off_curve", flowLpm: last.flowLpm, pumpHeadM: last.headM, neededM: round1(atLast) };
  // The pump's head falls and the pipe's need rises, so they cross once: halve the gap until it's closer than anyone can read.
  let [low, high] = [first.flowLpm, last.flowLpm];
  for (let round = 0; round < 60 && high - low > 0.01; round += 1) {
    const middle = (low + high) / 2;
    if (pumpHead(points, middle) >= (needed(pipe, middle) ?? Number.POSITIVE_INFINITY)) low = middle;
    else high = middle;
  }
  const flowLpm = round1((low + high) / 2);
  const result = pipeFlow({ ...pipe, flowLpm })!;
  return { kind: "meets", flowLpm, headM: round1(pumpHead(points, flowLpm)), velocity: result.velocity, fast: result.fast };
}
