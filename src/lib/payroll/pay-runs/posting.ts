import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError,ForbiddenError,ValidationError } from "@/lib/errors";
import { assertSameRequest,requestHash } from "@/lib/idempotency";
import { controlAccountCode,type ControlAccount } from "@/lib/invoices/service";
import { getJournal,parseJournalBody,postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import {
add,dec,
type Decimal,isPositive,
isZero,sum,
toFixedString,ZERO_DECIMAL
} from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { allocationOn } from "@/lib/payroll/allocations";
import {
PAY_ITEM_KIND_ORDER_SQL
} from "@/lib/payroll/pay-items";
import { payRunReference } from "@/lib/payroll/pay-run-reference";
import { leaveOutOfDate } from "@/lib/payroll/leave-pay-runs";
import { NOT_SUPPORTED } from "@/lib/payroll/rates";
import { percentageOfWeight,splitByWeights,timesheetWeights } from "@/lib/payroll/timesheet-split";
import { timesheetCoverage,type TimesheetCoverage } from "@/lib/payroll/timesheets";
import { loadTrackingContext,missingRequired,sortedTags,trackingKey,type TrackingTags } from "@/lib/tracking/service";
import { optionalSource,requireIdempotencyKey } from "@/lib/validation";
import { PayRun,PayRunPosting } from "@/lib/payroll/pay-runs/types";
import { EmployeeRow,calculateRun,totalsOf,trimRate } from "@/lib/payroll/pay-runs/calculation";
import { approverMustDiffer,findRun,isUniqueViolation,parseUuid,toDraftRun } from "@/lib/payroll/pay-runs/rows";
import { getPayRun } from "@/lib/payroll/pay-runs/read";

// Approving and voiding

export const PAYE_ACCOUNT: ControlAccount = { systemKey: "paye_payable", label: "PAYE payable", accountClass: "liability" };
export const KIWISAVER_ACCOUNT: ControlAccount = { systemKey: "kiwisaver_payable", label: "KiwiSaver payable", accountClass: "liability" };
export const ESCT_ACCOUNT: ControlAccount = { systemKey: "esct_payable", label: "ESCT payable", accountClass: "liability" };
export const STUDENT_LOAN_ACCOUNT: ControlAccount = { systemKey: "student_loan_payable", label: "Student loan payable", accountClass: "liability" };
export const WAGES_ACCOUNT: ControlAccount = { systemKey: "wages_payable", label: "Wages payable", accountClass: "liability" };

type ItemAccount = { id: string; name: string; rank: number; accountId: string; accountCode: string };

async function itemAccounts(tx: OrgTx): Promise<Map<string, ItemAccount | { id: string; name: string; missing: true }>> {
  const result = await tx.query<{ id: string; name: string; rank: number; account_id: string | null; account_code: string | null; is_active: boolean | null }>(
    `select p.id, p.name, a.id::text as account_id, a.code as account_code, a.is_active,
            (row_number() over (order by array_position(array['earnings', 'deduction', 'employer_contribution'], p.category),
                                         array_position(${PAY_ITEM_KIND_ORDER_SQL}, p.kind),
                                         lower(p.name), p.id))::int as rank
       from payroll_pay_items p left join accounts a on a.id = p.account_id`,
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      row.account_id && row.account_code
        ? { id: row.id, name: row.name, rank: row.rank, accountId: row.account_id, accountCode: row.account_code }
        : { id: row.id, name: row.name, missing: true as const },
    ]),
  );
}

function accountFor(entry: ItemAccount | { id: string; name: string; missing: true } | undefined, refused: string): ItemAccount {
  if (!entry || "missing" in entry) {
    throw new ValidationError(`The pay item ${entry?.name ?? ""} has no account, so ${refused}. Set one under Payroll › Pay items.`);
  }
  return entry;
}

/** One share of an employee's costs: a timesheet row or a default allocation line, with its weight. */
type Share = {
  source: "timesheet" | "allocation";
  weight: string;
  /** The share of the whole, to 4 places, for display. */
  percentage: string;
  tags: TrackingTags;
  departmentId: string | null;
  projectId: string | null;
  projectName: string | null;
  rdActivityId: string | null;
  hours: string | null;
  allocationId: string | null;
  allocationPercentage: string | null;
};

