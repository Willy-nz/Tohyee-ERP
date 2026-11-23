import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { endSpreadItemEarly } from "@/lib/spreading/service";

type Context = { params: Promise<{ itemId: string }> };

/** Ends it early: what's left lands in one month (SW8). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => endSpreadItemEarly(tx, itemId, body));
  return json({ item });
});
