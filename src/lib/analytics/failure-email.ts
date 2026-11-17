import { writeAuditEvent } from "@/lib/audit";
import type { Actor } from "@/lib/db/org-transaction";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { emailConfigured, sendEmail } from "@/lib/email/mailer";
import type { OrganisationRecord } from "@/lib/organisations/registry";

/*
 * An email when Analytics data stops refreshing: a
 * source whose last two loads both failed, the same test as the top bar's
 * notice. Sent once for each run of failures, to the
 * organisation's owners and admins, who can fix it on Data sources. It
 * names the sources and says where to look; why each failed stays in
 * Tohyee, since an error can name files and servers.
 */

type Stuck = { tableName: string; sourceName: string; runId: string };

/** Sources that have just failed for the second time running, and haven't been emailed about. */
async function newlyStuck(tx: Parameters<Parameters<typeof withOrganisationTransaction>[2]>[0]): Promise<Stuck[]> {
  const rows = await tx.query<{ table_name: string; source_name: string; run_id: string }>(
    `with ranked as (
       select id, table_name, source_name, status, row_number() over (partition by table_name order by started_at desc, id desc) as place
         from analytics_load_runs where status <> 'running'
     ), streak as (
       select table_name,
              max(id) filter (where place = 1) as run_id,
              max(source_name) filter (where place = 1) as source_name,
              bool_and(status = 'failed') filter (where place <= 2) as two_failed,
              count(*) filter (where place <= 2) as two,
              bool_or(status = 'failed') filter (where place = 3) as third_failed
         from ranked where place <= 3 group by table_name
     )
     select table_name, source_name, run_id::text from streak
      where two = 2 and two_failed and coalesce(third_failed, false) = false
        and not exists (select 1 from audit_events a where a.event_type = 'analytics.refresh_failure_emailed' and a.entity_id = streak.run_id::text)
      order by source_name`,
  );
  return rows.rows.map((row) => ({ tableName: row.table_name, sourceName: row.source_name, runId: row.run_id }));
}

/**
 * Emails the organisation's owners and admins about sources that have just
 * failed twice running. Returns how many emails went. Never throws: a
 * missing email must not stop the next load.
 */
export async function emailStuckSources(organisation: OrganisationRecord, actor: Actor): Promise<number> {
  try {
    if (!(await emailConfigured())) return 0;
    const stuck = await withOrganisationTransaction(organisation, actor, (tx) => newlyStuck(tx), { readOnly: true });
    if (stuck.length === 0) return 0;
    const people = await coreQuery<{ email: string }>(
      `select u.email from organisation_members m join users u on u.id = m.user_id
        where m.organisation_id = $1 and m.role in ('owner', 'admin') and u.is_active order by u.email`,
      [organisation.id],
    );
    const names = [...new Set(stuck.map((source) => source.sourceName))];
    const subject = names.length === 1 ? `Tohyee: ${names[0]} has stopped refreshing in Analytics` : `Tohyee: ${names.length} Analytics data sources have stopped refreshing`;
    const text = [
      `In ${organisation.displayName}, ${names.length === 1 ? "this Analytics data source has" : "these Analytics data sources have"} failed to refresh twice in a row:`,
      ...names.map((name) => `- ${name}`),
      "",
      "Reports that use them are showing older figures. Analytics › Data sources shows why each failed and has Refresh now to try again.",
      "You won't be emailed again about these until they've worked and then failed twice more.",
    ].join("\n");
    let sent = 0;
    for (const person of people.rows) {
      try {
        await sendEmail({ to: person.email, subject, text });
        sent += 1;
      } catch (error) {
        console.warn(`[tohyee] Analytics failure email to ${person.email} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    // Marked once anyone was told (or there was nobody to tell), so the next check doesn't send it again.
    if (sent > 0 || people.rows.length === 0) {
      await withOrganisationTransaction(organisation, actor, async (tx) => {
        for (const source of stuck) {
          await writeAuditEvent(tx, { eventType: "analytics.refresh_failure_emailed", entityType: "analytics_load_run", entityId: source.runId, details: { tableName: source.tableName, sourceName: source.sourceName, emails: sent } });
        }
      });
    }
    return sent;
  } catch (error) {
    console.warn(`[tohyee] Analytics failure email (${organisation.id}):`, error instanceof Error ? error.message : error);
    return 0;
  }
}
