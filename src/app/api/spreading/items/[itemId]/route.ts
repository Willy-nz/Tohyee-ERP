import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeSpreadItem } from "@/lib/spreading/service";

type Context = { params: Promise<{ itemId: string }> };

/** Takes an item off the worksheet, before anything has posted for it. Bookkeepers and above. */
export const DELETE = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeSpreadItem(tx, itemId));
  return json({ removed: true });
});
