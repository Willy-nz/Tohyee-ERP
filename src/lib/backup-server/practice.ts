import { promises as fs } from "node:fs";
import path from "node:path";
import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { getBackupServerSettings, serverRole } from "@/lib/backup-server/mode";
import { copiesState, STATUS_FOLDER } from "@/lib/backup-server/refresh";
import { type OutsideLink, outsideLinks } from "@/lib/backup-server/switch";
import { connectAsAdmin } from "@/lib/db/pools";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { getOrganisation } from "@/lib/organisations/registry";
import { readServerSetting, writeServerValue } from "@/lib/server-settings";

/*
 * Stages 3 and 4 of the backup server plan (BKS20-BKS22, issue #11): the
 * backup server checks whether the main can be reached and offers a
 * switch-over when it can't, and a server admin can practise a switch-over
 * without doing one.
 */

const MAIN_ADDRESS = "backup_server_main_address";
const PRACTICE = "backup_server_practice";
const MINUTE = 60 * 1000;
/** How long the main must be unreachable before server admins are asked whether to switch over (the plan's default). */
export const OFFER_AFTER_MINUTES = 15;
/** A practice older than this is worth doing again (the plan: every 6 months). */
export const PRACTISE_EVERY_DAYS = 183;

type MainAddress = { url?: string | null; unreachableSince?: string | null; offeredAt?: string | null; checkedAt?: string | null };
export type MainReach = { url: string | null; reachable: boolean | null; unreachableSince: string | null; offeredAt: string | null; checkedAt: string | null; offer: boolean };

export type Fetcher = (url: string) => Promise<boolean>;
const liveFetch: Fetcher = async (url) => {
  try {
    const response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(8000), redirect: "manual" });
    return response.ok;
  } catch {
    return false;
  }
};

function toReach(stored: MainAddress, now: Date): MainReach {
  const since = stored.unreachableSince ?? null;
  return {
    url: stored.url ?? null,
    reachable: stored.url && stored.checkedAt ? !since : null,
    unreachableSince: since,
    offeredAt: stored.offeredAt ?? null,
    checkedAt: stored.checkedAt ?? null,
    offer: Boolean(since && now.getTime() - new Date(since).getTime() >= OFFER_AFTER_MINUTES * MINUTE),
  };
}

export async function mainReach(now = new Date()): Promise<MainReach> {
  return toReach((await readServerSetting<MainAddress, Record<string, never>>(MAIN_ADDRESS)).value, now);
}

/** The main server's outside address, so the backup server can tell when it can't be reached (BKS20). Empty turns the check off. */
export async function setMainAddress(auth: ServerAdminAuth, input: { url?: unknown }): Promise<MainReach> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can change this.");
  if ((await serverRole()) !== "backup") throw new ValidationError("This isn't a backup server.");
  let url: string | null = null;
  if (typeof input.url === "string" && input.url.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(input.url.trim());
    } catch {
      throw new ValidationError("Give the main server's address in full, like https://books.example.nz.");
    }
    if (parsed.protocol !== "https:") throw new ValidationError("The main server's address starts with https://.");
    url = parsed.origin;
  }
  await withCoreTransaction((client) => writeServerValue(client, MAIN_ADDRESS, { url, unreachableSince: null, offeredAt: null, checkedAt: null }, auth.user.email));
  return mainReach();
}

/**
 * Asks the main's address whether it's up (BKS20). Unreachable for 15
 * minutes or more, it emails this server's admins once, asking whether to
 * switch over; it never switches by itself. When the main answers again,
 * the spell is over.
 */
export async function checkMainReachable(now = new Date(), fetcher: Fetcher = liveFetch): Promise<MainReach | null> {
  if ((await serverRole()) !== "backup") return null;
  const stored = (await readServerSetting<MainAddress, Record<string, never>>(MAIN_ADDRESS)).value;
  if (!stored.url) return null;
  const up = await fetcher(stored.url);
  const next: MainAddress = { ...stored, checkedAt: now.toISOString() };
  if (up) {
    next.unreachableSince = null;
    next.offeredAt = null;
  } else {
    next.unreachableSince = stored.unreachableSince ?? now.toISOString();
    if (!stored.offeredAt && now.getTime() - new Date(next.unreachableSince).getTime() >= OFFER_AFTER_MINUTES * MINUTE) {
      const copies = await copiesState();
      const newest = Object.values(copies.organisations).map((copy) => copy.madeAt).filter(Boolean).sort().at(-1);
      const admins = (await coreQuery<{ email: string }>("select email from users where is_server_admin and is_active")).rows;
      for (const admin of admins) {
        await sendSecurityAlert(admin.email, "the main server can't be reached: switch over?", [
          `The backup server hasn't been able to reach the main Tohyee server at ${stored.url} since ${next.unreachableSince}.`,
          newest ? `Its newest copy is the books as at ${newest}. Anything entered on the main after that isn't on the backup server.` : "It has no copies yet.",
          "If the main server is lost or won't be back soon, a server admin or an organisation's Owner can make the backup server the main one: sign in to the backup server and open Switch over.",
          "Tohyee won't switch over by itself.",
        ]).catch(() => false);
      }
      next.offeredAt = now.toISOString();
    }
  }
  await withCoreTransaction((client) => writeServerValue(client, MAIN_ADDRESS, next, "backup-server"));
  return toReach(next, now);
}

