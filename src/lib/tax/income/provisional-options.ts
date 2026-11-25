import { addDays, monthEndOf } from "@/lib/financial-year";
import { add, cmp, dec, type Decimal, divide, isNegative, mul, roundHalfUp, sub, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  finishSchedule,
  incomeYearDates,
  instalmentDate,
  instalmentDates,
  type InstalmentWorking,
  moneyText,
  type Payment,
  type ProvisionalSchedule,
  shortDate,
} from "@/lib/tax/income/rules";
import { type Requirement, requirements } from "@/lib/tax/income/uomi";

/*
 * Provisional tax options other than standard (examples TXF14-TXF17). Pure and browser-safe. From the Income Tax Act
 * 2007 ss RC 7-RC 18 and IRD's pages on the estimation, ratio and AIM options, payment dates and interest on
 * provisional tax, read 26 Nov 2026 through a summarising fetch tool; following common practice, not yet reviewed.
 */

export const PROVISIONAL_OPTIONS = ["standard", "estimation", "ratio", "aim"] as const;
export type ProvisionalOption = (typeof PROVISIONAL_OPTIONS)[number];
export const PROVISIONAL_OPTION_LABELS: Record<ProvisionalOption, string> = {
  standard: "Standard option",
  estimation: "Estimation option",
  ratio: "Ratio option",
  aim: "AIM, through other software",
};

/** IRD's limits for the ratio option: last year's RIT more than this and no more than the next (s RC 16(2)(a)). */
export const RATIO_RIT_FROM = dec("5000");
export const RATIO_RIT_TO = dec("150000");

export type Estimate = { estimatedOn: string; amount: Decimal };

/**
 * The estimation option's instalments (TXF15, s RC 10): (the estimate in force × the instalment's number ÷ the
 * number of instalments) less the provisional tax for the earlier instalments. An estimate counts for an instalment
 * when it's made on or before its date (s RC 7(3)). An instalment before the first estimate keeps the standard
 * option's amount (`standardTargets`, cumulative), or nothing can be worked out without them.
 */
export function estimationSchedule(input: {
  year: number;
  instalmentCount: 2 | 3;
  estimates: Estimate[];
  standardTargets: Decimal[] | null;
  payments: Payment[];
  today: string;
  endMonth?: number;
}): ProvisionalSchedule {
  const sorted = [...input.estimates].sort((a, b) => a.estimatedOn.localeCompare(b.estimatedOn));
  if (sorted.length === 0) {
    return { kind: "unknown", notes: ["Type the estimate of this year's residual income tax (RIT) you gave IRD, and the date you gave it."] };
  }
  const dates = instalmentDates(input.year, input.instalmentCount, input.endMonth ?? 3);
  const count = dates.length;
  const amounts: InstalmentWorking[] = [];
  let previous = ZERO_DECIMAL;
  for (let index = 0; index < count; index += 1) {
    const inForce = sorted.filter((estimate) => estimate.estimatedOn <= dates[index]).at(-1);
    let target: Decimal;
    let basis: string;
    if (!inForce) {
      const standard = input.standardTargets?.[index];
      if (standard === undefined) {
        return {
          kind: "unknown",
          notes: [`The first estimate was made after instalment ${index + 1} (${shortDate(dates[index])}), so that instalment was under the standard option, which Tohyee can't work out here. Type last year's RIT from IRD's assessment.`],
        };
      }
      target = standard;
      basis = `Before the first estimate: the standard option's amount`;
    } else {
      const number = index + 1;
      target = number === count ? inForce.amount : divide(mul(inForce.amount, dec(String(number))), dec(String(count)), 2);
      basis = `Estimate ${moneyText(inForce.amount)} (made ${shortDate(inForce.estimatedOn)}) × ${number} ÷ ${count} = ${moneyText(target)}${index > 0 ? `, less ${moneyText(previous)} for the earlier instalments` : ""}`;
    }
    amounts.push({ target, due: sub(target, previous), basis, estimate: false, assumption: null });
    previous = target;
  }
  const notes = [
    "An estimate must be fair and reasonable, and made again if it stops being so (s RC 7). You can estimate again on or before each instalment date, up to the last one.",
  ];
  if (amounts.some((entry) => isNegative(entry.due))) notes.push("A lower estimate makes an instalment nil; what's already paid over the new figure is a credit.");
  return finishSchedule({ dates, amounts, payments: input.payments, notes });
}

export type RatioPeriod = { number: number; dueDate: string; periodStart: string; periodEnd: string };

