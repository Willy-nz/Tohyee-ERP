import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { changeSpreadItem } from "@/lib/spreading/change";

type Context = { params: Promise<{ itemId: string }> };

/** POST `{ endDate?, left? }`: moves an item's last day, or changes what's still to come on an accrual (SW29, SW30). Posted months don't change. Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => changeSpreadItem(tx, itemId, body));
  return json({ item });
});
