import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError,NotFoundError,ValidationError } from "@/lib/errors";
import type { PayFrequency } from "@/lib/payroll/groups";
import { payRunReference } from "@/lib/payroll/pay-run-reference";
import { type DraftRun } from "@/lib/payroll/leave-pay-runs";
import { PayRunStatus,PayRunSummary } from "@/lib/payroll/pay-runs/types";

export type RunRow = {
  id: string;
  run_number: string;
  command_source: string;
  request_hash: string;
  pay_group_id: string;
  pay_group_name: string;
  pay_frequency: PayFrequency;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: PayRunStatus;
  employee_count: string;
  created_by_email: string;
  prepared_by_user_ids: string[];
  approval_journal_id: string | null;
  approve_request_hash: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  void_date: string | null;
  void_journal_id: string | null;
  void_request_hash: string | null;
  voided_by_email: string | null;
};

export const RUN_COLUMNS = `r.id, r.run_number::text, r.command_source, r.request_hash, r.pay_group_id, g.name as pay_group_name,
  r.pay_frequency, r.period_start::text, r.period_end::text, r.pay_date::text, r.status,
  (select count(*) from payroll_pay_run_employees e where e.pay_run_id = r.id)::text as employee_count,
  r.created_by_email, r.prepared_by_user_ids::text[] as prepared_by_user_ids, r.approval_journal_id::text,
  r.approve_request_hash, r.approved_by_email, r.approved_at::text, r.void_date::text, r.void_journal_id::text,
  r.void_request_hash, r.voided_by_email`;

export const RUN_FROM = "payroll_pay_runs r join payroll_pay_groups g on g.id = r.pay_group_id";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toSummary(row: RunRow): PayRunSummary {
  return {
    id: row.id,
    reference: payRunReference(row.run_number),
    payGroupId: row.pay_group_id,
    payGroupName: row.pay_group_name,
    payFrequency: row.pay_frequency,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    payDate: row.pay_date,
    status: row.status,
    employeeCount: Number(row.employee_count),
    createdByEmail: row.created_by_email,
    approvedByEmail: row.approved_by_email,
    approvedAt: row.approved_at,
    voidDate: row.void_date,
    voidedByEmail: row.voided_by_email,
  };
}

export function parseUuid(input: unknown, what: string): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) throw new NotFoundError(`That ${what} wasn't found.`);
  return input;
}

export async function findRun(tx: OrgTx, idInput: unknown, forUpdate = false): Promise<RunRow> {
  const id = parseUuid(idInput, "pay run");
  if (forUpdate) await tx.query("select 1 from payroll_pay_runs where id = $1 for update", [id]);
  const result = await tx.query<RunRow>(`select ${RUN_COLUMNS} from ${RUN_FROM} where r.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("That pay run wasn't found.");
  return result.rows[0];
}

export function assertDraft(run: RunRow): void {
  if (run.status !== "draft") {
    const reference = payRunReference(run.run_number);
    throw new ConflictError(
      run.status === "approved"
        ? `${reference} is approved, so it can't be changed. Void it and run the pay again.`
        : `${reference} is voided, so it can't be changed. Run the pay again.`,
    );
  }
}

export function toDraftRun(run: RunRow): DraftRun {
  return { id: run.id, run_number: run.run_number, period_start: run.period_start, period_end: run.period_end, pay_frequency: run.pay_frequency, status: run.status };
}

export async function markPrepared(tx: OrgTx, runId: string): Promise<void> {
  await tx.query(
    `update payroll_pay_runs
        set prepared_by_user_ids = case when $2::uuid is null or $2::uuid = any(prepared_by_user_ids) then prepared_by_user_ids
                                        else array_append(prepared_by_user_ids, $2::uuid) end,
            updated_at = now()
      where id = $1`,
    [runId, tx.actor.userId],
  );
}

export async function approverMustDiffer(tx: OrgTx): Promise<boolean> {
  const result = await tx.query<{ payroll_approver_must_differ: boolean }>(
    "select payroll_approver_must_differ from organisation_settings where id = true",
  );
  return result.rows[0]?.payroll_approver_must_differ ?? false;
}

export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

export function parseUuidField(input: unknown, index: number): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) throw new ValidationError(`Line ${index + 1}: choose a pay item.`);
  return input;
}
