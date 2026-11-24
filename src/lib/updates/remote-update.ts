import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import packageJson from "../../../package.json";
import { writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { coreQuery } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, UnavailableError } from "@/lib/errors";
import { prepareUpdate, updateSummary, type UpdateSummary } from "@/lib/updates/updates";

/**
 * Update now in Tohyee (UPD1-UPD6): a server admin updates a Windows server
 * from any device, without signing in to the server computer.
 *
 * The server settings stay on the server computer (src/lib/server-admin),
 * and this is the one exception the owner asked for. Tohyee runs as a
 * limited Windows account that can't install anything, so it doesn't: it
 * backs everything up, then leaves a request (just a version number) in a
 * folder it can write (TOHYEE_UPDATE_REQUEST_DIR). The Tohyee updater, a
 * scheduled task run by Windows as SYSTEM (installer/windows/tohyee-updater.ps1),
 * finds the request, asks GitHub itself for that release's installer, checks
 * the download against GitHub's SHA-256 and runs it silently. Nothing in the
 * request is trusted but the version number, and only the latest release is
 * installed, so the most a stolen server admin session can do here is
 * install the latest official release a little early.
 *
 * The updater writes how it's going to TOHYEE_UPDATE_STATUS_DIR (a folder
 * Tohyee can only read); the server start after the update records the new
 * version as usual.
 */

/** A request the updater hasn't picked up after this long is treated as stuck. */
export const REQUEST_STUCK_AFTER_MS = 10 * 60 * 1000;

export type UpdaterStatus = {
  state: "downloading" | "installing" | "failed" | "skipped";
  version: string | null;
  message: string | null;
  at: string | null;
  /** Installing for over 20 minutes without this server coming back on that version. */
  overdue: boolean;
};

/** How long an install can take before the page says it didn't finish. */
export const INSTALL_OVERDUE_AFTER_MS = 20 * 60 * 1000;

export type RemoteUpdateState = UpdateSummary & {
  /** False when this server wasn't installed with the Windows installer (or is an older one without the updater). */
  canUpdateHere: boolean;
  /** Why not, in a sentence, when canUpdateHere is false. */
  notHere: string | null;
  /** A request waiting for the updater. */
  pending: { version: string; requestedBy: string; requestedAt: string; stuck: boolean } | null;
  /** What the updater last said. */
  updater: UpdaterStatus | null;
};

const REQUEST_FILE = "request.json";
const STATUS_FILE = "status.json";
const VERSION = /^\d+\.\d+\.\d+$/;

function requestDir(): string | null {
  return process.env.TOHYEE_UPDATE_REQUEST_DIR?.trim() || null;
}

function statusDir(): string | null {
  return process.env.TOHYEE_UPDATE_STATUS_DIR?.trim() || null;
}

const NOT_HERE =
  "Update now works on servers installed with the Tohyee Windows installer (0.44.0 or later). On this server, update it the way it was installed.";

/** What the request file says, or null when there isn't one (or it isn't readable). */
async function readRequest(dir: string, now: Date): Promise<RemoteUpdateState["pending"]> {
  const file = path.join(dir, REQUEST_FILE);
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const parsed = JSON.parse(text) as { version?: unknown; requestedBy?: unknown; requestedAt?: unknown };
    const requestedAt = typeof parsed.requestedAt === "string" ? parsed.requestedAt : info.mtime.toISOString();
    const age = now.getTime() - new Date(requestedAt).getTime();
    return {
      version: typeof parsed.version === "string" ? parsed.version : "?",
      requestedBy: typeof parsed.requestedBy === "string" ? parsed.requestedBy : "?",
      requestedAt,
      stuck: !(age < REQUEST_STUCK_AFTER_MS),
    };
  } catch {
    return null;
  }
}

/** The updater's status file, cleaned up: only known states and short text. */
export function parseUpdaterStatus(text: string, now: Date = new Date(), currentVersion: string = packageJson.version): UpdaterStatus | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const states = ["downloading", "installing", "failed", "skipped"] as const;
  const state = states.find((known) => known === parsed.state);
  if (!state) return null;
  const short = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const given = short(parsed.version, 20);
  const version = given && VERSION.test(given) ? given : null;
  const at = short(parsed.at, 40);
  const started = at ? new Date(at).getTime() : Number.NaN;
  return {
    state,
    version,
    message: short(parsed.message, 500),
    at,
    overdue: state === "installing" && version !== currentVersion && Number.isFinite(started) && now.getTime() - started > INSTALL_OVERDUE_AFTER_MS,
  };
}

async function readStatus(dir: string | null, now: Date): Promise<UpdaterStatus | null> {
  if (!dir) return null;
  try {
    return parseUpdaterStatus(await readFile(path.join(dir, STATUS_FILE), "utf8"), now);
  } catch {
    return null;
  }
}

function requireServerAdminAnywhere(auth: AuthContext): void {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can update Tohyee.");
}

/** For Update now: the versions, any request waiting, and what the updater last said. Server admins only. */
export async function remoteUpdateState(auth: AuthContext, now: Date = new Date()): Promise<RemoteUpdateState> {
  requireServerAdminAnywhere(auth);
  const dir = requestDir();
  const canUpdateHere = dir !== null && process.platform === "win32";
  return {
    ...(await updateSummary()),
    canUpdateHere,
    notHere: canUpdateHere ? null : NOT_HERE,
    pending: dir ? await readRequest(dir, now) : null,
    updater: await readStatus(statusDir(), now),
  };
}

/**
 * Update now: the same checks and backups as the server app's Install
 * (prepareUpdate: the version must still be the latest, it must have a
 * Windows installer, and every backup must work), then the request for the
 * updater. Body: `version`, the version the person agreed to install.
 */
export async function requestRemoteUpdate(auth: AuthContext, body: Record<string, unknown>, now: () => Date = () => new Date()): Promise<RemoteUpdateState> {
  requireServerAdminAnywhere(auth);
  const dir = requestDir();
  if (!dir || process.platform !== "win32") throw new UnavailableError(NOT_HERE);
  const waiting = await readRequest(dir, now());
  if (waiting && !waiting.stuck) {
    throw new ConflictError(`An update to v${waiting.version} was asked for at ${waiting.requestedAt} and is on its way. Give it a few minutes.`);
  }

  const prepared = await prepareUpdate(auth, body);
  if (!VERSION.test(prepared.version)) throw new UnavailableError(`v${prepared.version} isn't a version the updater can install.`);

  await mkdir(dir, { recursive: true });
  const file = path.join(dir, REQUEST_FILE);
  const partial = `${file}.partial`;
  const request = { version: prepared.version, requestedBy: auth.user.email, requestedAt: now().toISOString() };
  try {
    await writeFile(partial, `${JSON.stringify(request)}\n`, "utf8");
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw new UnavailableError(`Everything was backed up, but the update couldn't be handed to the updater: ${error instanceof Error ? error.message : String(error)}`);
  }
  await writeAdminAuditEvent({ query: coreQuery }, { userId: auth.user.id, email: auth.user.email }, {
    eventType: "server_update_requested",
    entityType: "server_setting",
    entityId: "updates",
    details: { from: packageJson.version, to: prepared.version, backups: prepared.backups.length },
  });
  return remoteUpdateState(auth, now());
}
