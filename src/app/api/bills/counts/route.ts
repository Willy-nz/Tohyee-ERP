import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { countBillsByTab } from "@/lib/bills/service";

/** How many bills each tab of the list holds. Query: organisationId. */
export const GET = route(async (request) => {
  const counts = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => countBillsByTab(tx));
  return json(counts);
});
