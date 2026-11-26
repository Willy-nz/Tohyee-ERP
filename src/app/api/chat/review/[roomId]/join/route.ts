import { json, readJson, route, withTeamChat } from "@/lib/api/http";
import { joinForReview } from "@/lib/chat/review";

type Context = { params: Promise<{ roomId: string }> };

/** POST: an owner or admin joins a space from Review chats (TCH20). */
export const POST = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  const body = await readJson(request);
  return json(await withTeamChat(request, body.organisationId, "read", (tx) => joinForReview(tx, roomId)));
});
