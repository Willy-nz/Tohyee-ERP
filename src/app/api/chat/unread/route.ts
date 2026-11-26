import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { chatUnreadTotal } from "@/lib/chat/overview";

/** GET: whether Chat is on, and how many messages this person hasn't read across all their chats (TCH1, TCH24). */
export const GET = route(async (request) => {
  const answer = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => chatUnreadTotal(tx));
  return json(answer);
});
