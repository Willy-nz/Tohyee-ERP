import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import { requireTeamChat } from "@/lib/chat/enabled";
import { chatPeople, isOwnerOrAdmin, requireChatRole } from "@/lib/chat/people";
import { isMember, loadRoom, requireRoomMember, type RoomRow, roomMembers, roomReadOnlyBecause } from "@/lib/chat/rooms";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { CHAT_COLUMNS, CHAT_PAGE, type ChatMessage, MAX_CHAT_MESSAGE, type MessageRow, parseChatFiles, saveChatFiles, shapeMessages } from "@/lib/farming/chat";
import { optionalString, requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";

/*
 * Messages in Everyone, spaces and direct messages (TCH3-TCH5, TCH11,
 * TCH16, TCH18, TCH22, TCH23). They're kept with the farm chats' messages
 * and handled the same way: words, photos and voice notes with the same
 * limits, taking down, unread. Every read and write checks the person is in
 * the room first.
 */

export const MAX_MENTIONS = 20;

/** A room's message: a farm message without the farm or links, with the room and who it mentions. */
export type RoomMessage = Omit<ChatMessage, "farmId" | "links"> & { roomId: string; mentions: string[] };

type RoomMessageRow = MessageRow & { room_id: string | null };
export const ROOM_MESSAGE_COLUMNS = `${CHAT_COLUMNS}, room_id::text`;

/** Shapes room messages, with their mentions. */
export async function shapeRoomMessages(tx: OrgTx, rows: RoomMessageRow[]): Promise<RoomMessage[]> {
  if (rows.length === 0) return [];
  const shaped = await shapeMessages(tx, rows);
  const mentions = await tx.query<{ message_id: string; user_id: string }>("select message_id::text, user_id from chat_mentions where message_id = any($1::bigint[]) order by user_id", [
    rows.map((row) => row.id),
  ]);
  return shaped.map((message, index) => {
    // Rooms' messages have no farm and no links (TCH3).
    const rest: Omit<ChatMessage, "farmId" | "links"> & Partial<Pick<ChatMessage, "farmId" | "links">> = { ...message };
    delete rest.farmId;
    delete rest.links;
    return { ...rest, roomId: rows[index].room_id ?? "", mentions: mentions.rows.filter((entry) => entry.message_id === message.id).map((entry) => entry.user_id) };
  });
}

function pageInput(input: { before?: unknown; limit?: unknown }): { before: string | null; limit: number } {
  const before = input.before === undefined || input.before === null || input.before === "" ? null : requireId(input.before, "before");
  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 200) : CHAT_PAGE;
  return { before, limit };
}

/** A room's messages, newest last: the latest page or the page before `before`. No checks: callers check first. */
export async function roomPage(tx: OrgTx, roomId: string, input: { before?: unknown; limit?: unknown }): Promise<{ messages: RoomMessage[]; more: boolean }> {
  const { before, limit } = pageInput(input);
  const rows = await tx.query<RoomMessageRow>(
    `select ${ROOM_MESSAGE_COLUMNS} from farm_chat_messages
      where room_id = $1 and ($2::bigint is null or id < $2::bigint)
      order by farm_chat_messages.id desc limit $3`,
    [roomId, before, limit + 1],
  );
  const more = rows.rows.length > limit;
  return { messages: (await shapeRoomMessages(tx, rows.rows.slice(0, limit))).reverse(), more };
}

/** A room's messages for someone in it (TCH2, TCH22). */
export async function listRoomMessages(tx: OrgTx, input: { roomId: unknown; before?: unknown; limit?: unknown }): Promise<{ messages: RoomMessage[]; more: boolean }> {
  const room = await requireRoomMember(tx, input.roomId);
  return roomPage(tx, room.id, input);
}

