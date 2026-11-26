import { afterAll, beforeAll, expect, it } from "vitest";
import * as messageRoute from "@/app/api/chat/[messageId]/route";
import * as attachmentRoute from "@/app/api/chat/attachments/[attachmentId]/route";
import * as roomMessagesRoute from "@/app/api/chat/rooms/[roomId]/messages/route";
import * as roomMembersRoute from "@/app/api/chat/rooms/[roomId]/members/route";
import * as roomReadRoute from "@/app/api/chat/rooms/[roomId]/read/route";
import * as roomRoute from "@/app/api/chat/rooms/[roomId]/route";
import * as roomsRoute from "@/app/api/chat/rooms/route";
import * as unreadRoute from "@/app/api/chat/unread/route";
import { findAiTool } from "@/lib/ai/catalogue";
import { loadToolModules, moduleHidesTool } from "@/lib/ai/tool-modules";
import type { SessionUser } from "@/lib/auth/sessions";
import { listRoomMessages, markRoomRead, postRoomMessage, removeRoomMessage } from "@/lib/chat/messages";
import { chatHome, chatList, chatMentions, chatUnreadTotal } from "@/lib/chat/overview";
import { chatPeople } from "@/lib/chat/people";
import { addToSpace, closeSpace, createSpace, everyoneRoomId, getRoom, leaveSpace, renameSpace, startDirect } from "@/lib/chat/rooms";
import { postTeamMessage, setTeamChatEnabled } from "@/lib/chat/team";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { postChatMessage } from "@/lib/farming/chat";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "chat-rooms-co";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const RANDOM_ROOM = "5b0e7a52-1f3c-4d2e-9a8b-7c6d5e4f3a21";

type Route = Record<string, (request: Request, context: never) => Promise<Response>>;

