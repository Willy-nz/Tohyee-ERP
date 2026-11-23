import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setMySearchEmail } from "@/lib/saved-searches/service";

type Context = { params: Promise<{ searchId: string }> };

/** Sets how the person asking has this search emailed to them: frequency (daily, weekly, monthly, or never) and onlyWhen (always, has_rows, new_rows). */
export const PUT = route<Context>(async (request, context) => {
  const { searchId } = await context.params;
  const body = await readJson(request);
  const search = await withOrganisation(request, body.organisationId, "viewer", (tx) => setMySearchEmail(tx, searchId, body));
  return json({ search });
});
