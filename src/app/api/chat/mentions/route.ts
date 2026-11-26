import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { chatMentions } from "@/lib/chat/overview";

/** GET: messages that mention you, newest first (optional `before`) (TCH18). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  return json(await withTeamChat(request, params.get("organisationId"), "read", (tx) => chatMentions(tx, { before: params.get("before") })));
});
