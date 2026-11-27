import { json, requireAuth, route } from "@/lib/api/http";
import { serverRole } from "@/lib/backup-server/mode";

/** Whether this is the main server or a backup copy, for the banner every page shows on a backup server. Anyone signed in. */
export const GET = route(async (request) => {
  await requireAuth(request);
  return json({ role: await serverRole() });
});
