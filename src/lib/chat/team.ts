import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { CHAT_COLUMNS, CHAT_PAGE, type ChatMessage, MAX_CHAT_MESSAGE, type MessageRow, parseChatFiles, saveChatFiles, shapeMessages } from "@/lib/farming/chat";
import { optionalString, requireId, requireIdempotencyKey } from "@/lib/validation";

/*
 * Team chat (examples TCH1-TCH9, following common practice, not yet
 * reviewed): one chat for everyone in the organisation, its own app, switched
 * on in Settings, Modules. Messages have words, photos and voice notes, and
 * no links. It works like a farm's chat: the same limits, taking down and
 * unread counts. Farm staff and report viewers aren't in it; farm staff have
 * their farm's chat.
 */

export type TeamMessage = Omit<ChatMessage, "farmId" | "links">;

function toTeam(message: ChatMessage): TeamMessage {
  const { farmId: _farmId, links: _links, ...rest } = message;
  return rest;
}

export async function teamChatEnabled(tx: OrgTx): Promise<boolean> {
  const found = await tx.query<{ enabled: boolean }>("select enabled from team_chat_settings where id = true");
  return found.rows[0]?.enabled === true;
}

async function requireTeamChat(tx: OrgTx): Promise<void> {
  if (!(await teamChatEnabled(tx))) throw new ValidationError("Chat is off. An admin can turn it on under Settings, Modules.");
}

/** Switches Chat on or off (TCH1). Turning it off keeps the messages for when it's back on. */
export async function setTeamChatEnabled(tx: OrgTx, input: { enabled: unknown }): Promise<{ enabled: boolean }> {
  if (typeof input.enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
  await tx.query("update team_chat_settings set enabled = $1, updated_by_email = $2, updated_at = now() where id = true", [input.enabled, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: input.enabled ? "team_chat.turned_on" : "team_chat.turned_off", entityType: "organisation", entityId: tx.organisationId, details: {} });
  return { enabled: input.enabled };
}

/** The team chat, newest last (TCH2): the latest page, or the page before `before`. */
export async function listTeamChat(tx: OrgTx, input: { before?: unknown; limit?: unknown } = {}): Promise<{ messages: TeamMessage[]; more: boolean }> {
  await requireTeamChat(tx);
  const before = input.before === undefined || input.before === null || input.before === "" ? null : requireId(input.before, "before");
  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 200) : CHAT_PAGE;
  const rows = await tx.query<MessageRow>(
    `select ${CHAT_COLUMNS} from farm_chat_messages
      where farm_id is null and ($1::bigint is null or id < $1::bigint)
      order by farm_chat_messages.id desc limit $2`,
    [before, limit + 1],
  );
  const more = rows.rows.length > limit;
  return { messages: (await shapeMessages(tx, rows.rows.slice(0, limit))).reverse().map(toTeam), more };
}

