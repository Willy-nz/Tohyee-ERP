import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { saveLateFeeSettings } from "@/lib/invoices/late-fees";

/** PUT: an admin turns late fees on or off and sets the fee, rate, grace, minimum, accounts and monthly run (LATE1, LATE10). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => saveLateFeeSettings(tx, body));
  return json({ settings });
});
