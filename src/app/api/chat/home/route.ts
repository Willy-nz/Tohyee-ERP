import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { chatHome } from "@/lib/chat/overview";

/** GET: the latest messages from every chat you're in, newest first (optional `before`) (TCH10). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  return json(await withTeamChat(request, params.get("organisationId"), "read", (tx) => chatHome(tx, { before: params.get("before") })));
});
