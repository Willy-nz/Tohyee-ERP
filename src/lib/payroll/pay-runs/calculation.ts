import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { formatDate,formatMoney } from "@/lib/format";
import {
add,dec,isPositive,toFixedString,
toPlainString,
ZERO_DECIMAL
} from "@/lib/money/decimal";
import { annualiseForExtraPay,type ExtraPayMethod } from "@/lib/payroll/calculations";
import type { PayFrequency } from "@/lib/payroll/groups";
import {
calculateEmployeePay,
calculationFrequency,
type EmployeePayResult,
type KiwiSaverStatus
} from "@/lib/payroll/pay-calculation";
import {
EXTRA_PAY_KINDS,type PayItemCategory,
type PayItemKind,TERMINATION_KINDS
} from "@/lib/payroll/pay-items";
import { payRateOn } from "@/lib/payroll/pay-rates";
import { payRunReference } from "@/lib/payroll/pay-run-reference";
import { NOT_SUPPORTED } from "@/lib/payroll/rates";
import { timesheetCoverage,type TimesheetCoverage } from "@/lib/payroll/timesheets";
import { ExtraPayBasis,GroupEmployee,PayRunLine,PayRunTimesheets,PayRunTotals } from "@/lib/payroll/pay-runs/types";
import { RunRow } from "@/lib/payroll/pay-runs/rows";

export function toPayRunTimesheets(coverage: TimesheetCoverage): PayRunTimesheets | null {
  if (coverage.timesheetIds.length === 0) return null;
  return {
    count: coverage.timesheetIds.length,
    coveredDays: coverage.coveredDays,
    periodDays: coverage.periodDays,
    hours: coverage.totalHours,
    allDaysCovered: coverage.allDaysCovered,
  };
}

/** The approved timesheets for an employee's pay period: live on a draft, the ones it used once approved. */
export async function coverageFor(tx: OrgTx, run: RunRow, employeeId: string): Promise<TimesheetCoverage> {
  if (run.status === "draft") return timesheetCoverage(tx, employeeId, run.period_start, run.period_end);
  const used = await tx.query<{ timesheet_id: string }>(
    `select l.timesheet_id from payroll_pay_run_timesheets l join payroll_timesheets t on t.id = l.timesheet_id
      where l.pay_run_id = $1 and t.employee_id = $2`,
    [run.id, employeeId],
  );
  return timesheetCoverage(tx, employeeId, run.period_start, run.period_end, { timesheetIds: used.rows.map((row) => row.timesheet_id) });
}

// Employees and their lines

export type EmployeeRow = {
  employee_id: string;
  name: string;
  tax_code: string;
  student_loan: boolean;
  kiwisaver_status: KiwiSaverStatus;
  kiwisaver_employee_rate: string;
  kiwisaver_employer_rate: string;
  esct_rate: string | null;
  kiwisaver_reduction_from: string | null;
  kiwisaver_reduction_to: string | null;
  is_archived: boolean;
  date_of_birth: string | null;
  start_date: string;
  finish_date: string | null;
  gross: string | null;
  taxable_earnings: string | null;
  non_taxable_earnings: string | null;
  kiwisaver_earnings: string | null;
  paye: string | null;
  student_loan_deduction: string | null;
  kiwisaver_employee: string | null;
  deductions: string | null;
  net_pay: string | null;
  kiwisaver_employer: string | null;
  esct: string | null;
  kiwisaver_employer_net: string | null;
  employer_cost: string | null;
  extra_pay: string | null;
  extra_pay_tax: string | null;
  extra_pay_tax_rate: string | null;
  extra_pay_method: ExtraPayMethod | "flat_rate" | null;
  extra_pay_annualised: string | null;
  lump_sum_lowest_rate: boolean | null;
  kept_finish_date: string | null;
  leave_problem: string | null;
  leave_notes: string[] | null;
};

/**
 * A draft uses each employee's current details (so a fixed tax code shows
 * straight away, PRUN11); an approved pay run uses the copy kept when it was
 * approved.
 */
