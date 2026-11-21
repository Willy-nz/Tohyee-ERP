import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { chooseFuelLine, fuelQuarter } from "@/lib/farming/fuel-refund";

/** POST: what a line from the books is (`source`, `sourceId`, `fuelType`) and its `litres` (FUEL2, FUEL3). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const quarter = await withFarmWork(request, body.organisationId, "read", async (tx) => {
    await chooseFuelLine(tx, { source: body.source, sourceId: body.sourceId, fuelType: body.fuelType, litres: body.litres });
    return fuelQuarter(tx, { quarterEnd: body.quarterEnd });
  });
  return json({ quarter });
});
