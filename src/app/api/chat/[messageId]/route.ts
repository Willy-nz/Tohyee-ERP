import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { removeRoomMessage } from "@/lib/chat/messages";

type Context = { params: Promise<{ messageId: string }> };

/** DELETE: takes a message down in a chat you're in: whoever posted it, or an owner or admin (TCH4, TCH22). */
export const DELETE = route<Context>(async (request, context) => {
  const { messageId } = await context.params;
  const message = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => removeRoomMessage(tx, messageId));
  return json({ message });
});
