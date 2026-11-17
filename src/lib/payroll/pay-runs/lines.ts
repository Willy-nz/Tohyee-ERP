import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError,ValidationError } from "@/lib/errors";
import { formatDate,formatMoney } from "@/lib/format";
import {
add,
cmp,
dec,
type Decimal,
isNegative,
isPositive,mul,
parseDecimalInput,
sub,toFixedString,
toPlainString,
ZERO_DECIMAL
} from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import type { PayFrequency } from "@/lib/payroll/groups";
import {
lineAmount,salaryForPeriod
} from "@/lib/payroll/pay-calculation";
import {
LEAVE_PAY_ITEM_KINDS,
PAY_ITEM_COLUMNS,
PAY_ITEM_FROM,type PayItemKind,
type PayItemRow
} from "@/lib/payroll/pay-items";
import { payRunReference } from "@/lib/payroll/pay-run-reference";
import { leaveKeptFor,updateEmployeeLeave } from "@/lib/payroll/leave-pay-runs";
import { NOT_SUPPORTED } from "@/lib/payroll/rates";
import { asRecord,optionalString,requireArray,requireBoolean } from "@/lib/validation";
import { PayRun } from "@/lib/payroll/pay-runs/types";
import { rateForPeriod } from "@/lib/payroll/pay-runs/calculation";
import { UUID_PATTERN,assertDraft,findRun,markPrepared,parseUuid,parseUuidField,toDraftRun } from "@/lib/payroll/pay-runs/rows";
import { getPayRun } from "@/lib/payroll/pay-runs/read";

// Changing a draft

type ItemForLine = PayItemRow;

function parseQuantity(input: unknown, label: string): string {
  return toFixedString(dec(parseDecimalInput(input, `${label} hours`, { maxScale: 2, allowZero: true })), 2);
}

function parseRate(input: unknown, label: string): string {
  return parseDecimalInput(input, `${label} rate`, { maxScale: 6, allowZero: true });
}

function rejectNegative(input: unknown): void {
  if ((typeof input === "string" && input.trim().startsWith("-")) || (typeof input === "number" && input < 0)) {
    throw new ValidationError(`${NOT_SUPPORTED}: amounts below zero (corrections and back pay).`);
  }
}

/**
 * Replaces one employee's earnings and deductions on a draft (PRUN2). Each
 * line is a pay item with hours x rate (overtime's rate defaults to the
 * hourly rate x the item's multiplier) or an amount. Employer KiwiSaver,
 * PAYE, student loan and ESCT are calculated, not entered. Back pay worked
 * out from pay rate history stays, after the typed lines (XP10); remove it
 * with removeBackPay.
 */
