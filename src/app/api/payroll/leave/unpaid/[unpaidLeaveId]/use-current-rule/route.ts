import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { applyCurrentAnniversaryRule } from "@/lib/payroll/unpaid-leave-rule";

type Context = { params: Promise<{ unpaidLeaveId: string }> };

/** Moves unpaid leave recorded under the earlier whole-period rule to the current rule (TXF11). Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { unpaidLeaveId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => applyCurrentAnniversaryRule(tx, unpaidLeaveId));
  return json(result);
});
