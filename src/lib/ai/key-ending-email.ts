import { AI_KEY_UNUSED_DAYS, AI_KEY_WARNING_DAYS } from "@/lib/ai/tokens";
import { coreQuery } from "@/lib/db/transactions";
import { emailConfigured, sendEmail } from "@/lib/email/mailer";
import { formatDate } from "@/lib/format";

/*
 * An email before an AI key stops: the top bar already
 * says so a week ahead, but only to someone who opens
 * Tohyee, and a key is often used by an app that never does. Each key's
 * owner is emailed once, a week before it stops, by its end date or because
 * it hasn't been used for 90 days.
 */

/** When a key stops: its end date, or 90 days after it was last used (or made), whichever is first. */
const STOPS_AT = `least(coalesce(t.expires_at, 'infinity'), coalesce(t.last_used_at, t.created_at) + interval '${AI_KEY_UNUSED_DAYS} days')`;

type Ending = { id: string; name: string; email: string; organisation: string; stops_at: string; by_end_date: boolean };

/** Emails the owners of keys that stop within a week and haven't been told. Returns how many emails went. Never throws. */
export async function emailKeysEndingSoon(): Promise<number> {
  try {
    if (!(await emailConfigured())) return 0;
    const ending = await coreQuery<Ending>(
      `select t.id::text, t.name, u.email, o.display_name as organisation, ${STOPS_AT}::text as stops_at,
              (t.expires_at is not null and t.expires_at <= coalesce(t.last_used_at, t.created_at) + interval '${AI_KEY_UNUSED_DAYS} days') as by_end_date
         from ai_access_tokens t
         join users u on u.id = t.user_id and u.is_active
         join organisations o on o.id = t.organisation_id and o.is_active
        where t.kind = 'key' and t.revoked_at is null
          and ${STOPS_AT} > now() and ${STOPS_AT} <= now() + interval '${AI_KEY_WARNING_DAYS} days'
          and t.ending_warned_for is distinct from ${STOPS_AT}
        order by t.id`,
    );
    let sent = 0;
    for (const key of ending.rows) {
      const day = formatDate(key.stops_at.slice(0, 10));
      try {
        await sendEmail({
          to: key.email,
          subject: `Tohyee: your AI key "${key.name}" stops on ${day}`,
          text: [
            `Your AI key "${key.name}" for ${key.organisation} stops working on ${day}.`,
            key.by_end_date
              ? "That's the end date it was given. To carry on after that, make a new key in Tohyee under AI, and put it in the app that uses this one."
              : `It hasn't been used for a while, and a key that isn't used for ${AI_KEY_UNUSED_DAYS} days stops. Using it before then keeps it going; if nothing needs it any more, you can leave it to stop.`,
            "",
            "You're getting this because the key is yours. Nobody else can see or use it.",
          ].join("\n"),
        });
        sent += 1;
        await coreQuery("update ai_access_tokens set ending_warned_for = $2::timestamptz where id = $1", [key.id, key.stops_at]);
      } catch (error) {
        console.warn(`[tohyee] AI key ending email to ${key.email} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    return sent;
  } catch (error) {
    console.warn("[tohyee] AI key ending emails:", error instanceof Error ? error.message : error);
    return 0;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks every hour while the server runs. */
export function startAiKeyEndingEmails(): void {
  if (timer) return;
  const tick = () => void emailKeysEndingSoon();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}
