import { writeAuditEvent } from "@/lib/audit";
import { teamChatAllows } from "@/lib/auth/roles";
import { requireTeamChat } from "@/lib/chat/enabled";
import { type ChatPerson, chatPeople, isOwnerOrAdmin, namedMembers, requireChatPeople, requireChatRole, type RoomMember } from "@/lib/chat/people";
import { canManageSpace, directPeople, peopleKey, spaceName } from "@/lib/chat/rules";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { requireArray, requireIdempotencyKey } from "@/lib/validation";

/*
 * Chat's rooms (TCH10-TCH16, TCH19, TCH22, TCH23; asked for by the owner,
 * details following common practice, not yet reviewed): Everyone (the old
 * team chat, everyone in Chat), named spaces, and direct messages between a
 * fixed set of people. People only ever reach rooms they're in; a room they
 * aren't in is "Chat not found.", the same as one that doesn't exist.
 * Owners and admins read other rooms only through Review chats
 * (`@/lib/chat/review`).
 */

export type RoomKind = "everyone" | "space" | "direct";

export type RoomRow = {
  id: string;
  kind: RoomKind;
  name: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_at: string;
  closed_at: string | null;
  closed_by_email: string | null;
};

export type { RoomMember };

export type ChatRoomDetail = {
  id: string;
  kind: RoomKind;
  name: string;
  closed: boolean;
  closedByEmail: string | null;
  madeByEmail: string | null;
  /** Show "Owners and admins of this organisation can read this chat if they need to." (TCH19). */
  privacyLine: boolean;
  canPost: boolean;
  /** Why posting is off, when it is. */
  readOnlyBecause: string | null;
  canManage: boolean;
  canAddPeople: boolean;
  canLeave: boolean;
  members: RoomMember[];
};

const ROOM_COLUMNS = "id::text, kind, name, created_by_user_id, created_by_email, created_at::text, closed_at::text, closed_by_email";
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLOSED = "This space is closed. Its messages are kept to read.";
export const NOT_FOUND = "Chat not found.";

export function parseRoomId(input: unknown): string {
  if (typeof input !== "string" || !ROOM_ID.test(input)) throw new ValidationError("Choose a chat from the list.");
  return input.toLowerCase();
}

export async function everyoneRoomId(tx: OrgTx): Promise<string> {
  const found = await tx.query<{ id: string }>("select id::text from chat_rooms where kind = 'everyone'");
  if (!found.rows[0]) throw new NotFoundError(NOT_FOUND);
  return found.rows[0].id;
}

export async function loadRoom(tx: OrgTx, roomId: string): Promise<RoomRow | null> {
  const found = await tx.query<RoomRow>(`select ${ROOM_COLUMNS} from chat_rooms where id = $1`, [roomId]);
  return found.rows[0] ?? null;
}

/** Whether the acting person is in a room. Everyone is everyone in Chat (TCH11), which the role check decides. */
export async function isMember(tx: OrgTx, room: RoomRow): Promise<boolean> {
  if (room.kind === "everyone") return true;
  if (!tx.actor.userId) return false;
  const found = await tx.query("select 1 from chat_room_members where room_id = $1 and user_id = $2", [room.id, tx.actor.userId.toLowerCase()]);
  return found.rows.length > 0;
}

/** A room the acting person is in (TCH22), with Chat on and their role in Chat. */
export async function requireRoomMember(tx: OrgTx, roomIdInput: unknown): Promise<RoomRow> {
  await requireTeamChat(tx);
  requireChatRole(tx, "read");
  const room = await loadRoom(tx, parseRoomId(roomIdInput));
  if (!room || !(await isMember(tx, room))) throw new NotFoundError(NOT_FOUND);
  return room;
}