async function parseMentions(tx: OrgTx, room: RoomRow, input: unknown): Promise<string[]> {
  if (input === undefined || input === null) return [];
  const list = requireArray(input, "mentions", MAX_MENTIONS);
  const members = (await roomMembers(tx, room)).filter((member) => member.current);
  const self = tx.actor.userId?.toLowerCase();
  const picked = new Set<string>();
  for (const entry of list) {
    const id = typeof entry === "string" ? entry.toLowerCase() : "";
    if (id === self) continue;
    if (!members.some((member) => member.userId === id)) {
      const person = (await chatPeople(tx)).find((candidate) => candidate.userId === id);
      throw new ValidationError(`${person?.name ?? "That person"} isn't in this chat, so can't be mentioned.`);
    }
    picked.add(id);
  }
  return [...picked].sort();
}

/**
 * Posts in a room (TCH3, TCH18): words, photos, a voice note, and who it
 * mentions. `viaAi` is set by the AI's tool, never by the screen.
 */
export async function postRoomMessage(tx: OrgTx, input: Record<string, unknown>, options: { viaAi?: boolean } = {}): Promise<RoomMessage> {
  const room = await requireRoomMember(tx, input.roomId);
  requireChatRole(tx, "post");
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const replay = await tx.query<RoomMessageRow>(`select ${ROOM_MESSAGE_COLUMNS} from farm_chat_messages where idempotency_key = $1`, [idempotencyKey]);
  if (replay.rows[0]) {
    if (replay.rows[0].room_id !== room.id) throw new ValidationError("That idempotencyKey was used for a message in another chat.");
    return (await shapeRoomMessages(tx, replay.rows))[0];
  }
  const stuck = roomReadOnlyBecause(room, await roomMembers(tx, room), tx.actor.userId ?? null);
  if (stuck) throw new ValidationError(stuck);
  if (input.links !== undefined && input.links !== null && (!Array.isArray(input.links) || input.links.length > 0)) {
    throw new ValidationError("Team chat messages don't link to records.");
  }
  const body = (optionalString(input.body, "body", { maxLength: MAX_CHAT_MESSAGE }) ?? "").trim();
  const { photos, voice } = parseChatFiles(input, body);
  const mentions = await parseMentions(tx, room, input.mentions);
  const created = await tx.query<RoomMessageRow>(
    `insert into farm_chat_messages (farm_id, room_id, body, posted_by_user_id, posted_by_email, via_ai, idempotency_key)
     values (null, $1, $2, $3, $4, $5, $6) returning ${ROOM_MESSAGE_COLUMNS}`,
    [room.id, body, tx.actor.userId ?? null, tx.actor.email || "Tohyee", options.viaAi === true, idempotencyKey],
  );
  const message = created.rows[0];
  await saveChatFiles(tx, message.id, photos, voice);
  for (const userId of mentions) await tx.query("insert into chat_mentions (message_id, user_id) values ($1, $2)", [message.id, userId]);
  // Your own message counts as read.
  await saveRead(tx, room.id, message.id);
  await writeAuditEvent(tx, {
    eventType: "chat.posted",
    entityType: "farm_chat_message",
    entityId: message.id,
    details: { roomId: room.id, kind: room.kind, photos: photos.length, voice: voice !== null, mentions: mentions.length, ...(options.viaAi ? { viaAi: true } : {}) },
  });
  return (await shapeRoomMessages(tx, [message]))[0];
}

async function saveRead(tx: OrgTx, roomId: string, upTo: string): Promise<void> {
  if (!tx.actor.userId) return;
  await tx.query(
    `insert into chat_room_reads (room_id, user_id, read_up_to) values ($1, $2, $3)
     on conflict (room_id, user_id) do update set read_up_to = greatest(chat_room_reads.read_up_to, excluded.read_up_to)`,
    [roomId, tx.actor.userId.toLowerCase(), upTo],
  );
}

