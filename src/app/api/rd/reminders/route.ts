import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { rdReminders } from "@/lib/rd/claim";

/** GET: RDTI deadline reminders due now (owners and admins; RD25). */
export const GET = route(async (request) => {
  const reminders = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => rdReminders(tx));
  return json({ reminders });
});
