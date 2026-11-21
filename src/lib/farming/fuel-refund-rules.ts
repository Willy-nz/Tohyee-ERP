import { add, cmp, dec, type Decimal, divide, isPositive, mul, roundHalfUp, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * The fuel excise refund's rules (examples FUEL1-FUEL12; from NZTA's fuel
 * excise duty refunds page and the Land Transport Management (Apportionment
 * and Refund of Excise Duty and Excise-Equivalent Duty) Regulations 2004;
 * following common practice, not yet reviewed). Browser-safe.
 */

/** The regulations' refund rate for petrol: excise duty of 70.024c plus GST (FUEL1). */
export const PETROL_REFUND_PER_LITRE = "0.805276";

export const FUEL_TYPES = ["petrol", "diesel", "unsure", "not_fuel"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];
export const FUEL_TYPE_LABELS: Record<FuelType, string> = { petrol: "Petrol", diesel: "Diesel", unsure: "Not sure", not_fuel: "Not fuel" };

/** What uses petrol (FUEL6). */
export const FUEL_USER_KINDS = {
  quad: "Quad bike",
  motorbike: "Farm motorbike",
  side_by_side: "Side-by-side",
  tractor: "Tractor",
  generator: "Generator",
  pump: "Pump",
  small_engine: "Chainsaw or small engine",
  road_vehicle: "Road vehicle",
  other: "Other",
} as const;
export type FuelUserKind = keyof typeof FUEL_USER_KINDS;
export const FUEL_USER_KIND_KEYS = Object.keys(FUEL_USER_KINDS) as FuelUserKind[];

/** Accounts whose lines are looked at (FUEL2). */
export function isFuelAccountName(name: string): boolean {
  return /\b(fuel|petrol|diesel)\b/i.test(name);
}

/** Petrol, diesel or not sure, from a line's description (FUEL2). */
export function guessFuelType(description: string): "petrol" | "diesel" | "unsure" {
  const diesel = /\b(diesel|dsl)\b/i.test(description);
  const petrol = /\b(petrol|unleaded|ulp|premium\s*(95|98)?|regular\s*91|9[158](\s*octane)?)\b/i.test(description);
  // Both on one line: the farmer splits it (FUEL2).
  if (diesel && petrol) return "unsure";
  if (diesel) return "diesel";
  if (petrol) return "petrol";
  return "unsure";
}

/** Litres from the description, or the quantity when it's more than 1 (FUEL3). */
export function guessLitres(description: string, quantity: string): string | null {
  const written = /(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:l|lt|ltr|ltrs|litre|litres|liter|liters)\b/i.exec(description);
  if (written) return toFixedString(dec(written[1].replace(",", ".")), 2);
  const amount = dec(quantity);
  if (cmp(amount, dec("1")) > 0) return toFixedString(amount, 2);
  return null;
}

/** The quarter a date is in, as its last day (FUEL9). */
export function quarterEnd(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const quarter = Math.ceil(month / 3);
  return [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`][quarter - 1];
}

export function isQuarterEnd(date: string): boolean {
  return /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(date);
}

export function quarterStart(end: string): string {
  const year = end.slice(0, 4);
  return { "03-31": `${year}-01-01`, "06-30": `${year}-04-01`, "09-30": `${year}-07-01`, "12-31": `${year}-10-01` }[end.slice(5)] as string;
}

export function previousQuarterEnd(end: string): string {
  const year = Number(end.slice(0, 4));
  return { "03-31": `${year - 1}-12-31`, "06-30": `${year}-03-31`, "09-30": `${year}-06-30`, "12-31": `${year}-09-30` }[end.slice(5)] as string;
}

/** Three months after the quarter ends (FUEL9). */
export function claimDueDate(end: string): string {
  const year = Number(end.slice(0, 4));
  return { "03-31": `${year}-06-30`, "06-30": `${year}-09-30`, "09-30": `${year}-12-31`, "12-31": `${year + 1}-03-31` }[end.slice(5)] as string;
}

/** Late (10% off), too old (more than two years) or fine (FUEL9). */
export function claimTiming(end: string, today: string): "not_ended" | "open" | "late" | "too_old" {
  if (end >= today) return "not_ended";
  const twoYearsAgo = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
  if (end < twoYearsAgo) return "too_old";
  return today > claimDueDate(end) ? "late" : "open";
}

export type RefundInput = {
  opening: Decimal;
  closing: Decimal;
  petrolLitres: Decimal[];
  /** Each user's share in per cent, and whether it's licensed for the road. */
  shares: Array<{ percent: Decimal; roadLicensed: boolean }>;
};

export type RefundResult = {
  bought: string;
  used: string;
  sharedPercent: string;
  claimedPercent: string;
  offRoadLitres: string;
  refund: string;
  gst: string;
  excise: string;
  problems: string[];
  notes: string[];
};

/** Petrol used, the off-road share and the refund (FUEL5-FUEL7). */
export function workOutRefund(input: RefundInput): RefundResult {
  const problems: string[] = [];
  const notes: string[] = [];
  const bought = input.petrolLitres.reduce((sum, litres) => add(sum, litres), ZERO_DECIMAL);
  const used = sub(add(input.opening, bought), input.closing);
  if (cmp(used, ZERO_DECIMAL) < 0) problems.push("More petrol is in the tank at the end than the start plus what was bought. Check the tank figures.");
  const shared = input.shares.reduce((sum, share) => add(sum, share.percent), ZERO_DECIMAL);
  const claimed = input.shares.filter((share) => !share.roadLicensed).reduce((sum, share) => add(sum, share.percent), ZERO_DECIMAL);
  if (cmp(shared, dec("100")) > 0) problems.push(`The shares add up to ${toFixedString(shared, 2)}%: they can't be more than 100%.`);
  else if (cmp(shared, dec("100")) < 0 && isPositive(used)) notes.push(`The shares add up to ${toFixedString(shared, 2)}%. The other ${toFixedString(sub(dec("100"), shared), 2)}% of the petrol isn't claimed.`);
  const ok = problems.length === 0 && isPositive(used);
  const offRoad = ok ? roundHalfUp(divide(mul(used, claimed), dec("100"), 6), 2) : ZERO_DECIMAL;
  const refund = roundHalfUp(mul(offRoad, dec(PETROL_REFUND_PER_LITRE)), 2);
  const gst = roundHalfUp(divide(mul(refund, dec("3")), dec("23"), 6), 2);
  return {
    bought: toFixedString(bought, 2),
    used: toFixedString(used, 2),
    sharedPercent: toFixedString(shared, 2),
    claimedPercent: toFixedString(claimed, 2),
    offRoadLitres: toFixedString(offRoad, 2),
    refund: toFixedString(refund, 2),
    gst: toFixedString(gst, 2),
    excise: toFixedString(sub(refund, gst), 2),
    problems,
    notes,
  };
}
