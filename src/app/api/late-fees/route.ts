import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { dueTotals, lateFeesDue, listLateFeeExclusions } from "@/lib/invoices/late-fees";

/** GET: the late fee settings, customers never charged, and what's due to be charged on `asOf` (default today) (LATE1-LATE12). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const worked = await lateFeesDue(tx, { asOf: params.get("asOf") ?? undefined });
    return { ...worked, baseCurrency: tx.baseCurrency, totals: dueTotals(worked.due), exclusions: await listLateFeeExclusions(tx) };
  });
  return json(result);
});
