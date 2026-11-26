import { json, readJson, route, withTeamChat } from "@/lib/api/http";
import { addToSpace } from "@/lib/chat/rooms";

type Context = { params: Promise<{ roomId: string }> };

/** POST: `userIds`: adds people to a space you're in (TCH15). */
export const POST = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  const body = await readJson(request);
  const room = await withTeamChat(request, body.organisationId, "post", (tx) => addToSpace(tx, roomId, body.userIds));
  return json({ room });
});
