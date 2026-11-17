import { type Decimal, ZERO_DECIMAL, add, dec, divide, isZero, mul, sub, toFixedString } from "@/lib/money/decimal";

/**
 * Rounded figures on a report layout (RND1-RND5, 15 Nov 2026: "Round stuff so it is not out by 1"). The lowest lines shown are rounded, and
 * every total is added up from the rounded lines above it, so a column
 * always adds.
 */
export const REPORT_ROUNDINGS = {
  whole: "Whole dollars",
  thousands: "Thousands",
  millions: "Millions",
} as const;
export type ReportRounding = keyof typeof REPORT_ROUNDINGS;

export function isReportRounding(value: unknown): value is ReportRounding {
  return typeof value === "string" && Object.hasOwn(REPORT_ROUNDINGS, value);
}

const UNITS: Record<ReportRounding, Decimal> = { whole: dec("1"), thousands: dec("1000"), millions: dec("1000000") };

/** The amount to the nearest whole unit, a half going away from zero, still in dollars: 1,499.50 to thousands is 1,000.00. */
export function roundToUnit(value: Decimal, rounding: ReportRounding): Decimal {
  return mul(divide(value, UNITS[rounding], 0), UNITS[rounding]);
}

/** A rounded amount as the report shows it, in its units with no decimals: "12000.00" in thousands is "12". */
export function inRoundedUnits(value: string, rounding: ReportRounding): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const shown = toFixedString(divide(dec(value), UNITS[rounding], 0), 0);
  return shown === "-0" ? "0" : shown;
}

/** What the report says about its figures, e.g. "NZD thousands". */
export function roundingCaption(rounding: ReportRounding, currencyCode: string): string {
  const what = rounding === "whole" ? `rounded to whole ${currencyCode}` : `in ${currencyCode} ${REPORT_ROUNDINGS[rounding].toLowerCase()}`;
  return `Figures are ${what}. Each total is added from the rounded lines above it.`;
}

/** A balance sheet line that is rounded by itself: +1 for an asset, -1 for a liability, equity or the earnings of earlier years. */
export type BalanceLeaf = { sign: 1 | -1; amount: Decimal };

/**
 * The current year's earnings on a rounded balance sheet (RND4). Rounding
 * each line by itself can leave assets less liabilities a unit or two away
 * from equity, so this one line is what makes the sheet balance: the rounded
 * assets, less the rounded liabilities, equity and earlier earnings. Null
 * when the lines don't balance before rounding (the layout leaves an
 * account out, or has one twice): then nothing is adjusted.
 */
export function balancingEarnings(leaves: BalanceLeaf[], current: Decimal, rounding: ReportRounding): Decimal | null {
  let exact: Decimal = ZERO_DECIMAL;
  let rounded: Decimal = ZERO_DECIMAL;
  for (const leaf of leaves) {
    exact = leaf.sign === 1 ? add(exact, leaf.amount) : sub(exact, leaf.amount);
    const shown = roundToUnit(leaf.amount, rounding);
    rounded = leaf.sign === 1 ? add(rounded, shown) : sub(rounded, shown);
  }
  if (!isZero(sub(exact, current))) return null;
  return rounded;
}

/** A row of a cash flow or changes in equity layout: the lines it adds up, and whether they're listed. */
export type LineGroup = { id: string; refs: string[]; showLines: boolean };

/**
 * Groups of lines rounded so the statement adds (RND6). A group that lists
 * its lines is the sum of its rounded lines; one shown as a single figure is
 * rounded as one. `target` is what the groups must add up to (the rounded
 * change in cash, or in equity); when they don't, the group holding
 * `absorber` (net profit) takes the difference, and so does its own line.
 * With no rounding, everything is exact and nothing is adjusted.
 */
export function roundedGroups(
  groups: LineGroup[],
  amountOf: (ref: string) => Decimal,
  rounding: ReportRounding | undefined,
  target: Decimal | null = null,
  absorber = "profit",
): { rows: Map<string, { value: Decimal; lines: Map<string, Decimal> }>; total: Decimal } {
  const round = (value: Decimal) => (rounding ? roundToUnit(value, rounding) : value);
  const rows = new Map<string, { value: Decimal; lines: Map<string, Decimal> }>();
  let total: Decimal = ZERO_DECIMAL;
  for (const group of groups) {
    const lines = new Map<string, Decimal>();
    let exact: Decimal = ZERO_DECIMAL;
    let listed: Decimal = ZERO_DECIMAL;
    for (const ref of group.refs) {
      const amount = amountOf(ref);
      const shown = round(amount);
      lines.set(ref, shown);
      exact = add(exact, amount);
      listed = add(listed, shown);
    }
    const value = group.showLines ? listed : round(exact);
    rows.set(group.id, { value, lines });
    total = add(total, value);
  }
  if (rounding && target) {
    const difference = sub(target, total);
    const holder = groups.find((group) => group.refs.includes(absorber));
    if (holder && !isZero(difference)) {
      const row = rows.get(holder.id)!;
      row.value = add(row.value, difference);
      row.lines.set(absorber, add(row.lines.get(absorber) ?? ZERO_DECIMAL, difference));
      total = target;
    }
  }
  return { rows, total };
}
