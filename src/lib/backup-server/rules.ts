/*
 * Backup server mode (BKS4-BKS7, issue #11): what a Tohyee that keeps a copy
 * of another Tohyee refuses. Pure and browser-safe. The copy is replaced
 * from the main's backups, so anything changed here would be lost at the
 * next copy, and anything sent or imported here would be done twice.
 */

export type ServerRole = "main" | "backup";

export const BACKUP_SERVER_MESSAGE = "This is the backup copy of another Tohyee server. Nothing can be changed here. Use the main server, or ask a server admin about switching over.";
export const BACKUP_SERVER_ADMINS_ONLY = "This is the backup copy of another Tohyee server. Only server admins can look at it. Use the main server.";

/**
 * Changes a backup server still takes: signing in and out (its own
 * sessions), its own backup-server settings, updates (it has to run the
 * main's version) and the checks a server admin runs on the backups folder.
 */
const ALLOWED: RegExp[] = [
  /^\/api\/auth\//,
  /^\/api\/admin\/backup-server(\/|$)/,
  /^\/api\/admin\/server-update(\/|$)/,
  /^\/api\/admin\/updates(\/|$)/,
  /^\/api\/admin\/backups\/(check|restore\/find)(\/|$)/,
];

/** True when a backup server refuses this request: any change (not a read) outside the few paths above. */
export function backupServerRefuses(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !ALLOWED.some((pattern) => pattern.test(pathname));
}