/** A room's people, named from who's in Chat now; someone who has left keeps their email. */
export async function roomMembers(tx: OrgTx, room: RoomRow): Promise<RoomMember[]> {
  const people = await chatPeople(tx);
  if (room.kind === "everyone") return people.map((person) => ({ userId: person.userId, email: person.email, name: person.name, current: true }));
  const rows = await tx.query<{ user_id: string; user_email: string }>("select user_id, user_email from chat_room_members where room_id = $1", [room.id]);
  return namedMembers(tx, rows.rows);
}

/** A direct message is called by the other people in it; seen from outside (review), by everyone in it. */
export function directName(members: readonly RoomMember[], viewer: string | null): string {
  const others = members.filter((member) => member.userId !== viewer?.toLowerCase());
  return others.map((member) => member.name).join(", ") || "Just you";
}

/** Why nobody can post in a room just now, if so (TCH16, TCH23). */
export function roomReadOnlyBecause(room: RoomRow, members: readonly RoomMember[], viewer: string | null): string | null {
  if (room.closed_at) return CLOSED;
  if (room.kind === "direct" && members.length === 2) {
    const other = members.find((member) => member.userId !== viewer?.toLowerCase());
    if (other && !other.current) return `${other.name} is no longer in Chat here, so this chat is read-only.`;
  }
  return null;
}

export async function describeRoom(tx: OrgTx, room: RoomRow, member: boolean): Promise<ChatRoomDetail> {
  const members = await roomMembers(tx, room);
  const viewer = tx.actor.userId?.toLowerCase() ?? null;
  const role = tx.actor.role;
  const mayPost = !role || teamChatAllows(role, "post");
  const stuck = roomReadOnlyBecause(room, members, viewer);
  const readOnlyBecause = stuck ?? (mayPost ? null : "You can read this chat. Posting needs the bookkeeper role or higher, or a sales role.");
  const open = room.kind === "space" && !room.closed_at;
  return {
    id: room.id,
    kind: room.kind,
    name: room.kind === "direct" ? directName(members, member ? viewer : null) : (room.name ?? ""),
    closed: room.closed_at !== null,
    closedByEmail: room.closed_by_email,
    madeByEmail: room.created_by_email,
    privacyLine: room.kind !== "everyone",
    canPost: member && readOnlyBecause === null,
    readOnlyBecause,
    canManage: open && canManageSpace(role, room.created_by_user_id !== null && room.created_by_user_id === viewer),
    canAddPeople: open && member && mayPost,
    canLeave: room.kind === "space" && member,
    members,
  };
}

/** One room, for someone in it (TCH22). */
export async function getRoom(tx: OrgTx, roomIdInput: unknown): Promise<ChatRoomDetail> {
  const room = await requireRoomMember(tx, roomIdInput);
  return describeRoom(tx, room, true);
}

function pickedIds(input: unknown): string[] {
  const list = input === undefined || input === null ? [] : requireArray(input, "userIds", 500);
  if (list.some((id) => typeof id !== "string")) throw new ValidationError("Choose people from the list.");
  return [...new Set((list as string[]).map((id) => id.toLowerCase()))];
}

async function addMembers(tx: OrgTx, roomId: string, people: readonly ChatPerson[]): Promise<number> {
  let added = 0;
  for (const person of people) {
    const inserted = await tx.query(
      `insert into chat_room_members (room_id, user_id, user_email, added_by_email) values ($1, $2, $3, $4)
       on conflict (room_id, user_id) do nothing`,
      [roomId, person.userId, person.email, tx.actor.email || "Tohyee"],
    );
    added += inserted.rowCount ?? 0;
  }
  return added;
}

function requireSelf(tx: OrgTx): ChatPerson {
  const userId = tx.actor.userId?.toLowerCase();
  if (!userId) throw new ValidationError("Only a person can start a chat.");
  return { userId, email: tx.actor.email, name: tx.actor.email, role: tx.actor.role ?? "viewer" };
}

