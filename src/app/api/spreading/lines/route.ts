import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { getSpreadingSettings } from "@/lib/spreading/service";
import { listSourceLines } from "@/lib/spreading/sources";
import { requireId } from "@/lib/validation";

/** GET: a bill's (`billId`) or invoice's (`invoiceId`) lines for "Spread this" (SW15, SW16), and the account they'd be held in. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const billId = params.get("billId");
  const invoiceId = params.get("invoiceId");
  if (Boolean(billId) === Boolean(invoiceId)) throw new ValidationError("Give a billId or an invoiceId.");
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const settings = await getSpreadingSettings(tx);
    const sourceKind = billId ? "bill" : "invoice";
    const holding = settings[billId ? "prepayment" : "income_in_advance"];
    const lines = await listSourceLines(tx, sourceKind, requireId(billId ?? invoiceId, billId ? "billId" : "invoiceId"));
    return { holding, lines };
  });
  return json(result);
});
