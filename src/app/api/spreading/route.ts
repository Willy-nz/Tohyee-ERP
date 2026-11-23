import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { explainSpreadDifference } from "@/lib/spreading/explain";
import { previewSpreadMonth } from "@/lib/spreading/runs";
import { getSpreadWorksheet } from "@/lib/spreading/service";

/** GET: the worksheet (SW11); with `kind` and `month`, what posting that month would do; with `kind` and `explain`, what's behind an "Out by" (SW24). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const kind = params.get("kind");
  const month = params.get("month");
  if (kind && params.get("explain")) {
    const explain = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => explainSpreadDifference(tx, kind));
    return json({ explain });
  }
  if (kind && month) {
    const preview = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => previewSpreadMonth(tx, kind, month));
    return json({ preview });
  }
  const worksheet = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => getSpreadWorksheet(tx));
  return json({ worksheet });
});
