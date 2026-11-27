import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { makeMainServer, switchOverPreview } from "@/lib/backup-server/switch";

/** What switching over would do: the organisations here and what time each copy is as at. For a server admin or an organisation's Owner; anyone else learns only that they can't. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  return json({ preview: await switchOverPreview(auth) });
});

/** Makes this backup server the main one: `password` (typed again), `oldMainIsOff: true` and a `reason`. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  return json({ result: await makeMainServer(auth, await readJson(request)) });
});
