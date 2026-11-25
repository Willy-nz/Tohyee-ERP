import { ROLE_LABELS, type Role } from "@/lib/auth/roles";

/** What the server gives back from inviting someone; see InvitationLink in members.ts. */
export type InvitationOutcome = { emailed: boolean; url: string | null; localOnly: boolean; expiresAt: string };

/**
 * What People and roles says after Invite or Resend. Kept here (no server
 * code) so the page and its unit test share it.
 */
export function invitationMessage(
  action: "invite" | "resend",
  email: string,
  role: Role | null,
  invitation: InvitationOutcome | null,
  waiting: { emailed: boolean } | null = null,
): { tone: "success" | "warning"; text: string } {
  if (waiting) {
    // Their login's address isn't confirmed yet, so they weren't added.
    const lead = `${email} already has a login on this server, but nobody has confirmed the email address belongs to whoever uses it. They haven't been added yet.`;
    return waiting.emailed
      ? { tone: "warning", text: `${lead} We've emailed them a link. They'll join once they use it (within 7 days; the invitation waits 30 days).` }
      : {
          tone: "warning",
          text: `${lead} We couldn't email them. Ask a server admin to send them a setup link from Users. They'll join once they use it (within 30 days).`,
        };
  }
  if (!invitation) {
    // They already had a login: added, as before (nothing is sent).
    return { tone: "success", text: `Added ${email}${role ? ` as ${ROLE_LABELS[role].toLowerCase()}` : ""}.` };
  }
  const lead = action === "invite" ? `Invited ${email}${role ? ` as ${ROLE_LABELS[role].toLowerCase()}` : ""}.` : `Sent ${email} a new invitation. The last link no longer works.`;
  if (invitation.emailed) return { tone: "success", text: `${lead} We've emailed them a link to set up their login.` };
  if (invitation.url) return { tone: "warning", text: `${lead} This server can't send email, so copy the link below and send it to them yourself.` };
  return {
    tone: "warning",
    text: `${lead} The email couldn't be sent. Ask a server admin to set up email sending, or to send them a setup link from Users.`,
  };
}
