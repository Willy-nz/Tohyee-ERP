import { json, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listGadsAccounts } from "@/lib/analytics/google-ads";

/** GET: the ads accounts the connected Google account can see, to choose one. Admins and owners. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  return json({ accounts: await listGadsAccounts(organisation, actor) });
});
