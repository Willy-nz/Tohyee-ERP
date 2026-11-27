import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { getBackupServerSettings } from "@/lib/backup-server/mode";
import { mainAfterAll } from "@/lib/backup-server/switch";

/** On a server that found the main had moved: a server admin says it's the main after all. On the server computer. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  await mainAfterAll(auth);
  return json({ backupServer: await getBackupServerSettings() });
});
