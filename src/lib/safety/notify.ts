import type { OrgTx } from "@/lib/db/org-transaction";
import { formatDate } from "@/lib/format";
import { listMembers } from "@/lib/organisations/members";
import { awaitingNotice, type ReportData } from "@/lib/safety/shared";

/*
 * When a safety report may need notifying to WorkSafe (OPF6), the
 * organisation's owners and admins are told by email, not just the person
 * who reported it. Tohyee never tells WorkSafe itself, and doesn't decide
 * whether the event is notifiable: the email says it may be and who to
 * call. Queued in the transaction, sent by the email job. The email has the
 * report's title, farm and date only, never the restricted injury details.
 */

export const WORKSAFE_PHONE = "0800 030 040";

/** Queues the email to each active owner and admin (not the person who just saved it), once per report. */
export async function queueNotifiableAlert(tx: OrgTx, report: { recordId: string; farmId: string | null; happenedOn: string | null; data: ReportData }): Promise<number> {
  if (!awaitingNotice(report.data)) return 0;
  const farm = report.farmId ? ((await tx.query<{ name: string }>("select name from farms where id = $1", [report.farmId])).rows[0]?.name ?? "a farm") : "a farm";
  const people = (await listMembers(tx.organisationId)).filter((member) => member.isActive && (member.role === "owner" || member.role === "admin") && member.userId !== tx.actor.userId && member.email);
  let queued = 0;
  for (const person of people) {
    const subject = `Safety: a report on ${farm} may need notifying to WorkSafe`.slice(0, 250);
    const body = [
      `Hi ${person.displayName || person.email},`,
      "",
      `A safety report on ${farm} may need notifying to WorkSafe: "${report.data.title}"${report.happenedOn ? `, ${formatDate(report.happenedOn)}` : ""}.`,
      "",
      `The person who reported it answered yes to one of WorkSafe's questions about notifiable events (a death, a notifiable injury or illness, or a dangerous incident). If it's notifiable, WorkSafe must be told as soon as possible: ${WORKSAFE_PHONE}, or online at worksafe.govt.nz.`,
      "",
      "Open Tohyee, go to Farm › Safety and open the report to read it and record when WorkSafe was told. Tohyee doesn't tell WorkSafe itself.",
    ].join("\n");
    const added = await tx.query(
      "insert into safety_emails (report_record_id, to_user_id, to_email, subject, body) values ($1, $2, $3, $4, $5) on conflict (report_record_id, to_user_id) do nothing",
      [report.recordId, person.userId, person.email, subject, body.slice(0, 5000)],
    );
    queued += added.rowCount ?? 0;
  }
  return queued;
}
