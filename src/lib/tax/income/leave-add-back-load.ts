import type { OrgTx } from "@/lib/db/org-transaction";
import { dec } from "@/lib/money/decimal";
import { leaveLiabilityAccountIds } from "@/lib/payroll/pay-items";
import { type LeaveAddBack, leaveAddBack } from "@/lib/tax/income/leave-add-back";

/** Loads the suggestion for an income year from the employee entitlements account and the adjustments. */
export async function loadLeaveAddBack(
  tx: OrgTx,
  input: { yearEnd: string; lastYearAdjustments: ReadonlyArray<{ description: string; amount: string }>; thisYearAdjustments: ReadonlyArray<{ description: string; amount: string }> },
): Promise<LeaveAddBack | null> {
  const { liabilityAccountId } = await leaveLiabilityAccountIds(tx);
  if (!liabilityAccountId) return null;
  const result = await tx.query<{ code: string; name: string; balance: string }>(
    `select a.code, coalesce(a.reporting_name, a.name) as name,
            coalesce((select sum(l.credit_amount) - sum(l.debit_amount)
                        from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
                       where l.account_id = a.id and j.posting_date <= $2::date), 0)::text as balance
       from accounts a where a.id = $1`,
    [liabilityAccountId, input.yearEnd],
  );
  const row = result.rows[0];
  if (!row) return null;
  const toDec = (list: ReadonlyArray<{ description: string; amount: string }>) => list.map((entry) => ({ description: entry.description, amount: dec(entry.amount) }));
  return leaveAddBack({
    account: { code: row.code, name: row.name },
    yearEnd: input.yearEnd,
    owedAtYearEnd: dec(row.balance),
    lastYearAdjustments: toDec(input.lastYearAdjustments),
    thisYearAdjustments: toDec(input.thisYearAdjustments),
  });
}
