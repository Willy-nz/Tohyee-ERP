import { json, readJson, route, withTeamChat } from "@/lib/api/http";
import { markTeamChatRead } from "@/lib/chat/team";

/** POST: `upTo` (a message id): this person has read the team chat that far (TCH5). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  await withTeamChat(request, body.organisationId, "read", (tx) => markTeamChatRead(tx, body.upTo));
  return json({ ok: true });
});
