import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addManualFuel, fuelQuarter } from "@/lib/farming/fuel-refund";

/** POST: petrol or diesel bought without a line in the books: `boughtOn`, `description`, `fuelType`, `litres` (FUEL4). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const quarter = await withFarmWork(request, body.organisationId, "read", async (tx) => {
    await addManualFuel(tx, body);
    return fuelQuarter(tx, { quarterEnd: body.quarterEnd });
  });
  return json({ quarter }, { status: 201 });
});
