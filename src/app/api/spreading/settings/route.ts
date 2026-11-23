import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { saveSpreadingSettings } from "@/lib/spreading/service";

/** Turns Spreading on, or changes the account a kind is held in. Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => saveSpreadingSettings(tx, body));
  return json({ settings });
});
