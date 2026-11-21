import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { fuelQuarter, removeManualFuel } from "@/lib/farming/fuel-refund";

type Context = { params: Promise<{ id: string }> };

/** DELETE: removes petrol or diesel added by hand (FUEL4). */
export const DELETE = route<Context>(async (request, context) => {
  const { id } = await context.params;
  const params = searchParams(request);
  const quarter = await withFarmWork(request, params.get("organisationId"), "read", async (tx) => {
    await removeManualFuel(tx, { id });
    return fuelQuarter(tx, { quarterEnd: params.get("quarterEnd") });
  });
  return json({ quarter });
});
