import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { countInvoicesByTab } from "@/lib/invoices/service";

/** How many invoices each tab of the list holds. Query: organisationId. */
export const GET = route(async (request) => {
  const counts = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => countInvoicesByTab(tx));
  return json(counts);
});
