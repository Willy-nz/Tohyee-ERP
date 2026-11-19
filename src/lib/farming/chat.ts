import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm, requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { checkAttachment } from "@/lib/records/file-types";
import { optionalString, requireId, requireIdempotencyKey } from "@/lib/validation";

/*
 * Farm chat (examples FCH1-FCH9, following common practice, not yet
 * reviewed): one chat per farm for everyone who can see that farm, the same
 * people who see its paddocks and mobs. A message can carry photos and say
 * what it's about (paddocks, mobs, tasks on that farm), and then shows on
 * those too. A person's own AI can read the chat and post in it when they
 * ask; those messages are marked as from their AI. Tohyee holds no AI key,
 * so the AI never posts by itself.
 *
 * Taking a message down (its author, or an owner or admin) removes what it
 * said and its photos, and keeps that a message was there, by whom, and who
 * took it down.
 */

export const MAX_CHAT_MESSAGE = 4000;
export const MAX_CHAT_PHOTOS = 6;
export const MAX_CHAT_PHOTO_BYTES = 10 * 1024 * 1024;
export const CHAT_PAGE = 50;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
export const MAX_VOICE_SECONDS = 180;
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;

/**
 * What a phone's recorder makes (FCH9), told from the file's first bytes rather
 * than what it's called: WebM (Chrome, Android), Ogg (Firefox) or MP4 (iPhone).
 */
export function voiceType(bytes: Uint8Array): { contentType: string; extension: string } | null {
  const at = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { contentType: "audio/webm", extension: "webm" };
  if (bytes.length >= 4 && at(0, "OggS")) return { contentType: "audio/ogg", extension: "ogg" };
  if (bytes.length >= 12 && at(4, "ftyp")) return { contentType: "audio/mp4", extension: "m4a" };
  return null;
}
export const CHAT_LINK_KINDS = ["paddock", "mob", "task"] as const;
export type ChatLinkKind = (typeof CHAT_LINK_KINDS)[number];

export type ChatLink = { kind: ChatLinkKind; id: string; label: string };
export type ChatAttachment = { id: string; kind: "photo" | "voice"; fileName: string; contentType: string; bytes: number; seconds: number | null };
export type ChatMessage = {
  id: string;
  farmId: string;
  body: string;
  postedByEmail: string;
  viaAi: boolean;
  mine: boolean;
  createdAt: string;
  removed: boolean;
  removedByEmail: string | null;
  attachments: ChatAttachment[];
  links: ChatLink[];
};

/** A message as stored; team chat's messages (TCH1) have no farm. */
export type MessageRow = {
  id: string;
  farm_id: string | null;
  body: string;
  posted_by_user_id: string | null;
  posted_by_email: string;
  via_ai: boolean;
  created_at: string;
  removed_at: string | null;
  removed_by_email: string | null;
};

const LINK_LABELS = `
  case l.kind
    when 'paddock' then (select p.name from paddocks p where p.id = l.record_id)
    when 'mob' then (select coalesce(m.name, m.class_code) from mobs m where m.id = l.record_id)
    when 'task' then (select t.title from farm_tasks t where t.id = l.record_id)
  end`;

export async function shapeMessages(tx: OrgTx, rows: MessageRow[]): Promise<ChatMessage[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const attachments = await tx.query<{ id: string; message_id: string; kind: "photo" | "voice"; file_name: string; content_type: string; bytes: number; seconds: number | null }>(
    "select id::text, message_id::text, kind, file_name, content_type, bytes, seconds from farm_chat_attachments where message_id = any($1::bigint[]) order by farm_chat_attachments.id",
    [ids],
  );
  const links = await tx.query<{ message_id: string; kind: ChatLinkKind; record_id: string; label: string | null }>(
    `select l.message_id::text, l.kind, l.record_id::text, ${LINK_LABELS} as label
       from farm_chat_links l where l.message_id = any($1::bigint[]) order by l.kind, l.record_id`,
    [ids],
  );
  return rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id ?? "",
    body: row.removed_at ? "" : row.body,
    postedByEmail: row.posted_by_email,
    viaAi: row.via_ai,
    mine: row.posted_by_user_id !== null && row.posted_by_user_id === tx.actor.userId,
    createdAt: row.created_at,
    removed: row.removed_at !== null,
    removedByEmail: row.removed_by_email,
    attachments: attachments.rows
      .filter((entry) => entry.message_id === row.id)
      .map((entry) => ({ id: entry.id, kind: entry.kind, fileName: entry.file_name, contentType: entry.content_type, bytes: entry.bytes, seconds: entry.seconds })),
    links: links.rows
      .filter((entry) => entry.message_id === row.id && entry.label !== null)
      .map((entry) => ({ kind: entry.kind, id: entry.record_id, label: entry.label! })),
  }));
}

