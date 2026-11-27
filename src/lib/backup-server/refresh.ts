import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeAdminAuditEvent } from "@/lib/audit";
import { backupSource, serverRole } from "@/lib/backup-server/mode";
import { type FoundBackup, findBackups, recoverPeople } from "@/lib/backups/recovery";
import { restoreBackup } from "@/lib/backups/service";
import { closeOrganisationPool, connectAsAdmin, getAdminPool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
import { readServerSetting, writeServerValue } from "@/lib/server-settings";

/*
 * A backup server keeping its copy up to date (BKS8-BKS12, issue #11). It
 * reads the main server's backups folder and, for each organisation whose
 * newest backup it hasn't taken yet, restores that backup beside the copy it
 * has, checks it, and only then swaps it in. People and memberships come
 * from the main's server backup each time. It holds the main's
 * organisations and no others: one the main no longer has is archived here
 * for 30 days, then deleted.
 */

const SYSTEM = { id: null, email: "backup-server" };
const SYSTEM_ADMIN = { user: { ...SYSTEM, isServerAdmin: true } };
const STATE = "backup_server_copies";
/** How long a copy of an organisation the main no longer has is kept (the owner's choice, 27 Nov 2026). */
export const KEEP_REMOVED_DAYS = 30;
/** The folder inside the main's backups folder where the backup server says what it has taken. */
export const STATUS_FOLDER = "_backup-server";
const STATUS_FILE = "status.json";

export type CopyState = {
  /** The backup file this copy was made from. */
  backupName: string;
  /** When the main made that backup: the copy is the books as at this time. */
  madeAt: string;
  refreshedAt: string;
  /** Why the newest backup couldn't be taken; the copy before it is still here. */
  error: string | null;
  errorAt: string | null;
};

export type CopiesState = {
  organisations: Record<string, CopyState & { displayName: string }>;
  people: CopyState | null;
  /** The organisations the main has, from its newest server backup read so far. Null until one has been read. */
  mainOrganisations: string[] | null;
  /** The times of the newest few backups taken (newest first): how often the main's backups come (BKS13). */
  recentMadeAts?: string[];
  /** Organisations the main no longer has: archived here, deleted after KEEP_REMOVED_DAYS. */
  removed: Record<string, { displayName: string; archivedAt: string }>;
  lastRunAt: string | null;
  lastError: string | null;
};

const EMPTY: CopiesState = { organisations: {}, people: null, mainOrganisations: null, removed: {}, lastRunAt: null, lastError: null };

export async function copiesState(): Promise<CopiesState> {
  const stored = await readServerSetting<CopiesState, Record<string, never>>(STATE);
  return { ...EMPTY, ...stored.value, organisations: stored.value.organisations ?? {}, removed: stored.value.removed ?? {} };
}

async function saveState(state: CopiesState): Promise<void> {
  await withCoreTransaction((client) => writeServerValue(client, STATE, state, SYSTEM.email));
}

/** The newest readable backup of each organisation, and of the server's own database, in the main's folder. */
export function newestBackups(backups: FoundBackup[]): { organisations: Map<string, FoundBackup>; server: FoundBackup | null } {
  const organisations = new Map<string, FoundBackup>();
  let server: FoundBackup | null = null;
  for (const backup of backups) {
    if (!backup.header || backup.problem || !backup.compatible) continue;
    if (backup.header.kind === "server") {
      if (!server || backup.header.createdAt > server.header!.createdAt) server = backup;
    } else if (backup.header.organisationId) {
      const held = organisations.get(backup.header.organisationId);
      if (!held || backup.header.createdAt > held.header!.createdAt) organisations.set(backup.header.organisationId, backup);
    }
  }
  return { organisations, server };
}

/**
 * A short ID for the copy while it's restored and checked beside the one in
 * use: valid whatever the organisation's ID is, and new each time, because
 * the database it names stays in use after the swap.
 */
function incomingId(organisationId: string): string {
  return `incoming-${createHash("sha256").update(organisationId).digest("hex").slice(0, 8)}-${randomBytes(4).toString("hex")}`;
}

/** Copies left beside the ones in use by a refresh that was cut off (a restart): removed before starting again. */
async function clearUnfinished(held: Set<string>): Promise<void> {
  const stale = await coreQuery<{ id: string; database_name: string }>("select id, database_name from organisations where id like 'incoming-%'");
  for (const row of stale.rows) {
    // An organisation of the main's that happens to be called that is a copy, not a leftover.
    if (held.has(row.id)) continue;
    await closeOrganisationPool(row.database_name).catch(() => undefined);
    await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(row.database_name)} with (force)`);
    await withCoreTransaction(async (client) => {
      await client.query("delete from organisation_members where organisation_id = $1", [row.id]);
      await client.query("delete from backup_checks where organisation_id = $1", [row.id]);
      await client.query("delete from organisations where id = $1", [row.id]);
    });
  }
}

/**
 * Puts a restored, checked copy in the place of the one in use: the
 * organisation keeps its ID, members and everything else on this server,
 * and now reads the new database. The old database goes only after that.
 */
async function swapIn(organisationId: string, incoming: string, displayName: string): Promise<void> {
  const [current, next] = [await getOrganisation(organisationId), await getOrganisation(incoming)];
  if (!current || !next) throw new Error("The copy to swap in isn't there.");
  const admin = await connectAsAdmin(next.databaseName);
  try {
    await admin.query("update organisation_settings set organisation_id = $1, display_name = $2, updated_at = now() where id = true", [organisationId, displayName]);
  } finally {
    await admin.end();
  }
  await withCoreTransaction(async (client) => {
    await client.query("delete from organisation_members where organisation_id = $1", [incoming]);
    await client.query("delete from backup_checks where organisation_id = $1", [incoming]);
    await client.query("delete from organisations where id = $1", [incoming]);
    await client.query(
      "update organisations set database_name = $2, display_name = $3, base_currency = $4, is_active = true, jobs_paused_at = coalesce(jobs_paused_at, now()) where id = $1",
      [organisationId, next.databaseName, displayName, next.baseCurrency],
    );
  });
  await closeOrganisationPool(current.databaseName).catch(() => undefined);
  await closeOrganisationPool(next.databaseName).catch(() => undefined);
  await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(current.databaseName)} with (force)`);
}

