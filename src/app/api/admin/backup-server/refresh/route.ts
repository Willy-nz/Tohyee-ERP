import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { copiesState, refreshCopies } from "@/lib/backup-server/refresh";

/** Takes whatever is new in the main's backups folder now, without waiting for the next look. Server admins, on the backup server's computer. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const result = await refreshCopies();
  return json({ result, copies: await copiesState() });
});
