import { afterAll, beforeAll, expect, it } from "vitest";
import * as attachmentRoute from "@/app/api/chat/attachments/[attachmentId]/route";
import * as chatRoute from "@/app/api/chat/route";
import * as unreadRoute from "@/app/api/chat/unread/route";
import { findAiTool } from "@/lib/ai/catalogue";
import { loadToolModules, moduleHidesTool } from "@/lib/ai/tool-modules";
import type { SessionUser } from "@/lib/auth/sessions";
import { listTeamChat, postTeamMessage, removeTeamMessage, setTeamChatEnabled, teamChatUnread } from "@/lib/chat/team";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { listChat, postChatMessage } from "@/lib/farming/chat";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "team-chat-co";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(60, 2)]).toString("base64");

/** Team chat (TCH1-TCH8, following common practice, not yet reviewed). A made-up shop and people. */
describeWithDatabase("team chat", () => {
  let server: TestServer;
  const people: Record<string, SessionUser> = {};
  const as = (who: string, role: string) => <T>(work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: people[who].id, email: people[who].email, role: role as never }, work);
  const owner = as("owner", "owner");
  const bookkeeper = as("bookkeeper", "bookkeeper");
  const get = async (who: string, route: { GET: (request: Request, context: never) => Promise<Response> }, path: string, context?: unknown) =>
    route.GET(apiRequest(path, { cookie: await sessionCookieFor(people[who]) }), context as never);

  beforeAll(async () => {
    server = await startTestServer();
    for (const who of ["owner", "bookkeeper", "viewer", "rep", "worker", "reports"]) people[who] = await createTestUser(`team-chat-${who}@example.com`);
    await createTestOrganisation(people.owner, ORG);
    const roles: Array<[string, string]> = [
      ["bookkeeper", "bookkeeper"],
      ["viewer", "viewer"],
      ["rep", "sales_rep"],
      ["worker", "farm_worker"],
      ["reports", "report_viewer"],
    ];
    for (const [who, role] of roles) await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, people[who].id, role]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("TCH1: Chat is off until an admin turns it on, and its tools follow the switch", async () => {
    await expect(owner((tx) => listTeamChat(tx))).rejects.toThrow("Chat is off. An admin can turn it on under Settings, Modules.");
    expect(await owner((tx) => teamChatUnread(tx))).toEqual({ enabled: false, unread: 0 });
    expect(moduleHidesTool("read_team_chat", await owner((tx) => loadToolModules(tx)))).toContain("Chat is turned off");
    await owner((tx) => setTeamChatEnabled(tx, { enabled: true }));
    expect((await owner((tx) => getOrganisationSettings(tx))).chatEnabled).toBe(true);
    expect(moduleHidesTool("read_team_chat", await owner((tx) => loadToolModules(tx)))).toBeNull();
  });

  let first = "";
  it("TCH2, TCH3: one chat for everyone, with words, photos and a voice note, and no links", async () => {
    const message = await owner((tx) =>
      postTeamMessage(tx, { body: "Courier comes at 2 today", idempotencyKey: key("team"), photos: [{ fileName: "box.png", contentBase64: PNG }], voice: { seconds: 6, contentBase64: MP4 } }),
    );
    first = message.id;
    expect(message).toMatchObject({ body: "Courier comes at 2 today", mine: true, viaAi: false });
    expect(message.attachments.map((file) => file.kind)).toEqual(["photo", "voice"]);
    expect(message).not.toHaveProperty("links");
    await expect(owner((tx) => postTeamMessage(tx, { body: "Linked", idempotencyKey: key("team"), links: [{ kind: "paddock", id: "1" }] }))).rejects.toThrow(
      "Team chat messages don't link to records.",
    );
    await expect(owner((tx) => postTeamMessage(tx, { body: " ", idempotencyKey: key("team") }))).rejects.toThrow("Write something, add a photo or record a voice note.");
    await bookkeeper((tx) => postTeamMessage(tx, { body: "Got it", idempotencyKey: key("team") }));
    expect((await bookkeeper((tx) => listTeamChat(tx))).messages.map((entry) => entry.body)).toEqual(["Courier comes at 2 today", "Got it"]);
  });

  it("TCH2: it's apart from each farm's chat", async () => {
    await owner((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await owner((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    await owner((tx) => postChatMessage(tx, { farmId: farm, body: "On the farm", idempotencyKey: key("farm") }));
    expect((await owner((tx) => listChat(tx, { farmId: farm }))).messages.map((entry) => entry.body)).toEqual(["On the farm"]);
    expect((await owner((tx) => listTeamChat(tx))).messages.map((entry) => entry.body)).not.toContain("On the farm");
  });

  it("TCH6: sales reps read and post, viewers read only, farm staff and report viewers aren't in it", async () => {
    const posted = await chatRoute.POST(
      apiRequest("/api/chat", { method: "POST", cookie: await sessionCookieFor(people.rep), body: { organisationId: ORG, body: "Order for Ana is packed", idempotencyKey: key("team") } }),
      undefined as never,
    );
    expect(posted.status).toBe(201);
    expect((await get("viewer", chatRoute, `/api/chat?organisationId=${ORG}`)).status).toBe(200);
    const viewerPost = await chatRoute.POST(
      apiRequest("/api/chat", { method: "POST", cookie: await sessionCookieFor(people.viewer), body: { organisationId: ORG, body: "Hi", idempotencyKey: key("team") } }),
      undefined as never,
    );
    expect(viewerPost.status).toBe(403);
    expect((await get("worker", chatRoute, `/api/chat?organisationId=${ORG}`)).status).toBe(403);
    expect((await get("reports", chatRoute, `/api/chat?organisationId=${ORG}`)).status).toBe(403);
    // The voice note plays for people in the chat.
    const voiceId = (await owner((tx) => listTeamChat(tx))).messages[0].attachments.find((file) => file.kind === "voice")!.id;
    const played = await get("rep", attachmentRoute, `/api/chat/attachments/${voiceId}?organisationId=${ORG}`, { params: Promise.resolve({ attachmentId: voiceId }) });
    expect(played.status).toBe(200);
    expect(played.headers.get("content-type")).toBe("audio/mp4");
  });

  it("TCH5: unread counts others' messages since you last read", async () => {
    const answer = await get("viewer", unreadRoute, `/api/chat/unread?organisationId=${ORG}`);
    // Since TCH24 the count is every chat the viewer has: the team chat's 3 and the farm chat's 1.
    expect(await answer.json()).toEqual({ enabled: true, unread: 4 });
    // The owner posted the first and has read up to it; the bookkeeper's and the rep's are new to them.
    expect(await owner((tx) => teamChatUnread(tx))).toEqual({ enabled: true, unread: 2 });
  });

  it("TCH4: only the poster, or an owner or admin, takes a message down", async () => {
    await expect(bookkeeper((tx) => removeTeamMessage(tx, first))).rejects.toThrow("Only whoever posted a message, or an owner or admin, can take it down.");
    expect(await owner((tx) => removeTeamMessage(tx, first))).toMatchObject({ removed: true, body: "", attachments: [] });
  });

  it("TCH7: the AI reads the team chat and posts when asked, marked as from their AI", async () => {
    const read = findAiTool("read_team_chat")!;
    const post = findAiTool("post_team_chat_message")!;
    const posted = (await bookkeeper((tx) => post.run(tx, { body: "Stock count Friday", idempotencyKey: key("ai") }, {} as never))) as { message: { viaAi: boolean } };
    expect(posted.message.viaAi).toBe(true);
    const chat = (await bookkeeper((tx) => read.run(tx, {}, {} as never))) as { messages: Array<Record<string, unknown>> };
    expect(chat.messages.at(-1)).toMatchObject({ body: "Stock count Friday", viaAi: true });
    expect(chat.messages[0]).toMatchObject({ removed: true });
    await expect(as("worker", "farm_worker")((tx) => read.run(tx, {}, {} as never))).rejects.toThrow("Chat isn't open to this role.");
    await expect(as("viewer", "viewer")((tx) => post.run(tx, { body: "Hi" }, {} as never))).rejects.toThrow("Posting in Chat needs");
  });

  it("TCH1: turning Chat off keeps the messages for when it's back on", async () => {
    await owner((tx) => setTeamChatEnabled(tx, { enabled: false }));
    await expect(owner((tx) => listTeamChat(tx))).rejects.toThrow("Chat is off.");
    await owner((tx) => setTeamChatEnabled(tx, { enabled: true }));
    expect((await owner((tx) => listTeamChat(tx))).messages.length).toBe(4);
  });
});
