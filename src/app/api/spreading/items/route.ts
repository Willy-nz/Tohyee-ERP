import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createSpreadItem } from "@/lib/spreading/service";

/** Adds something to spread (SW1-SW7, SW12, SW13). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createSpreadItem(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
