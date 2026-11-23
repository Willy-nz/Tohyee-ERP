import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeSpreadItem, updateSpreadItemTags } from "@/lib/spreading/service";

type Context = { params: Promise<{ itemId: string }> };

/** Takes an item off the worksheet, before anything has posted for it. Bookkeepers and above. */
export const DELETE = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeSpreadItem(tx, itemId));
  return json({ removed: true });
});

/** Changes an item's tracking and custom fields, for the months not yet posted (SW25). Bookkeepers and above. */
export const PUT = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateSpreadItemTags(tx, itemId, body));
  return json({ item });
});
