import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setProvisionalOption } from "@/lib/tax/income/provisional-option-store";

/** PUT: the provisional tax option for an income year, with IRD's ratio for the ratio option (owners and admins; TXF14-TXF17). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const option = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    setProvisionalOption(tx, { incomeYear: body.incomeYear, option: body.option, ratioPercent: body.ratioPercent, version: body.version }),
  );
  return json({ option });
});
