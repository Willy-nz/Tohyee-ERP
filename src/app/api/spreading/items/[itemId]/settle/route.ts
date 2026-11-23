import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { settleSpreadItem } from "@/lib/spreading/service";

type Context = { params: Promise<{ itemId: string }> };

/** An accrual's bill or invoice has arrived (SW6, SW7). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => settleSpreadItem(tx, itemId, body));
  return json({ item });
});
