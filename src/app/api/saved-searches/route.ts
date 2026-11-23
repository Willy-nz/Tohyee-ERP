import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { loadRecordTypes, publicRecordTypes } from "@/lib/saved-searches/org-catalogue";
import { listSavedSearches, saveSavedSearch } from "@/lib/saved-searches/service";

/** GET: this person's saved searches and the shared ones, and what can be searched here (with this organisation's custom fields and tracking). */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => ({
    searches: await listSavedSearches(tx),
    recordTypes: publicRecordTypes(await loadRecordTypes(tx)),
  }));
  return json(result);
});

/** Saves a new search, or changes one when `id` is given. Sharing is for bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const search = await withOrganisation(request, body.organisationId, "viewer", (tx) => saveSavedSearch(tx, body));
  return json({ search }, { status: body.id ? 200 : 201 });
});
