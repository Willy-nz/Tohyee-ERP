import { json, MAX_FILE_JSON_BYTES, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { listChat, postChatMessage } from "@/lib/farming/chat";

/** GET: a farm's chat (`farmId`, optional `before` for older messages), for anyone who can see the farm (FCH1). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const chat = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listChat(tx, { farmId: params.get("farmId"), before: params.get("before") }));
  return json(chat);
});

/** POST: a message on a farm's chat: `farmId`, `body`, `photos` [{fileName, contentBase64}], `links` [{kind, id}], `idempotencyKey` (FCH2, FCH3). Farm staff and up. */
export const POST = route(async (request) => {
  // Up to six 10 MB photos and a 5 MB voice note, as base64.
  const body = await readJson(request, { maxBytes: Math.max(MAX_FILE_JSON_BYTES, 90 * 1024 * 1024) });
  const message = await withFarmWork(request, body.organisationId, "record", (tx) => postChatMessage(tx, body));
  return json({ message }, { status: 201 });
});
