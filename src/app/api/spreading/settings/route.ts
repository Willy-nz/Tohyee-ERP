import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getSpreadingSettings, saveSpreadingSettings } from "@/lib/spreading/service";

/** GET: the account each kind is held in; all null until Spreading is turned on. */
export const GET = route(async (request) => {
  const settings = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getSpreadingSettings(tx));
  return json({ settings });
});

/** Turns Spreading on, or changes the account a kind is held in. Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => saveSpreadingSettings(tx, body));
  return json({ settings });
});
