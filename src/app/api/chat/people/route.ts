import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { requireTeamChat } from "@/lib/chat/enabled";
import { chatPeople } from "@/lib/chat/people";

/** GET: the people in Chat now, to pick from (TCH13, TCH23): not farm staff, report viewers or anyone who has left. */
export const GET = route(async (request) => {
  const people = await withTeamChat(request, searchParams(request).get("organisationId"), "read", async (tx) => {
    await requireTeamChat(tx);
    const self = tx.actor.userId?.toLowerCase();
    return (await chatPeople(tx)).filter((person) => person.userId !== self).map(({ userId, name, email }) => ({ userId, name, email }));
  });
  return json({ people });
});
