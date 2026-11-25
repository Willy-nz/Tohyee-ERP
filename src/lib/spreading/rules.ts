import { ValidationError } from "@/lib/errors";
import { add, cmp, dec, type Decimal, divideTruncated, isPositive, mulDiv, roundHalfUp, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Spreading (examples SW1-SW14): income or a cost that belongs to other
 * months than the one it was billed or paid in. These are the sums only:
 * which months an amount lands in and how much each takes. Nothing here reads
 * the database, so the worksheet on screen and the server work them out alike.
 *
 * Every schedule adds up to the amount exactly: the last month takes whatever
 * rounding leaves (SW2).
 */

/** The four kinds, each with one balance sheet account. */
export const SPREAD_KINDS = ["prepayment", "income_in_advance", "accrued_expense", "accrued_income"] as const;
export type SpreadKind = (typeof SPREAD_KINDS)[number];

export const SPREAD_KIND_LABELS: Record<SpreadKind, string> = {
  prepayment: "Paid in advance",
  income_in_advance: "Income in advance",
  accrued_expense: "Not billed yet",
  accrued_income: "Not invoiced yet",
};

/** How an amount is shared across its months. */
export const SPREAD_METHODS = ["by_month", "by_days", "one_month", "own_amounts", "when_done"] as const;
export type SpreadMethod = (typeof SPREAD_METHODS)[number];

export const SPREAD_METHOD_LABELS: Record<SpreadMethod, string> = {
  by_month: "Evenly by month",
  by_days: "By days",
  one_month: "All in one month",
  own_amounts: "Your own amounts",
  when_done: "When it's done",
};

/** One month's share, as "2026-07" and an amount in dollars and cents. */
export type SpreadMonth = { month: string; amount: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
/** A schedule can't run longer than this: ten years of months. */
export const MAX_SPREAD_MONTHS = 120;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(date: string): { year: number; month: number; day: number } {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) };
}

