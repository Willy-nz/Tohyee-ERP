import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError,ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { assertSameRequest,requestHash } from "@/lib/idempotency";
import {
dec,isPositive
} from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import type { PayFrequency } from "@/lib/payroll/groups";
import {
lineAmount,
ordinaryHoursForPeriod,
payPeriodEnd,
salaryForPeriod
} from "@/lib/payroll/pay-calculation";
import { payRunReference } from "@/lib/payroll/pay-run-reference";
import { updateEmployeeLeave } from "@/lib/payroll/leave-pay-runs";
import { NOT_SUPPORTED,payrollRatesOn } from "@/lib/payroll/rates";
import { timesheetCoverage } from "@/lib/payroll/timesheets";
import { optionalSource,requireIdempotencyKey } from "@/lib/validation";
import { GroupEmployee,PayRun } from "@/lib/payroll/pay-runs/types";
import { periodRefusal,rateForPeriod } from "@/lib/payroll/pay-runs/calculation";
import { UUID_PATTERN,findRun,isUniqueViolation,toDraftRun } from "@/lib/payroll/pay-runs/rows";
import { getPayRun } from "@/lib/payroll/pay-runs/read";
export { type ExtraPayBasis, type PayRun, type PayRunEmployee, type PayRunLeave, type PayRunLine, type PayRunPosting, type PayRunStatus, type PayRunSummary, type PayRunTimesheets, type PayRunTotals } from "@/lib/payroll/pay-runs/types";
export { getPayRun, listPayRuns } from "@/lib/payroll/pay-runs/read";
export { addBackPay, removeBackPay, removePayRunEmployee, setPayRunEmployeeLines, updatePayRunLeave } from "@/lib/payroll/pay-runs/lines";
export { approvePayRun, ESCT_ACCOUNT, KIWISAVER_ACCOUNT, listPayRunPostings, PAYE_ACCOUNT, STUDENT_LOAN_ACCOUNT, voidPayRun, WAGES_ACCOUNT } from "@/lib/payroll/pay-runs/posting";

export { payRunReference };

async function ordinaryTimeItem(tx: OrgTx): Promise<string> {
  const result = await tx.query<{ id: string }>("select id from payroll_pay_items where is_system and kind = 'ordinary_time'");
  if (!result.rows[0]) throw new ValidationError("There's no Ordinary time pay item. Set up pay items under Payroll › Pay items.");
  return result.rows[0].id;
}

/**
 * Creates a draft pay run (PRUN11): a line of Ordinary time for each
 * employee in the pay group who is paid in the period. Someone finishing
 * inside the period gets their final pay: hourly, 0 hours to
 * fill in unless approved timesheets cover every day to the finish date.
 * Refuses (PRUN8) a pay group where someone on a salary starts after the
 * period starts or finishes before it ends, or a pay rate changes inside
 * the period.
 */