/** Direct messages, spaces and mentions (TCH10-TCH18, TCH22-TCH26; details following common practice, not yet reviewed). A made-up shop. */
describeWithDatabase("chat rooms", () => {
  let server: TestServer;
  const people: Record<string, SessionUser> = {};
  const as = (who: string) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: people[who].id, email: people[who].email }, work);
  const call = async (route: Route, method: string, who: string, path: string, body?: unknown, context?: unknown) =>
    route[method](apiRequest(path, { method, cookie: await sessionCookieFor(people[who]), body }), (context ?? undefined) as never);
  const roles: Array<[string, string, string]> = [
    ["olive", "owner", "Olive Owner"],
    ["ari", "admin", "Ari Admin"],
    ["bea", "bookkeeper", "Bea Tane"],
    ["ben", "bookkeeper", "Ben Tui"],
    ["sam", "sales_rep", "Sam Rep"],
    ["vic", "viewer", "Vic Viewer"],
    ["wren", "farm_worker", "Wren Worker"],
    ["rita", "report_viewer", "Rita Reports"],
    ["bo", "bookkeeper", "Bo Leaving"],
  ];

  beforeAll(async () => {
    server = await startTestServer();
    for (const [who, , name] of roles) people[who] = await createTestUser(`chat-rooms-${who}@example.com`, { displayName: name });
    await createTestOrganisation(people.olive, ORG);
    for (const [who, role] of roles.slice(1)) await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, people[who].id, role]);
    await as("olive")((tx) => setTeamChatEnabled(tx, { enabled: true }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  let direct = "";
  it("TCH12: a direct message is found by who's in it, so starting it again opens the same one", async () => {
    const started = await call(roomsRoute, "POST", "bea", "/api/chat/rooms", { organisationId: ORG, kind: "direct", userIds: [people.ben.id], idempotencyKey: key("dm") });
    expect(started.status).toBe(201);
    const room = (await started.json()).room;
    direct = room.id;
    expect(room).toMatchObject({ kind: "direct", name: "Ben Tui", privacyLine: true, canPost: true, canLeave: false, canManage: false });
    expect(room.members.map((member: { name: string }) => member.name).sort()).toEqual(["Bea Tane", "Ben Tui"]);
    const again = await as("ben")((tx) => startDirect(tx, { userIds: [people.bea.id], idempotencyKey: key("dm") }));
    expect(again.id).toBe(direct);
    expect(again.name).toBe("Bea Tane");
  });

  it("TCH13: small groups up to 12, fixed people, never closed, left or deleted", async () => {
    const group = await as("bea")((tx) => startDirect(tx, { userIds: [people.ben.id, people.sam.id], idempotencyKey: key("dm") }));
    expect(group.id).not.toBe(direct);
    expect(group.name).toBe("Ben Tui, Sam Rep");
    const many = Array.from({ length: 12 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    await expect(as("bea")((tx) => startDirect(tx, { userIds: many, idempotencyKey: key("dm") }))).rejects.toThrow("A direct message can have up to 12 people.");
    // Farm staff and report viewers aren't in Chat (TCH6), so they can't be picked.
    await expect(as("bea")((tx) => startDirect(tx, { userIds: [people.wren.id], idempotencyKey: key("dm") }))).rejects.toThrow("Choose people from the list.");
    await expect(as("bea")((tx) => startDirect(tx, { userIds: [people.rita.id], idempotencyKey: key("dm") }))).rejects.toThrow("Choose people from the list.");
    await expect(as("bea")((tx) => closeSpace(tx, direct))).rejects.toThrow("A direct message can't be closed or deleted.");
    await expect(as("olive")((tx) => closeSpace(tx, direct))).rejects.toThrow("Chat not found.");
    await expect(as("bea")((tx) => leaveSpace(tx, direct))).rejects.toThrow("You can't leave a direct message.");
    await expect(as("bea")((tx) => addToSpace(tx, direct, [people.sam.id]))).rejects.toThrow("Who's in a direct message is fixed. Start another one to include more people.");
  });

  let space = "";
  it("TCH14: anyone who can post makes a space and names it; viewers can't; names are unique and never Everyone", async () => {
    const key1 = key("space");
    const made = await as("bea")((tx) => createSpace(tx, { name: " Stocktake ", userIds: [people.ben.id], idempotencyKey: key1 }));
    space = made.id;
    expect(made).toMatchObject({ kind: "space", name: "Stocktake", privacyLine: true, canManage: true, canLeave: true, canAddPeople: true });
    expect(made.members.map((member) => member.name).sort()).toEqual(["Bea Tane", "Ben Tui"]);
    expect((await as("bea")((tx) => createSpace(tx, { name: "Stocktake", userIds: [people.ben.id], idempotencyKey: key1 }))).id).toBe(space);
    await expect(as("ben")((tx) => createSpace(tx, { name: "stocktake", userIds: [], idempotencyKey: key("space") }))).rejects.toThrow("There's already an open space called stocktake.");
    await expect(as("ben")((tx) => createSpace(tx, { name: "Everyone", userIds: [], idempotencyKey: key("space") }))).rejects.toThrow("Everyone is the chat for the whole team.");
    const viewer = await call(roomsRoute, "POST", "vic", "/api/chat/rooms", { organisationId: ORG, kind: "space", name: "Mine", userIds: [], idempotencyKey: key("space") });
    expect(viewer.status).toBe(403);
    // A sales rep can.
    const rep = await call(roomsRoute, "POST", "sam", "/api/chat/rooms", { organisationId: ORG, kind: "space", name: "Orders", userIds: [people.vic.id], idempotencyKey: key("space") });
    expect(rep.status).toBe(201);
  });

  it("TCH15: members add others and can leave, and then can't read it", async () => {
    await as("ben")((tx) => addToSpace(tx, space, [people.sam.id]));
    expect((await as("sam")((tx) => chatList(tx))).spaces.chats.map((chat) => chat.name)).toContain("Stocktake");
    await as("sam")((tx) => leaveSpace(tx, space));
    await expect(as("sam")((tx) => listRoomMessages(tx, { roomId: space }))).rejects.toThrow("Chat not found.");
    expect((await as("sam")((tx) => chatList(tx))).spaces.chats.map((chat) => chat.name)).not.toContain("Stocktake");
    const everyoneId = await as("bea")((tx) => everyoneRoomId(tx));
    await expect(as("bea")((tx) => leaveSpace(tx, everyoneId))).rejects.toThrow("Everyone can't be left");
  });

  let everyone = "";
  it("TCH11: Everyone is the first space, can't be renamed or closed, and the old team chat posts there", async () => {
    everyone = await as("bea")((tx) => everyoneRoomId(tx));
    const old = await as("bea")((tx) => postTeamMessage(tx, { body: "Morning all", idempotencyKey: key("team") }));
    expect((await as("ben")((tx) => listRoomMessages(tx, { roomId: everyone }))).messages.map((message) => message.id)).toContain(old.id);
    await expect(as("olive")((tx) => renameSpace(tx, everyone, "All of us"))).rejects.toThrow("Everyone can't be renamed or closed.");
    await expect(as("olive")((tx) => closeSpace(tx, everyone))).rejects.toThrow("Everyone can't be renamed or closed.");
    expect((await as("vic")((tx) => getRoom(tx, everyone)))).toMatchObject({ kind: "everyone", name: "Everyone", privacyLine: false, canPost: false });
    // Everyone is everyone in Chat (TCH6): not farm staff or report viewers.
    const members = (await as("bea")((tx) => getRoom(tx, everyone))).members.map((member) => member.name);
    expect(members).toEqual(expect.arrayContaining(["Olive Owner", "Ari Admin", "Sam Rep", "Vic Viewer"]));
    expect(members).not.toContain("Wren Worker");
    expect(members).not.toContain("Rita Reports");
  });

  it("TCH16: the maker or an owner or admin renames or closes a space; a closed space is read-only", async () => {
    await expect(as("ben")((tx) => renameSpace(tx, space, "Count"))).rejects.toThrow("Only whoever made this space, or an owner or admin, can rename or close it.");
    expect((await as("bea")((tx) => renameSpace(tx, space, "Stocktake Dec"))).name).toBe("Stocktake Dec");
    await as("ben")((tx) => postRoomMessage(tx, { roomId: space, body: "Aisle 3 done", idempotencyKey: key("m") }));
    // Ari isn't in it, but is an admin.
    const patched = await call(roomRoute, "PATCH", "ari", `/api/chat/rooms/${space}`, { organisationId: ORG, closed: true }, params({ roomId: space }));
    expect(patched.status).toBe(200);
    await expect(as("ben")((tx) => postRoomMessage(tx, { roomId: space, body: "One more", idempotencyKey: key("m") }))).rejects.toThrow("This space is closed. Its messages are kept to read.");
    await expect(as("bea")((tx) => addToSpace(tx, space, [people.sam.id]))).rejects.toThrow("This space is closed.");
    await expect(as("bea")((tx) => renameSpace(tx, space, "Again"))).rejects.toThrow("This space is closed.");
    expect((await as("ben")((tx) => listRoomMessages(tx, { roomId: space }))).messages.map((message) => message.body)).toEqual(["Aisle 3 done"]);
    expect(await as("ben")((tx) => getRoom(tx, space))).toMatchObject({ closed: true, canPost: false, canAddPeople: false });
  });

  let farmId = "";
  it("TCH10, TCH17: the list has Home, Mentions, Direct messages and Spaces with unread counts; farm chats are spaces for who sees them", async () => {
    await as("olive")((tx) => setFarmingEnabled(tx, { enabled: true }));
    farmId = (await as("olive")((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    await as("olive")((tx) => postChatMessage(tx, { farmId, body: "Gate on the race is broken", idempotencyKey: key("farm") }));
    await as("ben")((tx) => postRoomMessage(tx, { roomId: direct, body: "Payroll's done", idempotencyKey: key("m") }));
    const list = await as("bea")((tx) => chatList(tx));
    expect(Object.keys(list)).toEqual(["home", "mentions", "direct", "spaces"]);
    expect(list.spaces.chats[0]).toMatchObject({ ref: everyone, kind: "everyone", name: "Everyone" });
    const farm = list.spaces.chats.find((chat) => chat.kind === "farm")!;
    expect(farm).toMatchObject({ ref: `farm:${farmId}`, name: "Home farm", unread: 1 });
    expect(list.direct.chats.find((chat) => chat.ref === direct)).toMatchObject({ name: "Ben Tui", unread: 1 });
    const spacesUnread = list.spaces.chats.reduce((sum, chat) => sum + chat.unread, 0);
    expect(list.spaces.unread).toBe(spacesUnread);
    expect(list.direct.unread).toBe(list.direct.chats.reduce((sum, chat) => sum + chat.unread, 0));
    expect(list.home.unread).toBe(list.direct.unread + list.spaces.unread);
    // Home: the latest from every chat, newest first, each naming its chat.
    const home = await as("bea")((tx) => chatHome(tx));
    expect(home.messages.slice(0, 2).map((message) => [message.chat.name, message.body, message.unread])).toEqual([
      ["Ben Tui", "Payroll's done", true],
      ["Home farm", "Gate on the race is broken", true],
    ]);
    // A sales rep doesn't see farm chats, so neither in the list nor Home.
    expect((await as("sam")((tx) => chatList(tx))).spaces.chats.some((chat) => chat.kind === "farm")).toBe(false);
    expect((await as("sam")((tx) => chatHome(tx))).messages.some((message) => message.chat.kind === "farm")).toBe(false);
    // Reading clears the count.
    await as("bea")((tx) => markRoomRead(tx, direct, home.messages[0].id));
    expect((await as("bea")((tx) => chatList(tx))).direct.chats.find((chat) => chat.ref === direct)!.unread).toBe(0);
  });

  let mentioned = "";
  it("TCH18: @ offers the chat's people; a mention shows under Mentions and is unread until that chat is opened past it", async () => {
    const message = await as("bea")((tx) => postRoomMessage(tx, { roomId: everyone, body: "@Ben Tui can you check the till?", mentions: [people.ben.id], idempotencyKey: key("m") }));
    mentioned = message.id;
    expect(message.mentions).toEqual([people.ben.id]);
    let mentions = await as("ben")((tx) => chatMentions(tx));
    expect(mentions.messages.map((entry) => [entry.chat.name, entry.body, entry.unread])).toEqual([["Everyone", "@Ben Tui can you check the till?", true]]);
    expect((await as("ben")((tx) => chatList(tx))).mentions.unread).toBe(1);
    await as("ben")((tx) => markRoomRead(tx, everyone, mentioned));
    expect((await as("ben")((tx) => chatList(tx))).mentions.unread).toBe(0);
    mentions = await as("ben")((tx) => chatMentions(tx));
    expect(mentions.messages[0].unread).toBe(false);
    // Only the chat's people can be mentioned.
    await expect(as("bea")((tx) => postRoomMessage(tx, { roomId: direct, body: "@Sam Rep", mentions: [people.sam.id], idempotencyKey: key("m") }))).rejects.toThrow(
      "Sam Rep isn't in this chat, so can't be mentioned.",
    );
    // Taking it down takes the mention away.
    await as("bea")((tx) => removeRoomMessage(tx, mentioned));
    expect((await as("ben")((tx) => chatMentions(tx))).messages).toEqual([]);
  });

  it("TCH22: for a chat you're not in, every address says Chat not found", async () => {
    const photo = await as("bea")((tx) => postRoomMessage(tx, { roomId: direct, body: "Receipt", photos: [{ fileName: "r.png", contentBase64: PNG }], idempotencyKey: key("m") }));
    const fileId = photo.attachments[0].id;
    const context = params({ roomId: direct });
    const checks: Array<[Route, string, string, unknown, unknown]> = [
      [roomRoute, "GET", `/api/chat/rooms/${direct}?organisationId=${ORG}`, undefined, context],
      [roomMessagesRoute, "GET", `/api/chat/rooms/${direct}/messages?organisationId=${ORG}`, undefined, context],
      [roomMessagesRoute, "POST", `/api/chat/rooms/${direct}/messages`, { organisationId: ORG, body: "Hi", idempotencyKey: key("m") }, context],
      [roomReadRoute, "POST", `/api/chat/rooms/${direct}/read`, { organisationId: ORG, upTo: photo.id }, context],
      [roomMembersRoute, "POST", `/api/chat/rooms/${direct}/members`, { organisationId: ORG, userIds: [people.sam.id] }, context],
      [roomRoute, "PATCH", `/api/chat/rooms/${direct}`, { organisationId: ORG, name: "Mine now" }, context],
      [attachmentRoute, "GET", `/api/chat/attachments/${fileId}?organisationId=${ORG}`, undefined, params({ attachmentId: fileId })],
      [messageRoute, "DELETE", `/api/chat/${photo.id}?organisationId=${ORG}`, undefined, params({ messageId: photo.id })],
      [roomMessagesRoute, "GET", `/api/chat/rooms/${RANDOM_ROOM}/messages?organisationId=${ORG}`, undefined, params({ roomId: RANDOM_ROOM })],
    ];
    for (const [route, method, path, body, ctx] of checks) {
      const answer = await call(route, method, "sam", path, body, ctx);
      expect([path, method, answer.status]).toEqual([path, method, 404]);
      expect((await answer.json()).error).toBe(method === "GET" && path.includes("attachments") ? "Photo not found." : method === "DELETE" ? "Message not found." : "Chat not found.");
    }
    // A sloppy id is refused before anything is looked up.
    expect((await call(roomMessagesRoute, "GET", "sam", `/api/chat/rooms/12/messages?organisationId=${ORG}`, undefined, params({ roomId: "12" }))).status).toBe(400);
    // An idempotency key from another chat can't fetch that chat's message.
    const used = key("m");
    await as("bea")((tx) => postRoomMessage(tx, { roomId: direct, body: "Private", idempotencyKey: used }));
    await expect(as("sam")((tx) => postRoomMessage(tx, { roomId: everyone, body: "Hi", idempotencyKey: used }))).rejects.toThrow("That idempotencyKey was used for a message in another chat.");
    // An owner isn't let in here either: reviewing is its own place (TCH20).
    await expect(as("olive")((tx) => listRoomMessages(tx, { roomId: direct }))).rejects.toThrow("Chat not found.");
  });

  let boDirect = "";
  it("TCH23: someone who leaves the organisation drops out of pickers; their messages stay; a one-to-one with them is read-only", async () => {
    boDirect = (await as("bea")((tx) => startDirect(tx, { userIds: [people.bo.id], idempotencyKey: key("dm") }))).id;
    await as("bo")((tx) => postRoomMessage(tx, { roomId: boDirect, body: "Handover notes are in the shared drive", idempotencyKey: key("m") }));
    const group = await as("bea")((tx) => startDirect(tx, { userIds: [people.bo.id, people.ben.id], idempotencyKey: key("dm") }));
    await coreQuery("delete from organisation_members where organisation_id = $1 and user_id = $2", [ORG, people.bo.id]);
    expect((await as("bea")((tx) => chatPeople(tx))).map((person) => person.name)).not.toContain("Bo Leaving");
    expect(await as("bea")((tx) => getRoom(tx, boDirect))).toMatchObject({ canPost: false, readOnlyBecause: "Bo Leaving is no longer in Chat here, so this chat is read-only." });
    await expect(as("bea")((tx) => postRoomMessage(tx, { roomId: boDirect, body: "Thanks", idempotencyKey: key("m") }))).rejects.toThrow("Bo Leaving is no longer in Chat here, so this chat is read-only.");
    expect((await as("bea")((tx) => listRoomMessages(tx, { roomId: boDirect }))).messages.map((message) => message.body)).toEqual(["Handover notes are in the shared drive"]);
    // A group carries on for the others.
    expect((await as("bea")((tx) => postRoomMessage(tx, { roomId: group.id, body: "Still here", idempotencyKey: key("m") }))).body).toBe("Still here");
    await expect(as("bea")((tx) => addToSpace(tx, space, [people.bo.id]))).rejects.toThrow();
    // Access that has ended counts the same.
    await coreQuery("update organisation_members set access_ends_at = now() - interval '1 day', access_starts_at = now() - interval '2 days' where organisation_id = $1 and user_id = $2", [ORG, people.vic.id]);
    expect((await as("bea")((tx) => chatPeople(tx))).map((person) => person.name)).not.toContain("Vic Viewer");
    await coreQuery("update organisation_members set access_ends_at = null, access_starts_at = null where organisation_id = $1 and user_id = $2", [ORG, people.vic.id]);
  });

  it("TCH24: the Chat app's badge counts every chat", async () => {
    const total = await as("ben")((tx) => chatUnreadTotal(tx));
    const list = await as("ben")((tx) => chatList(tx));
    expect(total).toEqual({ enabled: true, unread: list.home.unread });
    expect(total.unread).toBeGreaterThan(0);
    const answer = await call(unreadRoute, "GET", "ben", `/api/chat/unread?organisationId=${ORG}`);
    expect(await answer.json()).toEqual(total);
  });

  it("TCH25: the AI lists, reads and posts only in its person's chats, with mentions; never through review", async () => {
    const list = findAiTool("list_chats")!;
    const read = findAiTool("read_chat")!;
    const post = findAiTool("post_chat_message")!;
    expect([list.level, read.level, post.level]).toEqual(["read", "read", "draft"]);
    const chats = (await as("bea")((tx) => list.run(tx, {}, {} as never))) as { chats: Array<{ chatId: string; name: string; kind: string; people?: Array<{ userId: string }> }> };
    expect(chats.chats.map((chat) => chat.name)).toEqual(expect.arrayContaining(["Everyone", "Ben Tui", "Stocktake Dec", "Home farm"]));
    const posted = (await as("bea")((tx) => post.run(tx, { chatId: direct, body: "@Ben Tui lunch?", mentions: [people.ben.id], idempotencyKey: key("ai") }, {} as never))) as {
      message: { viaAi: boolean; mentions: string[] };
    };
    expect(posted.message).toMatchObject({ viaAi: true, mentions: [people.ben.id] });
    const read1 = (await as("ben")((tx) => read.run(tx, { chatId: direct }, {} as never))) as { messages: Array<Record<string, unknown>> };
    expect(read1.messages.at(-1)).toMatchObject({ body: "@Ben Tui lunch?", viaAi: true });
    // The owner's AI can't read a chat the owner isn't in, even though the owner could review it.
    await expect(as("olive")((tx) => read.run(tx, { chatId: direct }, {} as never))).rejects.toThrow("Chat not found.");
    await expect(as("olive")((tx) => post.run(tx, { chatId: direct, body: "Hi" }, {} as never))).rejects.toThrow("Chat not found.");
    // A farm's chat is read with read_farm_chat.
    await expect(as("bea")((tx) => read.run(tx, { chatId: `farm:${farmId}` }, {} as never))).rejects.toThrow("read_farm_chat");
    // The old tools still mean Everyone.
    const team = (await as("bea")((tx) => findAiTool("read_team_chat")!.run(tx, {}, {} as never))) as { messages: Array<{ body?: string }> };
    expect(team.messages.map((message) => message.body)).toContain("Morning all");
    await expect(inOrganisation(ORG, { userId: people.wren.id, email: people.wren.email, role: "farm_worker" }, (tx) => list.run(tx, {}, {} as never))).rejects.toThrow("Chat isn't open to this role.");
  });

  it("TCH26: turning Chat off hides all of it and keeps the messages", async () => {
    await as("olive")((tx) => setTeamChatEnabled(tx, { enabled: false }));
    await expect(as("bea")((tx) => chatList(tx))).rejects.toThrow("Chat is off.");
    await expect(as("bea")((tx) => listRoomMessages(tx, { roomId: direct }))).rejects.toThrow("Chat is off.");
    expect(await as("bea")((tx) => chatUnreadTotal(tx))).toEqual({ enabled: false, unread: 0 });
    const modules = await as("bea")((tx) => loadToolModules(tx));
    for (const tool of ["list_chats", "read_chat", "post_chat_message"]) expect(moduleHidesTool(tool, modules)).toContain("Chat is turned off");
    await as("olive")((tx) => setTeamChatEnabled(tx, { enabled: true }));
    expect((await as("bea")((tx) => listRoomMessages(tx, { roomId: direct }))).messages.length).toBeGreaterThan(2);
  });
});
