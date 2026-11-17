import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { analyticsMember } from "@/lib/analytics/http";
import { googleAds, listGadsAccounts, saveGadsSettings } from "@/lib/analytics/google-ads";
import { requestOrigin } from "@/lib/crm/mail/origin";

/** GET: the Google Ads connection and its last load. Anyone in the organisation; the Google account only for admins. */
export const GET = route(async (request) => {
  const status = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx, { membership }) => googleAds.status(tx, roleAtLeast(membership.role, "admin")));
  return json(status);
});

/** POST: starts signing in with Google for Google Ads. Admins and owners. Returns Google's sign-in address. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  return json(await withOrganisation(request, body.organisationId, "admin", (tx) => googleAds.startConnect(tx, origin)));
});

/** PATCH: chooses what to load and whether it loads nightly. Body: { organisationId, customerId?, reloadDaily? }. A new choice drops the loaded tables. Admins and owners. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const available = body.customerId === undefined ? null : await listGadsAccounts(organisation, actor);
  const saved = await withOrganisation(request, body.organisationId, "admin", (tx) => saveGadsSettings(tx, { customerId: body.customerId, reloadDaily: body.reloadDaily }, available));
  if (saved.startAgain) await googleAds.dropTables(organisation.id);
  return json({ connection: saved.connection });
});

/** DELETE: disconnects, deleting the sign-in and the loaded tables. Admins and owners. */
export const DELETE = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  await googleAds.disconnect(organisation, actor);
  return json({ ok: true });
});
