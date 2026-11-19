import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { removeChatMessage } from "@/lib/farming/chat";

type Context = { params: Promise<{ messageId: string }> };

/** DELETE: takes a message down: whoever posted it, or an owner or admin (FCH5). */
export const DELETE = route<Context>(async (request, context) => {
  const { messageId } = await context.params;
  const message = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => removeChatMessage(tx, messageId));
  return json({ message });
});
