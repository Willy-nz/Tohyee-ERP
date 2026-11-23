import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { importSpreadItems } from "@/lib/spreading/files";

/** Brings items in from a CSV file, all of them or none (SW23). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => importSpreadItems(tx, body));
  return json(result, { status: 201 });
});
