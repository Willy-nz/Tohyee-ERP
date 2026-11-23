import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { getSpreadingSettings, listOpenAccruals } from "@/lib/spreading/service";
import { listSourceLines, type SourceKind } from "@/lib/spreading/sources";
import { requireId } from "@/lib/validation";

/**
 * GET: a bill's (`billId`), invoice's (`invoiceId`) or bank transaction's
 * (`bankTransactionId`) lines for "Spread this" (SW15, SW16, SW19), the
 * account they'd be held in, and the accruals one could be the bill or
 * invoice for (SW20).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const given = (
    [
      ["bill", params.get("billId")],
      ["invoice", params.get("invoiceId")],
      ["bank", params.get("bankTransactionId")],
    ] as Array<[SourceKind, string | null]>
  ).filter(([, id]) => id);
  if (given.length !== 1) throw new ValidationError("Give a billId, an invoiceId or a bankTransactionId.");
  const [sourceKind, documentId] = given[0];
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const settings = await getSpreadingSettings(tx);
    const lines = await listSourceLines(tx, sourceKind, requireId(documentId, "documentId"));
    const first = lines[0];
    if (!first || !settings[first.kind]) return { holding: null, lines, accruals: [] };
    return { holding: settings[first.kind], lines, accruals: await listOpenAccruals(tx, first.accrualKind) };
  });
  return json(result);
});
