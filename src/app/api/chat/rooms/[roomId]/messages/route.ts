import { json, MAX_FILE_JSON_BYTES, readJson, route, searchParams, withTeamChat } from "@/lib/api/http";
import { listRoomMessages, postRoomMessage } from "@/lib/chat/messages";

type Context = { params: Promise<{ roomId: string }> };

/** GET: a chat's messages, newest last (optional `before` for older ones), for people in it (TCH22). */
export const GET = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  const params = searchParams(request);
  const chat = await withTeamChat(request, params.get("organisationId"), "read", (tx) => listRoomMessages(tx, { roomId, before: params.get("before") }));
  return json(chat);
});

/** POST: a message: `body`, `photos` [{fileName, contentBase64}], `voice` {seconds, contentBase64}, `mentions` [userId], `idempotencyKey` (TCH3, TCH18). */
export const POST = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  // Up to six 10 MB photos and a 5 MB voice note, as base64.
  const body = await readJson(request, { maxBytes: Math.max(MAX_FILE_JSON_BYTES, 90 * 1024 * 1024) });
  const message = await withTeamChat(request, body.organisationId, "post", (tx) => postRoomMessage(tx, { ...body, roomId }));
  return json({ message }, { status: 201 });
});
