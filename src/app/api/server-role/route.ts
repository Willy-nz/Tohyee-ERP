import { json, requireAuth, route } from "@/lib/api/http";
import { serverRole } from "@/lib/backup-server/mode";
import { switchOverPreview } from "@/lib/backup-server/switch";

/** Whether this is the main server or a backup copy, for the banner every page shows on a backup server. Anyone signed in. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  const role = await serverRole();
  // On a backup server, whether this person may switch over: their one screen there if they aren't a server admin (BKS15).
  return json({ role, maySwitchOver: role === "backup" ? (await switchOverPreview(auth)).allowed : false });
});
