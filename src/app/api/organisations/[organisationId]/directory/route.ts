import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { getOrganisationDirectory, saveOrganisationDirectory } from "@/lib/organisations/directory";

type Context = { params: Promise<{ organisationId: string }> };

/** GET: the organisation's directory details, for anyone in the organisation. */
export const GET = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const directory = await withOrganisation(request, organisationId, "viewer", (tx) => getOrganisationDirectory(tx));
  return json({ directory });
});

/** PUT: replaces them; admins and owners, as the organisation's other settings are. */
export const PUT = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const body = await readJson(request);
  const directory = await withOrganisation(request, organisationId, "admin", (tx) => saveOrganisationDirectory(tx, body.directory));
  return json({ directory });
});
