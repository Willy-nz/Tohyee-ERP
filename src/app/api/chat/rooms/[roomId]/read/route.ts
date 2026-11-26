import { json, readJson, route, withTeamChat } from "@/lib/api/http";
import { markRoomRead } from "@/lib/chat/messages";

type Context = { params: Promise<{ roomId: string }> };

/** POST: `upTo` (a message id): this person has read the chat that far (TCH10). */
export const POST = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  const body = await readJson(request);
  await withTeamChat(request, body.organisationId, "read", (tx) => markRoomRead(tx, roomId, body.upTo));
  return json({ ok: true });
});
