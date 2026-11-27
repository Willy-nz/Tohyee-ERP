import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { watchForMainGoneQuiet } from "@/lib/backup-server/alerts";
import { getBackupServerSettings, pairAsBackupServer, unpairBackupServer } from "@/lib/backup-server/mode";
import { lastPractice, mainReach } from "@/lib/backup-server/practice";
import { copiesState, KEEP_REMOVED_DAYS } from "@/lib/backup-server/refresh";

/** GET: whether this is a main or a backup server, and its pairing. Server admins, on the server computer. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const backupServer = await getBackupServerSettings();
  const backup = backupServer.role === "backup";
  return json({ backupServer, main: backup ? await mainReach() : null, practice: backup ? await lastPractice() : null, copies: backupServer.role === "backup" ? await copiesState() : null, quiet: backupServer.role === "backup" ? await watchForMainGoneQuiet().catch(() => null) : null, keepRemovedDays: KEEP_REMOVED_DAYS });
});

/** Makes this a backup server for another Tohyee: `folder`, and the main's recovery `key` (code) or `kitFile` and `passphrase`. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ backupServer: await pairAsBackupServer(auth, await readJson(request, { maxBytes: 256 * 1024 })) });
});

/** Undoes a pairing that holds no organisations yet. */
export const DELETE = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ backupServer: await unpairBackupServer(auth) });
});