export async function setPayRunEmployeeLines(
  tx: OrgTx,
  runIdInput: unknown,
  employeeIdInput: unknown,
  input: { lines: unknown; keepUsualPay?: unknown },
): Promise<{ payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  assertDraft(run);
  const employeeId = parseUuid(employeeIdInput, "employee");
  const keepUsualPay = input.keepUsualPay === undefined || input.keepUsualPay === null ? false : requireBoolean(input.keepUsualPay, "keepUsualPay");
  const onRun = await tx.query<{ start_date: string; name: string }>(
    `select e.start_date::text, e.first_name || ' ' || e.last_name as name
       from payroll_pay_run_employees pe join payroll_employees e on e.id = pe.employee_id
      where pe.pay_run_id = $1 and pe.employee_id = $2`,
    [run.id, employeeId],
  );
  if (!onRun.rows[0]) throw new NotFoundError(`That employee isn't on ${payRunReference(run.run_number)}.`);
  const rawLines = requireArray(input.lines, "lines", 200);
  const existing = new Set((await tx.query<{ pay_item_id: string }>(
    "select pay_item_id from payroll_pay_run_lines where pay_run_id = $1 and employee_id = $2",
    [run.id, employeeId],
  )).rows.map((row) => row.pay_item_id));
  const itemIds = [...new Set(rawLines.map((raw, index) => parseUuidField(asRecord(raw, `Line ${index + 1}`).payItemId, index)))];
  const items = new Map(
    (await tx.query<ItemForLine>(`select ${PAY_ITEM_COLUMNS} from ${PAY_ITEM_FROM} where p.id = any($1::uuid[])`, [itemIds])).rows.map((row) => [
      row.id,
      row,
    ]),
  );
  let hourlyRate: string | null | undefined;
  const kept = await leaveKeptFor(tx, employeeId, run.period_start);
  const parsed: Array<{ payItemId: string; quantity: string | null; rate: string | null; amount: string; description: string | null; regular: boolean | null }> = [];
  for (const [index, raw] of rawLines.entries()) {
    const label = `Line ${index + 1}`;
    const line = asRecord(raw, label);
    const item = items.get(String(line.payItemId));
    if (!item) throw new ValidationError(`${label}: that pay item wasn't found.`);
    if (item.category === "employer_contribution") {
      throw new ValidationError(`${label}: ${item.name} is calculated by Tohyee, not entered.`);
    }
    if (item.is_archived && !existing.has(item.id)) throw new ValidationError(`${label}: ${item.name} is archived.`);
    if (LEAVE_PAY_ITEM_KINDS.includes(item.kind)) {
      throw new ValidationError(`${label}: ${item.name} is worked out by Tohyee from leave (Payroll › Leave), not typed.`);
    }
    if (kept.kept && (item.kind === "holiday_pay" || item.kind === "termination_holiday_pay")) {
      throw new ValidationError(
        item.kind === "holiday_pay"
          ? `${label}: Tohyee keeps ${onRun.rows[0].name}'s leave, so book it under Payroll › Leave instead of typing holiday pay.`
          : `${label}: Tohyee works out ${onRun.rows[0].name}'s holiday pay on finishing from their leave, so it isn't typed.`,
      );
    }
    const regularInput = line.regular === undefined || line.regular === null ? null : requireBoolean(line.regular, `${label} regular`);
    const regular = item.kind === "overtime" || item.kind === "allowance" ? (regularInput ?? kept.regularItems.has(item.id)) : null;
    const description = optionalString(line.description, `${label} description`, { maxLength: 200 });
    const hasQuantity = line.quantity !== undefined && line.quantity !== null && line.quantity !== "";
    const hasAmount = line.amount !== undefined && line.amount !== null && line.amount !== "";
    if (hasQuantity === hasAmount) throw new ValidationError(`${label}: give either hours (and a rate) or an amount.`);
    if (hasQuantity) {
      rejectNegative(line.quantity);
      rejectNegative(line.rate);
      const quantity = parseQuantity(line.quantity, label);
      let rate: string;
      if (line.rate === undefined || line.rate === null || line.rate === "") {
        if (hourlyRate === undefined) {
          const payRate = await rateForPeriod(tx, employeeId, run.period_start, onRun.rows[0].start_date);
          hourlyRate = payRate?.payBasis === "hourly" ? payRate.hourlyRate : null;
        }
        if (hourlyRate === null) throw new ValidationError(`${label}: ${onRun.rows[0].name} is on a salary, so give a rate for these hours.`);
        rate =
          item.kind === "overtime" && item.rate_multiplier !== null
            ? toFixedString(mul(dec(hourlyRate), dec(item.rate_multiplier)), 6)
            : hourlyRate;
      } else {
        rate = parseRate(line.rate, label);
      }
      parsed.push({ payItemId: item.id, quantity, rate, amount: lineAmount(quantity, rate), description, regular });
    } else {
      rejectNegative(line.amount);
      const amount = toFixedString(dec(parseDecimalInput(line.amount, `${label} amount`, { maxScale: 2, allowZero: true })), 2);
      parsed.push({ payItemId: item.id, quantity: null, rate: null, amount, description, regular });
    }
  }

  const backPay = await tx.query<{ pay_item_id: string; amount: string; description: string | null; back_pay_for_pay_run_id: string }>(
    `select pay_item_id, amount::text, description, back_pay_for_pay_run_id from payroll_pay_run_lines
      where pay_run_id = $1 and employee_id = $2 and back_pay_for_pay_run_id is not null order by line_number`,
    [run.id, employeeId],
  );
  // The usual pay Tohyee made from the usual week stays Tohyee's when asked; leave is worked out again below.
  const usual = keepUsualPay
    ? (
        await tx.query<{ pay_item_id: string; quantity: string | null; rate: string | null; amount: string; description: string | null; regular: boolean | null }>(
          `select pay_item_id, quantity::text, rate::text, amount::text, description, regular from payroll_pay_run_lines
            where pay_run_id = $1 and employee_id = $2 and source = 'usual_pay' order by line_number`,
          [run.id, employeeId],
        )
      ).rows
    : [];
  if (parsed.length + backPay.rows.length + usual.length > 200) {
    throw new ValidationError("An employee can have at most 200 lines on a pay run, back pay included.");
  }
  await tx.query("delete from payroll_pay_run_lines where pay_run_id = $1 and employee_id = $2", [run.id, employeeId]);
  const keptBackPay = backPay.rows.map((row) => ({
    payItemId: row.pay_item_id,
    quantity: null,
    rate: null,
    amount: row.amount,
    description: row.description,
    regular: null,
    backPayFor: row.back_pay_for_pay_run_id,
    source: "typed",
  }));
  const all = [
    ...parsed.map((entry) => ({ ...entry, backPayFor: null as string | null, source: "typed" })),
    ...keptBackPay,
    ...usual.map((row) => ({ payItemId: row.pay_item_id, quantity: row.quantity, rate: row.rate, amount: row.amount, description: row.description, regular: row.regular, backPayFor: null, source: "usual_pay" })),
  ];
  for (const [index, line] of all.entries()) {
    await tx.query(
      `insert into payroll_pay_run_lines (pay_run_id, employee_id, line_number, pay_item_id, quantity, rate, amount, description,
                                          back_pay_for_pay_run_id, regular, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [run.id, employeeId, index + 1, line.payItemId, line.quantity, line.rate, line.amount, line.description, line.backPayFor, line.regular, line.source],
    );
  }
  await updateEmployeeLeave(tx, toDraftRun(run), employeeId);
  await markPrepared(tx, run.id);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.changed",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number), employeeId, lineCount: parsed.length },
  });
  return { payRun: await getPayRun(tx, run.id) };
}

type BackPayTarget = { id: string; run_number: string; period_start: string; period_end: string; pay_frequency: PayFrequency };

type PaidLine = { kind: PayItemKind; quantity: string | null; rate: string | null; amount: string; rate_multiplier: string | null };

/**
 * One approved pay period's back pay at a new pay rate:
 * Ordinary time at the new rate (hours x rate, or the salary for the
 * period) and Overtime paid at the old rate x its multiplier, less what was
 * paid. Refuses what it can't work out honestly.
 */
const PERIOD_WORDS: Record<PayFrequency, string> = { weekly: "week", fortnightly: "fortnight", four_weekly: "four-week period", monthly: "month" };

function backPayForPeriod(
  target: BackPayTarget,
  lines: PaidLine[],
  rate: { pay_basis: "salary" | "hourly"; annual_salary: string | null; hourly_rate: string | null; effective_from: string },
  employee: { name: string; previous: { pay_basis: "salary" | "hourly"; annual_salary: string | null } | null },
): { amount: Decimal; description: string } {
  const reference = payRunReference(target.run_number);
  const refuse = (what: string) => new ValidationError(`${NOT_SUPPORTED}: back pay ${what} (${reference}).`);
  if (lines.some((line) => line.kind === "holiday_pay" || line.kind === "termination_holiday_pay" || LEAVE_PAY_ITEM_KINDS.includes(line.kind))) {
    throw refuse(
      "for a pay period with holiday pay or leave in it: back pay changes the ordinary weekly pay that leave was paid at and the gross earnings later holiday pay uses, which needs its own worked example",
    );
  }
  const ordinary = lines.filter((line) => line.kind === "ordinary_time");
  const overtime = lines.filter((line) => line.kind === "overtime");
  const period = `${formatDate(target.period_start)} to ${formatDate(target.period_end)}`;
  let paid = ZERO_DECIMAL;
  let owed = ZERO_DECIMAL;
  let description: string;
  if (rate.pay_basis === "salary") {
    if (ordinary.some((line) => line.quantity !== null)) throw refuse("when the pay basis changed from hourly to a salary");
    if (overtime.length > 0) throw refuse("on overtime at a typed rate");
    for (const line of ordinary) paid = add(paid, dec(line.amount));
    // A period that wasn't paid the full salary (unpaid days, say) would have them paid at the new rate (XP11b).
    const previous = employee.previous;
    if (previous?.pay_basis === "salary") {
      const full = dec(salaryForPeriod(previous.annual_salary!, target.pay_frequency));
      if (cmp(paid, full) !== 0) {
        throw new ValidationError(
          `${NOT_SUPPORTED}: back pay for ${reference}: ${employee.name}'s ordinary pay that ${PERIOD_WORDS[target.pay_frequency]} was $${formatMoney(toFixedString(paid, 2))}, not their full salary of $${formatMoney(toFixedString(full, 2))}. Work out its back pay and add it as an amount.`,
        );
      }
    }
    owed = dec(salaryForPeriod(rate.annual_salary!, target.pay_frequency));
    description = `Back pay for ${reference} (${period}): salary of $${formatMoney(rate.annual_salary)} a year from ${formatDate(rate.effective_from)}`;
  } else {
    if (ordinary.some((line) => line.quantity === null)) throw refuse("when the pay basis changed from a salary to hourly");
    const paidRates = [...new Set(ordinary.map((line) => toPlainString(dec(line.rate!))))];
    if (paidRates.length > 1) throw refuse("for a pay period paid at more than one ordinary rate");
    const newRate = rate.hourly_rate!;
    let hours = ZERO_DECIMAL;
    for (const line of ordinary) {
      paid = add(paid, dec(line.amount));
      owed = add(owed, dec(lineAmount(line.quantity!, newRate)));
      hours = add(hours, dec(line.quantity!));
    }
    for (const line of overtime) {
      const multiplier = line.rate_multiplier;
      if (line.quantity === null || multiplier === null || paidRates.length !== 1 || cmp(dec(line.rate!), mul(dec(paidRates[0]), dec(multiplier))) !== 0) {
        throw refuse("on overtime at a typed rate");
      }
      paid = add(paid, dec(line.amount));
      owed = add(owed, dec(lineAmount(line.quantity, toFixedString(mul(dec(newRate), dec(multiplier)), 6))));
    }
    description = `Back pay for ${reference} (${period}): ${toFixedString(hours, 2)} h at $${formatMoney(newRate)}${
      paidRates[0] ? ` instead of $${formatMoney(paidRates[0])}` : ""
    }${overtime.length ? ", and overtime" : ""}`;
  }
  const amount = sub(owed, paid);
  if (isNegative(amount)) throw refuse("at a lower rate than was paid");
  return { amount, description: description.slice(0, 200) };
}

