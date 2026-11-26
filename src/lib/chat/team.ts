import { writeAuditEvent } from "@/lib/audit";
import { requireTeamChat, teamChatEnabled } from "@/lib/chat/enabled";
import { listRoomMessages, markRoomRead, postRoomMessage, readRoomAttachment, removeRoomMessage, type RoomMessage } from "@/lib/chat/messages";
import { chatUnreadTotal } from "@/lib/chat/overview";
import { everyoneRoomId } from "@/lib/chat/rooms";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";

/*
 * Team chat (examples TCH1-TCH9, following common practice, not yet
 * reviewed): one chat for everyone in the organisation, its own app, switched
 * on in Settings, Modules. Since TCH11 it's the space called Everyone, beside
 * direct messages and other spaces (`@/lib/chat/rooms`); these keep the team
 * chat's addresses and AI tools working, and mean Everyone. Farm staff and
 * report viewers aren't in it; farm staff have their farm's chat.
 */

export type TeamMessage = RoomMessage;

export { teamChatEnabled };

/** Switches Chat on or off (TCH1, TCH26). Turning it off keeps the messages for when it's back on. */
export async function setTeamChatEnabled(tx: OrgTx, input: { enabled: unknown }): Promise<{ enabled: boolean }> {
  if (typeof input.enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
  await tx.query("update team_chat_settings set enabled = $1, updated_by_email = $2, updated_at = now() where id = true", [input.enabled, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: input.enabled ? "team_chat.turned_on" : "team_chat.turned_off", entityType: "organisation", entityId: tx.organisationId, details: {} });
  return { enabled: input.enabled };
}

async function everyone(tx: OrgTx): Promise<string> {
  await requireTeamChat(tx);
  return everyoneRoomId(tx);
}

/** Everyone, newest last (TCH2, TCH11): the latest page, or the page before `before`. */
export async function listTeamChat(tx: OrgTx, input: { before?: unknown; limit?: unknown } = {}): Promise<{ messages: TeamMessage[]; more: boolean }> {
  return listRoomMessages(tx, { roomId: await everyone(tx), before: input.before, limit: input.limit });
}

/** Posts in Everyone (TCH3). `viaAi` is set by the AI's tool, never by the screen. */
export async function postTeamMessage(tx: OrgTx, input: Record<string, unknown>, options: { viaAi?: boolean } = {}): Promise<TeamMessage> {
  return postRoomMessage(tx, { ...input, roomId: await everyone(tx) }, options);
}

/** Takes a message down (TCH4): its author, or an owner or admin, in a chat they're in. */
export async function removeTeamMessage(tx: OrgTx, idInput: unknown): Promise<TeamMessage> {
  return removeRoomMessage(tx, idInput);
}

/** A photo or voice note, for the people in its chat (TCH3, TCH22). */
export async function readTeamAttachment(tx: OrgTx, idInput: unknown): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  return readRoomAttachment(tx, idInput);
}

/** Marks Everyone read up to a message (TCH5). Never moves backwards. */
export async function markTeamChatRead(tx: OrgTx, upToInput: unknown): Promise<void> {
  await markRoomRead(tx, await everyone(tx), upToInput);
}

/** Unread across every chat this person is in (TCH5, TCH24). Nothing while Chat is off. */
export async function teamChatUnread(tx: OrgTx): Promise<{ enabled: boolean; unread: number }> {
  return chatUnreadTotal(tx);
}
