import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { postSpreadMonth } from "@/lib/spreading/runs";

/** Posts a kind's month as one journal on the month end (SW1, SW14). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => postSpreadMonth(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
