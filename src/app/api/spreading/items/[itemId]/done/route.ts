import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { markSpreadItemDone } from "@/lib/spreading/service";

type Context = { params: Promise<{ itemId: string }> };

/** Marks a "when it's done" item done in a month (SW12). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => markSpreadItemDone(tx, itemId, body));
  return json({ item });
});
