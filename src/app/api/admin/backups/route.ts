import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { recentChecks } from "@/lib/backups/checks";
import { watchForBackupServerGoneQuiet } from "@/lib/backup-server/alerts";
import { readBackupServerReport } from "@/lib/backup-server/refresh";
import { backupOverview } from "@/lib/backups/overview";
import { recoveryKitStatus } from "@/lib/backups/recovery-kit";
import { backUpNow, backupStatus, getBackupSettings, recentBackupRuns, updateBackupSettings } from "@/lib/backups/service";

/**
 * GET: backup settings, the overview (what's known and on what evidence),
 * each database's latest and last good backup, recent attempts and checks,
 * and the files in the folder. Server admins only.
 */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const { overview, files } = await backupOverview();
  const settings = await getBackupSettings();
  return json({
    settings,
    // What a backup server at a second place last said it has taken (BKS12), or null when there isn't one.
    backupServer: await readBackupServerReport(settings.folder),
    backupServerQuiet: await watchForBackupServerGoneQuiet().catch(() => null),
    overview,
    recoveryKit: await recoveryKitStatus(),
    status: await backupStatus(),
    runs: (await recentBackupRuns(30)).map(({ filePath, ...run }) => ({ ...run, fileName: filePath ? relativeName(filePath) : null })),
    checks: await recentChecks(30),
    // Paths on the server stay on the server; files are named relative to the backup folder.
    files: files.map((file) => ({ name: file.name, sizeBytes: file.sizeBytes, header: file.header, problem: file.problem })),
  });
});

/** The last two parts of a backup's path (its database's folder and its name): paths on the server stay on the server. */
function relativeName(filePath: string): string {
  return filePath.split(/[\\/]/).slice(-2).join("/");
}

/** Saves the backup settings: `enabled`, `folder` (blank = the default), `time` (HH:MM); `reset: true` goes back to the defaults. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ settings: await updateBackupSettings(auth, await readJson(request)) });
});

/** Backs up now: everything, or one organisation (`organisationId`). Waits until it's done. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const runs = await backUpNow({
    trigger: "manual",
    requestedByEmail: auth.user.email,
    organisationId: typeof body.organisationId === "string" && body.organisationId ? body.organisationId : undefined,
  });
  return json({ runs });
});
