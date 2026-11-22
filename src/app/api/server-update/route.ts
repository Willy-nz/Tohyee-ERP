import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { remoteUpdateState, requestRemoteUpdate } from "@/lib/updates/remote-update";

/**
 * Update now in Tohyee (UPD1-UPD6): unlike /api/admin/*, this works from
 * any device a server admin is signed in on, not only the server computer.
 * GET: the versions and how an update is going. POST (body `version`):
 * back everything up, then ask the Windows updater to install it.
 */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  return json(await remoteUpdateState(auth));
});

export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  return json(await requestRemoteUpdate(auth, await readJson(request)));
});
