import { route, withOrganisation } from "@/lib/api/http";
import { directoryRead } from "@/lib/analytics/read-routes";

/** GET: the organisation's directory for a directory item on a report's page (src/lib/analytics/read-routes.ts). */
export const GET = route(directoryRead(withOrganisation));