type Posting = {
  employeeId: string;
  payItemId: string;
  accountId: string;
  tags: TrackingTags;
  projectId: string | null;
  percentage: string;
  amount: string;
  group: string;
  shareNumber: number;
};

type DebitGroup = { key: string; rank: number; order: number; accountCode: string; description: string; tags: TrackingTags; amount: Decimal };

/**
 * Approves a draft (PRUN1-PRUN3, PRUN5, PRUN7): posts one journal dated the
 * pay date and keeps a copy of what each employee's pay was calculated from.
 */
export async function approvePayRun(
  tx: OrgTx,
  runIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const id = parseUuid(runIdInput, "pay run");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("payroll_pay_run_approval", { id });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; approve_request_hash: string }>(
      "select id, approve_request_hash from payroll_pay_runs where approve_command_source = $1 and approve_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].approve_request_hash, hash, "pay run approval");
    return { created: false, payRun: await getPayRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const run = await findRun(tx, id, true);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const reference = payRunReference(run.run_number);
  if (run.status !== "draft") throw new ConflictError(`${reference} is already ${run.status}.`);
  if ((await approverMustDiffer(tx)) && tx.actor.userId !== null && run.prepared_by_user_ids.includes(tx.actor.userId)) {
    throw new ForbiddenError("You prepared this pay run, so someone else has to approve it.");
  }
  if ((await approverMustDiffer(tx)) && tx.actor.userId !== null) {
    const changed = await tx.query<{ name: string }>(
      "select entry->>'name' as name from payroll_pay_runs r, jsonb_array_elements(r.details_changed_by) entry where r.id = $1 and entry->>'userId' = $2 limit 1",
      [run.id, tx.actor.userId],
    );
    if (changed.rows[0]) {
      throw new ForbiddenError(`You changed ${changed.rows[0].name}'s payroll details while ${reference} was a draft, so someone else has to approve it.`);
    }
  }
  await assertPostingDateAllowed(tx, run.pay_date);

  const calculated = await calculateRun(tx, run);
  if (calculated.length === 0) throw new ValidationError(`${reference} has nobody on it. Delete it instead.`);
  const problems = calculated.filter((entry) => entry.problem !== null);
  if (problems.length > 0) {
    throw new ValidationError(`${reference} can't be approved yet: ${problems.map((entry) => entry.problem).join(" ")}`);
  }
  // Leave is worked out again, so what's approved is what the leave records say now.
  const stale: string[] = [];
  for (const entry of calculated) {
    const outOfDate = await leaveOutOfDate(tx, toDraftRun(run), entry.employee.employee_id, entry.employee.name);
    if (outOfDate) stale.push(outOfDate);
  }
  if (stale.length > 0) throw new ValidationError(`${reference} can't be approved yet: ${stale.join(" ")}`);
  const refused = `${reference} can't be approved`;
  const accounts = await itemAccounts(tx);
  const ctx = await loadTrackingContext(tx);

  const postings: Posting[] = [];
  const groups = new Map<string, DebitGroup>();
  const deductions = new Map<string, { item: ItemAccount; amount: Decimal }>();
  let kiwiSaverItem: ItemAccount | null = null;
  const addShare = (employeeId: string, item: ItemAccount, amount: string, shares: Share[]) => {
    const split = splitByWeights(amount, shares.map((share) => share.weight));
    shares.forEach((share, index) => {
      if (isZero(dec(split[index]))) return;
      const key = `${item.id}|${item.accountCode}|${trackingKey(share.tags)}|${share.projectId ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          rank: item.rank,
          order: groups.size,
          accountCode: item.accountCode,
          description: share.projectName ? `${item.name} (project ${share.projectName})` : item.name,
          tags: share.tags,
          amount: ZERO_DECIMAL,
        };
        groups.set(key, group);
      }
      group.amount = add(group.amount, dec(split[index]));
      postings.push({
        employeeId,
        payItemId: item.id,
        accountId: item.accountId,
        tags: share.tags,
        projectId: share.projectId,
        percentage: share.percentage,
        amount: split[index],
        group: key,
        shareNumber: index + 1,
      });
    });
  };

  const usedTimesheets = new Set<string>();
  const employeeShares = new Map<string, Share[]>();
  for (const entry of calculated) {
    const pay = entry.pay!;
    const coverage = await timesheetCoverage(tx, entry.employee.employee_id, run.period_start, run.period_end);
    for (const id of coverage.timesheetIds) usedTimesheets.add(id);
    const shares = await sharesFor(tx, ctx, entry.employee, run.pay_date, coverage);
    employeeShares.set(entry.employee.employee_id, shares);
    const byItem = new Map<string, Decimal>();
    for (const line of entry.lines) {
      if (line.category === "deduction") {
        const item = accountFor(accounts.get(line.pay_item_id), refused);
        const current = deductions.get(item.id) ?? { item, amount: ZERO_DECIMAL };
        current.amount = add(current.amount, dec(line.amount));
        deductions.set(item.id, current);
      } else {
        byItem.set(line.pay_item_id, add(byItem.get(line.pay_item_id) ?? ZERO_DECIMAL, dec(line.amount)));
      }
    }
    for (const [itemId, amount] of byItem) {
      if (isZero(amount)) continue;
      addShare(entry.employee.employee_id, accountFor(accounts.get(itemId), refused), toFixedString(amount, 2), shares);
    }
    if (!isZero(dec(pay.kiwiSaverEmployer))) {
      if (!kiwiSaverItem) kiwiSaverItem = await kiwiSaverEmployerItem(tx, accounts, refused);
      addShare(entry.employee.employee_id, kiwiSaverItem, pay.kiwiSaverEmployer, shares);
    }
  }

  const debits = [...groups.values()].sort((a, b) => a.rank - b.rank || a.order - b.order);
  const totals = totalsOf(calculated);
  const kiwiSaverPayable = add(dec(totals.kiwiSaverEmployee), calculated.reduce((total, entry) => add(total, dec(entry.pay!.kiwiSaverEmployerNet)), ZERO_DECIMAL));
  const credits: Array<{ accountCode: string; amount: string; description: string }> = [];
  const credit = async (control: ControlAccount, amount: string, description: string) => {
    if (isZero(dec(amount))) return;
    credits.push({ accountCode: await controlAccountCode(tx, control, `pay runs can't be approved`), amount, description });
  };
  await credit(PAYE_ACCOUNT, totals.paye, "PAYE");
  await credit(STUDENT_LOAN_ACCOUNT, totals.studentLoan, "Student loan");
  await credit(KIWISAVER_ACCOUNT, toFixedString(kiwiSaverPayable, 2), "KiwiSaver");
  await credit(ESCT_ACCOUNT, totals.esct, "ESCT");
  for (const { item, amount } of [...deductions.values()].sort((a, b) => a.item.rank - b.item.rank)) {
    if (!isZero(amount)) credits.push({ accountCode: item.accountCode, amount: toFixedString(amount, 2), description: item.name });
  }
  await credit(WAGES_ACCOUNT, totals.netPay, "Net pay");
  if (debits.length + credits.length > 500) {
    throw new ValidationError(`${NOT_SUPPORTED}: a pay run whose journal would have more than 500 lines.`);
  }

  const posted = await postJournalBody(
    tx,
    "payroll:approval",
    run.id,
    parseJournalBody(
      tx,
      {
        postingDate: run.pay_date,
        reference,
        description: `Pay run ${reference}: ${run.pay_group_name}, ${run.period_start} to ${run.period_end}`,
        lines: [
          ...debits.map((group) => ({
            accountCode: group.accountCode,
            debitAmount: toFixedString(group.amount, 2),
            creditAmount: "0",
            description: group.description,
            tracking: group.tags,
          })),
          ...credits.map((line) => ({ accountCode: line.accountCode, debitAmount: "0", creditAmount: line.amount, description: line.description })),
        ],
      },
      { internal: true },
    ),
    { origin: "payroll" },
  );

  for (const entry of calculated) {
    const pay = entry.pay!;
    await tx.query(
      `update payroll_pay_run_employees
          set employee_name = $3, tax_code = $4, student_loan = $5, kiwisaver_status = $6, kiwisaver_employee_rate = $7,
              kiwisaver_employer_rate = $8, esct_rate = $9, gross = $10, taxable_earnings = $11, non_taxable_earnings = $12,
              kiwisaver_earnings = $13, paye = $14, student_loan_deduction = $15, kiwisaver_employee = $16, deductions = $17,
              net_pay = $18, kiwisaver_employer = $19, esct = $20, kiwisaver_employer_net = $21, employer_cost = $22,
              extra_pay = $23, extra_pay_tax = $24, extra_pay_tax_rate = $25, extra_pay_method = $26, extra_pay_annualised = $27,
              lump_sum_lowest_rate = $28, finish_date = $29,
              bank_account_ciphertext = (select e.bank_account_ciphertext from payroll_employees e where e.id = $2),
              kiwisaver_reduction_from = $30, kiwisaver_reduction_to = $31
        where pay_run_id = $1 and employee_id = $2`,
      [
        run.id,
        entry.employee.employee_id,
        entry.employee.name,
        entry.employee.tax_code,
        entry.employee.student_loan,
        entry.employee.kiwisaver_status,
        entry.employee.kiwisaver_employee_rate,
        entry.employee.kiwisaver_employer_rate,
        entry.employee.esct_rate,
        pay.gross,
        pay.taxableEarnings,
        pay.nonTaxableEarnings,
        pay.kiwiSaverEarnings,
        pay.paye,
        pay.studentLoan,
        pay.kiwiSaverEmployee,
        pay.deductions,
        pay.netPay,
        pay.kiwiSaverEmployer,
        pay.esct,
        pay.kiwiSaverEmployerNet,
        pay.employerCost,
        pay.extraPay,
        pay.extraPayTax,
        pay.extraPayTaxRate,
        isPositive(dec(pay.extraPay)) ? (entry.basis?.method ?? null) : null,
        isPositive(dec(pay.extraPay)) ? (entry.basis?.annualised ?? null) : null,
        pay.lumpSumLowestRate,
        entry.finishDate,
        entry.employee.kiwisaver_reduction_from,
        entry.employee.kiwisaver_reduction_to,
      ],
    );
  }
  const lineOrder = new Map(debits.map((group, index) => [group.key, index + 1]));
  for (const [index, posting] of postings.entries()) {
    await tx.query(
      `insert into payroll_pay_run_postings (pay_run_id, posting_number, employee_id, pay_item_id, account_id, tracking, project_id,
                                             percentage, amount, journal_line_order, share_number)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
      [
        run.id,
        index + 1,
        posting.employeeId,
        posting.payItemId,
        posting.accountId,
        JSON.stringify(posting.tags),
        posting.projectId,
        posting.percentage,
        posting.amount,
        lineOrder.get(posting.group),
        posting.shareNumber,
      ],
    );
  }
  // What each employee's costs were split by, and the timesheets used.
  for (const [employeeId, shares] of employeeShares) {
    for (const [index, share] of shares.entries()) {
      await tx.query(
        `insert into payroll_pay_run_shares (pay_run_id, employee_id, share_number, source, allocation_id, allocation_percentage, hours,
                                            weight, percentage, tracking, department_id, project_id, rd_activity_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
        [
          run.id,
          employeeId,
          index + 1,
          share.source,
          share.allocationId,
          share.allocationPercentage,
          share.hours,
          share.weight,
          share.percentage,
          JSON.stringify(share.tags),
          share.departmentId,
          share.projectId,
          share.rdActivityId,
        ],
      );
    }
  }
  for (const timesheetId of usedTimesheets) {
    await tx.query("insert into payroll_pay_run_timesheets (pay_run_id, timesheet_id) values ($1, $2)", [run.id, timesheetId]);
  }
  try {
    await tx.query(
      `update payroll_pay_runs
          set status = 'approved', approval_journal_id = $2, approve_command_source = $3, approve_idempotency_key = $4,
              approve_request_hash = $5, approved_by_user_id = $6, approved_by_email = $7, approved_at = now(), updated_at = now()
        where id = $1`,
      [run.id, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different pay run approval. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.approved",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference, payDate: run.pay_date, journalId: posted.journal.id, employeeCount: calculated.length },
  });
  return { created: true, payRun: await getPayRun(tx, run.id) };
}

async function kiwiSaverEmployerItem(
  tx: OrgTx,
  accounts: Map<string, ItemAccount | { id: string; name: string; missing: true }>,
  refused: string,
): Promise<ItemAccount> {
  const result = await tx.query<{ id: string }>("select id from payroll_pay_items where is_system and kind = 'kiwisaver_employer'");
  if (!result.rows[0]) {
    throw new ValidationError(`There's no KiwiSaver employer contribution pay item, so ${refused}. Set it up under Payroll › Pay items.`);
  }
  return accountFor(accounts.get(result.rows[0].id), refused);
}

/**
 * An employee's shares of their costs (PRUN1; TS5, TS6): approved
 * timesheets' rows for the days they cover, and the cost allocation in
 * effect on the pay date for the rest and for "other work" hours (100%
 * untagged before their first allocation), each with its weight (decision
 * 98). Department, Class and Location are tracking tags when advanced
 * features are on. A required category missing from a share is refused.
 */
async function sharesFor(
  tx: OrgTx,
  ctx: Awaited<ReturnType<typeof loadTrackingContext>>,
  employee: EmployeeRow,
  payDate: string,
  coverage: TimesheetCoverage,
): Promise<Share[]> {
  const tagsFor = (valueIds: Array<string | null>): TrackingTags => {
    const tags: TrackingTags = {};
    if (ctx.advancedFeatures) {
      for (const valueId of valueIds) {
        if (!valueId) continue;
        const value = ctx.values.get(valueId);
        if (value) tags[value.categoryId] = value.id;
      }
    }
    return sortedTags(tags);
  };
  const allocation = await allocationOn(tx, employee.employee_id, payDate);
  const lines = allocation
    ? allocation.lines.map((line) => ({
        percentage: line.percentage,
        tags: tagsFor([line.departmentId, line.classId, line.locationId]),
        departmentId: line.departmentId,
        projectId: line.projectId,
        projectName: line.projectName,
        rdActivityId: line.rdActivityId,
        allocationId: allocation.id,
      }))
    : [{ percentage: "100", tags: {}, departmentId: null, projectId: null, projectName: null, rdActivityId: null, allocationId: null }];
  const weights = timesheetWeights({
    periodDays: coverage.periodDays,
    coveredDays: coverage.coveredDays,
    rows: coverage.rows.map((row, index) => ({ key: `t${index}`, hours: row.hours })),
    otherHours: coverage.otherHours,
    allocation: lines.map((line, index) => ({ key: `a${index}`, percentage: line.percentage })),
  });
  const total = toFixedString(sum(weights.map((weight) => dec(weight.weight))), 8);
  const shares: Share[] = weights.map((weight) => {
    const index = Number(weight.key.slice(1));
    const percentage = percentageOfWeight(weight.weight, total);
    if (weight.source === "timesheet") {
      const row = coverage.rows[index];
      return {
        source: "timesheet",
        weight: weight.weight,
        percentage,
        tags: tagsFor([row.departmentId]),
        departmentId: row.departmentId,
        projectId: row.projectId,
        projectName: row.projectName,
        rdActivityId: row.rdActivityId,
        hours: row.hours,
        allocationId: null,
        allocationPercentage: null,
      };
    }
    const line = lines[index];
    return {
      source: "allocation",
      weight: weight.weight,
      percentage,
      tags: line.tags,
      departmentId: line.departmentId,
      projectId: line.projectId,
      projectName: line.projectName,
      rdActivityId: line.rdActivityId,
      hours: null,
      allocationId: line.allocationId,
      allocationPercentage: toFixedString(dec(line.percentage), 2),
    };
  });
  for (const share of shares) {
    const missing = missingRequired(ctx, share.tags, "expense");
    if (missing) {
      throw new ValidationError(
        share.source === "timesheet"
          ? `${employee.name}'s approved timesheet has hours with no ${missing}, and expense lines need one. Reopen the timesheet under Payroll › Timesheets and add one.`
          : `${employee.name}'s cost allocation on ${payDate} has no ${missing}, and expense lines need one. Fix it under Employees › Cost allocation.`,
      );
    }
  }
  return shares;
}

/** Voids an approved pay run (PRUN6): posts the exact reversal of its journal on the void date. */
export async function voidPayRun(
  tx: OrgTx,
  runIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; payRun: PayRun }> {
  await requirePayrollAccess(tx);
  const id = parseUuid(runIdInput, "pay run");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "Void date");
  const hash = requestHash("payroll_pay_run_void", { id, voidDate });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; void_request_hash: string }>(
      "select id, void_request_hash from payroll_pay_runs where void_command_source = $1 and void_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].void_request_hash, hash, "pay run void");
    return { created: false, payRun: await getPayRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const run = await findRun(tx, id, true);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const reference = payRunReference(run.run_number);
  if (run.status === "voided") throw new ConflictError(`${reference} has already been voided.`);
  if (run.status !== "approved") throw new ConflictError(`${reference} isn't approved, so there's nothing to void. Delete the draft instead.`);
  if (voidDate < run.pay_date) throw new ValidationError(`The void date can't be before the pay date (${run.pay_date}).`);
  // Undo in order (PPAY3, PPAY12): wage payments, then IRD payments for its period, then the pay run.
  const wagePayments = await tx.query<{ payment_number: string }>(
    "select payment_number::text from payroll_wage_payments where pay_run_id = $1 and status = 'active' order by payroll_wage_payments.payment_number",
    [run.id],
  );
  if (wagePayments.rows.length > 0) {
    throw new ConflictError(`${reference} has wage payments (${wagePayments.rows.map((row) => `WAGES-${row.payment_number}`).join(", ")}). Void them first.`);
  }
  const irdPayments = await tx.query<{ payment_number: string; period_start: string; period_end: string }>(
    `select payment_number::text, period_start::text, period_end::text from payroll_ird_payments
      where status = 'active' and period_start <= $1 and period_end >= $1 order by payroll_ird_payments.payment_number`,
    [run.pay_date],
  );
  if (irdPayments.rows.length > 0) {
    const first = irdPayments.rows[0];
    const names = irdPayments.rows.map((row) => `IRD-${row.payment_number}`).join(", ");
    throw new ConflictError(
      `${names} ${irdPayments.rows.length === 1 ? "pays" : "pay"} ${first.period_start} to ${first.period_end}, which includes ${reference}'s pay date. Void ${irdPayments.rows.length === 1 ? "it" : "them"} first.`,
    );
  }
  const original = await getJournal(tx, run.approval_journal_id!);
  const posted = await postJournalBody(
    tx,
    "payroll:void",
    run.id,
    parseJournalBody(
      tx,
      {
        postingDate: voidDate,
        reference: `VOID-${original.reference}`.slice(0, 100),
        description: `Void of pay run ${reference}: ${run.pay_group_name}, ${run.period_start} to ${run.period_end}`,
        lines: original.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
          description: line.description,
          tracking: line.tracking,
        })),
      },
      { internal: true },
    ),
    { origin: "payroll", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  try {
    await tx.query(
      `update payroll_pay_runs
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4, void_idempotency_key = $5,
              void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now(), updated_at = now()
        where id = $1`,
      [run.id, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different pay run void. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_pay_run.voided",
    entityType: "payroll_pay_run",
    entityId: run.id,
    details: { reference, voidDate, journalId: posted.journal.id },
  });
  return { created: true, payRun: await getPayRun(tx, run.id) };
}

/** Each employee's share of each debit line of an approved pay run's journal (PRUN1). Payroll access only. */
export async function listPayRunPostings(tx: OrgTx, runIdInput: unknown): Promise<PayRunPosting[]> {
  await requirePayrollAccess(tx);
  const run = await findRun(tx, runIdInput);
  const result = await tx.query<{
    posting_number: number;
    employee_id: string;
    employee_name: string;
    pay_item_name: string;
    account_code: string;
    tracking: TrackingTags;
    project_id: string | null;
    percentage: string;
    amount: string;
    journal_line_order: number;
  }>(
    `select p.posting_number, p.employee_id, pe.employee_name, i.name as pay_item_name, a.code as account_code, p.tracking,
            p.project_id::text, p.percentage::text, p.amount::text, p.journal_line_order
       from payroll_pay_run_postings p
       join payroll_pay_run_employees pe on pe.pay_run_id = p.pay_run_id and pe.employee_id = p.employee_id
       join payroll_pay_items i on i.id = p.pay_item_id
       join accounts a on a.id = p.account_id
      where p.pay_run_id = $1
      order by p.posting_number`,
    [run.id],
  );
  return result.rows.map((row) => ({
    postingNumber: row.posting_number,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    payItemName: row.pay_item_name,
    accountCode: row.account_code,
    tracking: row.tracking,
    projectId: row.project_id,
    percentage: trimRate(row.percentage),
    amount: toFixedString(dec(row.amount), 2),
    journalLineOrder: row.journal_line_order,
  }));
}
