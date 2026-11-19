import { afterAll, beforeAll, expect, it } from "vitest";
import * as chatRoute from "@/app/api/farming/chat/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { chatAbout, chatUnread, listChat, markChatRead, postChatMessage, readChatAttachment, removeChatMessage } from "@/lib/farming/chat";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addTask } from "@/lib/farming/tasks";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-chat-co";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Farm chat (FCH1-FCH9, following common practice, not yet reviewed). Made-up farms and people. */
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
    await expect(asOwner((tx) => postChatMessage(tx, { farmId: home, body: "  ", idempotencyKey: key("chat") }))).rejects.toThrow("Write something or add a photo.");
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
});
