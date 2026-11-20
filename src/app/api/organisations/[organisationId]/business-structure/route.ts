import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { getBusinessStructure, saveBusinessStructure } from "@/lib/organisations/entity";

type Context = { params: Promise<{ organisationId: string }> };

/** GET: what kind of entity the organisation is, and its IRD number (ENT1, ENT2), for anyone in it. */
export const GET = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const structure = await withOrganisation(request, organisationId, "viewer", (tx) => getBusinessStructure(tx));
  return json({ structure });
});

/** PUT: `entityType` and `irdNumber`; admins and owners, as the organisation's other settings are. */
export const PUT = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const body = await readJson(request);
  const structure = await withOrganisation(request, organisationId, "admin", (tx) => saveBusinessStructure(tx, { entityType: body.entityType, irdNumber: body.irdNumber }));
  return json({ structure });
});
