import { farmWorkAllows } from "@/lib/auth/roles";
import { requireTeamChat, teamChatEnabled } from "@/lib/chat/enabled";
import { ROOM_MESSAGE_COLUMNS, type RoomMessage, shapeRoomMessages } from "@/lib/chat/messages";
import { namedMembers, requireChatRole } from "@/lib/chat/people";
import { directName, type RoomKind } from "@/lib/chat/rooms";
import { type ChatKind, farmRef } from "@/lib/chat/rules";
import type { OrgTx } from "@/lib/db/org-transaction";
import { visibleFarmIds } from "@/lib/farming/access";
import { CHAT_PAGE, type MessageRow } from "@/lib/farming/chat";
import { getFarmingSettings } from "@/lib/farming/paddocks";
import { requireId } from "@/lib/validation";

/*
 * Chat's list down the side and its two feeds (TCH10, TCH17, TCH18, TCH24):
 * Home (the latest from every chat you're in), Mentions, Direct messages and
 * Spaces (Everyone, your spaces, and the farm chats you already see).
 */

export type ChatListEntry = { ref: string; kind: ChatKind; name: string; unread: number; closed: boolean; lastAt: string | null; farmId?: string };
export type ChatListing = {
  home: { unread: number };
  mentions: { unread: number };
  direct: { unread: number; chats: ChatListEntry[] };
  spaces: { unread: number; chats: ChatListEntry[] };
};

type MyRoom = { id: string; kind: RoomKind; name: string | null; closed_at: string | null; unread: number; last_at: string | null; read_up_to: string };
type MyFarm = { id: string; name: string; unread: number; last_at: string | null; read_up_to: string };

function viewerId(tx: OrgTx): string {
  return tx.actor.userId?.toLowerCase() ?? "";
}

/** The rooms the acting person is in: Everyone, and the spaces and direct messages they've been added to. */
async function myRooms(tx: OrgTx): Promise<MyRoom[]> {
  const rows = await tx.query<MyRoom>(
    `select r.id::text, r.kind, r.name, r.closed_at::text, coalesce(rd.read_up_to, 0)::text as read_up_to,
            (select count(*)::int from farm_chat_messages m
              where m.room_id = r.id and m.removed_at is null and m.id > coalesce(rd.read_up_to, 0)
                and m.posted_by_user_id is distinct from $1) as unread,
            (select max(m.created_at)::text from farm_chat_messages m where m.room_id = r.id and m.removed_at is null) as last_at
       from chat_rooms r left join chat_room_reads rd on rd.room_id = r.id and rd.user_id = $1
      where r.kind = 'everyone' or exists (select 1 from chat_room_members cm where cm.room_id = r.id and cm.user_id = $1)`,
    [viewerId(tx)],
  );
  return rows.rows;
}

/** The farm chats this person already has (TCH17): Farming on, a role that reads farm work, and the farms they see. */
async function myFarms(tx: OrgTx): Promise<MyFarm[]> {
  const role = tx.actor.role;
  if (role && !farmWorkAllows(role, "read")) return [];
  if (!(await getFarmingSettings(tx)).enabled) return [];
  const visible = await visibleFarmIds(tx);
  const rows = await tx.query<MyFarm>(
    `select f.id::text, f.name, coalesce(rd.read_up_to, 0)::text as read_up_to,
            (select count(*)::int from farm_chat_messages m
              where m.farm_id = f.id and m.removed_at is null and m.id > coalesce(rd.read_up_to, 0)
                and m.posted_by_user_id is distinct from $1) as unread,
            (select max(m.created_at)::text from farm_chat_messages m where m.farm_id = f.id and m.removed_at is null) as last_at
       from farms f left join farm_chat_reads rd on rd.farm_id = f.id and rd.user_id = $1
      where f.is_active and ($2::bigint[] is null or f.id = any($2::bigint[]))`,
    [tx.actor.userId ?? "", visible],
  );
  return rows.rows;
}

/** Direct messages' names: the other people in each. */
async function directNames(tx: OrgTx, roomIds: string[]): Promise<Map<string, string>> {
  if (roomIds.length === 0) return new Map();
  const rows = await tx.query<{ room_id: string; user_id: string; user_email: string }>("select room_id::text, user_id, user_email from chat_room_members where room_id = any($1::uuid[])", [roomIds]);
  const names = new Map<string, string>();
  for (const id of roomIds) names.set(id, directName(await namedMembers(tx, rows.rows.filter((row) => row.room_id === id)), viewerId(tx)));
  return names;
}

type Places = { rooms: MyRoom[]; farms: MyFarm[]; names: Map<string, string> };

async function places(tx: OrgTx): Promise<Places> {
  await requireTeamChat(tx);
  requireChatRole(tx, "read");
  const rooms = await myRooms(tx);
  const farms = await myFarms(tx);
  const names = await directNames(tx, rooms.filter((room) => room.kind === "direct").map((room) => room.id));
  for (const room of rooms) if (room.kind !== "direct") names.set(room.id, room.name ?? "");
  for (const farm of farms) names.set(farmRef(farm.id), farm.name);
  return { rooms, farms, names };
}

