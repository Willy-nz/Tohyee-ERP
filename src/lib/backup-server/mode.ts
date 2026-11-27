import { promises as fs } from "node:fs";
import path from "node:path";
import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { type RecoveryMaterial } from "@/lib/backups/format";
import { findBackups, inspectBackup, recoveryMaterial } from "@/lib/backups/recovery";
import type { ServerRole } from "@/lib/backup-server/rules";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { secretsAvailable } from "@/lib/secrets";
import { deleteServerSetting, readServerSetting, writeServerSetting } from "@/lib/server-settings";

/*
 * Backup server mode (BKS4-BKS7, issue #11). A server paired as a backup
 * server keeps a copy of another Tohyee from that Tohyee's backups folder.
 * This file holds the setting and the pairing; rules.ts says what such a
 * server refuses.
 */

type Stored = {
  mode?: "backup";
  /** The main's backups folder, as this computer sees it (a synced or shared folder). */
  folder?: string;
  pairedAt?: string;
  pairedByEmail?: string;
};
/** The main's recovery key (kept encrypted with this server's own secret key, as every server setting's secrets are). The main's live secret key is never here. */
type StoredSecrets = { recoveryKey?: { version: number; key: string } };

const SETTING = "backup_server";

export type BackupServerSettings = {
  role: ServerRole;
  folder: string | null;
  pairedAt: string | null;
  pairedByEmail: string | null;
  /** The role this process started in. Background jobs are chosen at start, so a change of role is finished by restarting Tohyee. */
  startedAs: ServerRole;
  restartNeeded: boolean;
};

let cached: { at: number; role: ServerRole } | null = null;
let startedAs: ServerRole | null = null;
const CACHE_MS = 5000;

/** This server's role. Read on every change request, so it's remembered for a few seconds. */
export async function serverRole(): Promise<ServerRole> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.role;
  let role: ServerRole = "main";
  try {
    const stored = await readServerSetting<Stored, StoredSecrets>(SETTING);
    role = stored.value.mode === "backup" ? "backup" : "main";
  } catch {
    // No core database yet (first start): a main server.
    role = "main";
  }
  cached = { at: now, role };
  return role;
}

/** Forgets the remembered role (after pairing, and between tests). */
export function forgetServerRole(): void {
  cached = null;
}

/** Called once at start: the role background jobs were chosen for. */
export async function noteStartedRole(): Promise<ServerRole> {
  startedAs = await serverRole();
  return startedAs;
}

export async function getBackupServerSettings(): Promise<BackupServerSettings> {
  const stored = await readServerSetting<Stored, StoredSecrets>(SETTING);
  const role: ServerRole = stored.value.mode === "backup" ? "backup" : "main";
  const began = startedAs ?? role;
  return {
    role,
    folder: stored.value.folder ?? null,
    pairedAt: stored.value.pairedAt ?? null,
    pairedByEmail: stored.value.pairedByEmail ?? null,
    startedAs: began,
    restartNeeded: began !== role,
  };
}

/** The main's recovery key and backups folder, for reading its backups. Null on a main server. */
export async function backupSource(): Promise<{ folder: string; material: RecoveryMaterial } | null> {
  const stored = await readServerSetting<Stored, StoredSecrets>(SETTING);
  if (stored.value.mode !== "backup" || !stored.value.folder || !stored.secrets.recoveryKey) return null;
  const saved = stored.secrets.recoveryKey;
  return { folder: stored.value.folder, material: { recoveryKey: { version: saved.version, key: Buffer.from(saved.key, "base64") } } };
}

/**
 * Makes this server a backup server for another Tohyee (BKS4): given the
 * main's recovery kit (a code, or the kit file and its passphrase) and the
 * folder its backups arrive in. Refused unless this server is empty, the
 * folder has backups, and the kit opens the newest one: the same checks as
 * the restore wizard's first step. Nothing is copied yet.
 */
export async function pairAsBackupServer(
  auth: ServerAdminAuth,
  input: { folder?: unknown; key?: unknown; kitFile?: unknown; passphrase?: unknown; material?: RecoveryMaterial },
): Promise<BackupServerSettings> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can make this a backup server.");
  if (!secretsAvailable()) throw new ValidationError("This server has no TOHYEE_SECRET_KEY, so it can't keep the main server's recovery key safely.");
  if ((await serverRole()) === "backup") throw new ValidationError("This is already a backup server.");
  const own = await coreQuery<{ count: string }>("select count(*)::text as count from organisations where demo_for_user_id is null");
  const count = Number(own.rows[0].count);
  if (count > 0) {
    throw new ValidationError(
      `A backup server starts empty, and this server has ${count === 1 ? "an organisation" : `${count} organisations`}. Its copies replace what's here, so set it up on a fresh install of Tohyee.`,
    );
  }
  const material = input.material ?? (await recoveryMaterial({ key: input.key, kitFile: input.kitFile, passphrase: input.passphrase }));
  if (!material?.recoveryKey) throw new ValidationError("Give the main server's recovery code, or its recovery file and passphrase.");
  const found = await findBackups(input.folder);
  try {
    await fs.access(found.folder);
  } catch {
    throw new ValidationError(`Tohyee can't open ${found.folder} on this computer.`);
  }
  const readable = found.backups.filter((backup) => backup.header && !backup.problem);
  if (readable.length === 0) throw new ValidationError(`There are no Tohyee backups in ${found.folder} yet. Check the main server backs up into the folder this one syncs, and that it has synced.`);
  const newest = readable[0];
  const inspection = await inspectBackup(path.join(found.folder, newest.name), material).catch((error: unknown) => {
    throw new ValidationError(`That recovery kit doesn't open the backups in this folder: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!inspection) throw new ValidationError("That recovery kit doesn't open the backups in this folder.");
  const key = material.recoveryKey;
  await withCoreTransaction(async (client) => {
    await writeServerSetting<Stored, StoredSecrets>(
      client,
      SETTING,
      { mode: "backup", folder: found.folder, pairedAt: new Date().toISOString(), pairedByEmail: auth.user.email },
      { recoveryKey: { version: key.version, key: key.key.toString("base64") } },
      auth.user.email,
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.backup_server_paired",
      entityType: "server_setting",
      entityId: SETTING,
      details: { folder: found.folder, recoveryKeyVersion: key.version, backupsFound: readable.length },
    });
  });
  forgetServerRole();
  return getBackupServerSettings();
}

/**
 * Stops being a backup server without becoming the main (BKS7): only while
 * it holds no organisations, so an unused pairing can be undone. A backup
 * server with copies becomes the main by switching over, not this way.
 */
export async function unpairBackupServer(auth: ServerAdminAuth): Promise<BackupServerSettings> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can change this.");
  if ((await serverRole()) !== "backup") throw new ValidationError("This isn't a backup server.");
  const own = await coreQuery<{ count: string }>("select count(*)::text as count from organisations where demo_for_user_id is null");
  if (Number(own.rows[0].count) > 0) throw new ValidationError("This backup server holds copies of organisations. It becomes the main server by switching over, not by unpairing.");
  await withCoreTransaction(async (client) => {
    await deleteServerSetting(client, SETTING);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, { eventType: "server.backup_server_unpaired", entityType: "server_setting", entityId: SETTING });
  });
  forgetServerRole();
  return getBackupServerSettings();
}
