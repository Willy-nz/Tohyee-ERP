import { addMonths, monthsBegun } from "@/lib/spreading/rules";

/**
 * Suggestions for the Spreading worksheet (SW26, SW27): reading the period
 * a bill or invoice line says it covers, and spotting a supplier who bills
 * every month and hasn't this month. Pure sums; nothing here saves or posts.
 */

export type SuggestedPeriod = {
  startDate: string;
  endDate: string;
  /** The words on the line that said so, to show beside the suggestion. */
  because: string;
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAME = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12, eighteen: 18 };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > lastDay(year, month)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function fullYear(text: string): number {
  const year = Number(text);
  return text.length === 2 ? 2000 + year : year;
}

/** A date as written, with what was left unsaid: "1 Jan" has no year, "Jan 2027" no day. */
type Written = { day: number | null; month: number; year: number | null };

const DATE = `(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})\\.?(?:,?\\s+(\\d{4}|\\d{2}))?|(${MONTH_NAME})\\.?\\s+(\\d{4})|(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4}|\\d{2})|(\\d{4})-(\\d{2})-(\\d{2})|(${MONTH_NAME})\\.?)`;
const RANGE = new RegExp(`${DATE}\\s*(?:-|–|—|to|until|till|through|thru)\\s*${DATE}`, "i");

function written(groups: Array<string | undefined>): Written | null {
  const [day, monthName, year, monthOnly, monthYear, slashDay, slashMonth, slashYear, isoYear, isoMonth, isoDay, bareMonth] = groups;
  if (day && monthName) return { day: Number(day), month: MONTHS[monthName.toLowerCase()], year: year ? fullYear(year) : null };
  if (monthOnly && monthYear) return { day: null, month: MONTHS[monthOnly.toLowerCase()], year: Number(monthYear) };
  // Day first, as New Zealand writes dates.
  if (slashDay && slashMonth && slashYear) return { day: Number(slashDay), month: Number(slashMonth), year: fullYear(slashYear) };
  if (isoYear && isoMonth && isoDay) return { day: Number(isoDay), month: Number(isoMonth), year: Number(isoYear) };
  if (bareMonth) return { day: null, month: MONTHS[bareMonth.toLowerCase()], year: null };
  return null;
}

/** "1 Jan 2027 to 31 Dec 2027", "01/07/2026 - 30/06/2027", "Jul 2026 to Jun 2027", "1 July to 30 June 2027". */
function rangeIn(text: string): SuggestedPeriod | null {
  const found = RANGE.exec(text);
  if (!found) return null;
  const from = written(found.slice(1, 13));
  const to = written(found.slice(13, 25));
  if (!from || !to || to.year === null) return null;
  // A start with no year is in the end's year, or the year before when its month comes later ("Jul to Jun 2027").
  const fromYear = from.year ?? (from.month > to.month ? to.year - 1 : to.year);
  const startDate = iso(fromYear, from.month, from.day ?? 1);
  const endDate = iso(to.year, to.month, to.day ?? lastDay(to.year, to.month));
  if (!startDate || !endDate || endDate <= startDate) return null;
  return { startDate, endDate, because: found[0].trim() };
}

const LENGTHS: Array<{ pattern: RegExp; months: (found: RegExpExecArray) => number }> = [
  { pattern: /\b(\d{1,2}|one|two|three|four|five|six|twelve|eighteen)[\s-]*(month|year|yr)s?\b/i, months: (found) => (NUMBER_WORDS[found[1].toLowerCase()] ?? Number(found[1])) * (found[2].toLowerCase() === "month" ? 1 : 12) },
  { pattern: /\b(annual(?:ly)?|yearly|per annum|p\.a\.)(?=\W|$)/i, months: () => 12 },
  { pattern: /\b(half[\s-]?year(?:ly)?|six[\s-]?monthly|6[\s-]?monthly|bi-?annual(?:ly)?)\b/i, months: () => 6 },
  { pattern: /\b(quarter(?:ly)?)\b/i, months: () => 3 },
];

function dayBefore(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

/** "Annual licence", "12 months", "quarterly": that long, from the document's own date. */
function lengthIn(text: string, documentDate: string): SuggestedPeriod | null {
  for (const { pattern, months } of LENGTHS) {
    const found = pattern.exec(text);
    if (!found) continue;
    const count = months(found);
    if (!Number.isInteger(count) || count < 2 || count > 60) continue;
    // The same day so many months on, less a day: 15 Mar 2026 for 12 months ends 14 Mar 2027.
    const [year, month, day] = documentDate.split("-").map(Number);
    const endMonth = addMonths(`${year}-${pad(month)}`, count);
    const [endYear, endMonthNumber] = endMonth.split("-").map(Number);
    const sameDay = iso(endYear, endMonthNumber, Math.min(day, lastDay(endYear, endMonthNumber)));
    if (!sameDay) return null;
    return { startDate: documentDate, endDate: dayBefore(sameDay), because: found[0].trim() };
  }
  return null;
}

/**
 * The period a line's words say it covers (SW26), or null when they don't
 * say, or say one month or less (nothing to spread). A written range wins
 * over a length.
 */
export function periodFromText(text: string, documentDate: string): SuggestedPeriod | null {
  const period = rangeIn(text) ?? lengthIn(text, documentDate);
  if (!period) return null;
  const months = monthsBegun(period.startDate, period.endDate).length;
  if (months < 2 || months > 120) return null;
  return period;
}

/** How many months back a supplier must have billed, every one, to count as billing monthly (SW27). */
export const RECURRING_MONTHS = 3;

/**
 * The usual amount for a supplier who billed an account in each of the
 * `RECURRING_MONTHS` months before `month` and hasn't in `month` (SW27):
 * the plain average of those months, in cents. Null when any of them is
 * missing or the month already has a bill.
 */
export function usualAmount(byMonth: ReadonlyMap<string, number>, month: string): number | null {
  if ((byMonth.get(month) ?? 0) !== 0) return null;
  let total = 0;
  for (let back = 1; back <= RECURRING_MONTHS; back += 1) {
    const cents = byMonth.get(addMonths(month, -back)) ?? 0;
    if (cents <= 0) return null;
    total += cents;
  }
  return Math.round(total / RECURRING_MONTHS);
}