async function mentionsUnread(tx: OrgTx, rooms: MyRoom[]): Promise<number> {
  const found = await tx.query<{ n: number }>(
    `select count(*)::int as n from chat_mentions cm
       join farm_chat_messages m on m.id = cm.message_id
       left join chat_room_reads rd on rd.room_id = m.room_id and rd.user_id = $1
      where cm.user_id = $1 and m.removed_at is null and m.room_id = any($2::uuid[]) and m.id > coalesce(rd.read_up_to, 0)`,
    [viewerId(tx), rooms.map((room) => room.id)],
  );
  return found.rows[0]?.n ?? 0;
}

const byName = (a: ChatListEntry, b: ChatListEntry) => a.name.localeCompare(b.name);

/** The list down the side (TCH10): each chat with its unread count, and each section's total. */
export async function chatList(tx: OrgTx): Promise<ChatListing> {
  const { rooms, farms, names } = await places(tx);
  const entry = (room: MyRoom): ChatListEntry => ({ ref: room.id, kind: room.kind, name: names.get(room.id) ?? "", unread: room.unread, closed: room.closed_at !== null, lastAt: room.last_at });
  const direct = rooms
    .filter((room) => room.kind === "direct")
    .map(entry)
    .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || byName(a, b));
  const everyone = rooms.filter((room) => room.kind === "everyone").map(entry);
  const open = [
    ...rooms.filter((room) => room.kind === "space" && !room.closed_at).map(entry),
    ...farms.map((farm): ChatListEntry => ({ ref: farmRef(farm.id), kind: "farm", farmId: farm.id, name: farm.name, unread: farm.unread, closed: false, lastAt: farm.last_at })),
  ].sort(byName);
  const closed = rooms.filter((room) => room.kind === "space" && room.closed_at).map(entry).sort(byName);
  const spaces = [...everyone, ...open, ...closed];
  const total = (chats: ChatListEntry[]) => chats.reduce((sum, chat) => sum + chat.unread, 0);
  return {
    home: { unread: total(direct) + total(spaces) },
    mentions: { unread: await mentionsUnread(tx, rooms) },
    direct: { unread: total(direct), chats: direct },
    spaces: { unread: total(spaces), chats: spaces },
  };
}

/** The Chat app's badge (TCH24): every unread message across this person's chats. Nothing while Chat is off. */
export async function chatUnreadTotal(tx: OrgTx): Promise<{ enabled: boolean; unread: number }> {
  if (!(await teamChatEnabled(tx))) return { enabled: false, unread: 0 };
  return { enabled: true, unread: (await chatList(tx)).home.unread };
}

export type FeedMessage = RoomMessage & { chat: { ref: string; kind: ChatKind; name: string }; unread: boolean };

async function feed(tx: OrgTx, where: Places, input: { before?: unknown }, mentionsOnly: boolean): Promise<{ messages: FeedMessage[]; more: boolean }> {
  const before = input.before === undefined || input.before === null || input.before === "" ? null : requireId(input.before, "before");
  const roomIds = where.rooms.map((room) => room.id);
  const farmIds = mentionsOnly ? [] : where.farms.map((farm) => farm.id);
  const rows = await tx.query<MessageRow & { room_id: string | null }>(
    `select ${ROOM_MESSAGE_COLUMNS} from farm_chat_messages
      where removed_at is null and ($1::bigint is null or id < $1::bigint)
        and (room_id = any($2::uuid[]) or farm_id = any($3::bigint[]))
        ${mentionsOnly ? "and exists (select 1 from chat_mentions cm where cm.message_id = farm_chat_messages.id and cm.user_id = $5)" : ""}
      order by farm_chat_messages.id desc limit $4`,
    mentionsOnly ? [before, roomIds, farmIds, CHAT_PAGE + 1, viewerId(tx)] : [before, roomIds, farmIds, CHAT_PAGE + 1],
  );
  const more = rows.rows.length > CHAT_PAGE;
  const page = rows.rows.slice(0, CHAT_PAGE);
  const shaped = await shapeRoomMessages(tx, page);
  const messages = shaped.map((message, index): FeedMessage => {
    const row = page[index];
    const room = row.room_id ? where.rooms.find((entry) => entry.id === row.room_id) : undefined;
    const farm = row.farm_id ? where.farms.find((entry) => entry.id === row.farm_id) : undefined;
    const ref = room ? room.id : farmRef(row.farm_id ?? "");
    const readUpTo = BigInt(room?.read_up_to ?? farm?.read_up_to ?? "0");
    return {
      ...message,
      chat: { ref, kind: room ? room.kind : "farm", name: where.names.get(ref) ?? "" },
      unread: !message.mine && BigInt(message.id) > readUpTo,
    };
  });
  return { messages, more };
}

/** Home (TCH10): the latest messages from every chat you're in, newest first, each naming its chat. */
export async function chatHome(tx: OrgTx, input: { before?: unknown } = {}): Promise<{ messages: FeedMessage[]; more: boolean }> {
  return feed(tx, await places(tx), input, false);
}

/** Mentions (TCH18): messages that mention you in chats you're in, newest first; unread until you've read that chat past them. */
export async function chatMentions(tx: OrgTx, input: { before?: unknown } = {}): Promise<{ messages: FeedMessage[]; more: boolean }> {
  return feed(tx, await places(tx), input, true);
}
