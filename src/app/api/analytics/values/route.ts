import { route, withOrganisation } from "@/lib/api/http";
import { valuesRead } from "@/lib/analytics/read-routes";

/** The values a slicer offers (src/lib/analytics/read-routes.ts). */
export const GET = route(valuesRead(withOrganisation));