async function requireOpenName(tx: OrgTx, name: string, exceptRoomId: string | null): Promise<void> {
  const taken = await tx.query("select 1 from chat_rooms where kind = 'space' and closed_at is null and lower(name) = lower($1) and id is distinct from $2::uuid", [name, exceptRoomId]);
  if (taken.rows.length) throw new ValidationError(`There's already an open space called ${name}.`);
}

/** Makes a space (TCH14): anyone in Chat who can post, with the people they pick. */
export async function createSpace(tx: OrgTx, input: { name: unknown; userIds?: unknown; idempotencyKey: unknown }): Promise<ChatRoomDetail> {
  await requireTeamChat(tx);
  requireChatRole(tx, "post");
  const self = requireSelf(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const name = spaceName(input.name);
  const others = pickedIds(input.userIds).filter((id) => id !== self.userId);
  const hash = requestHash("chat.space", { name, userIds: [...others].sort() });
  const replay = await tx.query<RoomRow & { request_hash: string }>(`select ${ROOM_COLUMNS}, request_hash from chat_rooms where idempotency_key = $1`, [idempotencyKey]);
  if (replay.rows[0]) {
    assertSameRequest(replay.rows[0].request_hash, hash, "space");
    return getRoom(tx, replay.rows[0].id);
  }
  await requireOpenName(tx, name, null);
  const people = await requireChatPeople(tx, others);
  const created = await tx.query<RoomRow>(
    `insert into chat_rooms (kind, name, created_by_user_id, created_by_email, idempotency_key, request_hash)
     values ('space', $1, $2, $3, $4, $5) returning ${ROOM_COLUMNS}`,
    [name, self.userId, tx.actor.email, idempotencyKey, hash],
  );
  const room = created.rows[0];
  await addMembers(tx, room.id, [self, ...people]);
  await writeAuditEvent(tx, { eventType: "chat.space_made", entityType: "chat_room", entityId: room.id, details: { name, people: people.length + 1 } });
  return describeRoom(tx, room, true);
}

/**
 * Starts a direct message (TCH12, TCH13), or opens the one these people
 * already have. Who's in it is fixed, so the people are the key, and sending
 * it again opens the same chat.
 */
export async function startDirect(tx: OrgTx, input: { userIds: unknown; idempotencyKey: unknown }): Promise<ChatRoomDetail> {
  await requireTeamChat(tx);
  requireChatRole(tx, "post");
  const self = requireSelf(tx);
  requireIdempotencyKey(input.idempotencyKey);
  const everyone = directPeople(self.userId, input.userIds === undefined || input.userIds === null ? [] : requireArray(input.userIds, "userIds", 500));
  const people = await requireChatPeople(tx, everyone.filter((id) => id !== self.userId));
  const key = peopleKey(everyone);
  const inserted = await tx.query<RoomRow>(
    `insert into chat_rooms (kind, people_key, created_by_user_id, created_by_email) values ('direct', $1, $2, $3)
     on conflict (people_key) do nothing returning ${ROOM_COLUMNS}`,
    [key, self.userId, tx.actor.email],
  );
  if (inserted.rows[0]) {
    await addMembers(tx, inserted.rows[0].id, [self, ...people]);
    await writeAuditEvent(tx, { eventType: "chat.direct_started", entityType: "chat_room", entityId: inserted.rows[0].id, details: { people: everyone.length } });
    return describeRoom(tx, inserted.rows[0], true);
  }
  const existing = await tx.query<RoomRow>(`select ${ROOM_COLUMNS} from chat_rooms where people_key = $1`, [key]);
  return describeRoom(tx, existing.rows[0], true);
}

/** A space someone may manage (TCH16): they're in it, or they're an owner or admin. Direct messages only for their people. */
async function requireManagedSpace(tx: OrgTx, roomIdInput: unknown): Promise<RoomRow> {
  await requireTeamChat(tx);
  requireChatRole(tx, "read");
  const room = await loadRoom(tx, parseRoomId(roomIdInput));
  if (!room) throw new NotFoundError(NOT_FOUND);
  const member = await isMember(tx, room);
  if (!member && !(isOwnerOrAdmin(tx) && room.kind === "space")) throw new NotFoundError(NOT_FOUND);
  if (room.kind === "everyone") throw new ValidationError("Everyone can't be renamed or closed.");
  if (room.kind === "direct") throw new ValidationError("A direct message can't be closed or deleted.");
  if (room.closed_at) throw new ValidationError(CLOSED);
  const viewer = tx.actor.userId?.toLowerCase() ?? null;
  if (!canManageSpace(tx.actor.role, room.created_by_user_id !== null && room.created_by_user_id === viewer)) {
    throw new ForbiddenError("Only whoever made this space, or an owner or admin, can rename or close it.");
  }
  return room;
}

async function detailFor(tx: OrgTx, room: RoomRow): Promise<ChatRoomDetail> {
  return describeRoom(tx, room, await isMember(tx, room));
}

export async function renameSpace(tx: OrgTx, roomIdInput: unknown, nameInput: unknown): Promise<ChatRoomDetail> {
  const room = await requireManagedSpace(tx, roomIdInput);
  const name = spaceName(nameInput);
  await requireOpenName(tx, name, room.id);
  const updated = await tx.query<RoomRow>(`update chat_rooms set name = $2 where id = $1 returning ${ROOM_COLUMNS}`, [room.id, name]);
  await writeAuditEvent(tx, { eventType: "chat.space_renamed", entityType: "chat_room", entityId: room.id, details: { from: room.name, to: name } });
  return detailFor(tx, updated.rows[0]);
}

/** Closes a space (TCH16): its messages stay to read; nobody posts in it again. */
export async function closeSpace(tx: OrgTx, roomIdInput: unknown): Promise<ChatRoomDetail> {
  const room = await requireManagedSpace(tx, roomIdInput);
  const updated = await tx.query<RoomRow>(`update chat_rooms set closed_at = now(), closed_by_email = $2 where id = $1 returning ${ROOM_COLUMNS}`, [room.id, tx.actor.email || "Tohyee"]);
  await writeAuditEvent(tx, { eventType: "chat.space_closed", entityType: "chat_room", entityId: room.id, details: { name: room.name } });
  return detailFor(tx, updated.rows[0]);
}

/** Adds people to a space (TCH15): anyone in it who can post. */
export async function addToSpace(tx: OrgTx, roomIdInput: unknown, userIdsInput: unknown): Promise<ChatRoomDetail> {
  const room = await requireRoomMember(tx, roomIdInput);
  requireChatRole(tx, "post");
  if (room.kind === "direct") throw new ValidationError("Who's in a direct message is fixed. Start another one to include more people.");
  if (room.kind === "everyone") throw new ValidationError("Everyone already has everyone in Chat in it.");
  if (room.closed_at) throw new ValidationError(CLOSED);
  const people = await requireChatPeople(tx, pickedIds(userIdsInput));
  if (people.length === 0) throw new ValidationError("Choose who to add.");
  const added = await addMembers(tx, room.id, people);
  if (added > 0) await writeAuditEvent(tx, { eventType: "chat.people_added", entityType: "chat_room", entityId: room.id, details: { added } });
  return describeRoom(tx, room, true);
}

/** Leaves a space (TCH15). Everyone and direct messages can't be left. */
export async function leaveSpace(tx: OrgTx, roomIdInput: unknown): Promise<{ left: true }> {
  const room = await requireRoomMember(tx, roomIdInput);
  if (room.kind === "everyone") throw new ValidationError("Everyone can't be left: it's the chat for the whole team.");
  if (room.kind === "direct") throw new ValidationError("You can't leave a direct message.");
  await tx.query("delete from chat_room_members where room_id = $1 and user_id = $2", [room.id, tx.actor.userId!.toLowerCase()]);
  await writeAuditEvent(tx, { eventType: "chat.left", entityType: "chat_room", entityId: room.id, details: {} });
  return { left: true };
}
