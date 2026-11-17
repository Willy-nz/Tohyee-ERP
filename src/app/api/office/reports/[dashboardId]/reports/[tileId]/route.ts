import { placedReportRead } from "@/lib/analytics/read-routes";
import { officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/** GET: an accounting report placed on a report's page, for the PowerPoint add-in. */
export const GET = officeRoute(placedReportRead(withOfficeOrganisation));
