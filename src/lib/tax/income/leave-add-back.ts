import { addDays } from "@/lib/financial-year";
import { add, cmp, dec, type Decimal, isPositive, isZero, neg, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { money } from "@/lib/tax/income/rules";

/*
 * Accrued leave and the 63-day rule (TXF4; Income Tax Act 2007 s EA 4, CH 3
 * and DB 51; following common practice, not yet reviewed). Leave owed at
 * balance date is employment income not yet paid. What isn't paid by the
 * 63rd day after balance date is added back this year and deducted next
 * year. Tohyee only suggests the figures: a person checks them and adds
 * them as adjustments. Nothing is added by itself.
 */

/** The description of this year's add-back adjustment. Next year finds it by this. */
export const LEAVE_ADD_BACK_LABEL = "Leave owed at balance date and not paid within 63 days, added back (s EA 4)";
/** The description of the deduction next year for last year's add-back. */
export const LEAVE_REVERSAL_LABEL = "Last year's leave add-back, deducted now (s DB 51)";

export type LeaveAddBack = {
  accountCode: string;
  accountName: string;
  yearEnd: string;
  /** The 63rd day after balance date: leave paid by then can stay deducted. */
  payBy: string;
  /** The employee entitlements account's balance at balance date (credit positive). */
  owedAtYearEnd: string;
  /** What last year's add-back adjustments came to: deducted this year. */
  lastYearAddBack: string;
  /** Already among this year's adjustments. */
  addBackAdded: boolean;
  reversalAdded: boolean;
};

/** The suggestion, or null when there's nothing owed and nothing from last year. Pure. */
export function leaveAddBack(input: {
  account: { code: string; name: string };
  yearEnd: string;
  owedAtYearEnd: Decimal;
  lastYearAdjustments: ReadonlyArray<{ description: string; amount: Decimal }>;
  thisYearAdjustments: ReadonlyArray<{ description: string; amount: Decimal }>;
}): LeaveAddBack | null {
  const lastYearAddBack = input.lastYearAdjustments.filter((entry) => entry.description.startsWith(LEAVE_ADD_BACK_LABEL)).reduce((sum, entry) => add(sum, entry.amount), ZERO_DECIMAL);
  if (!isPositive(input.owedAtYearEnd) && isZero(lastYearAddBack)) return null;
  return {
    accountCode: input.account.code,
    accountName: input.account.name,
    yearEnd: input.yearEnd,
    payBy: addDays(input.yearEnd, 63),
    owedAtYearEnd: money(isPositive(input.owedAtYearEnd) ? input.owedAtYearEnd : ZERO_DECIMAL),
    lastYearAddBack: money(lastYearAddBack),
    addBackAdded: input.thisYearAdjustments.some((entry) => entry.description.startsWith(LEAVE_ADD_BACK_LABEL)),
    reversalAdded: input.thisYearAdjustments.some((entry) => entry.description.startsWith(LEAVE_REVERSAL_LABEL)),
  };
}

/** The add-back for leave owed less what was paid by the 63rd day; never below nil or above what was owed. */
export function addBackAmount(owedAtYearEnd: Decimal, paidBy63Days: Decimal): Decimal {
  if (cmp(paidBy63Days, owedAtYearEnd) >= 0) return ZERO_DECIMAL;
  return isPositive(paidBy63Days) ? sub(owedAtYearEnd, paidBy63Days) : owedAtYearEnd;
}

/** Notes for the workpaper while a suggested adjustment hasn't been added. */
export function leaveAddBackNotes(suggestion: LeaveAddBack | null): string[] {
  if (!suggestion) return [];
  const notes: string[] = [];
  if (isPositive(dec(suggestion.owedAtYearEnd)) && !suggestion.addBackAdded) {
    notes.push(
      `Account ${suggestion.accountCode} ${suggestion.accountName} shows ${suggestion.owedAtYearEnd} of leave owed at ${suggestion.yearEnd}. It's deducted in full here. Leave not paid by ${suggestion.payBy} (63 days after balance date) isn't deductible until next year (Income Tax Act 2007 s EA 4). Check what was paid by then and add the rest back under Leave owed at balance date. Tohyee doesn't add it by itself.`,
    );
  }
  if (isPositive(dec(suggestion.lastYearAddBack)) && !suggestion.reversalAdded) {
    notes.push(`Last year's workpaper added back ${suggestion.lastYearAddBack} of leave not paid within 63 days. It's deductible this year (s DB 51): add it under Leave owed at balance date.`);
  }
  return notes;
}

/** The adjustment that deducts last year's add-back. */
export function reversalAmount(suggestion: LeaveAddBack): Decimal {
  return neg(dec(suggestion.lastYearAddBack));
}