/**
 * Adds back pay to an employee on a draft from a pay rate in their history
 * (XP10): one Back pay line for each approved pay period the
 * rate now covers that was paid at less. Taxed as an extra pay.
 */
export async function addBackPay(
  tx: OrgTx,
  runIdInput: unknown,
  employeeIdInput: unknown,
  input: { payItemId: unknown; payRateId: unknown },
): Promise<{ payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  assertDraft(run);
  const employeeId = parseUuid(employeeIdInput, "employee");
  const onRun = await tx.query<{ start_date: string; name: string }>(
    `select e.start_date::text, e.first_name || ' ' || e.last_name as name
       from payroll_pay_run_employees pe join payroll_employees e on e.id = pe.employee_id
      where pe.pay_run_id = $1 and pe.employee_id = $2`,
    [run.id, employeeId],
  );
  if (!onRun.rows[0]) throw new NotFoundError(`That employee isn't on ${payRunReference(run.run_number)}.`);
  if (typeof input.payItemId !== "string" || !UUID_PATTERN.test(input.payItemId)) throw new ValidationError("Choose a Back pay pay item.");
  const item = await tx.query<PayItemRow>(`select ${PAY_ITEM_COLUMNS} from ${PAY_ITEM_FROM} where p.id = $1`, [input.payItemId]);
  if (!item.rows[0] || item.rows[0].kind !== "back_pay") throw new ValidationError("Choose a pay item of the kind Back pay.");
  if (item.rows[0].is_archived) throw new ValidationError(`${item.rows[0].name} is archived.`);
  if (typeof input.payRateId !== "string" || !UUID_PATTERN.test(input.payRateId)) throw new NotFoundError("That pay rate wasn't found.");
  const found = await tx.query<{
    id: string;
    effective_from: string;
    pay_basis: "salary" | "hourly";
    annual_salary: string | null;
    hourly_rate: string | null;
  }>(
    `select id, effective_from::text, pay_basis, annual_salary::text, hourly_rate::text from payroll_pay_rates
      where id = $1 and employee_id = $2`,
    [input.payRateId, employeeId],
  );
  const rate = found.rows[0];
  if (!rate) throw new NotFoundError("That pay rate wasn't found for this employee.");
  if (rate.effective_from >= run.period_start) {
    throw new ValidationError(`No back pay is owed for that pay rate: it starts on ${formatDate(rate.effective_from)}, not before this pay period.`);
  }
  // The rate before this one, which the periods it now covers were paid at.
  const previous = await tx.query<{ pay_basis: "salary" | "hourly"; annual_salary: string | null }>(
    `select p.pay_basis, p.annual_salary::text from payroll_pay_rates p, payroll_pay_rates r
      where r.id = $2 and p.employee_id = $1 and (p.effective_from, p.entry_number) < (r.effective_from, r.entry_number)
      order by p.effective_from desc, p.entry_number desc limit 1`,
    [employeeId, rate.id],
  );
  const targets = await tx.query<BackPayTarget>(
    `select r.id, r.run_number::text, r.period_start::text, r.period_end::text, r.pay_frequency
       from payroll_pay_runs r join payroll_pay_run_employees pe on pe.pay_run_id = r.id
      where pe.employee_id = $1 and r.status = 'approved' and r.period_end >= $2::date and r.period_end < $3::date
      order by r.period_start, r.run_number`,
    [employeeId, rate.effective_from, run.period_start],
  );
  const added: Array<{ targetId: string; amount: string; description: string }> = [];
  for (const target of targets.rows) {
    const reference = payRunReference(target.run_number);
    if (target.period_start < rate.effective_from) {
      throw new ValidationError(
        `${NOT_SUPPORTED}: back pay for a pay rate that starts part-way through a paid period (${reference} pays ${target.period_start} to ${target.period_end}; the rate starts on ${rate.effective_from}).`,
      );
    }
    const inEffect = await rateForPeriod(tx, employeeId, target.period_start, onRun.rows[0].start_date);
    if (inEffect?.id !== rate.id) continue; // a later pay rate covers this period
    const earlier = await tx.query<{ run_number: string }>(
      `select r.run_number::text from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
        where l.back_pay_for_pay_run_id = $1 and l.employee_id = $2 and r.status <> 'voided'
        order by r.run_number limit 1`,
      [target.id, employeeId],
    );
    if (earlier.rows[0]) {
      throw new ValidationError(
        `${NOT_SUPPORTED}: a second back pay for ${reference}: ${onRun.rows[0].name} already has back pay for it on ${payRunReference(earlier.rows[0].run_number)}.`,
      );
    }
    const paid = await tx.query<PaidLine>(
      `select p.kind, l.quantity::text, l.rate::text, l.amount::text, p.rate_multiplier::text
         from payroll_pay_run_lines l join payroll_pay_items p on p.id = l.pay_item_id
        where l.pay_run_id = $1 and l.employee_id = $2 and p.category = 'earnings'
        order by l.line_number`,
      [target.id, employeeId],
    );
    const result = backPayForPeriod(target, paid.rows, rate, { name: onRun.rows[0].name, previous: previous.rows[0] ?? null });
    if (isPositive(result.amount)) {
      added.push({ targetId: target.id, amount: toFixedString(result.amount, 2), description: result.description });
    }
  }
  if (added.length === 0) {
    throw new ValidationError("No back pay is owed for that pay rate: no approved pay period it covers was paid at less.");
  }
  const last = await tx.query<{ count: string; last: string | null }>(
    "select count(*)::text as count, max(line_number)::text as last from payroll_pay_run_lines where pay_run_id = $1 and employee_id = $2",
    [run.id, employeeId],
  );
  if (Number(last.rows[0].count) + added.length > 200) {
    throw new ValidationError("An employee can have at most 200 lines on a pay run, back pay included.");
  }
  let lineNumber = Number(last.rows[0].last ?? "0");
  for (const line of added) {
    lineNumber += 1;
    await tx.query(
      `insert into payroll_pay_run_lines (pay_run_id, employee_id, line_number, pay_item_id, amount, description, back_pay_for_pay_run_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [run.id, employeeId, lineNumber, item.rows[0].id, line.amount, line.description, line.targetId],
    );
  }
  await markPrepared(tx, run.id);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.back_pay_added",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number), employeeId, payRateId: rate.id, periodCount: added.length },
  });
  return { payRun: await getPayRun(tx, run.id) };
}

/**
 * Works out leave again on a draft for everyone on it, or one employee
 * ("Update leave"): after a booking, a public holiday decision,
 * a cash-up or an earlier pay run changed what it depends on.
 */
export async function updatePayRunLeave(tx: OrgTx, runIdInput: unknown, employeeIdInput?: unknown): Promise<{ payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  assertDraft(run);
  const employees = await tx.query<{ employee_id: string }>("select employee_id::text from payroll_pay_run_employees where pay_run_id = $1", [run.id]);
  const only = employeeIdInput === undefined || employeeIdInput === null || employeeIdInput === "" ? null : parseUuid(employeeIdInput, "employee");
  if (only && !employees.rows.some((row) => row.employee_id === only)) throw new NotFoundError(`That employee isn't on ${payRunReference(run.run_number)}.`);
  for (const row of employees.rows) {
    if (!only || row.employee_id === only) await updateEmployeeLeave(tx, toDraftRun(run), row.employee_id);
  }
  await markPrepared(tx, run.id);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.leave_updated",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number), employeeId: only },
  });
  return { payRun: await getPayRun(tx, run.id) };
}

