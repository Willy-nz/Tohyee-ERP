import { writeAdminAuditEvent } from "@/lib/audit";
import type { Role } from "@/lib/auth/roles";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
import { removePayrollAccessOnJoin } from "@/lib/payroll/access";

/*
 * Invitations that wait for an email address to be confirmed.
 *
 * A login whose setup link was passed on by hand (the invitation couldn't be
 * emailed) might be held by whoever passed it on, not by the person whose
 * address it is. So another organisation inviting that address doesn't get
 * the login added straight away: the invitation waits here, and the person
 * is emailed a setup link. They join once their address is confirmed: by
 * using a link that reached their mailbox (or one a server admin gave them),
 * or by signing in with Google with the same address.
 */

/** How long a waiting invitation lasts before it's dropped. */
export const WAITING_DAYS = 30;

export type WaitingInvitation = {
  organisationId: string;
  userId: string;
  role: Role;
  accessStartsAt: string | null;
  accessEndsAt: string | null;
  invitedBy: { userId: string; email: string };
};

/** Records (or refreshes) a waiting invitation, inside the caller's transaction. */
export async function holdInvitation(client: DbClient, waiting: WaitingInvitation): Promise<void> {
  await client.query(
    `insert into organisation_waiting_members (organisation_id, user_id, role, access_starts_at, access_ends_at, invited_by_user_id, invited_by_email)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organisation_id, user_id) do update
       set role = excluded.role, access_starts_at = excluded.access_starts_at, access_ends_at = excluded.access_ends_at,
           invited_by_user_id = excluded.invited_by_user_id, invited_by_email = excluded.invited_by_email, invited_at = now()`,
    [waiting.organisationId, waiting.userId, waiting.role, waiting.accessStartsAt, waiting.accessEndsAt, waiting.invitedBy.userId, waiting.invitedBy.email],
  );
}

/** Marks a login's email address as confirmed. True when it wasn't before. */
export async function confirmEmail(client: DbClient, userId: string): Promise<boolean> {
  const updated = await client.query("update users set email_confirmed_at = now() where id = $1 and email_confirmed_at is null", [userId]);
  return updated.rowCount === 1;
}

type WaitingRow = { organisation_id: string; role: Role; access_starts_at: string | null; access_ends_at: string | null; invited_by_user_id: string | null; invited_by_email: string };

/**
 * Adds a login whose address is now confirmed to the organisations that were
 * waiting for it. Run after the confirming transaction. Each organisation is
 * done on its own; one that fails stays waiting (inviting again retries it).
 */
export async function joinWaitingOrganisations(userId: string): Promise<string[]> {
  const user = await coreQuery<{ email: string; confirmed: boolean }>("select email, email_confirmed_at is not null as confirmed from users where id = $1", [userId]);
  const login = user.rows[0];
  if (!login?.confirmed) return [];
  await coreQuery(`delete from organisation_waiting_members where user_id = $1 and invited_at <= now() - ($2::int * interval '1 day')`, [userId, WAITING_DAYS]);
  const waiting = await coreQuery<WaitingRow>(
    "select organisation_id, role, access_starts_at, access_ends_at, invited_by_user_id::text, invited_by_email from organisation_waiting_members where user_id = $1",
    [userId],
  );
  const joined: string[] = [];
  for (const row of waiting.rows) {
    try {
      const actor = { userId: row.invited_by_user_id, email: row.invited_by_email };
      // As for any join: they start without payroll access (PE12).
      const organisation = await getOrganisation(row.organisation_id);
      if (organisation && organisation.provisioningStatus === "ready") {
        await withOrganisationTransaction(organisation, { userId: row.invited_by_user_id ?? userId, email: row.invited_by_email }, (tx) =>
          removePayrollAccessOnJoin(tx, userId, login.email),
        );
      }
      const added = await withCoreTransaction(async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`members:${row.organisation_id}`]);
        const taken = await client.query("delete from organisation_waiting_members where organisation_id = $1 and user_id = $2", [row.organisation_id, userId]);
        if (taken.rowCount === 0) return false;
        const inserted = await client.query(
          "insert into organisation_members (organisation_id, user_id, role, access_starts_at, access_ends_at) values ($1, $2, $3, $4, $5) on conflict do nothing",
          [row.organisation_id, userId, row.role, row.access_starts_at, row.access_ends_at],
        );
        if (inserted.rowCount === 0) return false;
        await writeAdminAuditEvent(client, actor, {
          eventType: "organisation.member_added",
          entityType: "organisation",
          entityId: row.organisation_id,
          details: { email: login.email, role: row.role, userId, afterEmailConfirmed: true },
        });
        return true;
      });
      if (added) joined.push(row.organisation_id);
    } catch (error) {
      console.error(`[tohyee] Couldn't add a confirmed login to organisation ${row.organisation_id}:`, error instanceof Error ? error.message : error);
    }
  }
  return joined;
}
