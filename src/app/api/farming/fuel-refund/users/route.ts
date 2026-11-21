import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { saveFuelUser } from "@/lib/farming/fuel-refund";

/** POST: adds or changes something that uses petrol: `id`, `name`, `kind`, `roadLicensed`, `active` (FUEL6). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const users = await withFarmWork(request, body.organisationId, "read", (tx) => saveFuelUser(tx, body));
  return json({ users });
});