/** Posts in the team chat (TCH3): words, photos, a voice note. `viaAi` is set by the AI's tool, never by the screen. */
export async function postTeamMessage(tx: OrgTx, input: Record<string, unknown>, options: { viaAi?: boolean } = {}): Promise<TeamMessage> {
  await requireTeamChat(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const replay = await tx.query<MessageRow>(`select ${CHAT_COLUMNS} from farm_chat_messages where idempotency_key = $1`, [idempotencyKey]);
  if (replay.rows[0]) {
    if (replay.rows[0].farm_id !== null) throw new ValidationError("That idempotencyKey was used for a farm's message.");
    return toTeam((await shapeMessages(tx, replay.rows))[0]);
  }
  if (input.links !== undefined && input.links !== null && (!Array.isArray(input.links) || input.links.length > 0)) {
    throw new ValidationError("Team chat messages don't link to records.");
  }
  const body = (optionalString(input.body, "body", { maxLength: MAX_CHAT_MESSAGE }) ?? "").trim();
  const { photos, voice } = parseChatFiles(input, body);
  const created = await tx.query<MessageRow>(
    `insert into farm_chat_messages (farm_id, body, posted_by_user_id, posted_by_email, via_ai, idempotency_key)
     values (null, $1, $2, $3, $4, $5) returning ${CHAT_COLUMNS}`,
    [body, tx.actor.userId ?? null, tx.actor.email || "Tohyee", options.viaAi === true, idempotencyKey],
  );
  const message = created.rows[0];
  await saveChatFiles(tx, message.id, photos, voice);
  // Your own message counts as read.
  await markTeamChatRead(tx, message.id);
  await writeAuditEvent(tx, {
    eventType: "team_chat.posted",
    entityType: "farm_chat_message",
    entityId: message.id,
    details: { photos: photos.length, voice: voice !== null, ...(options.viaAi ? { viaAi: true } : {}) },
  });
  return toTeam((await shapeMessages(tx, [message]))[0]);
}

/** Takes a team chat message down (TCH4): its author, or an owner or admin. */
export async function removeTeamMessage(tx: OrgTx, idInput: unknown): Promise<TeamMessage> {
  await requireTeamChat(tx);
  const id = requireId(idInput, "messageId");
  const found = await tx.query<MessageRow>(`select ${CHAT_COLUMNS} from farm_chat_messages where id = $1 and farm_id is null`, [id]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Message not found.");
  if (row.removed_at) return toTeam((await shapeMessages(tx, [row]))[0]);
  const own = row.posted_by_user_id !== null && row.posted_by_user_id === tx.actor.userId;
  const role = tx.actor.role;
  if (!own && !(role && roleAtLeast(role, "admin"))) throw new ForbiddenError("Only whoever posted a message, or an owner or admin, can take it down.");
  await tx.query("delete from farm_chat_attachments where message_id = $1", [id]);
  const updated = await tx.query<MessageRow>(
    `update farm_chat_messages set body = '', removed_at = now(), removed_by_email = $2 where id = $1 returning ${CHAT_COLUMNS}`,
    [id, tx.actor.email || "Tohyee"],
  );
  await writeAuditEvent(tx, { eventType: "team_chat.removed", entityType: "farm_chat_message", entityId: id, details: { own } });
  return toTeam((await shapeMessages(tx, updated.rows))[0]);
}

/** A photo or voice note on a team chat message (TCH3). */
export async function readTeamAttachment(tx: OrgTx, idInput: unknown): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  await requireTeamChat(tx);
  const id = requireId(idInput, "attachmentId");
  const found = await tx.query<{ file_name: string; content_type: string; content: Buffer }>(
    `select a.file_name, a.content_type, a.content
       from farm_chat_attachments a join farm_chat_messages m on m.id = a.message_id
      where a.id = $1 and m.farm_id is null and m.removed_at is null`,
    [id],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Photo not found.");
  return { fileName: row.file_name, contentType: row.content_type, content: row.content };
}

/** Marks the team chat read up to a message (TCH5). Never moves backwards. */
export async function markTeamChatRead(tx: OrgTx, upToInput: unknown): Promise<void> {
  await requireTeamChat(tx);
  const upTo = requireId(upToInput, "upTo");
  if (!tx.actor.userId) return;
  await tx.query(
    `insert into team_chat_reads (user_id, read_up_to) values ($1, $2)
     on conflict (user_id) do update set read_up_to = greatest(team_chat_reads.read_up_to, excluded.read_up_to)`,
    [tx.actor.userId, upTo],
  );
}

/** Others' messages, not taken down, since this person last read (TCH5). Nothing while Chat is off. */
export async function teamChatUnread(tx: OrgTx): Promise<{ enabled: boolean; unread: number }> {
  if (!(await teamChatEnabled(tx))) return { enabled: false, unread: 0 };
  const found = await tx.query<{ unread: number }>(
    `select count(*)::int as unread from farm_chat_messages m
      where m.farm_id is null and m.removed_at is null
        and m.id > coalesce((select read_up_to from team_chat_reads where user_id = $1), 0)
        and m.posted_by_user_id is distinct from $1`,
    [tx.actor.userId ?? ""],
  );
  return { enabled: true, unread: found.rows[0]?.unread ?? 0 };
}
