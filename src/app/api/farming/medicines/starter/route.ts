import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addStarterList } from "@/lib/farming/medicines";

/** POST: adds the common kinds for a `list` (dairy or sheep) that are in `kinds` to a farm's cabinet (`farmId`) (MED2). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const slots = await withFarmWork(request, body.organisationId, "read", (tx) => addStarterList(tx, { farmId: body.farmId, list: body.list, kinds: body.kinds }));
  return json({ slots }, { status: 201 });
});
