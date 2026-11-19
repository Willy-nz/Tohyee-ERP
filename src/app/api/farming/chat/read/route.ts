import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { markChatRead } from "@/lib/farming/chat";

/** POST: `farmId` and `upTo` (a message id): this person has read the farm's chat that far (FCH6). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  await withFarmWork(request, body.organisationId, "read", (tx) => markChatRead(tx, body.farmId, body.upTo));
  return json({ ok: true });
});
