import { type Role, teamChatAllows } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { memberAccessCurrentSql } from "@/lib/organisations/registry";
import { lookupUserNames, nameOf } from "@/lib/people/names";

/*
 * Who's in Chat (TCH6, TCH23): the organisation's members whose sign-in is
 * on, whose access is current, and whose role is in Chat (everyone but farm
 * staff and report viewers). Members live in the core database, so this is
 * one read of it, done once per transaction, as approvals do.
 */

export type ChatPerson = { userId: string; email: string; name: string; role: Role };

/** Someone in a room; `current` is false once they've left Chat (TCH23). */
export type RoomMember = { userId: string; email: string; name: string; current: boolean };

const directories = new WeakMap<object, Promise<ChatPerson[]>>();

async function loadPeople(organisationId: string): Promise<ChatPerson[]> {
  const result = await coreQuery<{ user_id: string; email: string; display_name: string; role: Role }>(
    `select m.user_id::text, u.email, u.display_name, m.role
       from organisation_members m join users u on u.id = m.user_id
      where m.organisation_id = $1 and u.is_active and ${memberAccessCurrentSql("m")}
      order by lower(u.display_name), u.email`,
    [organisationId],
  );
  return result.rows
    .filter((row) => teamChatAllows(row.role, "read"))
    .map((row) => ({ userId: row.user_id.toLowerCase(), email: row.email, name: row.display_name, role: row.role }));
}

/** Everyone in Chat now, by name. */
export function chatPeople(tx: OrgTx): Promise<ChatPerson[]> {
  let found = directories.get(tx);
  if (!found) {
    found = loadPeople(tx.organisationId);
    directories.set(tx, found);
  }
  return found;
}

/** The people picked, all in Chat now (TCH13, TCH23); anyone else is refused. */
export async function requireChatPeople(tx: OrgTx, userIds: readonly string[]): Promise<ChatPerson[]> {
  const people = await chatPeople(tx);
  return userIds.map((id) => {
    const person = people.find((entry) => entry.userId === id.toLowerCase());
    if (!person) throw new ValidationError("Choose people from the list.");
    return person;
  });
}

/** The acting person's role lets them into Chat at this level (TCH6). Work Tohyee does itself has no role. */
export function requireChatRole(tx: OrgTx, need: "read" | "post"): void {
  const role = tx.actor.role;
  if (role && !teamChatAllows(role, need)) {
    throw new ForbiddenError(need === "post" ? "Posting in Chat needs the bookkeeper role or higher, or a sales role." : "Chat isn't open to this role.");
  }
}

/** Owners and admins (TCH20). */
export function isOwnerOrAdmin(tx: OrgTx): boolean {
  return tx.actor.role === "owner" || tx.actor.role === "admin";
}

/**
 * Rooms' people, named: from who's in Chat now, and anyone who has left by
 * their name from their sign-in, or the email that was kept (TCH23).
 */
export async function namedMembers(tx: OrgTx, rows: ReadonlyArray<{ user_id: string; user_email: string }>): Promise<RoomMember[]> {
  const people = await chatPeople(tx);
  const gone = rows.filter((row) => !people.some((person) => person.userId === row.user_id)).map((row) => row.user_email);
  const names = gone.length ? await lookupUserNames(gone) : null;
  return rows
    .map((row) => {
      const person = people.find((entry) => entry.userId === row.user_id);
      if (person) return { userId: row.user_id, email: person.email, name: person.name, current: true };
      return { userId: row.user_id, email: row.user_email, name: names ? nameOf(names, row.user_email) : row.user_email, current: false };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
