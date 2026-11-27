import { copiesState, readBackupServerReport } from "@/lib/backup-server/refresh";
import { getBackupSettings } from "@/lib/backups/service";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { readServerSetting, writeServerValue } from "@/lib/server-settings";

/*
 * Backup server alerts (BKS13-BKS14, issue #11). Each server tells its own
 * server admins when the other has gone quiet: the backup server when no
 * new backup arrives, the main when its backup server stops taking copies.
 * One email for each quiet spell, and the page says so until it's over.
 */

const HOUR = 60 * 60 * 1000;
/** With hourly backups: three missed hours. With nightly: a missed night and some. (The plan's defaults.) */
export const QUIET_HOURS_HOURLY = 3;
export const QUIET_HOURS_NIGHTLY = 30;

/**
 * How long without a new backup is too long, from how often they've been
 * arriving: backups an hour or two apart mean hourly (3 hours), anything
 * else nightly (30 hours). The backup server isn't told the main's setting,
 * so it works it out from the times of the backups it has seen.
 */
export function quietHoursFor(madeAts: string[]): number {
  const times = madeAts.map((each) => new Date(each).getTime()).filter(Number.isFinite).sort((left, right) => right - left);
  if (times.length < 2) return QUIET_HOURS_NIGHTLY;
  return times[0] - times[1] <= 2 * HOUR ? QUIET_HOURS_HOURLY : QUIET_HOURS_NIGHTLY;
}

/** True when the newest of these times is more than `hours` before now (or there are none at all). */
export function goneQuiet(now: Date, newest: string | null, hours: number): boolean {
  if (!newest) return false;
  const at = new Date(newest).getTime();
  return Number.isFinite(at) && now.getTime() - at > hours * HOUR;
}

type Watch = { alertedAt?: string | null };
export type QuietState = { quiet: boolean; newest: string | null; hours: number; alertedAt: string | null };

async function admins(): Promise<string[]> {
  return (await coreQuery<{ email: string }>("select email from users where is_server_admin and is_active")).rows.map((row) => row.email);
}

async function watch(key: string, now: Date, newest: string | null, hours: number, subject: string, lines: string[]): Promise<QuietState> {
  const stored = (await readServerSetting<Watch, Record<string, never>>(key)).value;
  const quiet = goneQuiet(now, newest, hours);
  let alertedAt = stored.alertedAt ?? null;
  if (quiet && !alertedAt) {
    for (const email of await admins()) await sendSecurityAlert(email, subject, lines).catch(() => false);
    alertedAt = now.toISOString();
  }
  if (!quiet) alertedAt = null;
  if (alertedAt !== (stored.alertedAt ?? null)) {
    await withCoreTransaction((client) => writeServerValue(client, key, { ...stored, alertedAt }, "backup-server"));
  }
  return { quiet, newest, hours, alertedAt };
}

/** On a backup server (BKS13): has the main stopped sending backups? */
export async function watchForMainGoneQuiet(now = new Date()): Promise<QuietState> {
  const state = await copiesState();
  const madeAts = Object.values(state.organisations).map((copy) => copy.madeAt).filter(Boolean);
  const newest = madeAts.sort().at(-1) ?? null;
  // The times of the last few backups taken say how often they come.
  const hours = quietHoursFor(state.recentMadeAts ?? []);
  return watch("backup_server_watch_main", now, newest, hours, "no new backups from the main server", [
    `This backup server hasn't had a new backup from the main Tohyee server for more than ${hours} hours.`,
    newest ? `Its newest copy is the books as at ${newest}.` : "",
    "Check the main server is running and backing up, and that its backups folder is still syncing to this computer.",
    "If the main server is lost, this backup server can be made the main one (Server › Backup server).",
  ].filter(Boolean));
}

/** On the main (BKS14): has its backup server stopped taking copies? Nothing to say when there isn't one. */
export async function watchForBackupServerGoneQuiet(now = new Date()): Promise<QuietState | null> {
  const settings = await getBackupSettings();
  const report = await readBackupServerReport(settings.folder);
  if (!report) return null;
  const hours = settings.frequency === "hourly" ? QUIET_HOURS_HOURLY : QUIET_HOURS_NIGHTLY;
  return watch("backup_server_watch_backup", now, report.at, hours, "the backup server has stopped taking copies", [
    `The backup server at your second place hasn't taken a copy from this server's backups for more than ${hours} hours.`,
    `It last did at ${report.at}.`,
    "Check that computer is on, Tohyee is running there, and the backups folder is still syncing to it.",
  ]);
}
