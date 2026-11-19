import { afterAll, beforeAll, expect, it } from "vitest";
import * as attachmentRoute from "@/app/api/farming/chat/attachments/[attachmentId]/route";
import * as chatRoute from "@/app/api/farming/chat/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { FARM_DETAIL_READ_TOOLS } from "@/lib/ai/farm-record-tools";
import { chatAbout, chatUnread, listChat, markChatRead, postChatMessage, readChatAttachment, removeChatMessage } from "@/lib/farming/chat";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addTask } from "@/lib/farming/tasks";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-chat-co";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Farm chat (FCH1-FCH11, following common practice, not yet reviewed). Made-up farms and people. */
describeWithDatabase("farm chat", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let home = "";
  let runoff = "";
  let paddock = "";
  let runoffPaddock = "";
  let mob = "";
  let task = "";
  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email, role: "owner" }, work);
  const asWorker = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: worker.id, email: worker.email, role: "farm_worker" }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("chat-owner@example.com");
    worker = await createTestUser("chat-worker@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    await asOwner((tx) => setFarmingEnabled(tx, { enabled: true }));
    home = (await asOwner((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    runoff = (await asOwner((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    paddock = (await asOwner((tx) => addPaddock(tx, { farmId: home, name: "Top flat", effectiveHa: "6.00", onDate: "2026-07-01" }))).id;
    runoffPaddock = (await asOwner((tx) => addPaddock(tx, { farmId: runoff, name: "Gully", effectiveHa: "12.00", onDate: "2026-07-01" }))).id;
    mob = (
      await asOwner((tx) =>
        tx.query<{ id: string }>("insert into mobs (farm_id, name, kind, class_code, head, created_by_email) values ($1, 'Heifers', 'cattle', 'heifer', 40, 'x') returning id::text", [home]),
      )
    ).rows[0].id;
    task = (await asOwner((tx) => addTask(tx, { farmId: home, title: "Fix the trough", dueOn: "2026-11-20" }, { today: "2026-11-19" }))).id;
    await asOwner((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [home] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  let first = "";
  it("FCH1-FCH3: anyone on the farm posts words and photos about its paddocks, mobs and tasks; records on another farm are refused", async () => {
    const message = await asOwner((tx) =>
      postChatMessage(tx, {
        farmId: home,
        body: "Heifers are in Top flat, trough needs fixing",
        idempotencyKey: key("chat"),
        photos: [{ fileName: "trough.png", contentBase64: PNG }],
        links: [{ kind: "paddock", id: paddock }, { kind: "mob", id: mob }, { kind: "task", id: task }],
      }),
    );
    first = message.id;
    expect(message).toMatchObject({ body: "Heifers are in Top flat, trough needs fixing", mine: true, viaAi: false, removed: false });
    expect(message.links.map((link) => link.label)).toEqual(["Heifers", "Top flat", "Fix the trough"]);
    expect(message.attachments).toMatchObject([{ kind: "photo", contentType: "image/png" }]);
    expect((await asWorker((tx) => readChatAttachment(tx, message.attachments[0].id))).contentType).toBe("image/png");

    await expect(asOwner((tx) => postChatMessage(tx, { farmId: home, body: "Wrong farm", idempotencyKey: key("chat"), links: [{ kind: "paddock", id: runoffPaddock }] }))).rejects.toThrow(
      "That paddock isn't on this farm.",
    );
    await expect(asOwner((tx) => postChatMessage(tx, { farmId: home, body: "  ", idempotencyKey: key("chat") }))).rejects.toThrow("Write something, add a photo or record a voice note.");
    await expect(
      asOwner((tx) => postChatMessage(tx, { farmId: home, body: "Not a photo", idempotencyKey: key("chat"), photos: [{ fileName: "notes.txt", contentBase64: Buffer.from("hello").toString("base64") }] })),
    ).rejects.toThrow();

    // The same idempotencyKey gives back the same message.
    const keyed = key("chat");
    const once = await asWorker((tx) => postChatMessage(tx, { farmId: home, body: "On my way", idempotencyKey: keyed }));
    const twice = await asWorker((tx) => postChatMessage(tx, { farmId: home, body: "On my way", idempotencyKey: keyed }));
    expect(twice.id).toBe(once.id);
  });

  it("FCH1, FCH7: a farm's chat is for the people who can see the farm", async () => {
    await expect(asWorker((tx) => listChat(tx, { farmId: runoff }))).rejects.toThrow("Farm not found.");
    await expect(asWorker((tx) => postChatMessage(tx, { farmId: runoff, body: "Hi", idempotencyKey: key("chat") }))).rejects.toThrow("Farm not found.");
    const chat = await asWorker((tx) => listChat(tx, { farmId: home }));
    expect(chat.messages.map((message) => message.body)).toEqual(["Heifers are in Top flat, trough needs fixing", "On my way"]);
    expect(chat.messages[0].mine).toBe(false);
    // Through the route, a farm worker sees the farm's chat with names.
    const response = await chatRoute.GET(apiRequest(`/api/farming/chat?organisationId=${ORG}&farmId=${home}`, { cookie: await sessionCookieFor(worker) }), undefined as never);
    expect(response.status).toBe(200);
  });

  it("FCH4: a message shows on what it's about", async () => {
    expect((await asWorker((tx) => chatAbout(tx, "paddock", paddock))).map((message) => message.id)).toEqual([first]);
    expect(await asWorker((tx) => chatAbout(tx, "paddock", runoffPaddock))).toEqual([]);
  });

  it("FCH6: unread counts others' messages after what you've read; posting counts as reading", async () => {
    // The worker posted after the owner's message, so they've read it.
    expect(await asWorker((tx) => chatUnread(tx))).toEqual([]);
    expect(await asOwner((tx) => chatUnread(tx))).toEqual([{ farmId: home, unread: 1 }]);
    const latest = (await asOwner((tx) => listChat(tx, { farmId: home }))).messages.at(-1)!.id;
    await asOwner((tx) => markChatRead(tx, home, latest));
    expect(await asOwner((tx) => chatUnread(tx))).toEqual([]);
    // Reading never moves backwards.
    await asOwner((tx) => markChatRead(tx, home, first));
    expect(await asOwner((tx) => chatUnread(tx))).toEqual([]);
  });

  it("FCH5: only the poster, or an owner or admin, takes a message down; its words and photos go", async () => {
    await expect(asWorker((tx) => removeChatMessage(tx, first))).rejects.toThrow("Only whoever posted a message, or an owner or admin, can take it down.");
    const removed = await asOwner((tx) => removeChatMessage(tx, first));
    expect(removed).toMatchObject({ removed: true, body: "", attachments: [], removedByEmail: owner.email });
    expect(await asWorker((tx) => chatAbout(tx, "paddock", paddock))).toEqual([]);
  });

  it("FCH8: a message an AI posts for someone is marked as from their AI", async () => {
    const message = await asOwner((tx) => postChatMessage(tx, { farmId: home, body: "Rain due Friday", idempotencyKey: key("chat") }, { viaAi: true }));
    expect(message).toMatchObject({ viaAi: true, mine: true });
  });

  // Made-up recordings: just the first bytes each format starts with.
  const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 1)]).toString("base64");
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(60, 2)]).toString("base64");

  it("FCH9: a message can have one voice note, up to 3 minutes and 5 MB, checked from its contents", async () => {
    const spoken = await asWorker((tx) => postChatMessage(tx, { farmId: home, idempotencyKey: key("chat"), voice: { seconds: 41.6, contentBase64: MP4 } }));
    expect(spoken).toMatchObject({ body: "", attachments: [{ kind: "voice", contentType: "audio/mp4", fileName: "voice-note.m4a", seconds: 42 }] });
    const both = await asOwner((tx) =>
      postChatMessage(tx, { farmId: home, body: "Listen to this", idempotencyKey: key("chat"), photos: [{ fileName: "gate.png", contentBase64: PNG }], voice: { seconds: 5, contentBase64: WEBM } }),
    );
    expect(both.attachments.map((file) => [file.kind, file.contentType])).toEqual([
      ["photo", "image/png"],
      ["voice", "audio/webm"],
    ]);

    await expect(asOwner((tx) => postChatMessage(tx, { farmId: home, idempotencyKey: key("chat"), voice: { seconds: 181, contentBase64: MP4 } }))).rejects.toThrow(
      "A voice note can be up to 3 minutes.",
    );
    await expect(asOwner((tx) => postChatMessage(tx, { farmId: home, idempotencyKey: key("chat"), voice: { contentBase64: MP4 } }))).rejects.toThrow("The voice note needs its length in seconds.");
    await expect(asOwner((tx) => postChatMessage(tx, { farmId: home, idempotencyKey: key("chat"), voice: { seconds: 3, contentBase64: PNG } }))).rejects.toThrow(
      "That recording isn't audio Tohyee can play back.",
    );
    const huge = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(5 * 1024 * 1024)]).toString("base64");
    await expect(asOwner((tx) => postChatMessage(tx, { farmId: home, idempotencyKey: key("chat"), voice: { seconds: 3, contentBase64: huge } }))).rejects.toThrow(
      "The voice note is larger than 5 MB.",
    );

    // People on the farm can play it, a piece at a time as iPhones ask; others can't.
    const voiceId = spoken.attachments[0].id;
    const cookie = await sessionCookieFor(worker);
    const whole = await attachmentRoute.GET(apiRequest(`/api/farming/chat/attachments/${voiceId}?organisationId=${ORG}`, { cookie }), { params: Promise.resolve({ attachmentId: voiceId }) });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    const ranged = apiRequest(`/api/farming/chat/attachments/${voiceId}?organisationId=${ORG}`, { cookie, headers: { range: "bytes=0-1" } });
    const piece = await attachmentRoute.GET(ranged, { params: Promise.resolve({ attachmentId: voiceId }) });
    expect(piece.status).toBe(206);
    expect(piece.headers.get("content-range")).toBe("bytes 0-1/72");
    expect(Buffer.from(await piece.arrayBuffer())).toEqual(Buffer.from([0, 0]));

    // Taking the message down removes the voice note too.
    const gone = await asWorker((tx) => removeChatMessage(tx, spoken.id));
    expect(gone.attachments).toEqual([]);
    await expect(asWorker((tx) => readChatAttachment(tx, voiceId))).rejects.toThrow();
  });

  it("FCH10: the AI sees that a message has a voice note and how long, but can't hear it", async () => {
    const tool = FARM_DETAIL_READ_TOOLS.find((entry) => entry.name === "read_farm_chat")!;
    const answer = (await asOwner((tx) => tool.run(tx, { farmId: home }, {} as never))) as { messages: Array<Record<string, unknown>> };
    expect(answer.messages.find((message) => message.body === "Listen to this")).toMatchObject({ photos: 1, voiceNoteSeconds: 5 });
    expect(JSON.stringify(answer)).not.toContain("contentBase64");
  });
});
