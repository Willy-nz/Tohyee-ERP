import { freshnessRead } from "@/lib/analytics/read-routes";
import { officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/** GET: how fresh a report's data is, for the PowerPoint add-in. */
export const GET = officeRoute(freshnessRead(withOfficeOrganisation));
