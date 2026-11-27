import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { practiseSwitchOver } from "@/lib/backup-server/practice";

/** Practise a switch-over: checks everything one needs, without switching. Server admins, on the backup server's computer. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ practice: await practiseSwitchOver(auth) });
});
