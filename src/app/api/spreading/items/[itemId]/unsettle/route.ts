import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { unsettleSpreadItem } from "@/lib/spreading/service";

type Context = { params: Promise<{ itemId: string }> };

/** Undoes "bill arrived" or "invoice sent" on an accrual, until its difference has posted (SW21). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => unsettleSpreadItem(tx, itemId));
  return json({ item });
});