export const CHAT_COLUMNS = "id::text, farm_id::text, body, posted_by_user_id, posted_by_email, via_ai, created_at::text, removed_at::text, removed_by_email";

/** A farm's chat, newest last (FCH1): the latest page, or the page before `before`. */
export async function listChat(tx: OrgTx, input: { farmId: unknown; before?: unknown; limit?: unknown }): Promise<{ messages: ChatMessage[]; more: boolean }> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  await requireFarmAccess(tx, farmId);
  const before = input.before === undefined || input.before === null || input.before === "" ? null : requireId(input.before, "before");
  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 200) : CHAT_PAGE;
  const rows = await tx.query<MessageRow>(
    `select ${CHAT_COLUMNS} from farm_chat_messages
      where farm_id = $1 and ($2::bigint is null or id < $2::bigint)
      order by farm_chat_messages.id desc limit $3`,
    [farmId, before, limit + 1],
  );
  const more = rows.rows.length > limit;
  return { messages: (await shapeMessages(tx, rows.rows.slice(0, limit))).reverse(), more };
}

/** Messages about one paddock, mob or task (FCH4), newest first, from the farms this person can see. */
export async function chatAbout(tx: OrgTx, kindInput: unknown, recordIdInput: unknown, limit = 20): Promise<ChatMessage[]> {
  await requireFarming(tx);
  const kind = parseKind(kindInput);
  const recordId = requireId(recordIdInput, "recordId");
  const visible = await visibleFarmIds(tx);
  const rows = await tx.query<MessageRow>(
    `select ${CHAT_COLUMNS.split(", ").map((column) => `m.${column}`).join(", ")}
       from farm_chat_messages m join farm_chat_links l on l.message_id = m.id
      where l.kind = $1 and l.record_id = $2 and m.removed_at is null
        and ($3::bigint[] is null or m.farm_id = any($3::bigint[]))
      order by m.id desc limit $4`,
    [kind, recordId, visible, limit],
  );
  return shapeMessages(tx, rows.rows);
}

function parseKind(input: unknown): ChatLinkKind {
  if (typeof input !== "string" || !(CHAT_LINK_KINDS as readonly string[]).includes(input)) throw new ValidationError("A message can be about a paddock, a mob or a task.");
  return input as ChatLinkKind;
}

const LINK_TABLES: Record<ChatLinkKind, string> = { paddock: "paddocks", mob: "mobs", task: "farm_tasks" };

/**
 * Posts a message (FCH2, FCH3): words, photos, or both, about paddocks, mobs
 * or tasks on the same farm. `viaAi` is set by the AI's tool, never by the screen.
 */
export async function postChatMessage(tx: OrgTx, input: Record<string, unknown>, options: { viaAi?: boolean } = {}): Promise<ChatMessage> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  await requireFarmAccess(tx, farmId);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const replay = await tx.query<MessageRow>(`select ${CHAT_COLUMNS} from farm_chat_messages where idempotency_key = $1`, [idempotencyKey]);
  if (replay.rows[0]) {
    if (replay.rows[0].farm_id !== farmId) throw new ValidationError("That idempotencyKey was used for another farm's message.");
    return (await shapeMessages(tx, replay.rows))[0];
  }
  const body = (optionalString(input.body, "body", { maxLength: MAX_CHAT_MESSAGE }) ?? "").trim();

  const { photos, voice } = parseChatFiles(input, body);

  const linksInput = input.links === undefined || input.links === null ? [] : input.links;
  if (!Array.isArray(linksInput)) throw new ValidationError("links must be a list.");
  if (linksInput.length > 10) throw new ValidationError("A message can be about up to 10 paddocks, mobs or tasks.");
  const links: Array<{ kind: ChatLinkKind; id: string }> = [];
  for (const entry of linksInput) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const kind = parseKind(record.kind);
    const id = requireId(record.id, `${kind} id`);
    // Only records on this farm (FCH3), so a message can't point somewhere its readers can't see.
    const found = await tx.query<{ farm_id: string }>(`select farm_id::text from ${LINK_TABLES[kind]} where id = $1`, [id]);
    if (found.rows[0]?.farm_id !== farmId) throw new ValidationError(`That ${kind} isn't on this farm.`);
    if (!links.some((link) => link.kind === kind && link.id === id)) links.push({ kind, id });
  }

  const created = await tx.query<MessageRow>(
    `insert into farm_chat_messages (farm_id, body, posted_by_user_id, posted_by_email, via_ai, idempotency_key)
     values ($1, $2, $3, $4, $5, $6) returning ${CHAT_COLUMNS}`,
    [farmId, body, tx.actor.userId ?? null, tx.actor.email || "Tohyee", options.viaAi === true, idempotencyKey],
  );
  const message = created.rows[0];
  await saveChatFiles(tx, message.id, photos, voice);
  for (const link of links) {
    await tx.query("insert into farm_chat_links (message_id, kind, record_id) values ($1, $2, $3)", [message.id, link.kind, link.id]);
  }
  // Your own message counts as read.
  await markChatRead(tx, farmId, message.id);
  await writeAuditEvent(tx, {
    eventType: "farm_chat.posted",
    entityType: "farm_chat_message",
    entityId: message.id,
    details: { farmId, photos: photos.length, voice: voice !== null, links: links.length, ...(options.viaAi ? { viaAi: true } : {}) },
  });
  return (await shapeMessages(tx, [message]))[0];
}

