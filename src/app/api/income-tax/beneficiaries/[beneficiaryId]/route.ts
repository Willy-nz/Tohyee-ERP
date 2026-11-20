import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteBeneficiary, updateBeneficiary } from "@/lib/tax/income/beneficiaries";

type Context = { params: Promise<{ beneficiaryId: string }> };

/** PATCH: changes a beneficiary, or archives or restores one with `archived` (TRU2). */
export const PATCH = route<Context>(async (request, context) => {
  const { beneficiaryId } = await context.params;
  const body = await readJson(request);
  const beneficiary = await withOrganisation(request, body.organisationId, "admin", (tx) => updateBeneficiary(tx, beneficiaryId, body));
  return json({ beneficiary });
});

/** DELETE: a beneficiary that's never had income allocated (TRU2). */
export const DELETE = route<Context>(async (request, context) => {
  const { beneficiaryId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => deleteBeneficiary(tx, beneficiaryId));
  return json({ ok: true });
});
