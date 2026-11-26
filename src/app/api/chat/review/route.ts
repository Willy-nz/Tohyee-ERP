import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { reviewList } from "@/lib/chat/review";

/** GET: every space and direct message, for owners and admins to review (TCH20). */
export const GET = route(async (request) => {
  return json({ chats: await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => reviewList(tx)) });
});
