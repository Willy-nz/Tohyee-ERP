import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { revokeUserAiKeys } from "@/lib/ai/tokens";
import { endPasskeys } from "@/lib/auth/passkey-end";
import { type AdminActor, writeAdminAuditEvent } from "@/lib/audit";
import { configuredOrigin } from "@/lib/auth/origin";
import { hashPassword, validateNewPassword } from "@/lib/auth/password";
import { createSession, type SessionMeta, type SessionUser, twoStepRequired } from "@/lib/auth/sessions";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { sendEmail } from "@/lib/email/mailer";
import { UnauthorizedError, ValidationError } from "@/lib/errors";
import { joinWaitingOrganisations } from "@/lib/organisations/waiting-members";

/**
 * Setup links. A server admin doesn't choose
 * anyone's password: adding a login (or resetting someone's two-step sign-in)
 * makes a one-time link, valid for SETUP_LINK_DAYS, which is emailed when the
 * server can send email and can always be copied and sent another way. The
 * person opens it from anywhere, chooses their password and sets up two-step
 * sign-in straight away. With two-step sign-in on, a password alone no longer
 * starts setting two-step up (signIn refuses it), so someone who learns a
 * password can't register their own authenticator app.
 */
export const SETUP_LINK_DAYS = 7;

export type SetupLink = {
  url: string;
  expiresAt: string;
  /** Emailed to the person (the server can send email). */
  emailed: boolean;
  /** Remote access is off, so the link uses this computer's name and only works on the local network. */
  localOnly: boolean;
};

export const SETUP_NEEDED =
  "Your login hasn't been set up yet. Open the setup link you were sent (it lasts 7 days), or ask whoever invited you, or your server admin, for a new one.";

/** When a setup link no longer works. Invited people ask whoever invited them. */
export const SETUP_LINK_USED = "This setup link has expired or was already used. Ask whoever invited you, or your server admin, for a new one.";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** The address the link starts with: remote access's public address, or this computer's name on the local network. */
async function linkOrigin(): Promise<{ origin: string; localOnly: boolean }> {
  const configured = await configuredOrigin();
  if (configured) return { origin: configured, localOnly: false };
  return { origin: `http://${hostname().toLowerCase()}:${process.env.PORT?.trim() || "3000"}`, localOnly: true };
}

/**
 * Makes a new setup link for a login, retiring any earlier one. Inside the
 * caller's transaction; emailSetupLink sends it afterwards.
 */
export async function createSetupLink(
  client: DbClient,
  userId: string,
  actor: AdminActor,
  options: { byServerAdmin?: boolean } = {},
): Promise<{ token: string; url: string; expiresAt: string; localOnly: boolean }> {
  const token = randomBytes(32).toString("base64url");
  await client.query("update user_setup_links set used_at = now() where user_id = $1 and used_at is null", [userId]);
  // A server admin's link vouches for the address; anyone else's only once it has been emailed (markSetupLinkEmailed).
  const inserted = await client.query<{ expires_at: string }>(
    `insert into user_setup_links (token_hash, user_id, created_by_email, expires_at, proves_email)
     values ($1, $2, $3, now() + ($4::int * interval '1 day'), $5) returning expires_at`,
    [hashToken(token), userId, actor.email, SETUP_LINK_DAYS, options.byServerAdmin === true],
  );
  await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
    eventType: "user.setup_link_created",
    entityType: "user",
    entityId: userId,
  });
  const { origin, localOnly } = await linkOrigin();
  return {
    token,
    url: `${origin}/login/setup-account?token=${encodeURIComponent(token)}`,
    expiresAt: new Date(inserted.rows[0].expires_at).toISOString(),
    localOnly,
  };
}

/**
 * The link reached the person's mailbox and was shown to nobody else, so
 * using it confirms the address is theirs. Only called after the email was
 * sent: a link used before this stays unconfirming, which is the safe side.
 */
export async function markSetupLinkEmailed(token: string): Promise<void> {
  await coreQuery("update user_setup_links set proves_email = true where token_hash = $1 and used_at is null", [hashToken(token)]);
}