export type RefreshResult = { refreshed: string[]; failed: { organisationId: string | null; error: string }[]; archived: string[]; deleted: string[]; people: boolean };

let running = false;

/**
 * Takes whatever is new in the main's backups folder (BKS8-BKS11). Each
 * organisation is done by itself: one that fails keeps its last good copy
 * and is tried again next time, and the others carry on.
 */
export async function refreshCopies(now = new Date()): Promise<RefreshResult> {
  const result: RefreshResult = { refreshed: [], failed: [], archived: [], deleted: [], people: false };
  if ((await serverRole()) !== "backup") return result;
  if (running) return result;
  running = true;
  const state = await copiesState();
  try {
    const source = await backupSource();
    if (!source) throw new Error("This backup server has lost its pairing (the main server's recovery key can't be read). Pair it again.");
    await clearUnfinished(new Set([...Object.keys(state.organisations), ...(state.mainOrganisations ?? [])]));
    const found = await findBackups(source.folder);
    const newest = newestBackups(found.backups);
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

    // Which organisations the main has now, from its newest server backup: old backups of ones it has since
    // removed are still in the folder, and aren't taken.
    const serverIsNew = Boolean(newest.server && (state.people?.backupName !== newest.server.name || state.people?.error));
    if (newest.server && serverIsNew) {
      try {
        const plan = await recoverPeople(SYSTEM_ADMIN, { file: path.join(found.folder, newest.server.name), material: source.material, apply: false });
        state.mainOrganisations = plan.organisationsInBackup.map((organisation) => organisation.id);
      } catch {
        // Said below, where people are taken.
      }
    }

    for (const [organisationId, backup] of [...newest.organisations.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      const held = state.organisations[organisationId];
      const header = backup.header!;
      // One the main no longer has: its old backups are still in the folder, but its copy here is on its way out.
      if (state.removed[organisationId]) continue;
      if (state.mainOrganisations && !state.mainOrganisations.includes(organisationId)) continue;
      if (held && held.backupName === backup.name && !held.error) continue;
      if (held && held.madeAt > header.createdAt) continue;
      const displayName = header.displayName ?? organisationId;
      const file = path.join(found.folder, backup.name);
      try {
        const here = await getOrganisation(organisationId);
        if (!here) {
          await restoreBackup(SYSTEM, { file, id: organisationId, material: source.material, mirror: true });
        } else {
          const incoming = incomingId(organisationId);
          await restoreBackup(SYSTEM, { file, id: incoming, material: source.material, mirror: true });
          await swapIn(organisationId, incoming, displayName);
        }
        state.organisations[organisationId] = { displayName, backupName: backup.name, madeAt: header.createdAt, refreshedAt: now.toISOString(), error: null, errorAt: null };
        state.recentMadeAts = [...new Set([header.createdAt, ...(state.recentMadeAts ?? [])])].sort().reverse().slice(0, 6);
        result.refreshed.push(organisationId);
      } catch (error) {
        // The copy from before is untouched and stays in use.
        state.organisations[organisationId] = held
          ? { ...held, error: message(error), errorAt: now.toISOString() }
          : { displayName, backupName: "", madeAt: "", refreshedAt: "", error: message(error), errorAt: now.toISOString() };
        result.failed.push({ organisationId, error: message(error) });
      }
      await saveState(state);
    }

    // People and who's in what, from the main's server backup, every time it's new or an organisation just arrived.
    if (newest.server && (serverIsNew || result.refreshed.length > 0)) {
      const file = path.join(found.folder, newest.server.name);
      try {
        const plan = await recoverPeople(SYSTEM_ADMIN, { file, material: source.material, apply: false });
        const applied = await recoverPeople(SYSTEM_ADMIN, { file, material: source.material, apply: true, mirror: true, replace: plan.conflicts.map((conflict) => conflict.email) });
        state.people = { backupName: newest.server.name, madeAt: newest.server.header!.createdAt, refreshedAt: now.toISOString(), error: null, errorAt: null };
        result.people = true;

        // The same organisations as the main, always: one it no longer has is archived here, then deleted.
        state.mainOrganisations = applied.organisationsInBackup.map((organisation) => organisation.id);
        const onMain = new Set(state.mainOrganisations);
        const here = await coreQuery<{ id: string; display_name: string; database_name: string }>("select id, display_name, database_name from organisations where demo_for_user_id is null");
        for (const organisation of here.rows) {
          if (onMain.has(organisation.id)) {
            if (state.removed[organisation.id]) {
              delete state.removed[organisation.id];
              await coreQuery("update organisations set is_active = true where id = $1", [organisation.id]);
            }
            continue;
          }
          const gone = state.removed[organisation.id];
          if (!gone) {
            state.removed[organisation.id] = { displayName: organisation.display_name, archivedAt: now.toISOString() };
            await withCoreTransaction(async (client) => {
              await client.query("update organisations set is_active = false where id = $1", [organisation.id]);
              await writeAdminAuditEvent(client, { userId: null, email: SYSTEM.email }, { eventType: "backup_server.organisation_archived", entityType: "organisation", entityId: organisation.id, details: { reason: "The main server no longer has it.", keptDays: KEEP_REMOVED_DAYS } });
            });
            result.archived.push(organisation.id);
          }
        }
      } catch (error) {
        state.people = { ...(state.people ?? { backupName: "", madeAt: "", refreshedAt: "" }), error: message(error), errorAt: now.toISOString() };
        result.failed.push({ organisationId: null, error: message(error) });
      }
    }
    // An archived copy past its 30 days is deleted, whether or not anything new arrived this time.
    for (const [organisationId, gone] of Object.entries(state.removed)) {
      if (now.getTime() - new Date(gone.archivedAt).getTime() < KEEP_REMOVED_DAYS * 24 * 60 * 60 * 1000) continue;
      const organisation = await getOrganisation(organisationId);
      if (organisation) {
        await closeOrganisationPool(organisation.databaseName).catch(() => undefined);
        await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(organisation.databaseName)} with (force)`);
        await withCoreTransaction(async (client) => {
          await client.query("delete from organisation_members where organisation_id = $1", [organisationId]);
          await client.query("delete from backup_checks where organisation_id = $1", [organisationId]);
          await client.query("delete from organisations where id = $1", [organisationId]);
          await writeAdminAuditEvent(client, { userId: null, email: SYSTEM.email }, { eventType: "backup_server.organisation_deleted", entityType: "organisation", entityId: organisationId, details: { archivedAt: gone.archivedAt } });
        });
      }
      delete state.removed[organisationId];
      delete state.organisations[organisationId];
      result.deleted.push(organisationId);
    }
    state.lastRunAt = now.toISOString();
    state.lastError = null;
    await saveState(state);
    await writeStatusFile(found.folder, state, now).catch(() => undefined);
  } catch (error) {
    state.lastRunAt = now.toISOString();
    state.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await saveState(state).catch(() => undefined);
    result.failed.push({ organisationId: null, error: state.lastError });
  } finally {
    running = false;
  }
  return result;
}

export type BackupServerReport = {
  at: string;
  organisations: { id: string; madeAt: string; refreshedAt: string; error: string | null }[];
  people: { madeAt: string; error: string | null } | null;
};

/** A small file in the main's backups folder saying what the backup server has taken (BKS12): how the main knows, with no link between the two. Names no people. */
async function writeStatusFile(folder: string, state: CopiesState, now: Date): Promise<void> {
  const report: BackupServerReport = {
    at: now.toISOString(),
    organisations: Object.entries(state.organisations).map(([id, copy]) => ({ id, madeAt: copy.madeAt, refreshedAt: copy.refreshedAt, error: copy.error })),
    people: state.people ? { madeAt: state.people.madeAt, error: state.people.error } : null,
  };
  const target = path.join(folder, STATUS_FOLDER);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, `${STATUS_FILE}.partial`), JSON.stringify(report, null, 2));
  await fs.rename(path.join(target, `${STATUS_FILE}.partial`), path.join(target, STATUS_FILE));
}

/** On the main: what its backup server last said, read from the backups folder. Null when there's no backup server (or it has never reported). */
export async function readBackupServerReport(folder: string): Promise<BackupServerReport | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(folder, STATUS_FOLDER, STATUS_FILE), "utf8")) as BackupServerReport;
    if (typeof parsed?.at !== "string" || !Array.isArray(parsed.organisations)) return null;
    return {
      at: parsed.at,
      organisations: parsed.organisations.filter((each) => typeof each?.id === "string").map((each) => ({ id: String(each.id), madeAt: String(each.madeAt ?? ""), refreshedAt: String(each.refreshedAt ?? ""), error: each.error ? String(each.error).slice(0, 1000) : null })),
      people: parsed.people ? { madeAt: String(parsed.people.madeAt ?? ""), error: parsed.people.error ? String(parsed.people.error).slice(0, 1000) : null } : null,
    };
  } catch {
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;

/** On a backup server: looks for new backups every 5 minutes while Tohyee runs. */
export function startCopyRefresher(): void {
  if (timer) return;
  const tick = () => {
    refreshCopies()
      .then((result) => {
        for (const failure of result.failed) console.warn(`[tohyee] Backup server: couldn't take the copy of ${failure.organisationId ?? "the main server's people"}: ${failure.error}`);
        if (result.refreshed.length > 0) console.log(`[tohyee] Backup server: took new copies of ${result.refreshed.join(", ")}.`);
      })
      // Then: has the main gone quiet (BKS13)? Imported here, as alerts reads this file's state.
      .then(() => import("@/lib/backup-server/alerts"))
      .then(({ watchForMainGoneQuiet }) => watchForMainGoneQuiet())
      .then((quiet) => {
        if (quiet.quiet) console.warn(`[tohyee] Backup server: no new backup from the main server for more than ${quiet.hours} hours.`);
      })
      // And: can the main be reached at its address (BKS20)?
      .then(() => import("@/lib/backup-server/practice"))
      .then(({ checkMainReachable }) => checkMainReachable())
      .then((reach) => {
        if (reach?.offer) console.warn(`[tohyee] Backup server: the main server hasn't answered since ${reach.unreachableSince}.`);
      })
      .catch((error) => console.warn("[tohyee] Backup server refresh:", error instanceof Error ? error.message : error));
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}