export async function createPayRun(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; payGroupId: unknown; periodStart: unknown; payDate: unknown },
): Promise<{ created: boolean; payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash("payroll_pay_run", { payGroupId: input.payGroupId, periodStart: input.periodStart, payDate: input.payDate });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>(
      "select id, request_hash from payroll_pay_runs where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "pay run");
    return { created: false, payRun: await getPayRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const groupId = typeof input.payGroupId === "string" && UUID_PATTERN.test(input.payGroupId) ? input.payGroupId : null;
  if (!groupId) throw new ValidationError("Choose a pay group.");
  // One pay run at a time per pay group, so two people can't create overlapping runs.
  const group = await tx.query<{ name: string; pay_frequency: PayFrequency; is_archived: boolean }>(
    "select name, pay_frequency, is_archived from payroll_pay_groups where id = $1 for update",
    [groupId],
  );
  if (!group.rows[0]) throw new ValidationError("That pay group wasn't found.");
  const { name: groupName, pay_frequency: frequency, is_archived: archived } = group.rows[0];
  if (archived) throw new ValidationError(`${groupName} is archived.`);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;

  const periodStart = parseIsoDate(input.periodStart, "Period start");
  const payDate = parseIsoDate(input.payDate, "Pay date");
  const periodEnd = payPeriodEnd(periodStart, frequency);
  if (payDate < periodStart) throw new ValidationError(`The pay date can't be before the pay period starts (${periodStart}).`);
  payrollRatesOn(payDate);

  const overlap = await tx.query<{ run_number: string; period_start: string; period_end: string }>(
    `select run_number::text, period_start::text, period_end::text from payroll_pay_runs
      where pay_group_id = $1 and status <> 'voided' and period_start <= $3 and period_end >= $2
      order by period_start limit 1`,
    [groupId, periodStart, periodEnd],
  );
  if (overlap.rows[0]) {
    const other = overlap.rows[0];
    throw new ConflictError(
      `${payRunReference(other.run_number)} already pays ${groupName} for ${other.period_start} to ${other.period_end}. Void it first to run that pay again.`,
    );
  }

  const employees = await tx.query<GroupEmployee>(
    `select id, first_name || ' ' || last_name as name, start_date::text, finish_date::text
       from payroll_employees
      where pay_group_id = $1 and not is_archived and start_date <= $3 and (finish_date is null or finish_date >= $2)
      order by lower(last_name), lower(first_name), id`,
    [groupId, periodStart, periodEnd],
  );
  if (employees.rows.length === 0) throw new ValidationError(`Nobody in ${groupName} is paid for ${periodStart} to ${periodEnd}.`);
  const ordinaryTime = await ordinaryTimeItem(tx);

  const drafts: Array<{ employeeId: string; quantity: string | null; rate: string | null; amount: string; description: string | null }> = [];
  for (const employee of employees.rows) {
    const rate = await rateForPeriod(tx, employee.id, periodStart, employee.start_date);
    if (!rate) throw new ValidationError(`${employee.name} has no pay rate for ${periodStart}. Add one under Employees.`);
    if (rate.payBasis === "salary" && employee.start_date > periodStart) {
      throw new ValidationError(
        `${NOT_SUPPORTED}: part of a pay period on a salary. ${employee.name} starts on ${employee.start_date}, after the period starts.`,
      );
    }
    const refused = await periodRefusal(tx, employee, periodStart, periodEnd);
    if (refused) throw new ValidationError(refused);
    if (rate.payBasis === "salary") {
      drafts.push({ employeeId: employee.id, quantity: null, rate: null, amount: salaryForPeriod(rate.annualSalary!, frequency), description: null });
    } else {
      // Approved timesheets covering every day of the period give the hours (TS8); someone finishing
      // before the period ends starts at 0 hours unless timesheets cover every day to their finish date.
      const leavesEarly = employee.finish_date !== null && employee.finish_date < periodEnd;
      const coverage = await timesheetCoverage(tx, employee.id, periodStart, leavesEarly ? employee.finish_date! : periodEnd);
      const fromTimesheets = coverage.allDaysCovered && isPositive(dec(coverage.totalHours));
      const hours = fromTimesheets ? coverage.totalHours : leavesEarly ? "0.00" : ordinaryHoursForPeriod(rate.ordinaryHoursPerWeek!, frequency);
      drafts.push({
        employeeId: employee.id,
        quantity: hours,
        rate: rate.hourlyRate!,
        amount: lineAmount(hours, rate.hourlyRate!),
        description: fromTimesheets
          ? "From approved timesheets"
          : leavesEarly
            ? `Final pay: enter the hours worked to ${formatDate(employee.finish_date)}`
            : null,
      });
    }
  }

  let runId: string | undefined;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into payroll_pay_runs (
         command_source, idempotency_key, request_hash, pay_group_id, pay_frequency, period_start, period_end, pay_date,
         created_by_user_id, created_by_email, prepared_by_user_ids
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $9::uuid is null then '{}'::uuid[] else array[$9::uuid] end)
       on conflict (command_source, idempotency_key) do nothing returning id`,
      [source, idempotencyKey, hash, groupId, frequency, periodStart, periodEnd, payDate, tx.actor.userId, tx.actor.email],
    );
    runId = inserted.rows[0]?.id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a pay run for ${groupName} starting ${periodStart}.`);
    throw error;
  }
  if (!runId) {
    const winner = await replay();
    if (winner) return winner;
    throw new ConflictError("The pay run couldn't be saved. Try again with a new idempotency key.");
  }
  for (const draft of drafts) {
    await tx.query("insert into payroll_pay_run_employees (pay_run_id, employee_id) values ($1, $2)", [runId, draft.employeeId]);
    await tx.query(
      `insert into payroll_pay_run_lines (pay_run_id, employee_id, line_number, pay_item_id, quantity, rate, amount, description)
       values ($1, $2, 1, $3, $4, $5, $6, $7)`,
      [runId, draft.employeeId, ordinaryTime, draft.quantity, draft.rate, draft.amount, draft.description],
    );
  }
  // Leave and the usual pay from the usual week, for employees whose leave Tohyee keeps (P8).
  const created = await findRun(tx, runId);
  for (const draft of drafts) await updateEmployeeLeave(tx, toDraftRun(created), draft.employeeId, { initial: true });
  const payRun = await getPayRun(tx, runId);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.created",
    entityType: "payroll_pay_run",
    entityId: runId,
    details: { reference: payRun.reference, payGroupId: groupId, periodStart, periodEnd, payDate, employeeCount: drafts.length },
  });
  return { created: true, payRun };
}

/** Deletes a draft (PRUN11). Approved and voided pay runs are kept. */
export async function deletePayRun(tx: OrgTx, runIdInput: unknown): Promise<{ deleted: true }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  if (run.status !== "draft") {
    throw new ConflictError(`${payRunReference(run.run_number)} is ${run.status}, so it can't be deleted.${run.status === "approved" ? " Void it instead." : ""}`);
  }
  await tx.query("delete from payroll_pay_run_lines where pay_run_id = $1", [run.id]);
  await tx.query("delete from payroll_pay_run_employees where pay_run_id = $1", [run.id]);
  await tx.query("delete from payroll_pay_runs where id = $1", [run.id]);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.deleted",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number) },
  });
  return { deleted: true };
}
