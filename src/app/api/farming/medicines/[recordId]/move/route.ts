import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { moveMedicine } from "@/lib/farming/medicines";

type Context = { params: Promise<{ recordId: string }> };

/** POST: moves stock to another farm: `toFarmId`, `quantity`, `unit`, `movedOn`, `note` (MED5). */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const slots = await withFarmWork(request, body.organisationId, "record", (tx) => moveMedicine(tx, { ...body, chemicalRecordId: recordId }));
  return json({ slots }, { status: 201 });
});
