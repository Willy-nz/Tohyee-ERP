import { promises as fs } from "node:fs";
import path from "node:path";
import { writeAdminAuditEvent } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { FENCED_SETTING, forgetServerRole, getBackupServerSettings, serverIdentity, serverRole } from "@/lib/backup-server/mode";
import { copiesState, STATUS_FOLDER } from "@/lib/backup-server/refresh";
import { getBackupSettings } from "@/lib/backups/service";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { getRemoteAccess } from "@/lib/remote/settings";
import { deleteServerSetting, readServerSetting, writeServerValue } from "@/lib/server-settings";

/*
 * Switching over (BKS15-BKS19, issue #11): a person makes the backup server
 * the main one. Tohyee never does it by itself. The old main, if it comes
 * back, finds a note in the backups folder saying the main has moved, and
 * stops: two mains would each run feeds and send emails, and their books
 * would drift apart.
 */

type Who = { user: { id: string | null; email: string; isServerAdmin: boolean } };
const MOVED_FILE = "main-moved.json";
const MAIN_SINCE = "main_since";
const REFUSED = "server.switch_over_refused";

export type MainMoved = { serverId: string; at: string; byEmail: string };

export type OutsideLink = { method: string; address: string | null; on: boolean; reachable: "yes" | "no" | "not checked"; note: string };

export type SwitchOverPreview = {
  role: "main" | "backup" | "fenced";
  /** Whether this person may switch over: a server admin, or an Owner of an organisation here. */
  allowed: boolean;
  organisations: { id: string; displayName: string; asAt: string | null; archived: boolean }[];
  peopleAsAt: string | null;
  lastLookedAt: string | null;
  links: OutsideLink[];
  folder: string | null;
};

/** A server admin, or an Owner of any organisation on this server (the owner's choice, issue #11 question 4). */
async function maySwitch(auth: Who): Promise<boolean> {
  if (auth.user.isServerAdmin) return true;
  if (!auth.user.id) return false;
  const owns = await coreQuery("select 1 from organisation_members m join organisations o on o.id = m.organisation_id where m.user_id = $1 and m.role = 'owner' and o.is_active limit 1", [auth.user.id]);
  return (owns.rowCount ?? 0) > 0;
}

/**
 * How this server can be reached from outside (the owner's addition after
 * the 27 Nov outage: a backup server is no use if its own way in is down).
 * It asks its own outside address for the health page. From behind some
 * routers a server can't reach its own outside address even when everyone
 * else can, so "no" means "check from a phone", not "it's down".
 */
export async function outsideLinks(): Promise<OutsideLink[]> {
  const remote = await getRemoteAccess().catch(() => null);
  if (!remote) return [];
  const address = remote.publicUrl ?? remote.tohyeeAddress;
  if (!remote.enabled || !address) return [{ method: remote.method, address: address ?? null, on: false, reachable: "not checked", note: "Remote access is off on this server: after switching over, only this network can reach it." }];
  let reachable: OutsideLink["reachable"] = "no";
  try {
    const response = await fetch(new URL("/api/health", address), { signal: AbortSignal.timeout(8000), redirect: "manual" });
    if (response.ok) reachable = "yes";
  } catch {
    reachable = "no";
  }
  return [{ method: remote.method, address, on: true, reachable, note: reachable === "yes" ? "This server answered at its outside address." : "This server couldn't reach its own outside address. Try it from a phone on mobile data before relying on it." }];
}

