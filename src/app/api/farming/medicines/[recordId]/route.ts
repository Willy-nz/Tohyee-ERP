import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { removeMedicine, updateMedicine } from "@/lib/farming/medicines";

type Context = { params: Promise<{ recordId: string }> };

/** PATCH: a cabinet product's `name`, `kind`, `photoFileId` (null for the drawing) or `reorderAt` (MED2, MED3, MED6). */
export const PATCH = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const slots = await withFarmWork(request, body.organisationId, "read", (tx) => updateMedicine(tx, { ...body, chemicalRecordId: recordId }));
  return json({ slots });
});

/** DELETE: takes a product out of the cabinet; its history stays (MED9). */
export const DELETE = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const slots = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => removeMedicine(tx, { chemicalRecordId: recordId }));
  return json({ slots });
});
