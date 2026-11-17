import { directoryRead } from "@/lib/analytics/read-routes";
import { officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/** GET: the organisation's directory for a report's directory item, for the PowerPoint add-in. */
export const GET = officeRoute(directoryRead(withOfficeOrganisation));
