import { add, cmp, type Decimal, dec, divide, isPositive, mul, roundHalfUp, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Late payment fees and interest, worked out (LATE1-LATE12,
 * docs/ACCOUNTING-EXAMPLES.md). No database: the service gives these the
 * invoice, its payments and what's been charged, and posts what they say.
 */

const DAY_MS = 86_400_000;

/** The date `days` after `date` (YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** A change to what's owing on an invoice: a payment (negative) or one voided or removed (positive), from `date`. */
export type BalanceChange = { date: string; amount: string };

/**
 * LATE6-LATE7: simple interest on what's still owing at the end of each day
 * from `from` to `to` inclusive, at `ratePercent` a year over 365 days,
 * rounded half up to `scale` places at the end only. `owing` is the invoice
 * total; each change counts from the end of its date. Nothing owing (or
 * overpaid) on a day charges nothing for it.
 */
export function interestFor(input: {
  owing: string;
  changes: readonly BalanceChange[];
  from: string;
  to: string;
  ratePercent: string;
  scale: number;
}): { amount: string; days: number; balanceDays: string } {
  const days = daysFrom(input.from, input.to) + 1;
  if (days <= 0) return { amount: toFixedString(ZERO_DECIMAL, input.scale), days: 0, balanceDays: "0" };
  // What's owing at the end of `from`'s day before: everything up to the day before `from`.
  let balance = dec(input.owing);
  const sorted = [...input.changes].sort((a, b) => a.date.localeCompare(b.date));
  for (const change of sorted) if (change.date < input.from) balance = add(balance, dec(change.amount));
  // Then day by day, in runs between changes.
  let balanceDays: Decimal = ZERO_DECIMAL;
  let day = input.from;
  const later = sorted.filter((change) => change.date >= input.from && change.date <= input.to);
  let index = 0;
  while (day <= input.to) {
    // Changes dated today count for today (a payment on the 10th stops the 10th's interest).
    while (index < later.length && later[index].date === day) {
      balance = add(balance, dec(later[index].amount));
      index += 1;
    }
    const nextChange = index < later.length ? later[index].date : null;
    const runEnd = nextChange && nextChange <= input.to ? addDays(nextChange, -1) : input.to;
    const run = daysFrom(day, runEnd) + 1;
    if (isPositive(balance)) balanceDays = add(balanceDays, mul(balance, dec(String(run))));
    day = addDays(runEnd, 1);
  }
  const amount = divide(mul(balanceDays, dec(input.ratePercent)), dec("36500"), input.scale);
  return { amount: toFixedString(amount, input.scale), days, balanceDays: toFixedString(balanceDays, 2) };
}

/** One part of the fee: its tax code (null with no GST) and amount. */
export type FeePart = { taxCode: string | null; amount: string };

/**
 * LATE5: the fee split across the sale's tax codes in the shares of their
 * amounts before GST, to `scale` places, any odd units on the largest share.
 * Codes whose lines come to nothing or less take no part. A sale with no
 * positive amounts at all gives the whole fee to `fallback`.
 */
export function splitFee(fee: string, lines: readonly { taxCode: string | null; net: string }[], scale: number, fallback: string | null): FeePart[] {
  const totals = new Map<string | null, Decimal>();
  for (const line of lines) totals.set(line.taxCode, add(totals.get(line.taxCode) ?? ZERO_DECIMAL, dec(line.net)));
  const shares = [...totals.entries()].filter(([, net]) => isPositive(net));
  const feeAmount = dec(fee);
  if (shares.length === 0) return [{ taxCode: fallback, amount: toFixedString(roundHalfUp(feeAmount, scale), scale) }];
  const whole = sum(shares.map(([, net]) => net));
  const parts = shares.map(([taxCode, net]) => ({ taxCode, net, amount: divide(mul(feeAmount, net), whole, scale) }));
  const leftOver = sub(roundHalfUp(feeAmount, scale), sum(parts.map((part) => part.amount)));
  // The largest share (first on a tie) takes what rounding left over.
  const largest = parts.reduce((best, part) => (cmp(part.net, best.net) > 0 ? part : best), parts[0]);
  largest.amount = add(largest.amount, leftOver);
  return parts.filter((part) => isPositive(part.amount)).map((part) => ({ taxCode: part.taxCode, amount: toFixedString(part.amount, scale) }));
}

export type LateFeeSettingsShape = {
  enabled: boolean;
  feeAmount: string | null;
  interestRate: string | null;
  graceDays: number;
  minimumOverdue: string;
};

/** LATE2, LATE11: whether an overdue invoice can be charged on `asOf`. */
export function chargeable(settings: LateFeeSettingsShape, invoice: { dueDate: string; amountDue: string }, asOf: string): boolean {
  if (!settings.enabled || (!settings.feeAmount && !settings.interestRate)) return false;
  if (daysFrom(invoice.dueDate, asOf) <= settings.graceDays) return false;
  const due = dec(invoice.amountDue);
  return isPositive(due) && cmp(due, dec(settings.minimumOverdue)) >= 0;
}
