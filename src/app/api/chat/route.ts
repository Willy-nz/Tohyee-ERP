import { json, MAX_FILE_JSON_BYTES, readJson, route, searchParams, withTeamChat } from "@/lib/api/http";
import { listTeamChat, postTeamMessage } from "@/lib/chat/team";

/** GET: the organisation's team chat (optional `before` for older messages) (TCH2). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const chat = await withTeamChat(request, params.get("organisationId"), "read", (tx) => listTeamChat(tx, { before: params.get("before") }));
  return json(chat);
});

/** POST: a message in the team chat: `body`, `photos` [{fileName, contentBase64}], `voice` {seconds, contentBase64}, `idempotencyKey` (TCH3). */
export const POST = route(async (request) => {
  // Up to six 10 MB photos and a 5 MB voice note, as base64.
  const body = await readJson(request, { maxBytes: Math.max(MAX_FILE_JSON_BYTES, 90 * 1024 * 1024) });
  const message = await withTeamChat(request, body.organisationId, "post", (tx) => postTeamMessage(tx, body));
  return json({ message }, { status: 201 });
});
