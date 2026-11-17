import { json, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listGmcAccounts } from "@/lib/analytics/merchant-center";

/** GET: the Merchant Center accounts the connected Google account can see, to choose one (GMC2). Admins and owners. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  return json({ accounts: await listGmcAccounts(organisation, actor) });
});