export async function switchOverPreview(auth: Who): Promise<SwitchOverPreview> {
  const role = await serverRole();
  const allowed = await maySwitch(auth);
  // People who can't switch over learn only that, not what's on this server.
  if (!allowed || role !== "backup") return { role, allowed, organisations: [], peopleAsAt: null, lastLookedAt: null, links: [], folder: null };
  const copies = await copiesState();
  const settings = await getBackupServerSettings();
  return {
    role,
    allowed,
    organisations: Object.entries(copies.organisations)
      .map(([id, copy]) => ({ id, displayName: copy.displayName, asAt: copy.madeAt || null, archived: Boolean(copies.removed[id]) }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    peopleAsAt: copies.people?.madeAt || null,
    lastLookedAt: copies.lastRunAt,
    links: await outsideLinks(),
    folder: auth.user.isServerAdmin ? settings.folder : null,
  };
}

async function confirmPassword(auth: Who, password: unknown): Promise<void> {
  if (!auth.user.id) return; // The command-line tool, on the server itself.
  const actor = { userId: auth.user.id, email: auth.user.email };
  const recent = await coreQuery<{ n: string }>("select count(*)::text as n from admin_audit_events where event_type = $2 and actor_user_id = $1 and created_at > now() - interval '15 minutes'", [auth.user.id, REFUSED]);
  if (Number(recent.rows[0]?.n ?? 0) >= 5) throw new ForbiddenError("Too many wrong passwords. Wait 15 minutes and try again.");
  const found = await coreQuery<{ password_hash: string }>("select password_hash from users where id = $1 and is_active", [auth.user.id]);
  const ok = typeof password === "string" && found.rows[0] ? await verifyPassword(password, found.rows[0].password_hash) : false;
  if (!ok) {
    await writeAdminAuditEvent({ query: coreQuery }, actor, { eventType: REFUSED, entityType: "server_setting", entityId: "backup_server" });
    throw new ForbiddenError("That password isn't right.");
  }
}

export type SwitchOverResult = {
  organisations: string[];
  /** Whether the note for the old main was written in the backups folder. If not, the old main won't know to stop: keep it off. */
  noteWritten: boolean;
  restartNeeded: boolean;
};

/**
 * Makes this backup server the main one (BKS16). The person types their
 * password again and confirms the old main is off or can't be reached. It
 * writes the "main has moved" note for the old main first, then becomes the
 * main: changes are taken, and every organisation's automatic jobs come on
 * (the owner's choice, 27 Nov 2026). Archived copies stay archived.
 */
export async function makeMainServer(auth: Who, input: { password?: unknown; oldMainIsOff?: unknown; reason?: unknown }, now = new Date()): Promise<SwitchOverResult> {
  if ((await serverRole()) !== "backup") throw new ValidationError("This isn't a backup server.");
  if (!(await maySwitch(auth))) throw new ForbiddenError("Only a server admin or an organisation's Owner can make this the main server.");
  await confirmPassword(auth, input.password);
  if (input.oldMainIsOff !== true) throw new ValidationError("Confirm the old main server is off or can't be reached. Two main servers at once would each send emails and bring in bank lines, and their books would drift apart.");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (!reason) throw new ValidationError("Say in a few words why you're switching over. It's kept in the record.");
  const settings = await getBackupServerSettings();
  const copies = await copiesState();
  const serverId = await serverIdentity();

  let noteWritten = false;
  if (settings.folder) {
    try {
      const target = path.join(settings.folder, STATUS_FOLDER);
      await fs.mkdir(target, { recursive: true });
      const moved: MainMoved = { serverId, at: now.toISOString(), byEmail: auth.user.email };
      await fs.writeFile(path.join(target, `${MOVED_FILE}.partial`), JSON.stringify(moved, null, 2));
      await fs.rename(path.join(target, `${MOVED_FILE}.partial`), path.join(target, MOVED_FILE));
      noteWritten = true;
    } catch {
      noteWritten = false;
    }
  }

  const archived = Object.keys(copies.removed);
  const turnedOn = await withCoreTransaction(async (client) => {
    await deleteServerSetting(client, "backup_server");
    await deleteServerSetting(client, FENCED_SETTING);
    await writeServerValue(client, MAIN_SINCE, { at: now.toISOString() }, auth.user.email);
    const on = await client.query<{ id: string }>(
      "update organisations set jobs_paused_at = null, jobs_paused_reason = null where demo_for_user_id is null and is_active and not (id = any($1::text[])) returning id",
      [archived],
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.made_main",
      entityType: "server_setting",
      entityId: "backup_server",
      details: { reason, byServerAdmin: auth.user.isServerAdmin, noteWritten, copies: Object.fromEntries(Object.entries(copies.organisations).map(([id, copy]) => [id, copy.madeAt])), peopleAsAt: copies.people?.madeAt ?? null, archived },
    });
    return on.rows.map((row) => row.id).sort();
  });
  forgetServerRole();
  const after = await getBackupServerSettings();
  return { organisations: turnedOn, noteWritten, restartNeeded: after.restartNeeded };
}

/**
 * On a main server (BKS17): looks in its own backups folder for a note
 * saying another server was made the main after this one last became it.
 * If there is one, this server is fenced: no changes, no jobs. Returns the
 * note when it has just been fenced.
 */
export async function checkMainMoved(): Promise<MainMoved | null> {
  if ((await serverRole()) !== "main") return null;
  const folder = (await getBackupSettings()).folder;
  let note: MainMoved;
  try {
    note = JSON.parse(await fs.readFile(path.join(folder, STATUS_FOLDER, MOVED_FILE), "utf8")) as MainMoved;
  } catch {
    return null;
  }
  if (typeof note?.serverId !== "string" || typeof note.at !== "string" || !Number.isFinite(new Date(note.at).getTime())) return null;
  if (note.serverId === (await serverIdentity())) return null;
  const since = (await readServerSetting<{ at?: string }, Record<string, never>>(MAIN_SINCE)).value.at;
  // A note from before this server was last made the main is old news.
  if (since && new Date(since).getTime() >= new Date(note.at).getTime()) return null;
  await withCoreTransaction(async (client) => {
    await writeServerValue(client, FENCED_SETTING, { at: new Date().toISOString(), movedAt: note.at, byEmail: String(note.byEmail ?? "").slice(0, 200) }, "tohyee");
    await writeAdminAuditEvent(client, { userId: null, email: "tohyee" }, { eventType: "server.fenced", entityType: "server_setting", entityId: FENCED_SETTING, details: { movedAt: note.at } });
  });
  forgetServerRole();
  return note;
}

/**
 * "This is the main server after all" (BKS18): a server admin, on the
 * server computer, lifts the fence, for when the switch-over was a mistake
 * or the other server is the one being retired. Notes from before now no
 * longer fence it.
 */
export async function mainAfterAll(auth: Who, now = new Date()): Promise<void> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can do this.");
  if ((await serverRole()) !== "fenced") throw new ValidationError("This server isn't waiting on that: it's already the main, or it's a backup server.");
  await withCoreTransaction(async (client) => {
    await deleteServerSetting(client, FENCED_SETTING);
    await writeServerValue(client, MAIN_SINCE, { at: now.toISOString() }, auth.user.email);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, { eventType: "server.main_after_all", entityType: "server_setting", entityId: FENCED_SETTING });
  });
  forgetServerRole();
}
