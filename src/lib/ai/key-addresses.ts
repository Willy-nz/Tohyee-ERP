import type { AiTokenIdentity } from "@/lib/ai/tokens";
import { coreQuery } from "@/lib/db/transactions";
import { emailConfigured, sendEmail } from "@/lib/email/mailer";

/*
 * Where an AI key or connected app was used from: the
 * address of its latest call is shown beside "last used" on the AI page, so
 * a key being used from somewhere unexpected is easy to spot. A Full access
 * key's owner is also emailed when it's used from an address it hasn't been
 * used from before.
 */

/** An address is noted again at most this often per key. */
const SEEN_EVERY = "5 minutes";
/** Addresses kept per key; the ones not seen for longest are dropped. */
const ADDRESSES_KEPT = 50;
/** At most one new-address email per key in this time, so an app whose address keeps changing isn't a flood. */
const EMAIL_EVERY = "24 hours";

/** Notes where this call came from. True when an email went. Never throws. */
export async function noteAiUseFrom(identity: Pick<AiTokenIdentity, "tokenId" | "kind" | "tokenName" | "accessLevel" | "user" | "membership">, address: string | null): Promise<boolean> {
  try {
    if (!address) return false;
    const from = address.slice(0, 100);
    const noted = await coreQuery<{ is_new: boolean }>(
      `insert into ai_token_addresses (token_id, address) values ($1, $2)
       on conflict (token_id, address) do update set last_seen_at = now()
         where ai_token_addresses.last_seen_at < now() - interval '${SEEN_EVERY}'
       returning (xmax = 0) as is_new`,
      [identity.tokenId, from],
    );
    if (noted.rows.length === 0) return false;
    await coreQuery("update ai_access_tokens set last_used_from = $2 where id = $1 and last_used_from is distinct from $2", [identity.tokenId, from]);
    if (!noted.rows[0].is_new) return false;
    await coreQuery(
      `delete from ai_token_addresses where token_id = $1 and address in (
         select address from ai_token_addresses where token_id = $1 order by last_seen_at desc offset ${ADDRESSES_KEPT})`,
      [identity.tokenId],
    );
    // The first address a key is used from is where its owner put it.
    const others = await coreQuery<{ n: number }>("select count(*)::int as n from ai_token_addresses where token_id = $1 and address <> $2", [identity.tokenId, from]);
    if (identity.kind !== "key" || identity.accessLevel !== "full" || others.rows[0].n === 0) return false;
    if (!(await emailConfigured())) return false;
    const claimed = await coreQuery(
      `update ai_access_tokens set new_address_emailed_at = now()
        where id = $1 and (new_address_emailed_at is null or new_address_emailed_at < now() - interval '${EMAIL_EVERY}') returning id`,
      [identity.tokenId],
    );
    if (claimed.rows.length === 0) return false;
    await sendEmail({
      to: identity.user.email,
      subject: `Tohyee: your AI key "${identity.tokenName}" was used from a new address`,
      text: [
        `Your Full access AI key "${identity.tokenName}" for ${identity.membership.organisation.displayName} was just used from ${from}, an address it hasn't been used from before.`,
        "If that was you or the app you gave the key to (an app's address can change), there's nothing to do.",
        "If it wasn't, revoke the key now in Tohyee under AI, and make a new one.",
        "",
        "You're getting this because the key is yours. You'll get at most one of these a day for each key.",
      ].join("\n"),
    });
    return true;
  } catch (error) {
    console.warn("[tohyee] AI key address:", error instanceof Error ? error.message : error);
    return false;
  }
}
