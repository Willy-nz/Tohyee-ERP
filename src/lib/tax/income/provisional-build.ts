import type { OrgTx } from "@/lib/db/org-transaction";
import { add, dec, type Decimal, ZERO_DECIMAL } from "@/lib/money/decimal";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { getProvisionalOption, type ProvisionalOptionSetting } from "@/lib/tax/income/provisional-option-store";
import { estimationSchedule, type RatioSupplies, ratioInstalmentPeriods, ratioSchedule } from "@/lib/tax/income/provisional-options";
import type { Payment, ProvisionalSchedule, TaxpayerType } from "@/lib/tax/income/rules";

/*
 * The year's provisional tax under the option chosen for it (TXF14-TXF17): the standard schedule as before, or the
 * estimation, ratio or AIM option instead.
 */

export const AIM_NOTE =
  "This income year uses AIM through other software. Your AIM software works out these instalments; Tohyee doesn't, so it shows no instalments and no interest estimate for them.";

/** The standard schedule's cumulative targets, for instalments before the first estimate (TXF15). */
function standardTargets(standard: ProvisionalSchedule, count: number): Decimal[] | null {
  if (standard.kind === "not_provisional") return Array.from({ length: count }, () => ZERO_DECIMAL);
  if (standard.kind !== "schedule") return null;
  let total = ZERO_DECIMAL;
  return standard.instalments.map((entry) => (total = add(total, dec(entry.ownAmount))));
}

/** GST return Box 5 for a ratio instalment's two months (TXF16): filed returns where there are any, else the books. */
async function supplies(tx: OrgTx, periods: ReturnType<typeof ratioInstalmentPeriods>, today: string): Promise<RatioSupplies[]> {
  const setting = await tx.query<{ gst_period_months: number | null }>("select gst_period_months from organisation_settings where id = true");
  const months = setting.rows[0]?.gst_period_months === 1 ? 1 : 2;
  const result: RatioSupplies[] = [];
  for (const period of periods) {
    if (period.periodEnd >= today) {
      result.push({ ...period, box5: null, source: null });
      continue;
    }
    const chunks = months === 2 ? [[period.periodStart, period.periodEnd]] : [[period.periodStart, `${period.periodStart.slice(0, 7)}-${lastDay(period.periodStart)}`], [`${period.periodEnd.slice(0, 7)}-01`, period.periodEnd]];
    let box5 = ZERO_DECIMAL;
    let allFiled = true;
    for (const [start, end] of chunks) {
      const filed = await tx.query<{ box5: string }>("select box5::text from gst_returns where period_start = $1 and period_end = $2", [start, end]);
      if (filed.rows[0]) box5 = add(box5, dec(filed.rows[0].box5));
      else {
        allFiled = false;
        box5 = add(box5, dec((await calculateGstReturn(tx, { periodStart: start, periodEnd: end })).boxes.box5));
      }
    }
    result.push({ ...period, box5, source: allFiled ? "filed" : "books" });
  }
  return result;
}

function lastDay(monthStart: string): string {
  const [year, month] = monthStart.split("-").map(Number);
  return String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0");
}

/** The schedule for the option chosen for the year, and the notes that go with it (TXF14-TXF17). */
export async function provisionalForYear(
  tx: OrgTx,
  input: { incomeYear: number; endMonth: number; today: string; instalmentCount: 2 | 3; standard: ProvisionalSchedule; payments: Payment[]; type: TaxpayerType },
): Promise<{ setting: ProvisionalOptionSetting; schedule: ProvisionalSchedule }> {
  const setting = await getProvisionalOption(tx, input.incomeYear);
  const told = "Choosing an option in Tohyee doesn't tell IRD: choose it with IRD too.";
  switch (setting.option) {
    case "standard":
      return { setting, schedule: input.standard };
    case "estimation": {
      const schedule = estimationSchedule({
        year: input.incomeYear,
        instalmentCount: input.instalmentCount,
        estimates: setting.estimates.map((entry) => ({ estimatedOn: entry.estimatedOn, amount: dec(entry.amount) })),
        standardTargets: standardTargets(input.standard, input.instalmentCount),
        payments: input.payments,
        today: input.today,
        endMonth: input.endMonth,
      });
      return { setting, schedule: { ...schedule, notes: [...schedule.notes, told] } };
    }
    case "ratio": {
      const periods = ratioInstalmentPeriods(input.incomeYear, input.endMonth);
      const schedule = ratioSchedule({ year: input.incomeYear, ratioPercent: dec(setting.ratioPercent ?? "0"), supplies: await supplies(tx, periods, input.today), payments: input.payments, today: input.today });
      return {
        setting,
        schedule: { ...schedule, notes: [...schedule.notes, "You must stop using the ratio option if a GST return is 60 or more days late, your registration ends or you move to six-monthly GST (s RC 17).", told] },
      };
    }
    case "aim": {
      const notes = [AIM_NOTE, "IRD's AIM page says AIM is for individuals and companies with turnover under $5 million, using AIM-capable software. IRD moves AIM users back to the standard option at the start of each year unless they choose AIM again."];
      if (input.type === "trust") notes.push("This is a trust: IRD's AIM page describes AIM for individuals and companies. Check that it applies.");
      return { setting, schedule: { kind: "other_software", notes } };
    }
  }
}
