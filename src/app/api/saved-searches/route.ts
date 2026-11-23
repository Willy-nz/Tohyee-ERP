import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listSavedSearches, saveSavedSearch } from "@/lib/saved-searches/service";

/** GET: this person's saved searches and the shared ones. */
export const GET = route(async (request) => {
  const searches = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listSavedSearches(tx));
  return json({ searches });
});

/** Saves a new search, or changes one when `id` is given. Sharing is for bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const search = await withOrganisation(request, body.organisationId, "viewer", (tx) => saveSavedSearch(tx, body));
  return json({ search }, { status: body.id ? 200 : 201 });
});