/**
 * The ratio option's six instalments and the two months each is for (TXF16): with a 31 March balance date, 28 Jun,
 * 28 Aug, 28 Oct, 15 Jan, 28 Feb and 7 May (IRD's payment dates), each for the two months ending the month before.
 * Only 31 March is checked; other balance dates are refused where the option is chosen.
 */
export function ratioInstalmentPeriods(year: number, endMonth = 3): RatioPeriod[] {
  const previous = addDays(incomeYearDates(year, endMonth).start, -1);
  return [3, 5, 7, 9, 11, 13].map((months, index) => {
    const periodEnd = monthEndOf(addMonths(previous, months - 1));
    const periodStart = `${addMonths(previous, months - 2).slice(0, 7)}-01`;
    return { number: index + 1, dueDate: instalmentDate(previous, months), periodStart, periodEnd };
  });
}

/** The first day of the month `count` months after a date's month. */
function addMonths(date: string, count: number): string {
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

export type RatioSupplies = RatioPeriod & {
  /** GST return Box 5 for the two months (sales including GST and zero-rated sales), or null when not known yet. */
  box5: Decimal | null;
  source: "filed" | "books" | null;
};

/**
 * The ratio option's instalments (TXF16, s RC 11): IRD's ratio × total taxable supplies (GST included) for the two
 * months, rounded to the cent. A period that hasn't ended isn't known yet. A negative Box 5 gives nil (IRD's rule for
 * it isn't checked, and the note says so).
 */
export function ratioSchedule(input: { year: number; ratioPercent: Decimal; supplies: RatioSupplies[]; payments: Payment[]; today: string }): ProvisionalSchedule {
  const percent = toPlainString(input.ratioPercent);
  const notes: string[] = [];
  const amounts: InstalmentWorking[] = [];
  let total = ZERO_DECIMAL;
  for (const period of input.supplies) {
    const months = `${shortDate(period.periodStart)} to ${shortDate(period.periodEnd)}`;
    if (period.box5 === null) {
      amounts.push({ target: total, due: ZERO_DECIMAL, basis: `Not known until the GST period ${months} ends`, estimate: false, assumption: null, notKnownYet: true });
      continue;
    }
    let own = roundHalfUp(divide(mul(input.ratioPercent, period.box5), dec("100"), 6), 2);
    if (isNegative(own)) {
      notes.push(`Box 5 for ${months} is negative, so Tohyee shows that instalment as nil. IRD's rule for a negative period isn't checked: ask IRD or your tax agent.`);
      own = ZERO_DECIMAL;
    }
    total = add(total, own);
    const from = period.source === "filed" ? "the filed GST return" : "the books (GST return not filed yet)";
    amounts.push({ target: total, due: own, basis: `${percent}% × ${moneyText(period.box5)} (Box 5 for ${months}, from ${from}) = ${moneyText(own)}`, estimate: period.source !== "filed", assumption: null });
  }
  notes.push("Paid in full and on time, ratio instalments bring no use-of-money interest. Late or short ones can bring penalties and interest, which Tohyee doesn't estimate.");
  return finishSchedule({ dates: input.supplies.map((period) => period.dueDate), amounts, payments: input.payments, notes });
}

/**
 * What must be paid by when, for the interest estimate, under each option (TXF15-TXF17; IRD "Interest on provisional
 * tax"): standard as before (ITX45-ITX48); estimation, the year's RIT in equal shares by each instalment date with no
 * $60,000 rule; ratio, all of it by the end-of-year date; AIM, nothing Tohyee can work out (null).
 */
export function optionRequirements(input: {
  option: ProvisionalOption;
  rit: Decimal;
  /** The dates instalments are on time by. */
  instalmentDates: string[];
  standardInstalments: Array<{ due: string; amount: Decimal }> | null;
  endOfYearDue: string | null;
}): Requirement[] | null {
  if (input.option === "aim") return null;
  if (input.option === "standard") return requirements({ rit: input.rit, instalments: input.standardInstalments, endOfYearDue: input.endOfYearDue });
  if (!(cmp(input.rit, ZERO_DECIMAL) > 0)) return [];
  if (input.option === "ratio" || input.instalmentDates.length === 0) return input.endOfYearDue ? [{ due: input.endOfYearDue, amount: input.rit }] : [];
  const count = input.instalmentDates.length;
  const share = divide(input.rit, dec(String(count)), 2);
  return input.instalmentDates.map((due, index) => ({ due, amount: index === count - 1 ? sub(input.rit, mul(share, dec(String(count - 1)))) : share }));
}