type ChatFile = { fileName: string; contentType: string; content: Buffer };
type VoiceFile = ChatFile & { seconds: number };

/** A message's photos (FCH2) and voice note (FCH9), checked; a message needs words or one of them. */
export function parseChatFiles(input: Record<string, unknown>, body: string): { photos: ChatFile[]; voice: VoiceFile | null } {
  const photosInput = input.photos === undefined || input.photos === null ? [] : input.photos;
  if (!Array.isArray(photosInput)) throw new ValidationError("photos must be a list.");
  if (photosInput.length > MAX_CHAT_PHOTOS) throw new ValidationError(`A message can have up to ${MAX_CHAT_PHOTOS} photos.`);
  const photos = photosInput.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const name = optionalString(record.fileName, `photos ${index + 1} fileName`, { maxLength: 200 }) ?? "photo.jpg";
    if (typeof record.contentBase64 !== "string" || record.contentBase64.length === 0) throw new ValidationError(`Photo ${index + 1} is empty.`);
    if (record.contentBase64.length > Math.ceil((MAX_CHAT_PHOTO_BYTES * 4) / 3) + 4) throw new ValidationError(`Photo ${index + 1} is larger than 10 MB.`);
    const content = Buffer.from(record.contentBase64, "base64");
    const checked = checkAttachment(name, new Uint8Array(content));
    if (!PHOTO_TYPES.has(checked.contentType)) throw new ValidationError(`${checked.fileName} isn't a photo (JPG, PNG, WebP or HEIC).`);
    return { ...checked, content };
  });
  const voice = parseVoice(input.voice);
  if (!body && photos.length === 0 && !voice) throw new ValidationError("Write something, add a photo or record a voice note.");
  return { photos, voice };
}

/** Keeps a new message's photos and voice note. */
export async function saveChatFiles(tx: OrgTx, messageId: string, photos: ChatFile[], voice: VoiceFile | null): Promise<void> {
  for (const photo of photos) {
    await tx.query("insert into farm_chat_attachments (message_id, kind, file_name, content_type, bytes, content) values ($1, 'photo', $2, $3, $4, $5)", [
      messageId,
      photo.fileName,
      photo.contentType,
      photo.content.length,
      photo.content,
    ]);
  }
  if (voice) {
    await tx.query("insert into farm_chat_attachments (message_id, kind, file_name, content_type, bytes, content, seconds) values ($1, 'voice', $2, $3, $4, $5, $6)", [
      messageId,
      voice.fileName,
      voice.contentType,
      voice.content.length,
      voice.content,
      voice.seconds,
    ]);
  }
}

/** One voice note (FCH9): up to 3 minutes and 5 MB, and audio a phone can play back. */
function parseVoice(input: unknown): VoiceFile | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("voice must be a recording.");
  const record = input as Record<string, unknown>;
  if (typeof record.contentBase64 !== "string" || record.contentBase64.length === 0) throw new ValidationError("The voice note is empty.");
  if (record.contentBase64.length > Math.ceil((MAX_VOICE_BYTES * 4) / 3) + 4) throw new ValidationError("The voice note is larger than 5 MB.");
  const seconds = typeof record.seconds === "number" && Number.isFinite(record.seconds) ? Math.max(1, Math.ceil(record.seconds)) : NaN;
  if (Number.isNaN(seconds)) throw new ValidationError("The voice note needs its length in seconds.");
  if (seconds > MAX_VOICE_SECONDS) throw new ValidationError("A voice note can be up to 3 minutes.");
  const content = Buffer.from(record.contentBase64, "base64");
  if (content.length === 0) throw new ValidationError("The voice note is empty.");
  if (content.length > MAX_VOICE_BYTES) throw new ValidationError("The voice note is larger than 5 MB.");
  const type = voiceType(new Uint8Array(content));
  if (!type) throw new ValidationError("That recording isn't audio Tohyee can play back.");
  return { fileName: `voice-note.${type.extension}`, contentType: type.contentType, content, seconds };
}

