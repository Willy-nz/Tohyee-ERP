import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setTeamChatEnabled } from "@/lib/chat/team";

/** PATCH: turns Chat on or off (`enabled`) (TCH1). Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => setTeamChatEnabled(tx, { enabled: body.enabled }));
  return json({ settings });
});
