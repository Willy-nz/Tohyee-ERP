import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { chargeLateFees } from "@/lib/invoices/late-fees";

/** POST { asOf?, invoiceIds? }: makes the late payment invoices for what's due (LATE3), drafts unless the settings say approve. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => chargeLateFees(tx, { asOf: body.asOf, invoiceIds: body.invoiceIds }));
  return json(result);
});