async function loadEmployees(tx: OrgTx, run: RunRow): Promise<EmployeeRow[]> {
  const snapshot = run.status !== "draft";
  const pick = (column: string, cast = "") => (snapshot ? `pe.${column}${cast}` : `e.${column}${cast}`);
  const result = await tx.query<EmployeeRow>(
    `select pe.employee_id,
            ${snapshot ? "pe.employee_name" : "e.first_name || ' ' || e.last_name"} as name,
            ${pick("tax_code")} as tax_code, ${pick("student_loan")} as student_loan,
            ${pick("kiwisaver_status")} as kiwisaver_status,
            ${pick("kiwisaver_employee_rate", "::text")} as kiwisaver_employee_rate,
            ${pick("kiwisaver_employer_rate", "::text")} as kiwisaver_employer_rate,
            ${pick("esct_rate", "::text")} as esct_rate,
            ${pick("kiwisaver_reduction_from", "::text")} as kiwisaver_reduction_from,
            ${pick("kiwisaver_reduction_to", "::text")} as kiwisaver_reduction_to,
            e.is_archived, e.date_of_birth::text, e.start_date::text, e.finish_date::text,
            pe.gross::text, pe.taxable_earnings::text, pe.non_taxable_earnings::text, pe.kiwisaver_earnings::text,
            pe.paye::text, pe.student_loan_deduction::text, pe.kiwisaver_employee::text, pe.deductions::text,
            pe.net_pay::text, pe.kiwisaver_employer::text, pe.esct::text, pe.kiwisaver_employer_net::text,
            pe.employer_cost::text, pe.extra_pay::text, pe.extra_pay_tax::text, pe.extra_pay_tax_rate::text,
            pe.extra_pay_method, pe.extra_pay_annualised::text, pe.lump_sum_lowest_rate, pe.finish_date::text as kept_finish_date,
            pe.leave_problem, pe.leave_notes
       from payroll_pay_run_employees pe
       join payroll_employees e on e.id = pe.employee_id
      where pe.pay_run_id = $1
      order by lower(e.last_name), lower(e.first_name), pe.employee_id`,
    [run.id],
  );
  return result.rows;
}

type LineRow = {
  employee_id: string;
  line_number: number;
  pay_item_id: string;
  pay_item_name: string;
  category: PayItemCategory;
  kind: PayItemKind;
  subject_to_paye: boolean;
  subject_to_acc_levy: boolean;
  subject_to_kiwisaver: boolean;
  quantity: string | null;
  rate: string | null;
  amount: string;
  description: string | null;
  back_pay_for_pay_run_id: string | null;
  source: "typed" | "usual_pay" | "leave";
  regular: boolean | null;
  leave_type: string | null;
  leave_from: string | null;
  leave_to: string | null;
  leave_hours: string | null;
  leave_units: string | null;
  leave_in_advance: boolean;
  holiday_date: string | null;
  leave_basis: Record<string, unknown> | null;
};

async function loadLines(tx: OrgTx, runId: string): Promise<LineRow[]> {
  const result = await tx.query<LineRow>(
    `select l.employee_id, l.line_number, l.pay_item_id, p.name as pay_item_name, p.category, p.kind,
            p.subject_to_paye, p.subject_to_acc_levy, p.subject_to_kiwisaver, l.quantity::text, l.rate::text, l.amount::text,
            l.description, l.back_pay_for_pay_run_id::text, l.source, l.regular, l.leave_type, l.leave_from::text, l.leave_to::text,
            l.leave_hours::text, l.leave_units::text, l.leave_in_advance, l.holiday_date::text, l.leave_basis
       from payroll_pay_run_lines l join payroll_pay_items p on p.id = l.pay_item_id
      where l.pay_run_id = $1
      order by l.employee_id, l.line_number`,
    [runId],
  );
  return result.rows;
}

