import { afterAll, beforeAll, expect, it } from "vitest";
import * as reviewAttachmentRoute from "@/app/api/chat/review/attachments/[attachmentId]/route";
import * as reviewRoomRoute from "@/app/api/chat/review/[roomId]/route";
import * as reviewRoute from "@/app/api/chat/review/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listRoomMessages, postRoomMessage } from "@/lib/chat/messages";
import { chatList } from "@/lib/chat/overview";
import { joinForReview, removeInReview, reviewAttachment, reviewList, reviewRoom } from "@/lib/chat/review";
import { createSpace, everyoneRoomId, getRoom, startDirect } from "@/lib/chat/rooms";
import { setTeamChatEnabled } from "@/lib/chat/team";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "chat-review-co";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Route = Record<string, (request: Request, context: never) => Promise<Response>>;

/** Owners and admins can review any chat, openly and on the record (TCH19-TCH21; details following common practice, not yet reviewed). */
describeWithDatabase("chat review", () => {
  let server: TestServer;
  const people: Record<string, SessionUser> = {};
  const as = (who: string) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: people[who].id, email: people[who].email }, work);
  const get = async (route: Route, who: string, path: string, context?: unknown) =>
    route.GET(apiRequest(path, { cookie: await sessionCookieFor(people[who]) }), (context ?? undefined) as never);
  const audits = (eventType: string) =>
    as("olive")((tx) =>
      tx.query<{ entity_id: string; actor_email: string; details: Record<string, unknown>; created_at: string }>(
        "select entity_id, actor_email, details, created_at::text from audit_events where event_type = $1 order by id",
        [eventType],
      ),
    ).then((result) => result.rows);
  let direct = "";
  let space = "";
  let photoId = "";
  let messageId = "";

  beforeAll(async () => {
    server = await startTestServer();
    for (const [who, name] of [["olive", "Olive Owner"], ["ari", "Ari Admin"], ["bea", "Bea Tane"], ["ben", "Ben Tui"]]) {
      people[who] = await createTestUser(`chat-review-${who}@example.com`, { displayName: name });
    }
    await createTestOrganisation(people.olive, ORG);
    for (const [who, role] of [["ari", "admin"], ["bea", "bookkeeper"], ["ben", "bookkeeper"]]) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, people[who].id, role]);
    }
    await as("olive")((tx) => setTeamChatEnabled(tx, { enabled: true }));
    direct = (await as("bea")((tx) => startDirect(tx, { userIds: [people.ben.id], idempotencyKey: key("dm") }))).id;
    const photo = await as("bea")((tx) => postRoomMessage(tx, { roomId: direct, body: "The quote I mentioned", photos: [{ fileName: "q.png", contentBase64: PNG }], idempotencyKey: key("m") }));
    photoId = photo.attachments[0].id;
    messageId = photo.id;
    space = (await as("ben")((tx) => createSpace(tx, { name: "Rosters", userIds: [people.bea.id], idempotencyKey: key("s") }))).id;
    await as("ben")((tx) => postRoomMessage(tx, { roomId: space, body: "Who can do Saturday?", idempotencyKey: key("m") }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("TCH19: every direct message and space says owners and admins can read it; Everyone doesn't need to", async () => {
    expect((await as("bea")((tx) => getRoom(tx, direct))).privacyLine).toBe(true);
    expect((await as("bea")((tx) => getRoom(tx, space))).privacyLine).toBe(true);
    const everyone = await as("bea")((tx) => everyoneRoomId(tx));
    expect((await as("bea")((tx) => getRoom(tx, everyone))).privacyLine).toBe(false);
  });

  it("TCH20: Review chats is only for owners and admins, apart from their own list, with no unread and no posting", async () => {
    expect((await get(reviewRoute, "bea", `/api/chat/review?organisationId=${ORG}`)).status).toBe(403);
    await expect(as("bea")((tx) => reviewRoom(tx, direct))).rejects.toThrow("Review chats is for owners and admins.");
    const listed = await as("olive")((tx) => reviewList(tx));
    expect(listed.map((chat) => [chat.kind, chat.name, chat.youreIn])).toEqual(
      expect.arrayContaining([
        ["direct", "Bea Tane, Ben Tui", false],
        ["space", "Rosters", false],
      ]),
    );
    expect(listed[0]).not.toHaveProperty("unread");
    const answer = await get(reviewRoomRoute, "olive", `/api/chat/review/${direct}?organisationId=${ORG}`, params({ roomId: direct }));
    expect(answer.status).toBe(200);
    const opened = await answer.json();
    expect(opened.messages.map((message: { body: string }) => message.body)).toEqual(["The quote I mentioned"]);
    expect(opened.room).toMatchObject({ canPost: false, youreIn: false });
    expect(opened.room).not.toHaveProperty("unread");
    // Not in the owner's own list, and nothing to post with.
    const own = await as("olive")((tx) => chatList(tx));
    expect([...own.direct.chats, ...own.spaces.chats].map((chat) => chat.ref)).not.toContain(direct);
    await expect(as("olive")((tx) => postRoomMessage(tx, { roomId: direct, body: "Hello", idempotencyKey: key("m") }))).rejects.toThrow("Chat not found.");
  });

  it("TCH21: each opening, photo and take-down from review is in the audit trail", async () => {
    const before = (await audits("chat.reviewed")).length;
    await as("ari")((tx) => reviewRoom(tx, space));
    const after = await audits("chat.reviewed");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ entity_id: space, actor_email: people.ari.email, details: { kind: "space", name: "Rosters" } });
    expect(after.at(-1)!.created_at).toBeTruthy();
    const file = await get(reviewAttachmentRoute, "ari", `/api/chat/review/attachments/${photoId}?organisationId=${ORG}`, params({ attachmentId: photoId }));
    expect(file.status).toBe(200);
    expect((await audits("chat.reviewed")).at(-1)).toMatchObject({ entity_id: direct, details: { attachmentId: photoId } });
    // A member reading their own chat isn't recorded.
    const count = (await audits("chat.reviewed")).length;
    await as("bea")((tx) => listRoomMessages(tx, { roomId: direct }));
    expect((await audits("chat.reviewed")).length).toBe(count);
    // Bookkeepers can't open files through review.
    await expect(as("bea")((tx) => reviewAttachment(tx, photoId))).rejects.toThrow("Review chats is for owners and admins.");
    // Taking a message down from review.
    expect(await as("ari")((tx) => removeInReview(tx, messageId))).toMatchObject({ removed: true });
    expect((await audits("chat.removed")).at(-1)).toMatchObject({ entity_id: messageId, details: { review: true, roomId: direct } });
  });

  it("TCH20: an admin can join a space from review, but not a direct message", async () => {
    await expect(as("ari")((tx) => joinForReview(tx, direct))).rejects.toThrow("A direct message can't be joined.");
    await as("ari")((tx) => joinForReview(tx, space));
    expect((await as("ari")((tx) => chatList(tx))).spaces.chats.map((chat) => chat.name)).toContain("Rosters");
    expect((await as("ari")((tx) => postRoomMessage(tx, { roomId: space, body: "I can", idempotencyKey: key("m") }))).body).toBe("I can");
    expect((await audits("chat.joined")).at(-1)).toMatchObject({ entity_id: space, details: { fromReview: true } });
  });
});
