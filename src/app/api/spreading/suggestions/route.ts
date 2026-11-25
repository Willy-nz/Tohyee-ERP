import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listSpreadSuggestions } from "@/lib/spreading/suggestions";

/** GET: what Tohyee has noticed that could be spread or accrued (SW26, SW27). Worked out each time; nothing is saved. */
export const GET = route(async (request) => {
  const suggestions = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listSpreadSuggestions(tx));
  return json({ suggestions });
});
