import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { teamChatUnread } from "@/lib/chat/team";

/** GET: whether Chat is on, and how many messages this person hasn't read (TCH1, TCH5). */
export const GET = route(async (request) => {
  const answer = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => teamChatUnread(tx));
  return json(answer);
});
