import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { dismissSpreadSuggestion } from "@/lib/spreading/suggestions";

/** POST `{ key }`: "Not this one" (SW28), so a suggestion doesn't come back. Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => dismissSpreadSuggestion(tx, body));
  return json({ ok: true });
});
