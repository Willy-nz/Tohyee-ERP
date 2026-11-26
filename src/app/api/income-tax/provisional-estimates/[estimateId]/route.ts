import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeProvisionalEstimate } from "@/lib/tax/income/provisional-option-store";

type Context = { params: Promise<{ estimateId: string }> };

/** DELETE: removes an estimate typed by mistake; the audit log keeps it (owners and admins; TXF15). */
export const DELETE = route<Context>(async (request, context) => {
  const { estimateId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => removeProvisionalEstimate(tx, estimateId));
  return json({ removed: true });
});
