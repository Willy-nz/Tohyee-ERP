import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addProvisionalEstimate } from "@/lib/tax/income/provisional-option-store";

/** POST: an estimate of the year's residual income tax given to IRD, under the estimation option (owners and admins; TXF15). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    addProvisionalEstimate(tx, { idempotencyKey: body.idempotencyKey, incomeYear: body.incomeYear, estimatedOn: body.estimatedOn, amount: body.amount, note: body.note }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