export function toLine(row: LineRow): PayRunLine {
  return {
    lineNumber: row.line_number,
    payItemId: row.pay_item_id,
    payItemName: row.pay_item_name,
    category: row.category,
    kind: row.kind,
    quantity: row.quantity === null ? null : toFixedString(dec(row.quantity), 2),
    rate: row.rate === null ? null : trimRate(row.rate),
    amount: toFixedString(dec(row.amount), 2),
    description: row.description,
    backPayForPayRunId: row.back_pay_for_pay_run_id,
    source: row.source,
    regular: row.regular,
    leave: row.leave_type
      ? {
          type: row.leave_type,
          from: row.leave_from,
          to: row.leave_to,
          hours: row.leave_hours === null ? null : toPlainString(dec(row.leave_hours)),
          units: row.leave_units === null ? null : toPlainString(dec(row.leave_units)),
          inAdvance: row.leave_in_advance,
          holidayDate: row.holiday_date,
          basis: row.leave_basis ?? {},
        }
      : null,
  };
}

/** A rate with at least 2 decimal places and no trailing zeros past them (33.750000 → 33.75). */
export function trimRate(rate: string): string {
  const fixed = toFixedString(dec(rate), 6);
  return fixed.replace(/(\.\d\d\d*?)0+$/, "$1");
}

function storedPay(row: EmployeeRow): EmployeePayResult | null {
  if (row.gross === null) return null;
  const m = (value: string | null) => toFixedString(dec(value ?? "0"), 2);
  return {
    gross: m(row.gross),
    taxableEarnings: m(row.taxable_earnings),
    nonTaxableEarnings: m(row.non_taxable_earnings),
    kiwiSaverEarnings: m(row.kiwisaver_earnings),
    paye: m(row.paye),
    studentLoan: m(row.student_loan_deduction),
    kiwiSaverEmployee: m(row.kiwisaver_employee),
    deductions: m(row.deductions),
    netPay: m(row.net_pay),
    kiwiSaverEmployer: m(row.kiwisaver_employer),
    esct: m(row.esct),
    kiwiSaverEmployerNet: m(row.kiwisaver_employer_net),
    employerCost: m(row.employer_cost),
    extraPay: m(row.extra_pay),
    extraPayTax: m(row.extra_pay_tax),
    extraPayTaxRate: row.extra_pay_tax_rate === null ? null : toPlainString(dec(row.extra_pay_tax_rate)),
    lumpSumLowestRate: row.lump_sum_lowest_rate ?? false,
  };
}

/** The pay rate for the period: the one in effect when it starts, or when the employee started (PRUN11). */
export async function rateForPeriod(tx: OrgTx, employeeId: string, periodStart: string, startDate: string) {
  return payRateOn(tx, employeeId, startDate > periodStart ? startDate : periodStart);
}

function isExtraPayLine(line: LineRow): boolean {
  return line.category === "earnings" && EXTRA_PAY_KINDS.includes(line.kind);
}

function calculate(
  run: RunRow,
  employee: EmployeeRow,
  lines: LineRow[],
  basis: ExtraPayBasis | null,
): { pay: EmployeePayResult | null; problem: string | null } {
  if (run.status !== "draft") return { pay: storedPay(employee), problem: null };
  if (employee.is_archived) return { pay: null, problem: `${employee.name} is archived. Take them off this pay run.` };
  try {
    const pay = calculateEmployeePay({
      name: employee.name,
      frequency: run.pay_frequency,
      payDate: run.pay_date,
      taxCode: employee.tax_code,
      studentLoan: employee.student_loan,
      kiwiSaverStatus: employee.kiwisaver_status,
      kiwiSaverEmployeeRate: employee.kiwisaver_employee_rate,
      kiwiSaverEmployerRate: employee.kiwisaver_employer_rate,
      esctRate: employee.esct_rate,
      dateOfBirth: employee.date_of_birth,
      kiwiSaverReduction:
        employee.kiwisaver_reduction_from && employee.kiwisaver_reduction_to
          ? { from: employee.kiwisaver_reduction_from, to: employee.kiwisaver_reduction_to }
          : null,
      lines: lines.map((line) => ({
        category: line.category === "deduction" ? "deduction" : "earnings",
        taxable: line.subject_to_paye,
        kiwiSaver: line.subject_to_kiwisaver,
        extraPay: isExtraPayLine(line),
        accLevy: line.subject_to_acc_levy,
        amount: line.amount,
      })),
      extraPayAnnualised: basis ? (basis.annualised ?? "0.00") : null,
    });
    return { pay, problem: null };
  } catch (error) {
    if (error instanceof ValidationError) return { pay: null, problem: error.message };
    throw error;
  }
}

