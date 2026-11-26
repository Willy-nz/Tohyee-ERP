import { json, readJson, route, withTeamChat } from "@/lib/api/http";
import { leaveSpace } from "@/lib/chat/rooms";

type Context = { params: Promise<{ roomId: string }> };

/** POST: leaves a space (TCH15). */
export const POST = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  const body = await readJson(request);
  return json(await withTeamChat(request, body.organisationId, "read", (tx) => leaveSpace(tx, roomId)));
});
