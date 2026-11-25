import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError } from "@/lib/errors";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { updateDraftsCovering } from "@/lib/payroll/leave-pay-runs";
import { toUnpaid, UNPAID_COLUMNS, type UnpaidLeaveRecord, type UnpaidRow, uuid } from "@/lib/payroll/leave-records";

/**
 * Moves unpaid leave recorded under Tohyee's earlier whole-period rule to the current rule (TXF11): from then on it
 * moves the anniversary only by the part over one week (TXF10). A person does this after checking it; it's audited,
 * draft pay runs from the leave's start are worked out again, and approved pay runs don't change.
 */
export async function applyCurrentAnniversaryRule(tx: OrgTx, idInput: unknown): Promise<{ unpaidLeave: UnpaidLeaveRecord; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const id = uuid(idInput, "unpaid leave");
  const result = await tx.query<UnpaidRow>(
    `update payroll_unpaid_leave set anniversary_rule = 'over_one_week', anniversary_rule_changed_at = now(), anniversary_rule_changed_by_email = $2
      where id = $1 and status = 'active' and anniversary_rule = 'whole_period'
      returning ${UNPAID_COLUMNS}`,
    [id, tx.actor.email],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("That unpaid leave wasn't found, or it already uses the current rule.");
  await writeAuditEvent(tx, {
    eventType: "payroll_unpaid_leave.anniversary_rule_changed",
    entityType: "payroll_employee",
    entityId: row.employee_id,
    details: { id, startDate: row.start_date, endDate: row.end_date, from: "whole_period", to: "over_one_week" },
  });
  const payRuns = await updateDraftsCovering(tx, row.employee_id, row.start_date, "9999-12-31");
  return { unpaidLeave: toUnpaid(row), payRuns };
}
