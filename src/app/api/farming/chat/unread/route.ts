import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { chatUnread } from "@/lib/farming/chat";

/** GET: unread messages on each farm this person can see (FCH6). */
export const GET = route(async (request) => {
  const farms = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => chatUnread(tx));
  return json({ farms });
});
