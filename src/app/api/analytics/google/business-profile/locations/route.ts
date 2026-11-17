import { json, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listGbpLocations } from "@/lib/analytics/business-profile";

/** GET: the business profiles (locations) the connected Google account can see, to choose one. Admins and owners. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  return json({ locations: await listGbpLocations(organisation, actor) });
});
