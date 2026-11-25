import { describe, expect, it } from "vitest";
import { invitationMessage } from "@/lib/organisations/invite-messages";

const link = { expiresAt: "2026-11-01T00:00:00.000Z", localOnly: false };

describe("what People and roles says after inviting", () => {
  it("someone with a login is just added", () => {
    expect(invitationMessage("invite", "tama@example.com", "bookkeeper", null)).toEqual({ tone: "success", text: "Added tama@example.com as bookkeeper." });
  });

  it("someone new is invited by email, or the inviter copies the link", () => {
    expect(invitationMessage("invite", "kiri@example.com", "viewer", { ...link, emailed: true, url: null }).text).toBe(
      "Invited kiri@example.com as viewer. We've emailed them a link to set up their login.",
    );
    expect(invitationMessage("invite", "kiri@example.com", "viewer", { ...link, emailed: false, url: "https://books.example.nz/login/setup-account?token=x" })).toMatchObject({
      tone: "warning",
      text: expect.stringContaining("copy the link below"),
    });
  });

  it("a resend that couldn't be emailed, with no link to show, says who can help", () => {
    const said = invitationMessage("resend", "lani@example.com", null, { ...link, emailed: false, url: null });
    expect(said.tone).toBe("warning");
    expect(said.text).toMatch(/^Sent lani@example.com a new invitation\. The last link no longer works\. The email couldn't be sent\./);
  });

  it("someone whose login's address isn't confirmed wasn't added, and the inviter is told plainly", () => {
    const emailed = invitationMessage("invite", "hemi@example.com", "viewer", null, { emailed: true });
    expect(emailed.tone).toBe("warning");
    expect(emailed.text).toMatch(/^hemi@example.com already has a login on this server, but nobody has confirmed the email address belongs to whoever uses it\. They haven't been added yet\. We've emailed them a link\./);
    const notEmailed = invitationMessage("invite", "hemi@example.com", "viewer", null, { emailed: false });
    expect(notEmailed.text).toMatch(/We couldn't email them\. Ask a server admin to send them a setup link from Users\./);
  });
});
