import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { fuelQuarter, saveFuelQuarter } from "@/lib/farming/fuel-refund";

/** GET: a quarter's petrol, diesel, tank, shares and refund (`quarterEnd`) (FUEL2-FUEL9). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const quarter = await withFarmWork(request, params.get("organisationId"), "read", (tx) => fuelQuarter(tx, { quarterEnd: params.get("quarterEnd") }));
  return json({ quarter });
});

/** PUT: a quarter's tank (`opening`, `closing`) and `shares` [{userId, percent}] (FUEL5, FUEL6). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const quarter = await withFarmWork(request, body.organisationId, "read", async (tx) => {
    await saveFuelQuarter(tx, { quarterEnd: body.quarterEnd, opening: body.opening, closing: body.closing, shares: body.shares });
    return fuelQuarter(tx, { quarterEnd: body.quarterEnd });
  });
  return json({ quarter });
});
