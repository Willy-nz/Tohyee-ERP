import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { moveMobToFarm } from "@/lib/farming/mob-farm-move";

type Context = { params: Promise<{ mobId: string }> };

/**
 * Moves all or some of a mob to another farm in the organisation (OPF7-OPF13): a move, not a sale, so
 * the books' head count doesn't change and the withholding goes with the animals. Farm staff can record
 * it if they work on both farms. `operationId` lets a phone send it again safely.
 */
export const POST = route<Context>(async (request, context) => {
  const { mobId } = await context.params;
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => moveMobToFarm(tx, mobId, body));
  return json(result, { status: 201 });
});