/** Takes the back pay worked out from pay rate history off an employee on a draft (XP10). */
export async function removeBackPay(tx: OrgTx, runIdInput: unknown, employeeIdInput: unknown): Promise<{ payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  assertDraft(run);
  const employeeId = parseUuid(employeeIdInput, "employee");
  const removed = await tx.query(
    "delete from payroll_pay_run_lines where pay_run_id = $1 and employee_id = $2 and back_pay_for_pay_run_id is not null",
    [run.id, employeeId],
  );
  if (!removed.rowCount) throw new NotFoundError(`That employee has no back pay on ${payRunReference(run.run_number)}.`);
  await markPrepared(tx, run.id);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.back_pay_removed",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number), employeeId, lineCount: removed.rowCount },
  });
  return { payRun: await getPayRun(tx, run.id) };
}

/** Leaves an employee out of a draft (PRUN11). */
export async function removePayRunEmployee(tx: OrgTx, runIdInput: unknown, employeeIdInput: unknown): Promise<{ payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput, true);
  assertDraft(run);
  const employeeId = parseUuid(employeeIdInput, "employee");
  await tx.query("delete from payroll_pay_run_lines where pay_run_id = $1 and employee_id = $2", [run.id, employeeId]);
  const removed = await tx.query("delete from payroll_pay_run_employees where pay_run_id = $1 and employee_id = $2", [run.id, employeeId]);
  if (removed.rowCount !== 1) throw new NotFoundError(`That employee isn't on ${payRunReference(run.run_number)}.`);
  await markPrepared(tx, run.id);
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.employee_removed",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference: payRunReference(run.run_number), employeeId },
  });
  return { payRun: await getPayRun(tx, run.id) };
}
