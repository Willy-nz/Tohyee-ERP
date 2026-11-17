import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { analyticsMember } from "@/lib/analytics/http";
import { businessProfile, listGbpLocations, saveGbpSettings } from "@/lib/analytics/business-profile";
import { requestOrigin } from "@/lib/crm/mail/origin";

/** GET: the Business Profile connection and its last load. Anyone in the organisation; the Google account only for admins. */
export const GET = route(async (request) => {
  const status = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx, { membership }) => businessProfile.status(tx, roleAtLeast(membership.role, "admin")));
  return json(status);
});

/** POST: starts signing in with Google for Business Profile. Admins and owners. Returns Google's sign-in address. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  return json(await withOrganisation(request, body.organisationId, "admin", (tx) => businessProfile.startConnect(tx, origin)));
});

/** PATCH: chooses what to load and whether it loads nightly. Body: { organisationId, locationName?, reloadDaily? }. A new choice drops the loaded tables. Admins and owners. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const available = body.locationName === undefined ? null : await listGbpLocations(organisation, actor);
  const saved = await withOrganisation(request, body.organisationId, "admin", (tx) => saveGbpSettings(tx, { locationName: body.locationName, reloadDaily: body.reloadDaily }, available));
  if (saved.startAgain) await businessProfile.dropTables(organisation.id);
  return json({ connection: saved.connection });
});

/** DELETE: disconnects, deleting the sign-in and the loaded tables. Admins and owners. */
export const DELETE = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  await businessProfile.disconnect(organisation, actor);
  return json({ ok: true });
});