/** Marks a room read up to a message (TCH5, TCH10). Never moves backwards. */
export async function markRoomRead(tx: OrgTx, roomIdInput: unknown, upToInput: unknown): Promise<void> {
  const room = await requireRoomMember(tx, roomIdInput);
  await saveRead(tx, room.id, requireId(upToInput, "upTo"));
}

async function messageRow(tx: OrgTx, id: string): Promise<RoomMessageRow | null> {
  const found = await tx.query<RoomMessageRow>(`select ${ROOM_MESSAGE_COLUMNS} from farm_chat_messages where id = $1 and room_id is not null`, [id]);
  return found.rows[0] ?? null;
}

/**
 * Takes a message down (TCH4): whoever posted it, or an owner or admin. Its
 * words, photos, voice note and mentions go; that it was there stays. In
 * someone's own chats, only those they're in; `review` is Review chats'
 * path, for owners and admins (TCH21).
 */
export async function removeRoomMessage(tx: OrgTx, idInput: unknown, options: { review?: boolean } = {}): Promise<RoomMessage> {
  await requireTeamChat(tx);
  requireChatRole(tx, "read");
  const id = requireId(idInput, "messageId");
  const row = await messageRow(tx, id);
  const room = row?.room_id ? await loadRoom(tx, row.room_id) : null;
  if (!row || !room) throw new NotFoundError("Message not found.");
  if (options.review) {
    if (!isOwnerOrAdmin(tx)) throw new ForbiddenError("Review chats is for owners and admins.");
  } else if (!(await isMember(tx, room))) {
    throw new NotFoundError("Message not found.");
  }
  if (row.removed_at) return (await shapeRoomMessages(tx, [row]))[0];
  const own = row.posted_by_user_id !== null && row.posted_by_user_id === tx.actor.userId;
  const role = tx.actor.role;
  if (!own && !(role && roleAtLeast(role, "admin"))) throw new ForbiddenError("Only whoever posted a message, or an owner or admin, can take it down.");
  await tx.query("delete from farm_chat_attachments where message_id = $1", [id]);
  await tx.query("delete from chat_mentions where message_id = $1", [id]);
  const updated = await tx.query<RoomMessageRow>(
    `update farm_chat_messages set body = '', removed_at = now(), removed_by_email = $2 where id = $1 returning ${ROOM_MESSAGE_COLUMNS}`,
    [id, tx.actor.email || "Tohyee"],
  );
  await writeAuditEvent(tx, { eventType: "chat.removed", entityType: "farm_chat_message", entityId: id, details: { roomId: room.id, kind: room.kind, own, ...(options.review ? { review: true } : {}) } });
  return (await shapeRoomMessages(tx, updated.rows))[0];
}

export type ChatFile = { fileName: string; contentType: string; content: Buffer };

/** A photo or voice note with the room it's in, or null; taken-down messages have none. */
export async function attachmentWithRoom(tx: OrgTx, attachmentId: string): Promise<(ChatFile & { room: RoomRow }) | null> {
  const found = await tx.query<{ room_id: string; file_name: string; content_type: string; content: Buffer }>(
    `select m.room_id::text, a.file_name, a.content_type, a.content
       from farm_chat_attachments a join farm_chat_messages m on m.id = a.message_id
      where a.id = $1 and m.room_id is not null and m.removed_at is null`,
    [attachmentId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const room = await loadRoom(tx, row.room_id);
  return room ? { room, fileName: row.file_name, contentType: row.content_type, content: row.content } : null;
}

/** A photo or voice note, for people in its chat only (TCH22). */
export async function readRoomAttachment(tx: OrgTx, idInput: unknown): Promise<ChatFile> {
  await requireTeamChat(tx);
  requireChatRole(tx, "read");
  const file = await attachmentWithRoom(tx, requireId(idInput, "attachmentId"));
  if (!file || !(await isMember(tx, file.room))) throw new NotFoundError("Photo not found.");
  return { fileName: file.fileName, contentType: file.contentType, content: file.content };
}

