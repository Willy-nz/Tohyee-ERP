import { isRole, roleAtLeast } from "@/lib/auth/roles";
import { businessTimeZone, todayIsoDate } from "@/lib/dates";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { emailConfigured, sendEmail } from "@/lib/email/mailer";
import { formatDate, formatMoney } from "@/lib/format";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { type EmailFrequency, type EmailWhen, getSavedSearch, runSearch, type SearchResult } from "@/lib/saved-searches/service";

/**
 * Saved searches by email: each person's own choice of how often, and
 * whether only when there's something in it or something new. The search is
 * run as that person, with the role they have that day, so an email never
 * holds more than they could open on the screen. Checked every hour; nothing
 * goes if the server can't send email. Off with TOHYEE_SAVED_SEARCH_EMAILS=off.
 */

const SYSTEM = { userId: null, email: "saved-searches@tohyee" } as const;
const ROWS_IN_EMAIL = 25;
const IDS_KEPT = 2000;

/** Monday of the week a date is in. */
function weekStart(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return at.toISOString().slice(0, 10);
}

/** Whether a search is due to be checked today: once a day, once in each week (from Monday), or once in each month. */
export function emailDue(frequency: EmailFrequency, lastCheckedOn: string | null, today: string): boolean {
  if (!lastCheckedOn) return true;
  if (lastCheckedOn >= today) return false;
  if (frequency === "daily") return true;
  if (frequency === "weekly") return weekStart(lastCheckedOn) !== weekStart(today);
  return lastCheckedOn.slice(0, 7) !== today.slice(0, 7);
}

/** Whether to send, given what matches now and what matched at the last check. */
export function shouldSend(onlyWhen: EmailWhen, ids: readonly string[], seen: readonly string[]): boolean {
  if (onlyWhen === "always") return true;
  if (onlyWhen === "has_rows") return ids.length > 0;
  const before = new Set(seen);
  return ids.some((id) => !before.has(id));
}

/** The email's words: the count, the first rows as lines, the totals, and where to open it. */
export function searchEmailText(input: { name: string; organisation: string; result: SearchResult; newCount: number | null }): { subject: string; text: string } {
  const { result } = input;
  const count = `${result.matches} found`;
  const cell = (value: string | null, index: number) => {
    const column = result.columns[index];
    if (value === null || value === "") return "-";
    if (column.type === "money") return formatMoney(value);
    if (column.type === "date") return formatDate(value);
    if (column.type === "choice") return column.choices?.[value] ?? value;
    return value;
  };
  const lines = [`${input.name}: ${count} in ${input.organisation}${input.newCount ? ` (${input.newCount} new)` : ""}.`, ""];
  if (result.rows.length > 0) {
    lines.push(result.columns.map((column) => column.label).join(" | "));
    for (const row of result.rows.slice(0, ROWS_IN_EMAIL)) lines.push(row.cells.map(cell).join(" | "));
    if (result.matches > ROWS_IN_EMAIL) lines.push(`... and ${result.matches - ROWS_IN_EMAIL} more.`);
    const totals = result.totals.map((total, index) => (total === null ? null : `${result.columns[index].label} ${formatMoney(total)}`)).filter(Boolean);
    if (totals.length > 0) lines.push("", `Totals of all that match: ${totals.join(", ")}.`);
  }
  lines.push("", "Open it in Tohyee under Reports, Saved searches.", "You asked for this email on that page, and can stop it there.");
  return { subject: `${input.name}: ${count}`, text: lines.join("\n") };
}

type Due = { id: string; search_id: string; user_id: string; frequency: EmailFrequency; only_when: EmailWhen; last_checked_on: string | null; seen_ids: string[] };

/** One organisation's due emails. Returns how many were sent. A search that fails is logged and tried again next time. */
export async function sendOrganisationSearchEmails(organisation: OrganisationRecord, today = todayIsoDate()): Promise<number> {
  const all = await withOrganisationTransaction(organisation, SYSTEM, async (tx) => {
    const result = await tx.query<Due>(
      `select e.id::text, e.search_id::text, e.user_id::text, e.frequency, e.only_when, to_char(e.last_checked_on, 'YYYY-MM-DD') as last_checked_on, e.seen_ids from saved_search_emails e order by e.id`,
    );
    return result.rows;
  });
  const due = all.filter((row) => emailDue(row.frequency, row.last_checked_on, today));
  if (due.length === 0) return 0;
  let sent = 0;
  for (const row of due) {
    try {
      // Who they are today: still a member, still someone who can see the books.
      const member = await coreQuery<{ email: string; role: string }>(
        `select u.email, m.role from organisation_members m join users u on u.id = m.user_id and u.is_active where m.organisation_id = $1 and m.user_id = $2`,
        [organisation.id, row.user_id],
      );
      const person = member.rows[0];
      if (!person || !isRole(person.role) || !roleAtLeast(person.role, "viewer")) {
        await withOrganisationTransaction(organisation, SYSTEM, (tx) => tx.query("delete from saved_search_emails where id = $1", [row.id]));
        continue;
      }
      const role = person.role;
      const outcome = await withOrganisationTransaction(organisation, { userId: row.user_id, email: person.email, role }, async (tx) => {
        // Throws if it's no longer theirs to open (made private again, or deleted).
        const search = await getSavedSearch(tx, row.search_id);
        const result = await runSearch(tx, { recordType: search.recordType, definition: search.definition, limit: IDS_KEPT, today });
        const ids = result.rows.map((each) => each.id);
        const seen = Array.isArray(row.seen_ids) ? row.seen_ids.map(String) : [];
        const send = shouldSend(row.only_when, ids, seen);
        const before = new Set(seen);
        const newCount = row.only_when === "new_rows" ? ids.filter((id) => !before.has(id)).length : null;
        return { search, result, ids, send, newCount };
      });
      if (outcome.send) {
        const message = searchEmailText({ name: outcome.search.name, organisation: organisation.displayName ?? organisation.id, result: outcome.result, newCount: outcome.newCount });
        await sendEmail({ to: person.email, subject: `Tohyee: ${message.subject}`, text: message.text });
        sent += 1;
      }
      await withOrganisationTransaction(organisation, SYSTEM, (tx) =>
        tx.query("update saved_search_emails set last_checked_on = $2, last_sent_on = case when $3 then $2::date else last_sent_on end, seen_ids = $4::jsonb, email = $5 where id = $1", [
          row.id,
          today,
          outcome.send,
          JSON.stringify(outcome.ids),
          person.email,
        ]),
      );
    } catch (error) {
      console.warn(`[tohyee] Saved search email ${row.id} failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return sent;
}

let running = false;

/** Every ready organisation's due emails. Never throws. */
export async function sendDueSearchEmails(): Promise<number> {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    // Not in the small hours: a weekly email is for Monday morning, not a minute past midnight.
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: businessTimeZone(), hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    if (hour < 6) return 0;
    if (!(await emailConfigured())) return 0;
    for (const organisation of await listOrganisationsForJobs()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      try {
        sent += await sendOrganisationSearchEmails(organisation);
      } catch (error) {
        console.warn(`[tohyee] Saved search emails failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    console.warn("[tohyee] Saved search emails:", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

/** Checks every hour while the server runs, and three minutes after it starts. */
export function startSavedSearchEmails(): void {
  if (timer || process.env.TOHYEE_SAVED_SEARCH_EMAILS === "off") return;
  const tick = () => void sendDueSearchEmails();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}
