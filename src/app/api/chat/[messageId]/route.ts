import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { removeTeamMessage } from "@/lib/chat/team";

type Context = { params: Promise<{ messageId: string }> };

/** DELETE: takes a team chat message down: whoever posted it, or an owner or admin (TCH4). */
export const DELETE = route<Context>(async (request, context) => {
  const { messageId } = await context.params;
  const message = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => removeTeamMessage(tx, messageId));
  return json({ message });
});