type Calculated = {
  employee: EmployeeRow;
  lines: LineRow[];
  pay: EmployeePayResult | null;
  problem: string | null;
  finishDate: string | null;
  basis: ExtraPayBasis | null;
};

/** The finish date when it's inside the period: a final pay. */
function finalPayDate(run: RunRow, employee: EmployeeRow): string | null {
  if (run.status !== "draft") return employee.kept_finish_date;
  const finish = employee.finish_date;
  return finish !== null && finish >= run.period_start && finish <= run.period_end ? finish : null;
}

const FLAT_RATE_CODES = new Set(["ND", "NSW", "CAE", "EDW"]);

/** An approved pay's regular taxable pay: taxable earnings less extra pays. */
const REGULAR_PAY_SQL = "(pe.taxable_earnings - coalesce(pe.extra_pay, 0))";

/**
 * How a draft's extra pays are taxed, or why they
 * can't be: four weeks' regular pay to the pay date, or the last 2 paid
 * periods when a final pay has holiday pay on finishing or redundancy.
 */
export async function extraPayBasis(
  tx: OrgTx,
  run: RunRow,
  employee: EmployeeRow,
  lines: LineRow[],
  finishDate: string | null,
): Promise<{ basis: ExtraPayBasis | null; problem: string | null }> {
  const extras = lines.filter((line) => isExtraPayLine(line) && isPositive(dec(line.amount)));
  if (extras.length === 0) return { basis: null, problem: null };
  const name = employee.name;
  const termination = extras.some((line) => TERMINATION_KINDS.includes(line.kind));
  if (termination && finishDate === null) {
    return {
      basis: null,
      problem: `${NOT_SUPPORTED}: holiday pay on finishing or redundancy on a pay that isn't ${name}'s final pay (their finish date isn't in this pay period).`,
    };
  }
  if (!termination && finishDate !== null) {
    return {
      basis: null,
      problem: `${NOT_SUPPORTED}: an extra pay or back pay on ${name}'s final pay without holiday pay on finishing or redundancy (whether it arises from the employment ending decides IRD's method).`,
    };
  }
  const code = employee.tax_code.trim().replace(/\s+/g, " ").toUpperCase();
  if (FLAT_RATE_CODES.has(code)) return { basis: { method: "flat_rate", annualised: null }, problem: null };
  const method: ExtraPayMethod = termination ? "end_of_employment" : "four_weeks";
  const frequency = calculationFrequency(run.pay_frequency);
  const regularHere = lines
    .filter((line) => line.category === "earnings" && line.subject_to_paye && !isExtraPayLine(line))
    .reduce((total, line) => add(total, dec(line.amount)), ZERO_DECIMAL);
  const earlier =
    method === "four_weeks"
      ? await tx.query<{ pay_frequency: PayFrequency; regular: string }>(
          `select r.pay_frequency, ${REGULAR_PAY_SQL}::text as regular
             from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
            where pe.employee_id = $1 and r.status = 'approved' and r.id <> $2
              and r.pay_date between $3::date and $4::date and ${REGULAR_PAY_SQL} > 0
            order by r.pay_date, r.run_number`,
          [employee.employee_id, run.id, addDays(run.pay_date, -27), run.pay_date],
        )
      : await tx.query<{ pay_frequency: PayFrequency; regular: string }>(
          `select r.pay_frequency, ${REGULAR_PAY_SQL}::text as regular
             from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
            where pe.employee_id = $1 and r.status = 'approved' and r.id <> $2
              and r.period_end < $3::date and ${REGULAR_PAY_SQL} > 0
            order by r.period_end desc, r.run_number desc
            limit 2`,
          [employee.employee_id, run.id, run.period_start],
        );
  const other = earlier.rows.find((row) => row.pay_frequency !== run.pay_frequency);
  if (other) {
    return {
      basis: null,
      problem: `${NOT_SUPPORTED}: an extra pay taxed against pays of another frequency (${name} had a ${calculationFrequency(other.pay_frequency)} pay; this pay run is ${frequency}).`,
    };
  }
  const pays = earlier.rows.map((row) => toFixedString(dec(row.regular), 2));
  if (method === "four_weeks" && isPositive(regularHere)) pays.push(toFixedString(regularHere, 2));
  try {
    return { basis: { method, annualised: annualiseForExtraPay({ method, frequency, pays }) }, problem: null };
  } catch (error) {
    if (error instanceof ValidationError) return { basis: null, problem: `${error.message.replace(/\.$/, "")} for ${name}.` };
    throw error;
  }
}

