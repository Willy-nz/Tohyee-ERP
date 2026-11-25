import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import * as setupAccountRoute from "@/app/api/auth/setup-account/route";
import * as invitationRoute from "@/app/api/organisations/[organisationId]/members/[userId]/invitation/route";
import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import { sendSetupLink } from "@/lib/auth/setup-links";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const FIRST = "confirm-first-org";
const SECOND = "confirm-second-org";

type Json = Record<string, unknown>;
const json = async (response: Response) => (await response.json()) as Json;

/**
 * A login set up through a setup link that was passed on by hand isn't
 * trusted as the owner of its email address by other organisations until the
 * address is confirmed. Email is captured, never sent; every person and
 * address is made up.
 */
describeWithDatabase("invitations and confirming an email address", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const sent: OutgoingEmail[] = [];
  let emailWorks = true;
  let serverAdmin: SessionUser;
  let firstAdmin: SessionUser;
  let secondOwner: SessionUser;
  const cookies = new Map<string, string>();
  const cookie = async (user: SessionUser) => {
    if (!cookies.has(user.id)) cookies.set(user.id, await sessionCookieFor(user));
    return cookies.get(user.id)!;
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "invitation-confirm-test-key-0123456789abcdef";
    server = await startTestServer();
    setEmailSenderForTests(async (message) => {
      if (!emailWorks) throw new Error("mail server unreachable");
      sent.push(message);
    });
    serverAdmin = await createTestUser("conf-server-admin@example.com", { serverAdmin: true, displayName: "Server Admin" });
    firstAdmin = await createTestUser("conf-first-admin@example.com", { displayName: "First Admin" });
    secondOwner = await createTestUser("conf-second-owner@example.com", { displayName: "Second Owner" });
    await updateEmailSettings({ user: { id: serverAdmin.id, email: serverAdmin.email, isServerAdmin: true } }, { host: "smtp.example.com", port: 465, username: "books@example.com", password: "app-password" });
    await createTestOrganisation(serverAdmin, FIRST);
    await createTestOrganisation(serverAdmin, SECOND);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin'), ($3, $4, 'owner')", [FIRST, firstAdmin.id, SECOND, secondOwner.id]);
  });

  beforeEach(() => {
    sent.length = 0;
    emailWorks = true;
  });

  afterAll(async () => {
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  const invite = async (as: SessionUser, organisationId: string, body: Json) =>
    membersRoute.POST(apiRequest(`/api/organisations/${organisationId}/members`, { method: "POST", cookie: await cookie(as), body }), params({ organisationId }));
  const resend = async (as: SessionUser, organisationId: string, userId: string) =>
    invitationRoute.POST(apiRequest(`/api/organisations/${organisationId}/members/${userId}/invitation`, { method: "POST", cookie: await cookie(as) }), params({ organisationId, userId }));
  const openLink = async (token: string, password: string) =>
    setupAccountRoute.POST(apiRequest("/api/auth/setup-account", { method: "POST", body: { token, password } }), undefined as never);
  const tokenIn = (text: string) => decodeURIComponent(/token=([^\s&]+)/.exec(text)![1]);
  const login = async (email: string) =>
    (await coreQuery<{ id: string; confirmed: boolean; sessions: number }>(
      "select u.id::text, u.email_confirmed_at is not null as confirmed, (select count(*) from sessions s where s.user_id = u.id)::int as sessions from users u where u.email = $1",
      [email],
    )).rows[0];
  const isMember = async (organisationId: string, userId: string) =>
    ((await coreQuery("select 1 from organisation_members where organisation_id = $1 and user_id = $2", [organisationId, userId])).rowCount ?? 0) > 0;
  const waiting = async (organisationId: string, userId: string) =>
    (await coreQuery<{ role: string }>("select role from organisation_waiting_members where organisation_id = $1 and user_id = $2", [organisationId, userId])).rows[0];

  /** The first organisation invites an address while email is down, and its admin uses the shown link. */
  async function setUpByHand(email: string, displayName: string) {
    emailWorks = false;
    const first = await json(await invite(firstAdmin, FIRST, { email, displayName, role: "viewer" }));
    const url = (first.invitation as { url: string }).url;
    expect(url).toMatch(/setup-account\?token=/);
    expect((await openLink(tokenIn(url), "chosen-by-whoever-had-the-link-1")).status).toBe(200);
    emailWorks = true;
    sent.length = 0;
    return login(email);
  }

  it("a login set up from a link passed on by hand isn't added by another organisation: the invitation waits for the email to be confirmed", async () => {
    const held = await setUpByHand("hemi.target@example.com", "Hemi Target");
    expect(held).toMatchObject({ confirmed: false });
    expect(held.sessions).toBeGreaterThan(0);

    const response = await invite(secondOwner, SECOND, { email: "hemi.target@example.com", displayName: "Hemi", role: "bookkeeper" });
    expect(response.status).toBe(201);
    const result = await json(response);
    expect(result).toMatchObject({ member: null, invited: false, invitation: null, waiting: { emailed: true } });
    // The link only went to the mailbox: nothing in the answer to the inviter.
    expect(JSON.stringify(result)).not.toMatch(/token|setup-account/);
    expect(await isMember(SECOND, held.id)).toBe(false);
    expect(await waiting(SECOND, held.id)).toMatchObject({ role: "bookkeeper" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("hemi.target@example.com");
    expect(sent[0].text).toContain("check the address is yours");

    // Inviting again while it waits doesn't add them either.
    expect((await json(await invite(secondOwner, SECOND, { email: "hemi.target@example.com", displayName: "Hemi", role: "viewer" }))).waiting).toMatchObject({ emailed: true });
    expect(await isMember(SECOND, held.id)).toBe(false);
    const token = tokenIn(sent[1].text);

    // The person whose mailbox it is uses the link: the address is confirmed, whoever held the login is signed out, and they join.
    expect((await openLink(token, "the-real-persons-password-1")).status).toBe(200);
    const after = await login("hemi.target@example.com");
    expect(after.confirmed).toBe(true);
    expect(after.sessions).toBe(1);
    expect(await isMember(SECOND, held.id)).toBe(true);
    expect((await coreQuery<{ role: string }>("select role from organisation_members where organisation_id = $1 and user_id = $2", [SECOND, held.id])).rows[0].role).toBe("viewer");
    expect(await waiting(SECOND, held.id)).toBeUndefined();
    const audit = await coreQuery<{ details: Json }>("select details from admin_audit_events where event_type = 'organisation.member_added' and entity_id = $1 order by id desc limit 1", [SECOND]);
    expect(audit.rows[0].details).toMatchObject({ email: "hemi.target@example.com", afterEmailConfirmed: true });
  });

  it("with email down, the second inviter is told plainly and gets no link; a server admin's setup link confirms it", async () => {
    const held = await setUpByHand("moana.target@example.com", "Moana Target");
    emailWorks = false;
    const result = await json(await invite(secondOwner, SECOND, { email: "moana.target@example.com", displayName: "Moana", role: "viewer" }));
    expect(result).toMatchObject({ member: null, waiting: { emailed: false } });
    expect(JSON.stringify(result)).not.toMatch(/token|setup-account/);
    expect(await isMember(SECOND, held.id)).toBe(false);

    // The server admin vouches by giving the person a setup link themselves.
    const link = await sendSetupLink({ id: serverAdmin.id, email: serverAdmin.email }, held.id);
    expect((await openLink(tokenIn(link.url), "moanas-own-password-1")).status).toBe(200);
    expect((await login("moana.target@example.com")).confirmed).toBe(true);
    expect(await isMember(SECOND, held.id)).toBe(true);
  });

  it("a login whose invitation reached the mailbox is confirmed, and another organisation adds it as before", async () => {
    await invite(firstAdmin, FIRST, { email: "rua.emailed@example.com", displayName: "Rua Emailed", role: "viewer" });
    expect((await openLink(tokenIn(sent[0].text), "ruas-own-password-1")).status).toBe(200);
    const confirmed = await login("rua.emailed@example.com");
    expect(confirmed.confirmed).toBe(true);
    sent.length = 0;
    const result = await json(await invite(secondOwner, SECOND, { email: "rua.emailed@example.com", displayName: "Rua", role: "viewer" }));
    expect(result).toMatchObject({ invited: false, invitation: null, waiting: null, member: { email: "rua.emailed@example.com" } });
    expect(sent).toHaveLength(0);
    expect(await isMember(SECOND, confirmed.id)).toBe(true);
  });

  it("using a link passed on by hand takes the confirmation away again", async () => {
    await invite(firstAdmin, FIRST, { email: "nika.reset@example.com", displayName: "Nika Reset", role: "viewer" });
    expect((await openLink(tokenIn(sent[0].text), "nikas-own-password-1")).status).toBe(200);
    const before = await login("nika.reset@example.com");
    expect(before.confirmed).toBe(true);
    // Still Invited (two-step not set up yet), so a Resend with email down shows the link to the first admin.
    emailWorks = false;
    const resent = await json(await resend(firstAdmin, FIRST, before.id));
    const url = (resent.invitation as { url: string }).url;
    expect(url).toMatch(/setup-account/);
    expect((await openLink(tokenIn(url), "someone-elses-password-1")).status).toBe(200);
    expect((await login("nika.reset@example.com")).confirmed).toBe(false);
    emailWorks = true;
    expect((await json(await invite(secondOwner, SECOND, { email: "nika.reset@example.com", displayName: "Nika", role: "viewer" }))).waiting).toMatchObject({ emailed: true });
    expect(await isMember(SECOND, before.id)).toBe(false);
  });

  it("confirming by email removes a Google account someone else linked to the login", async () => {
    const held = await setUpByHand("ari.google@example.com", "Ari Google");
    await coreQuery("insert into user_google_identities (user_id, google_sub, email) values ($1, 'sub-holder', 'holder.personal@example.com')", [held.id]);
    await invite(secondOwner, SECOND, { email: "ari.google@example.com", displayName: "Ari", role: "viewer" });
    expect((await openLink(tokenIn(sent[0].text), "aris-own-password-1")).status).toBe(200);
    expect((await coreQuery("select 1 from user_google_identities where user_id = $1", [held.id])).rowCount).toBe(0);
    expect(await isMember(SECOND, held.id)).toBe(true);
  });
});
