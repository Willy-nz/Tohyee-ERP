import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { analyticsMember } from "@/lib/analytics/http";
import { disconnectGmc, dropGmcTables, getGmcStatus, listGmcAccounts, saveGmcSettings, startGmcConnect } from "@/lib/analytics/merchant-center";
import { requestOrigin } from "@/lib/crm/mail/origin";

/** GET: the Merchant Center connection and its last load. Anyone in the organisation; the Google account only for admins. */
export const GET = route(async (request) => {
  const status = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx, { membership }) => getGmcStatus(tx, roleAtLeast(membership.role, "admin")));
  return json(status);
});

/** POST: starts signing in with Google for Merchant Center. Admins and owners. Returns Google's sign-in address. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  return json(await withOrganisation(request, body.organisationId, "admin", (tx) => startGmcConnect(tx, origin)));
});

/**
 * PATCH: chooses the account and whether it loads nightly. Body: {
 * organisationId, accountId?, reloadDaily? }. A new account is checked
 * against the ones Google lists for the Google account now, and drops the
 * loaded tables to start again. Admins and owners.
 */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const available = body.accountId === undefined ? null : await listGmcAccounts(organisation, actor);
  const saved = await withOrganisation(request, body.organisationId, "admin", (tx) => saveGmcSettings(tx, { accountId: body.accountId, reloadDaily: body.reloadDaily }, available));
  if (saved.startAgain) await dropGmcTables(organisation.id);
  return json({ connection: saved.connection });
});

/** DELETE: disconnects, deleting the sign-in and the loaded Merchant Center tables. Admins and owners. */
export const DELETE = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  await disconnectGmc(organisation, actor);
  return json({ ok: true });
});