/** Back pay lines whose pay period another approved pay run has already back-paid. */
async function backPayClash(tx: OrgTx, run: RunRow, employee: EmployeeRow, lines: LineRow[]): Promise<string | null> {
  const targets = lines.map((line) => line.back_pay_for_pay_run_id).filter((id): id is string => id !== null);
  if (targets.length === 0) return null;
  const clash = await tx.query<{ target: string; run_number: string }>(
    `select t.run_number::text as target, r.run_number::text
       from payroll_pay_run_lines l
       join payroll_pay_runs r on r.id = l.pay_run_id
       join payroll_pay_runs t on t.id = l.back_pay_for_pay_run_id
      where l.employee_id = $1 and l.back_pay_for_pay_run_id = any($2::uuid[]) and r.status = 'approved' and r.id <> $3
      order by r.run_number limit 1`,
    [employee.employee_id, targets, run.id],
  );
  const row = clash.rows[0];
  return row
    ? `${NOT_SUPPORTED}: a second back pay for ${payRunReference(row.target)}: ${employee.name} was already given back pay for it on ${payRunReference(row.run_number)}. Remove the back pay.`
    : null;
}

export function notesFor(
  finishDate: string | null,
  pay: EmployeePayResult | null,
  basis: ExtraPayBasis | null,
  lines: LineRow[],
  leaveNotes: string[] | null,
  name: string,
): string[] {
  const notes: string[] = [];
  if (finishDate) {
    const tohyees = lines.some((line) => line.leave_type === "termination");
    notes.push(
      tohyees
        ? `Final pay: employment finishes on ${formatDate(finishDate)}. Holiday pay owed on finishing is worked out by Tohyee from ${name}'s leave.`
        : `Final pay: employment finishes on ${formatDate(finishDate)}. Tohyee doesn't keep ${name}'s leave, so holiday pay owed on finishing isn't calculated by Tohyee; work it out outside Tohyee and add it as Holiday pay on finishing.`,
    );
  }
  for (const note of leaveNotes ?? []) notes.push(note);
  if (pay && basis && isPositive(dec(pay.extraPay))) {
    const how =
      basis.method === "flat_rate"
        ? "the tax code's flat rate"
        : `IRD's extra pay rules, ${basis.method === "four_weeks" ? "four weeks' pay" : "the last 2 paid pay periods"} annualised: $${formatMoney(basis.annualised ?? "0")}`;
    notes.push(
      `Extra pay $${formatMoney(pay.extraPay)} taxed at ${pay.extraPayTaxRate}% (${how})${pay.lumpSumLowestRate ? "; lowest rate, so the lump sum indicator is on" : ""}.`,
    );
  }
  return notes;
}

export async function calculateRun(tx: OrgTx, run: RunRow): Promise<Calculated[]> {
  const employees = await loadEmployees(tx, run);
  const lines = await loadLines(tx, run.id);
  const calculated: Calculated[] = [];
  for (const employee of employees) {
    const own = lines.filter((line) => line.employee_id === employee.employee_id);
    const finishDate = finalPayDate(run, employee);
    let basis: ExtraPayBasis | null = null;
    let basisProblem: string | null = null;
    if (run.status !== "draft") {
      basis = employee.extra_pay_method
        ? {
            method: employee.extra_pay_method,
            annualised: employee.extra_pay_annualised === null ? null : toFixedString(dec(employee.extra_pay_annualised), 2),
          }
        : null;
    } else if (!employee.is_archived) {
      ({ basis, problem: basisProblem } = await extraPayBasis(tx, run, employee, own, finishDate));
      basisProblem ??= await backPayClash(tx, run, employee, own);
    }
    const leaveProblem = run.status === "draft" && !employee.is_archived ? employee.leave_problem : null;
    const result = basisProblem
      ? { pay: null, problem: basisProblem }
      : leaveProblem
        ? { pay: calculate(run, employee, own, basis).pay, problem: leaveProblem }
        : calculate(run, employee, own, basis);
    // A finish date or pay rate change entered after the draft was made is refused here too (PRUN8).
    const later =
      run.status === "draft" && !employee.is_archived
        ? await periodRefusal(
            tx,
            { id: employee.employee_id, name: employee.name, start_date: employee.start_date, finish_date: employee.finish_date },
            run.period_start,
            run.period_end,
            run.id,
          )
        : null;
    calculated.push({ employee, lines: own, finishDate, basis, ...(later ? { pay: null, problem: later } : result) });
  }
  return calculated;
}

