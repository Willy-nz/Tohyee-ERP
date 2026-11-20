import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addMedicine, cabinet } from "@/lib/farming/medicines";
import { canRecordSafety } from "@/lib/safety/records";

/** GET: a farm's medicine cabinet (`farmId`), with stock on hand, badges and expiry (MED1, MED6, MED7). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withFarmWork(request, params.get("organisationId"), "read", async (tx) => ({ slots: await cabinet(tx, { farmId: params.get("farmId") }), canManage: canRecordSafety(tx) }));
  return json(result);
});

/** POST: puts a product in the cabinet: `kind`, and `chemicalRecordId` or a new product's `farmId`, `name`, `unit` (MED1, MED2). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const slots = await withFarmWork(request, body.organisationId, "read", (tx) => addMedicine(tx, body));
  return json({ slots }, { status: 201 });
});
