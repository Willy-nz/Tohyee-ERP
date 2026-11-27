/*
 * Backup server mode (BKS4-BKS7, issue #11): what a Tohyee that keeps a copy
 * of another Tohyee refuses. Pure and browser-safe. The copy is replaced
 * from the main's backups, so anything changed here would be lost at the
 * next copy, and anything sent or imported here would be done twice.
 */

/**
 * main: the server everyone uses. backup: keeps a copy of another one.
 * fenced (BKS17): was the main, and has found that the backup server was
 * made the main while it was away; it takes no changes and runs no jobs
 * until a server admin pairs it as the backup server (or says it's the main
 * after all).
 */
export type ServerRole = "main" | "backup" | "fenced";

export const BACKUP_SERVER_MESSAGE = "This is the backup copy of another Tohyee server. Nothing can be changed here. Use the main server, or ask a server admin about switching over.";
export const FENCED_MESSAGE = "This server is no longer the main one: the backup server was made the main while this one was away. Nothing can be changed here. Use the other server.";
/** What a server that isn't the main says when it refuses a change. */
export function refusalFor(role: ServerRole): string {
  return role === "fenced" ? FENCED_MESSAGE : BACKUP_SERVER_MESSAGE;
}
/** On a backup server, people who aren't server admins reach only this (BKS15): the switch-over screen, for an organisation's Owner. */
export function openToOwnersOnBackup(pathname: string): boolean {
  return pathname === "/api/backup-server/switch-over" || pathname === "/api/server-role" || pathname.startsWith("/api/auth/");
}
export const BACKUP_SERVER_ADMINS_ONLY = "This is the backup copy of another Tohyee server. Only server admins can look at it. Use the main server.";

/**
 * Changes a backup server still takes: signing in and out (its own
 * sessions), its own backup-server settings, updates (it has to run the
 * main's version) and the checks a server admin runs on the backups folder.
 */
const ALLOWED: RegExp[] = [
  /^\/api\/auth\//,
  /^\/api\/admin\/backup-server(\/|$)/, // its pairing, and "take new copies now"
  /^\/api\/backup-server\/switch-over$/, // making it the main server
  /^\/api\/admin\/backup-server\/main-after-all$/,
  /^\/api\/admin\/server-update(\/|$)/,
  /^\/api\/admin\/updates(\/|$)/,
  /^\/api\/admin\/backups\/(check|restore\/find)(\/|$)/,
];

/** True when a backup server refuses this request: any change (not a read) outside the few paths above. */
export function backupServerRefuses(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !ALLOWED.some((pattern) => pattern.test(pathname));
}
