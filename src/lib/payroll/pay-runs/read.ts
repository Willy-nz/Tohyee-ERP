import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import {
dec,toFixedString
} from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { PayRun,PayRunSummary,PayRunTimesheets } from "@/lib/payroll/pay-runs/types";
import { calculateRun,coverageFor,notesFor,rateForPeriod,toLine,toPayRunTimesheets,totalsOf,trimRate } from "@/lib/payroll/pay-runs/calculation";
import { RUN_COLUMNS,RUN_FROM,RunRow,approverMustDiffer,findRun,toSummary } from "@/lib/payroll/pay-runs/rows";

export async function getPayRun(tx: OrgTx, idInput: unknown): Promise<PayRun> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, idInput);
  const calculated = await calculateRun(tx, run);
  const hourly = new Map<string, string | null>();
  const timesheets = new Map<string, PayRunTimesheets | null>();
  for (const entry of calculated) {
    timesheets.set(entry.employee.employee_id, toPayRunTimesheets(await coverageFor(tx, run, entry.employee.employee_id)));
  }
  if (run.status === "draft") {
    for (const entry of calculated) {
      const rate = await rateForPeriod(tx, entry.employee.employee_id, run.period_start, entry.employee.start_date);
      hourly.set(entry.employee.employee_id, rate?.payBasis === "hourly" && rate.hourlyRate ? trimRate(rate.hourlyRate) : null);
    }
  }
  return {
    ...toSummary(run),
    approvalJournalId: run.approval_journal_id,
    voidJournalId: run.void_journal_id,
    inBooks: run.in_books,
    preparedByMe: tx.actor.userId !== null && run.prepared_by_user_ids.includes(tx.actor.userId),
    approverMustDiffer: await approverMustDiffer(tx),
    employees: calculated.map((entry) => ({
      employeeId: entry.employee.employee_id,
      name: entry.employee.name,
      taxCode: entry.employee.tax_code,
      studentLoan: entry.employee.student_loan,
      kiwiSaverStatus: entry.employee.kiwisaver_status,
      kiwiSaverEmployeeRate: toFixedString(dec(entry.employee.kiwisaver_employee_rate), 2),
      kiwiSaverEmployerRate: toFixedString(dec(entry.employee.kiwisaver_employer_rate), 2),
      esctRate: entry.employee.esct_rate === null ? null : toFixedString(dec(entry.employee.esct_rate), 2),
      hourlyRate: hourly.get(entry.employee.employee_id) ?? null,
      lines: entry.lines.map(toLine),
      pay: entry.pay,
      problem: entry.problem,
      timesheets: timesheets.get(entry.employee.employee_id) ?? null,
      finishDate: entry.finishDate,
      extraPayBasis: entry.basis,
      notes: notesFor(entry.finishDate, entry.pay, entry.basis, entry.lines, entry.employee.leave_notes, entry.employee.name),
    })),
    totals: totalsOf(calculated),
    problemCount: calculated.filter((entry) => entry.problem !== null).length,
  };
}

export async function listPayRuns(tx: OrgTx, options: { status?: unknown } = {}): Promise<PayRunSummary[]> {
  await requirePayrollAccess(tx);
  const status = options.status;
  if (status !== undefined && status !== null && status !== "" && status !== "draft" && status !== "approved" && status !== "voided") {
    throw new ValidationError('status must be "draft", "approved" or "voided".');
  }
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from ${RUN_FROM}
      where ($1::text is null or r.status = $1)
      order by r.pay_date desc, r.run_number desc
      limit 500`,
    [status || null],
  );
  return result.rows.map(toSummary);
}
