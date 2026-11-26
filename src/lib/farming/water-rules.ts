/*
 * Farm water: sizing a pipe (examples FW1-FW5, following common engineering
 * practice, not yet reviewed). Pure and browser-safe: the Water page works
 * these out as you type, and the server works them out the same way for a
 * mapped pipe. Tested in tests/unit/farm-water.test.ts.
 *
 * These are engineering estimates, in ordinary floating point like the
 * map's distances: they aren't money or stock quantities.
 *
 * - Friction is Darcy-Weisbach, with the friction factor from the
 *   Colebrook-White equation (solved by repeating it until it settles), or
 *   64/Re when the flow is slow enough to be laminar (Re under 2,000).
 * - Water at 15 °C; the pipe wall's roughness is 0.007 mm, a usual figure
 *   for polyethylene. Bends, valves and fittings aren't counted.
 * - It's a guide for choosing a pipe, not a design: the screen says so.
 */

/** Kinematic viscosity of water at 15 °C, m²/s. */
const VISCOSITY = 1.139e-6;
/** Wall roughness for polyethylene pipe, metres. */
const ROUGHNESS = 0.000007;
const GRAVITY = 9.80665;
/** Kilopascals in a metre of water. */
export const KPA_PER_METRE = 9.80665;
/** Water moving faster than this wears fittings and makes water hammer worse: a common guide for farm lines. */
export const VELOCITY_GUIDE = 1.5;

export const MIN_INSIDE_MM = 5;
export const MAX_INSIDE_MM = 1000;
export const MAX_FLOW_LPM = 100000;
export const MAX_LENGTH_M = 100000;
export const MAX_RISE_M = 2000;

export type PipeInput = {
  /** The pipe's inside diameter, mm. */
  insideMm: number;
  /** The flow it has to carry, litres a minute. */
  flowLpm: number;
  /** Its length, metres. */
  lengthM: number;
  /** How far the far end is above the start (negative when it's below), metres. */
  riseM: number;
};

export type PipeResult = {
  /** Metres a second. */
  velocity: number;
  /** Faster than the guide. */
  fast: boolean;
  /** Head lost to friction over the whole length, metres. */
  frictionM: number;
  /** Friction for each 100 m of pipe, metres. */
  per100M: number;
  /** Friction plus the rise: the head needed at the start to deliver the flow with nothing to spare, metres. Negative when the fall more than covers the friction. */
  totalM: number;
  totalKpa: number;
};

function frictionFactor(reynolds: number, insideM: number): number {
  if (reynolds < 2000) return 64 / reynolds;
  const relative = ROUGHNESS / insideM / 3.7;
  // Colebrook-White: 1/sqrt(f) = -2 log10(e/3.7D + 2.51/(Re sqrt(f))). It settles in a handful of rounds.
  let inverse = 7;
  for (let round = 0; round < 50; round += 1) {
    const next = -2 * Math.log10(relative + (2.51 * inverse) / reynolds);
    if (Math.abs(next - inverse) < 1e-10) {
      inverse = next;
      break;
    }
    inverse = next;
  }
  return 1 / (inverse * inverse);
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/** What a pipe does with a flow (FW1-FW3), or null when a figure is missing or out of range. */
export function pipeFlow(input: PipeInput): PipeResult | null {
  const { insideMm, flowLpm, lengthM, riseM } = input;
  if (![insideMm, flowLpm, lengthM, riseM].every(Number.isFinite)) return null;
  if (insideMm < MIN_INSIDE_MM || insideMm > MAX_INSIDE_MM || flowLpm <= 0 || flowLpm > MAX_FLOW_LPM || lengthM <= 0 || lengthM > MAX_LENGTH_M || Math.abs(riseM) > MAX_RISE_M) return null;
  const insideM = insideMm / 1000;
  const flow = flowLpm / 60000;
  const velocity = flow / ((Math.PI * insideM * insideM) / 4);
  const reynolds = (velocity * insideM) / VISCOSITY;
  const gradient = (frictionFactor(reynolds, insideM) / insideM) * ((velocity * velocity) / (2 * GRAVITY));
  const frictionM = round(gradient * lengthM, 1);
  const totalM = round(frictionM + riseM, 1);
  return {
    velocity: round(velocity, 2),
    fast: round(velocity, 2) > VELOCITY_GUIDE,
    frictionM,
    per100M: round(gradient * 100, 2),
    totalM,
    totalKpa: Math.round(totalM * KPA_PER_METRE),
  };
}

/**
 * Polyethylene pressure pipe is sold by its outside diameter and a wall
 * ratio (SDR, the outside diameter over the wall thickness): a lower SDR is
 * a thicker wall, a higher pressure rating and a smaller hole. The inside
 * diameter from those two is nominal: makers' tables differ by a few tenths
 * of a millimetre, so the screen lets the real figure be typed instead.
 */
export const PIPE_OUTSIDE_MM = [20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 160] as const;
export const PIPE_SDRS = [
  { sdr: 11, label: "SDR 11 (thicker wall)" },
  { sdr: 13.6, label: "SDR 13.6" },
  { sdr: 17, label: "SDR 17 (thinner wall)" },
] as const;

/** The nominal inside diameter of a pipe from its outside diameter and SDR, to a tenth of a millimetre (FW4). */
export function nominalInsideMm(outsideMm: number, sdr: number): number {
  return round(outsideMm - (2 * outsideMm) / sdr, 1);
}

export type SizeOption = { outsideMm: number; insideMm: number; result: PipeResult };

/**
 * Every listed size for a flow, length and rise (FW5), and the smallest
 * one whose water stays at or under the velocity guide. That's the
 * suggestion; the pressure it needs is for the person to judge against
 * their pump or tank.
 */
export function sizeOptions(input: Omit<PipeInput, "insideMm">, sdr: number): { options: SizeOption[]; suggested: number | null } {
  const options: SizeOption[] = [];
  for (const outsideMm of PIPE_OUTSIDE_MM) {
    const insideMm = nominalInsideMm(outsideMm, sdr);
    const result = pipeFlow({ ...input, insideMm });
    if (result) options.push({ outsideMm, insideMm, result });
  }
  return { options, suggested: options.find((option) => !option.result.fast)?.outsideMm ?? null };
}
