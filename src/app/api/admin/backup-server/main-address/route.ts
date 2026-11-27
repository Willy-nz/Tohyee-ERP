import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { setMainAddress } from "@/lib/backup-server/practice";

/** The main server's outside address (`url`), so the backup server can tell when it can't be reached. Empty turns the check off. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ main: await setMainAddress(auth, await readJson(request)) });
});
