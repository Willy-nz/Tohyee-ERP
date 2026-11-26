import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { removeInReview } from "@/lib/chat/review";

type Context = { params: Promise<{ messageId: string }> };

/** DELETE: an owner or admin takes a message down from Review chats; recorded as from review (TCH21). */
export const DELETE = route<Context>(async (request, context) => {
  const { messageId } = await context.params;
  const message = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => removeInReview(tx, messageId));
  return json({ message });
});
