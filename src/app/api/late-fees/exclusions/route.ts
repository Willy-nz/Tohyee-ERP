import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setLateFeeExclusion } from "@/lib/invoices/late-fees";

/** POST { contactId, excluded }: an admin says a customer is never charged late fees, or is again (LATE11). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const exclusions = await withOrganisation(request, body.organisationId, "admin", (tx) => setLateFeeExclusion(tx, body.contactId, body.excluded !== false));
  return json({ exclusions });
});
