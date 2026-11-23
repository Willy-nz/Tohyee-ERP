import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { homeSearches } from "@/lib/saved-searches/service";

/** GET: the saved searches shown on this person's Home, each with how many match now. */
export const GET = route(async (request) => {
  const searches = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => homeSearches(tx));
  return json({ searches });
});
