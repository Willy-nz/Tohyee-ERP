import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteSavedSearch } from "@/lib/saved-searches/service";

type Context = { params: Promise<{ searchId: string }> };

/** Deletes a saved search: its maker, or an admin. Nothing in the books changes. */
export const DELETE = route<Context>(async (request, context) => {
  const { searchId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => deleteSavedSearch(tx, searchId));
  return json({ deleted: true });
});
