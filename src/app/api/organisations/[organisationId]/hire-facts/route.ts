import { json, route, withOrganisation } from "@/lib/api/http";
import { hireFacts } from "@/lib/organisations/hire-facts";

type Context = { params: Promise<{ organisationId: string }> };

/** GET: counts and periods from the books for a hiring brief. Owners and admins, who invite people. */
export const GET = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const facts = await withOrganisation(request, organisationId, "admin", (tx) => hireFacts(tx));
  return json({ facts });
});
