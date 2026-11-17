import { json, readJson, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { businessProfile } from "@/lib/analytics/business-profile";

/** POST: loads Business Profile now and waits until it's done (Refresh now). Admins and owners. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  return json({ run: await businessProfile.refresh(organisation, actor, "manual") });
});
