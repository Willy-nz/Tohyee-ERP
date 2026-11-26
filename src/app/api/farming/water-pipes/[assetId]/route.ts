import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { setPipeFigures } from "@/lib/farming/water";

type Context = { params: Promise<{ assetId: string }> };

/** PUT `{ insideMm, flowLpm, riseM }`: says what a mapped water pipe is; empty clears a figure. Farm staff and up (FW6). */
export const PUT = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const pipe = await withFarmWork(request, body.organisationId, "record", (tx) => setPipeFigures(tx, assetId, { insideMm: body.insideMm, flowLpm: body.flowLpm, riseM: body.riseM }));
  return json({ pipe });
});