function monthKey(year: number, month: number): string {
  const zeroBased = year * 12 + (month - 1);
  return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, "0")}`;
}

/** The month after (or before) a "2026-07" month. */
export function addMonths(month: string, count: number): string {
  return monthKey(Number(month.slice(0, 4)), Number(month.slice(5, 7)) + count);
}

/** The last day of a "2026-07" month: the date a month's journal is posted on. */
export function monthEndDate(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return `${month}-${String(daysInMonth(year, number)).padStart(2, "0")}`;
}

function dayNumber(date: string): number {
  const { year, month, day } = parts(date);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

function checkedDates(startDate: string, endDate: string): void {
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) throw new ValidationError("Give the first and last day it covers.");
  if (endDate < startDate) throw new ValidationError("The last day can't be before the first day.");
}

function checkedMonth(month: string | null | undefined, what: string): string {
  if (!month || !ISO_MONTH.test(month)) throw new ValidationError(`Choose ${what}.`);
  return month;
}

/**
 * The months "evenly by month" counts (SW1, SW3): one for every month begun,
 * counting from the first day. 1 Jul to 30 Jun is twelve; so is 15 Jul to
 * 14 Jul, in July to June (the month each begins in). A start on the 31st
 * begins on the last day of a shorter month.
 */
export function monthsBegun(startDate: string, endDate: string): string[] {
  checkedDates(startDate, endDate);
  const start = parts(startDate);
  const months: string[] = [];
  for (let index = 0; index <= MAX_SPREAD_MONTHS; index += 1) {
    const month = monthKey(start.year, start.month + index);
    const year = Number(month.slice(0, 4));
    const number = Number(month.slice(5, 7));
    const begins = `${month}-${String(Math.min(start.day, daysInMonth(year, number))).padStart(2, "0")}`;
    if (begins > endDate) break;
    months.push(month);
  }
  if (months.length > MAX_SPREAD_MONTHS) throw new ValidationError("That's more than ten years. Spread it over a shorter time.");
  return months;
}

/** Each calendar month the days fall in, with how many (SW3 by days). */
export function daysByMonth(startDate: string, endDate: string): Array<{ month: string; days: number }> {
  checkedDates(startDate, endDate);
  const list: Array<{ month: string; days: number }> = [];
  for (let month = startDate.slice(0, 7); month <= endDate.slice(0, 7); month = addMonths(month, 1)) {
    const from = month === startDate.slice(0, 7) ? startDate : `${month}-01`;
    const to = month === endDate.slice(0, 7) ? endDate : monthEndDate(month);
    list.push({ month, days: dayNumber(to) - dayNumber(from) + 1 });
    if (list.length > MAX_SPREAD_MONTHS) throw new ValidationError("That's more than ten years. Spread it over a shorter time.");
  }
  return list;
}

function positiveAmount(amount: string): Decimal {
  let value: Decimal;
  try {
    value = dec(amount);
  } catch {
    throw new ValidationError("Give the amount to spread.");
  }
  if (!isPositive(value) || cmp(roundHalfUp(value, 2), value) !== 0) throw new ValidationError("The amount to spread is more than zero, in dollars and cents.");
  return value;
}

/** Shares that add up exactly: each as worked out, and the last takes what's left. */
function closing(total: Decimal, months: string[], share: (index: number) => Decimal): SpreadMonth[] {
  let left = total;
  return months.map((month, index) => {
    const amount = index === months.length - 1 ? left : share(index);
    left = sub(left, amount);
    return { month, amount: toFixedString(amount, 2) };
  });
}

export type SpreadPlan = {
  /** The amount to spread, without GST when GST was claimed or charged on it (SW1, SW9). */
  amount: string;
  method: SpreadMethod;
  /** The first and last day it covers: by month and by days. */
  startDate?: string | null;
  endDate?: string | null;
  /** The month it all lands in: all in one month, and when it's done once it is. */
  month?: string | null;
  /** Your own amounts: they must add up to the amount. */
  ownAmounts?: SpreadMonth[] | null;
};

/**
 * The months an amount lands in, and how much in each (SW1-SW5, SW12, SW13).
 * "When it's done" has no months until it's given the month it was finished.
 */
export function spreadSchedule(plan: SpreadPlan): SpreadMonth[] {
  const total = positiveAmount(plan.amount);
  switch (plan.method) {
    case "by_month": {
      const months = monthsBegun(plan.startDate ?? "", plan.endDate ?? "");
      const each = divideTruncated(total, dec(String(months.length)), 2);
      return closing(total, months, () => each);
    }
    case "by_days": {
      const days = daysByMonth(plan.startDate ?? "", plan.endDate ?? "");
      const all = dec(String(days.reduce((count, entry) => count + entry.days, 0)));
      return closing(
        total,
        days.map((entry) => entry.month),
        (index) => roundHalfUp(mulDiv(total, dec(String(days[index].days)), all, 6), 2),
      );
    }
    case "one_month":
      return [{ month: checkedMonth(plan.month, "the month it lands in"), amount: toFixedString(total, 2) }];
    case "when_done":
      return plan.month ? [{ month: checkedMonth(plan.month, "the month it was done"), amount: toFixedString(total, 2) }] : [];
    case "own_amounts": {
      const rows = plan.ownAmounts ?? [];
      if (rows.length === 0) throw new ValidationError("Give an amount for at least one month.");
      if (rows.length > MAX_SPREAD_MONTHS) throw new ValidationError("That's more than ten years. Spread it over a shorter time.");
      const seen = new Set<string>();
      const parsed = rows.map((row) => {
        const month = checkedMonth(row.month, "a month for each amount");
        if (seen.has(month)) throw new ValidationError(`${month} is there twice. Put one amount on each month.`);
        seen.add(month);
        return { month, amount: positiveAmount(row.amount) };
      });
      const given = sum(parsed.map((row) => row.amount));
      if (cmp(given, total) !== 0) {
        throw new ValidationError(`Your amounts add up to ${toFixedString(given, 2)}, not ${toFixedString(total, 2)}.`);
      }
      return parsed.sort((left, right) => left.month.localeCompare(right.month)).map((row) => ({ month: row.month, amount: toFixedString(row.amount, 2) }));
    }
  }
}

/**
 * What's still to come when an item's last day moves, or what's left
 * changes (SW29, SW30): `left` spread again over the months after
 * `through` (the last month that can't change) up to the new last day, the
 * way the item was spread before. By month, each month still to come takes
 * an equal share; by days, each takes its days from the first of the month
 * after `through`. Null when the new last day leaves no month to come.
 */
export function respread(plan: { method: "by_month" | "by_days"; startDate: string; endDate: string; left: string; through: string | null }): SpreadMonth[] | null {
  if (plan.endDate < plan.startDate) return null;
  if (plan.method === "by_month") {
    const months = monthsBegun(plan.startDate, plan.endDate).filter((month) => plan.through === null || month > plan.through);
    if (months.length === 0) return null;
    // The calendar months still to come, whatever day of the month the cover started on.
    return spreadSchedule({ amount: plan.left, method: "by_month", startDate: `${months[0]}-01`, endDate: monthEndDate(months[months.length - 1]) });
  }
  const from = plan.through === null ? plan.startDate : [`${addMonths(plan.through, 1)}-01`, plan.startDate].sort()[1];
  if (plan.endDate < from) return null;
  return spreadSchedule({ amount: plan.left, method: "by_days", startDate: from, endDate: plan.endDate });
}

/**
 * What's still to come after some months have posted (SW8): the months left
 * moved into one month, so an item can be ended early. Posted months never
 * change.
 */
export function endEarly(schedule: SpreadMonth[], postedThrough: string | null, releaseMonth: string): SpreadMonth[] {
  checkedMonth(releaseMonth, "the month to release the rest in");
  const posted = schedule.filter((row) => postedThrough !== null && row.month <= postedThrough);
  if (postedThrough !== null && releaseMonth <= postedThrough) throw new ValidationError("Choose a month after the last one posted.");
  const rest = sum(schedule.filter((row) => postedThrough === null || row.month > postedThrough).map((row) => dec(row.amount)));
  return cmp(rest, ZERO_DECIMAL) === 0 ? posted : [...posted, { month: releaseMonth, amount: toFixedString(rest, 2) }];
}

/**
 * An item added after some of its months have already posted (SW18): those
 * months' amounts are caught up in the next month to post, and the posted
 * months aren't reopened. `postedThrough` is the kind's latest posted month.
 */
export function catchUp(schedule: SpreadMonth[], postedThrough: string | null): { schedule: SpreadMonth[]; caughtUp: { months: number; amount: string; into: string } | null } {
  const sorted = [...schedule].sort((left, right) => (left.month < right.month ? -1 : left.month > right.month ? 1 : 0));
  if (postedThrough === null || sorted.every((row) => row.month > postedThrough)) return { schedule: sorted, caughtUp: null };
  const into = addMonths(postedThrough, 1);
  const late = sorted.filter((row) => row.month <= postedThrough);
  const lateTotal = sum(late.map((row) => dec(row.amount)));
  const rest = sorted.filter((row) => row.month > postedThrough);
  const first = rest[0]?.month === into ? rest.shift()! : null;
  const amount = toFixedString(add(lateTotal, first ? dec(first.amount) : ZERO_DECIMAL), 2);
  return { schedule: [{ month: into, amount }, ...rest], caughtUp: { months: late.length, amount: toFixedString(lateTotal, 2), into } };
}

/** How much of a schedule falls in months up to and including `month`, and how much after. */
export function splitAt(schedule: SpreadMonth[], month: string | null): { through: string; after: string } {
  let through = ZERO_DECIMAL;
  let after = ZERO_DECIMAL;
  for (const row of schedule) {
    if (month !== null && row.month <= month) through = add(through, dec(row.amount));
    else after = add(after, dec(row.amount));
  }
  return { through: toFixedString(through, 2), after: toFixedString(after, 2) };
}

/**
 * Which way a month's amount goes for each kind (SW1, SW4, SW6, SW7): the
 * account it's held in, and the income or expense account it lands on.
 * Prepayments and income in advance run a balance down; the two accruals
 * build one up until the bill or invoice arrives.
 */
export function spreadPosting(kind: SpreadKind): { holding: "debit" | "credit"; target: "debit" | "credit" } {
  switch (kind) {
    case "prepayment":
      return { holding: "credit", target: "debit" };
    case "income_in_advance":
      return { holding: "debit", target: "credit" };
    case "accrued_expense":
      return { holding: "credit", target: "debit" };
    case "accrued_income":
      return { holding: "debit", target: "credit" };
  }
}
