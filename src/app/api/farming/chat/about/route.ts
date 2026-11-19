import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { chatAbout } from "@/lib/farming/chat";

/** GET: messages about a paddock, mob or task (`kind`, `recordId`), newest first (FCH4). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const messages = await withFarmWork(request, params.get("organisationId"), "read", (tx) => chatAbout(tx, params.get("kind"), params.get("recordId")));
  return json({ messages });
});
