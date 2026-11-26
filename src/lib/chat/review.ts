import { writeAuditEvent } from "@/lib/audit";
import { requireTeamChat } from "@/lib/chat/enabled";
import { attachmentWithRoom, type ChatFile, removeRoomMessage, roomPage, type RoomMessage } from "@/lib/chat/messages";
import { isOwnerOrAdmin, namedMembers, requireChatRole } from "@/lib/chat/people";
import { CLOSED, directName, isMember, loadRoom, NOT_FOUND, parseRoomId, type RoomKind, type RoomMember, type RoomRow, roomMembers } from "@/lib/chat/rooms";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireId } from "@/lib/validation";

/*
 * Review chats (TCH20, TCH21; the owner chose "admin can review"): an owner
 * or admin can read any space or direct message in the organisation, even
 * one they're not in, here and only here. It's apart from their own list, has
 * no unread counts and no posting, and every opening (and every photo or
 * voice note opened) is in the audit trail. Members are told by the line on
 * every such chat (TCH19). AI connections never get this.
 */

const REVIEWERS_ONLY = "Review chats is for owners and admins.";

async function requireReviewer(tx: OrgTx): Promise<void> {
  await requireTeamChat(tx);
  requireChatRole(tx, "read");
  if (!isOwnerOrAdmin(tx)) throw new ForbiddenError(REVIEWERS_ONLY);
}

export type ReviewEntry = { id: string; kind: "space" | "direct"; name: string; people: number; messages: number; lastAt: string | null; closed: boolean; youreIn: boolean };

/** Every space and direct message, most recent first; no unread counts. */
export async function reviewList(tx: OrgTx): Promise<ReviewEntry[]> {
  await requireReviewer(tx);
  const rooms = await tx.query<{ id: string; kind: "space" | "direct"; name: string | null; closed_at: string | null; messages: number; last_at: string | null }>(
    `select r.id::text, r.kind, r.name, r.closed_at::text,
            (select count(*)::int from farm_chat_messages m where m.room_id = r.id) as messages,
            (select max(m.created_at)::text from farm_chat_messages m where m.room_id = r.id) as last_at
       from chat_rooms r where r.kind in ('space', 'direct')
      order by last_at desc nulls last, r.created_at desc`,
  );
  const members = await tx.query<{ room_id: string; user_id: string; user_email: string }>("select room_id::text, user_id, user_email from chat_room_members");
  const viewer = tx.actor.userId?.toLowerCase() ?? "";
  const named = new Map<string, RoomMember[]>();
  for (const room of rooms.rows) named.set(room.id, await namedMembers(tx, members.rows.filter((row) => row.room_id === room.id)));
  return rooms.rows.map((room) => {
    const inRoom = named.get(room.id) ?? [];
    return {
      id: room.id,
      kind: room.kind,
      name: room.kind === "direct" ? directName(inRoom, null) : (room.name ?? ""),
      people: inRoom.length,
      messages: room.messages,
      lastAt: room.last_at,
      closed: room.closed_at !== null,
      youreIn: inRoom.some((member) => member.userId === viewer),
    };
  });
}

async function reviewedRoom(tx: OrgTx, roomIdInput: unknown): Promise<RoomRow> {
  await requireReviewer(tx);
  const room = await loadRoom(tx, parseRoomId(roomIdInput));
  if (!room || room.kind === "everyone") throw new NotFoundError(NOT_FOUND);
  return room;
}

export type ReviewedRoom = { id: string; kind: RoomKind; name: string; closed: boolean; members: RoomMember[]; youreIn: boolean; canPost: false; canJoin: boolean };

/** Reads one chat for review (TCH20), and records that it was opened, by whom and when (TCH21). */
export async function reviewRoom(tx: OrgTx, roomIdInput: unknown, input: { before?: unknown } = {}): Promise<{ room: ReviewedRoom; messages: RoomMessage[]; more: boolean }> {
  const room = await reviewedRoom(tx, roomIdInput);
  const members = await roomMembers(tx, room);
  const youreIn = await isMember(tx, room);
  const page = await roomPage(tx, room.id, { before: input.before });
  const name = room.kind === "direct" ? directName(members, null) : (room.name ?? "");
  await writeAuditEvent(tx, {
    eventType: "chat.reviewed",
    entityType: "chat_room",
    entityId: room.id,
    details: { kind: room.kind, name, ...(input.before ? { before: String(input.before) } : {}) },
  });
  return {
    room: { id: room.id, kind: room.kind, name, closed: room.closed_at !== null, members, youreIn, canPost: false, canJoin: room.kind === "space" && !youreIn && !room.closed_at },
    ...page,
  };
}

/** A photo or voice note opened from review (TCH21): recorded too. */
export async function reviewAttachment(tx: OrgTx, idInput: unknown): Promise<ChatFile> {
  await requireReviewer(tx);
  const attachmentId = requireId(idInput, "attachmentId");
  const file = await attachmentWithRoom(tx, attachmentId);
  if (!file || file.room.kind === "everyone") throw new NotFoundError("Photo not found.");
  await writeAuditEvent(tx, { eventType: "chat.reviewed", entityType: "chat_room", entityId: file.room.id, details: { kind: file.room.kind, attachmentId } });
  return { fileName: file.fileName, contentType: file.contentType, content: file.content };
}

/** Joins a space from review (TCH20); then it's in their own list. A direct message's people are fixed. */
export async function joinForReview(tx: OrgTx, roomIdInput: unknown): Promise<{ joined: true; roomId: string }> {
  const room = await reviewedRoom(tx, roomIdInput);
  if (room.kind === "direct") throw new ValidationError("A direct message can't be joined.");
  if (room.closed_at) throw new ValidationError(CLOSED);
  if (!tx.actor.userId) throw new ValidationError("Only a person can join a space.");
  await tx.query(
    `insert into chat_room_members (room_id, user_id, user_email, added_by_email) values ($1, $2, $3, $3)
     on conflict (room_id, user_id) do nothing`,
    [room.id, tx.actor.userId.toLowerCase(), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "chat.joined", entityType: "chat_room", entityId: room.id, details: { fromReview: true } });
  return { joined: true, roomId: room.id };
}

/** Takes a message down from review (TCH21): recorded as done from review. */
export async function removeInReview(tx: OrgTx, messageId: unknown): Promise<RoomMessage> {
  await requireReviewer(tx);
  return removeRoomMessage(tx, messageId, { review: true });
}
