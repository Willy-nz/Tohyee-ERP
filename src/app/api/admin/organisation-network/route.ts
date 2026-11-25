import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { authenticate, requireServerAdmin } from "@/lib/auth/guard";
import { getOrganisationNetwork, saveOrganisationNetwork } from "@/lib/network/organisation-reach";

/** GET: where organisations' database sources and post boxes may connect. Server admins only. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  requireServerAdmin(auth, request);
  return json({ network: await getOrganisationNetwork() });
});

/** PUT: changes it. Server admins only, on the server computer. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  return json({ network: await saveOrganisationNetwork(auth.user, { localNetwork: body.localNetwork, thisComputer: body.thisComputer }) });
});