export function totalsOf(calculated: Calculated[]): PayRunTotals {
  const sum = (pick: (pay: EmployeePayResult) => string) =>
    toFixedString(
      calculated.reduce((total, entry) => (entry.pay ? add(total, dec(pick(entry.pay))) : total), ZERO_DECIMAL),
      2,
    );
  return {
    gross: sum((pay) => pay.gross),
    paye: sum((pay) => pay.paye),
    studentLoan: sum((pay) => pay.studentLoan),
    kiwiSaverEmployee: sum((pay) => pay.kiwiSaverEmployee),
    deductions: sum((pay) => pay.deductions),
    netPay: sum((pay) => pay.netPay),
    kiwiSaverEmployer: sum((pay) => pay.kiwiSaverEmployer),
    esct: sum((pay) => pay.esct),
    employerCost: sum((pay) => pay.employerCost),
  };
}

/**
 * Why an employee can't be paid on a pay run for this period (PRUN8): they
 * finished before it, they're on a salary and finish part-way through it
 *, or their pay rate changes part-way through. Checked when
 * the draft is made and again every time it's calculated, so a finish date
 * or pay rate entered afterwards isn't missed on approval.
 */
export async function periodRefusal(
  tx: OrgTx,
  employee: GroupEmployee,
  periodStart: string,
  periodEnd: string,
  payRunId: string | null = null,
): Promise<string | null> {
  if (employee.finish_date !== null && employee.finish_date < periodStart) {
    return `${employee.name} finished on ${employee.finish_date}, before this pay period. Take them off this pay run.`;
  }
  if (employee.finish_date !== null && employee.finish_date < periodEnd) {
    const rate = await rateForPeriod(tx, employee.id, periodStart, employee.start_date);
    if (rate?.payBasis === "salary") {
      return `${NOT_SUPPORTED}: part of a pay period on a salary. ${employee.name} finishes on ${employee.finish_date}, before the period ends.`;
    }
  }
  const change = await tx.query<{ effective_from: string }>(
    `select effective_from::text from payroll_pay_rates
      where employee_id = $1 and effective_from > $2 and effective_from <= $3
      order by effective_from limit 1`,
    [employee.id, employee.start_date > periodStart ? employee.start_date : periodStart, periodEnd],
  );
  if (change.rows[0]) {
    return `${NOT_SUPPORTED}: a pay rate that changes part-way through a pay period. ${employee.name}'s pay rate changes on ${change.rows[0].effective_from}.`;
  }
  // Someone moved between pay groups mustn't be paid twice for the same days.
  const other = await tx.query<{ run_number: string; period_start: string; period_end: string }>(
    `select r.run_number::text, r.period_start::text, r.period_end::text
       from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
      where pe.employee_id = $1 and r.status <> 'voided' and ($4::uuid is null or r.id <> $4::uuid)
        and r.period_start <= $3 and r.period_end >= $2
      order by r.period_start, r.run_number limit 1`,
    [employee.id, periodStart, periodEnd, payRunId],
  );
  if (other.rows[0]) {
    const run = other.rows[0];
    return `${employee.name} is already paid for ${run.period_start} to ${run.period_end} on ${payRunReference(run.run_number)}. Take them off one of the pay runs (or void it).`;
  }
  return null;
}
