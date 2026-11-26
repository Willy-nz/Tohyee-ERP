import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { getFarmWater } from "@/lib/farming/water";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's mapped water pipes, with each one's length, size, flow and what that works out to (FW6). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const water = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => getFarmWater(tx, farmId));
  return json({ water });
});