export type PracticeResult = {
  at: string;
  byEmail: string;
  organisations: { id: string; displayName: string; asAt: string | null; behindMinutes: number | null; opens: boolean; problem: string | null }[];
  /** Whether the note that stops the old main could be written in the backups folder. */
  noteCanBeWritten: boolean;
  links: OutsideLink[];
  /** Every check passed. */
  ready: boolean;
  problems: string[];
};

/**
 * "Practise a switch-over" (BKS21): everything a switch-over needs, checked
 * without switching. Each copy is opened; its age says how much work would
 * be lost today; a test file proves the note for the old main can be
 * written; and the outside address is tried. The result is kept, and worth
 * doing again every 6 months.
 */
export async function practiseSwitchOver(auth: ServerAdminAuth, now = new Date()): Promise<PracticeResult> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can practise a switch-over.");
  if ((await serverRole()) !== "backup") throw new ValidationError("This isn't a backup server.");
  const settings = await getBackupServerSettings();
  const copies = await copiesState();
  const problems: string[] = [];
  const organisations: PracticeResult["organisations"] = [];
  for (const [id, copy] of Object.entries(copies.organisations).sort((left, right) => left[1].displayName.localeCompare(right[1].displayName))) {
    if (copies.removed[id]) continue;
    let opens = false;
    let problem: string | null = copy.error ? `Its newest backup wasn't taken: ${copy.error}` : null;
    try {
      const organisation = await getOrganisation(id);
      if (!organisation) throw new Error("There's no copy of it here.");
      const client = await connectAsAdmin(organisation.databaseName);
      try {
        const row = await client.query<{ organisation_id: string }>("select organisation_id from organisation_settings where id = true");
        opens = row.rows[0]?.organisation_id === id;
        if (!opens) problem = "Its copy doesn't open as this organisation.";
      } finally {
        await client.end();
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    const behindMinutes = copy.madeAt ? Math.max(0, Math.round((now.getTime() - new Date(copy.madeAt).getTime()) / MINUTE)) : null;
    if (!opens || problem) problems.push(`${copy.displayName}: ${problem ?? "its copy couldn't be opened."}`);
    organisations.push({ id, displayName: copy.displayName, asAt: copy.madeAt || null, behindMinutes, opens, problem });
  }
  if (organisations.length === 0) problems.push("There are no copies here yet.");

  let noteCanBeWritten = false;
  if (settings.folder) {
    const probe = path.join(settings.folder, STATUS_FOLDER, "practice.tmp");
    try {
      await fs.mkdir(path.dirname(probe), { recursive: true });
      await fs.writeFile(probe, now.toISOString());
      await fs.rm(probe);
      noteCanBeWritten = true;
    } catch {
      noteCanBeWritten = false;
    }
  }
  if (!noteCanBeWritten) problems.push("The backups folder can't be written to from here, so an old main that came back wouldn't be told to stop.");

  const links = await outsideLinks();
  if (!links.some((link) => link.on)) problems.push("Remote access is off on this server: after a switch-over only its own network could reach it.");
  else if (!links.some((link) => link.reachable === "yes")) problems.push("This server couldn't reach its own outside address. Try it from a phone on mobile data.");

  const result: PracticeResult = { at: now.toISOString(), byEmail: auth.user.email, organisations, noteCanBeWritten, links, ready: problems.length === 0, problems };
  await withCoreTransaction(async (client) => {
    await writeServerValue(client, PRACTICE, result, auth.user.email);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, { eventType: "server.switch_over_practised", entityType: "server_setting", entityId: PRACTICE, details: { ready: result.ready, problems: problems.length, organisations: organisations.length } });
  });
  return result;
}

/** The last practice, and whether it's time for another (BKS22). */
export async function lastPractice(now = new Date()): Promise<{ last: PracticeResult | null; due: boolean }> {
  const stored = (await readServerSetting<Partial<PracticeResult>, Record<string, never>>(PRACTICE)).value;
  const last = stored.at ? (stored as PracticeResult) : null;
  return { last, due: !last || now.getTime() - new Date(last.at).getTime() > PRACTISE_EVERY_DAYS * 24 * 60 * MINUTE };
}