/**
 * Another organisation invited someone whose login's address isn't confirmed
 * yet: a setup link to their mailbox. Using it confirms the address, and then
 * they join. Says whether it was sent.
 */
export async function emailConfirmationInvite(
  to: { email: string; displayName: string },
  link: { url: string; localOnly: boolean },
  invitedBy: { email: string; displayName: string },
  organisationName: string,
): Promise<boolean> {
  try {
    await sendEmail({
      to: to.email,
      subject: `Tohyee: you're invited to ${organisationName}`,
      text: [
        `Hi ${to.displayName},`,
        "",
        `${invitedBy.displayName} (${invitedBy.email}) has invited you to ${organisationName} in Tohyee.`,
        "There's already a Tohyee login for this email address on this server. Before you can join, we need to check the address is yours.",
        `Open this link within ${SETUP_LINK_DAYS} days and set up your login again: choose a password and set up two-step sign-in. Anyone else signed in to this login is signed out.`,
        link.url,
        ...(link.localOnly ? ["", "The link only works on the same network as the Tohyee server."] : []),
        "",
        "The link works once. If you weren't expecting this, ignore this email.",
      ].join("\n"),
    });
    return true;
  } catch {
    return false;
  }
}

/** Emails the link when the server can send email; says whether it did. */
export async function emailSetupLink(to: { email: string; displayName: string }, link: { url: string; localOnly: boolean }, adminEmail: string): Promise<boolean> {
  try {
    await sendEmail({
      to: to.email,
      subject: "Tohyee: set up your login",
      text: [
        `Hi ${to.displayName},`,
        "",
        `${adminEmail} has given you a login for Tohyee. To set it up, open this link within ${SETUP_LINK_DAYS} days, choose your password and set up two-step sign-in with an authenticator app on your phone:`,
        link.url,
        ...(link.localOnly ? ["", "The link only works on the same network as the Tohyee server."] : []),
        "",
        "The link works once. If you weren't expecting this, ignore this email.",
      ].join("\n"),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The invitation email: someone in an organisation's People and roles
 * invited a person who had no login yet. Says whether it was sent.
 */
export async function emailInvitation(
  to: { email: string; displayName: string },
  link: { url: string; localOnly: boolean },
  invitedBy: { email: string; displayName: string },
  organisationName: string,
): Promise<boolean> {
  try {
    await sendEmail({
      to: to.email,
      subject: `Tohyee: you're invited to ${organisationName}`,
      text: [
        `Hi ${to.displayName},`,
        "",
        `${invitedBy.displayName} (${invitedBy.email}) has invited you to ${organisationName} in Tohyee.`,
        `To accept, open this link within ${SETUP_LINK_DAYS} days and set up your login:`,
        link.url,
        ...(link.localOnly ? ["", "The link only works on the same network as the Tohyee server."] : []),
        "",
        "The link works once. If you weren't expecting this, ignore this email.",
      ].join("\n"),
    });
    return true;
  } catch {
    return false;
  }
}

/** A server admin's "Send setup link": a fresh link for a login whose two-step sign-in isn't set up. */
export async function sendSetupLink(actor: AdminActor, userId: string): Promise<SetupLink> {
  const { link, user } = await withCoreTransaction(async (client) => {
    const found = await client.query<{ email: string; display_name: string; is_active: boolean; two_step_enabled: boolean }>(
      "select email, display_name, is_active, totp_enabled_at is not null as two_step_enabled from users where id = $1 for update",
      [userId],
    );
    const row = found.rows[0];
    if (!row) throw new ValidationError("User not found.");
    if (!row.is_active) throw new ValidationError(`${row.email}'s login is off. Turn it back on first.`);
    if (row.two_step_enabled) throw new ValidationError(`${row.email} has already set up two-step sign-in. To start again (a lost phone), use Reset two-step.`);
    return { link: await createSetupLink(client, userId, actor, { byServerAdmin: true }), user: { email: row.email, displayName: row.display_name } };
  });
  const emailed = await emailSetupLink(user, link, actor.email);
  return { url: link.url, expiresAt: link.expiresAt, emailed, localOnly: link.localOnly };
}

/** `googleAvailable`: the person may choose Continue with Google instead of a password (never for server admins). */
export type SetupLinkState = { valid: boolean; email: string | null; displayName: string | null; googleAvailable: boolean };

/** What the setup page shows before anything is typed: whether the link still works, and whose it is. */
export async function readSetupLink(tokenInput: unknown): Promise<SetupLinkState> {
  const token = typeof tokenInput === "string" ? tokenInput : "";
  if (!token) return { valid: false, email: null, displayName: null, googleAvailable: false };
  const found = await coreQuery<{ email: string; display_name: string; is_server_admin: boolean }>(
    `select u.email, u.display_name, u.is_server_admin from user_setup_links l join users u on u.id = l.user_id
      where l.token_hash = $1 and l.used_at is null and l.expires_at > now() and u.is_active`,
    [hashToken(token)],
  );
  const row = found.rows[0];
  if (!row) return { valid: false, email: null, displayName: null, googleAvailable: false };
  const { googleSignInAvailable } = await import("@/lib/auth/google-sign-in");
  return { valid: true, email: row.email, displayName: row.display_name, googleAvailable: !row.is_server_admin && (await googleSignInAvailable()) };
}

/**
 * Uses a setup link: sets the password the person chose, starts two-step
 * sign-in afresh (any old authenticator and backup codes stop working, other
 * sessions end) and signs them in part-way, to set up their authenticator app.
 */
export async function completeAccountSetup(input: { token: unknown; password: unknown }, meta: SessionMeta): Promise<{ user: SessionUser; token: string; expiresAt: Date }> {
  const token = typeof input.token === "string" ? input.token : "";
  if (!token) throw new UnauthorizedError("This setup link is missing its code. Open the link again.");
  const password = validateNewPassword(input.password);
  const passwordHash = await hashPassword(password);
  let provesEmail = false;
  const signedIn = await withCoreTransaction(async (client) => {
    const claimed = await client.query<{ user_id: string; proves_email: boolean; was_confirmed: boolean }>(
      `update user_setup_links l set used_at = now()
         from users u
        where l.token_hash = $1 and l.used_at is null and l.expires_at > now() and u.id = l.user_id and u.is_active
        returning l.user_id, l.proves_email, u.email_confirmed_at is not null as was_confirmed`,
      [hashToken(token)],
    );
    const userId = claimed.rows[0]?.user_id;
    if (!userId) throw new UnauthorizedError(SETUP_LINK_USED);
    provesEmail = claimed.rows[0].proves_email;
    const updated = await client.query<{ email: string; display_name: string; is_server_admin: boolean }>(
      `update users set password_hash = $2, google_only = false, password_changed_at = now(), failed_login_count = 0, locked_until = null,
              totp_secret_ciphertext = null, totp_enabled_at = null, totp_last_step = null, updated_at = now(),
              -- Without two-step sign-in this is a full sign-in (it ends someone's "Invited").
              last_login_at = case when $3 then last_login_at else now() end,
              -- A link that was handed over by hand says nothing about who reads this mailbox.
              email_confirmed_at = case when $4 then coalesce(email_confirmed_at, now()) else null end
        where id = $1 returning email, display_name, is_server_admin`,
      [userId, passwordHash, twoStepRequired(), provesEmail],
    );
    if (provesEmail && !claimed.rows[0].was_confirmed) {
      // Whoever held the login before may have linked their own Google account to it.
      await client.query("delete from user_google_identities where user_id = $1 and email <> $2", [userId, updated.rows[0].email]);
    }
    await client.query("delete from user_backup_codes where user_id = $1", [userId]);
    await client.query("delete from sessions where user_id = $1", [userId]);
    await revokeUserAiKeys(client, userId);
    await endPasskeys(client, userId);
    const row = updated.rows[0];
    await writeAdminAuditEvent(client, { userId, email: row.email }, { eventType: "user.setup_completed", entityType: "user", entityId: userId });
    const session = await createSession(client, userId, meta, { pending: twoStepRequired() });
    return {
      user: { id: userId, email: row.email, displayName: row.display_name, isServerAdmin: row.is_server_admin },
      token: session.token,
      expiresAt: session.expiresAt,
    };
  });
  if (provesEmail) await joinWaitingOrganisations(signedIn.user.id);
  return signedIn;
}