/** Takes a message down (FCH5): its author, or an owner or admin. Its words and photos go; that it was there stays. */
export async function removeChatMessage(tx: OrgTx, idInput: unknown): Promise<ChatMessage> {
  await requireFarming(tx);
  const id = requireId(idInput, "messageId");
  const found = await tx.query<MessageRow>(`select ${CHAT_COLUMNS} from farm_chat_messages where id = $1`, [id]);
  const row = found.rows[0];
  // Team chat's messages (no farm) are taken down through team chat (TCH4).
  if (!row || row.farm_id === null || !(await canSeeFarm(tx, row.farm_id))) throw new NotFoundError("Message not found.");
  if (row.removed_at) return (await shapeMessages(tx, [row]))[0];
  const own = row.posted_by_user_id !== null && row.posted_by_user_id === tx.actor.userId;
  const role = tx.actor.role;
  if (!own && !(role && roleAtLeast(role, "admin"))) throw new ForbiddenError("Only whoever posted a message, or an owner or admin, can take it down.");
  await tx.query("delete from farm_chat_attachments where message_id = $1", [id]);
  const updated = await tx.query<MessageRow>(
    `update farm_chat_messages set body = '', removed_at = now(), removed_by_email = $2 where id = $1 returning ${CHAT_COLUMNS}`,
    [id, tx.actor.email || "Tohyee"],
  );
  await writeAuditEvent(tx, { eventType: "farm_chat.removed", entityType: "farm_chat_message", entityId: id, details: { farmId: row.farm_id, own } });
  return (await shapeMessages(tx, updated.rows))[0];
}

/** A photo or voice note on a message, for the farm's people only (FCH2, FCH9). */
export async function readChatAttachment(tx: OrgTx, idInput: unknown): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  await requireFarming(tx);
  const id = requireId(idInput, "attachmentId");
  const found = await tx.query<{ farm_id: string | null; file_name: string; content_type: string; content: Buffer }>(
    `select m.farm_id::text, a.file_name, a.content_type, a.content
       from farm_chat_attachments a join farm_chat_messages m on m.id = a.message_id
      where a.id = $1 and m.removed_at is null`,
    [id],
  );
  const row = found.rows[0];
  if (!row || row.farm_id === null || !(await canSeeFarm(tx, row.farm_id))) throw new NotFoundError("Photo not found.");
  return { fileName: row.file_name, contentType: row.content_type, content: row.content };
}

/** Marks a farm's chat read up to a message (FCH6). Never moves backwards. */
export async function markChatRead(tx: OrgTx, farmIdInput: unknown, upToInput: unknown): Promise<void> {
  const farmId = requireId(farmIdInput, "farmId");
  await requireFarmAccess(tx, farmId);
  const upTo = requireId(upToInput, "upTo");
  if (!tx.actor.userId) return;
  await tx.query(
    `insert into farm_chat_reads (user_id, farm_id, read_up_to) values ($1, $2, $3)
     on conflict (user_id, farm_id) do update set read_up_to = greatest(farm_chat_reads.read_up_to, excluded.read_up_to)`,
    [tx.actor.userId, farmId, upTo],
  );
}

/** Unread messages on each farm this person can see (FCH6): others' messages, not taken down, after what they've read. */
export async function chatUnread(tx: OrgTx): Promise<Array<{ farmId: string; unread: number }>> {
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  const rows = await tx.query<{ farm_id: string; unread: number }>(
    `select m.farm_id::text, count(*)::int as unread
       from farm_chat_messages m
       left join farm_chat_reads r on r.farm_id = m.farm_id and r.user_id = $1
      where m.farm_id is not null and m.removed_at is null and m.id > coalesce(r.read_up_to, 0)
        and m.posted_by_user_id is distinct from $1
        and ($2::bigint[] is null or m.farm_id = any($2::bigint[]))
      group by m.farm_id`,
    [tx.actor.userId ?? "", visible],
  );
  return rows.rows.map((row) => ({ farmId: row.farm_id, unread: row.unread }));
}
