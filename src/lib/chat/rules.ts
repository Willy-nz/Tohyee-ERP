import type { Role } from "@/lib/auth/roles";
import { ValidationError } from "@/lib/errors";

/*
 * Chat's plain rules (TCH10-TCH27, asked for by the owner; details following
 * common practice, not yet reviewed). Browser-safe: the screens use them too.
 */

/** People in one direct message, you included (TCH13). */
export const MAX_DIRECT_PEOPLE = 12;
export const MAX_SPACE_NAME = 80;

/** Always shown on a direct message or space (TCH19). */
export const CHAT_PRIVACY_LINE = "Owners and admins of this organisation can read this chat if they need to.";

export type ChatKind = "everyone" | "space" | "direct" | "farm";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_ID = USER_ID;

export function isUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID.test(value);
}

/** Who's in a direct message, as one key: the same people always make the same key (TCH12). */
export function peopleKey(userIds: readonly string[]): string {
  return [...new Set(userIds.map((id) => id.toLowerCase()))].sort().join(",");
}

/** You and the people you picked, checked, sorted and without repeats (TCH12, TCH13). */
export function directPeople(self: string, others: readonly unknown[]): string[] {
  if (others.some((id) => !isUserId(id))) throw new ValidationError("Choose people from the list.");
  const people = new Set([self.toLowerCase(), ...(others as string[]).map((id) => id.toLowerCase())]);
  if (people.size < 2) throw new ValidationError("Choose who to message.");
  if (people.size > MAX_DIRECT_PEOPLE) throw new ValidationError(`A direct message can have up to ${MAX_DIRECT_PEOPLE} people. Make a space for a bigger group.`);
  return [...people].sort();
}

/** A space's name (TCH14): trimmed, single spaces, up to 80 characters, never Everyone. */
export function spaceName(input: unknown): string {
  const name = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new ValidationError("Give the space a name.");
  if (name.length > MAX_SPACE_NAME) throw new ValidationError(`A space's name can be up to ${MAX_SPACE_NAME} characters.`);
  if (name.toLowerCase() === "everyone") throw new ValidationError("Everyone is the chat for the whole team. Choose another name.");
  return name;
}

/** Renaming or closing a space (TCH16): whoever made it, or an owner or admin. */
export function canManageSpace(role: Role | undefined, isMaker: boolean): boolean {
  return isMaker || role === "owner" || role === "admin";
}

/** The @word being typed just before the caret (TCH18), or null. An @ inside a word (an email) doesn't count. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Replaces the @word being typed with the person's name and a space. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}

export type ChatRef = { kind: "room"; id: string } | { kind: "farm"; farmId: string };

/** A chat in the list: a room's random id, or "farm:<id>" for a farm's chat (TCH17). */
export function parseChatRef(input: unknown): ChatRef | null {
  if (typeof input !== "string") return null;
  if (ROOM_ID.test(input)) return { kind: "room", id: input.toLowerCase() };
  const farm = /^farm:([1-9]\d{0,17})$/.exec(input);
  return farm ? { kind: "farm", farmId: farm[1] } : null;
}

export function farmRef(farmId: string): string {
  return `farm:${farmId}`;
}
