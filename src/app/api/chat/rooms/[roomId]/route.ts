import { json, readJson, route, searchParams, withTeamChat } from "@/lib/api/http";
import { closeSpace, getRoom, renameSpace } from "@/lib/chat/rooms";
import { ValidationError } from "@/lib/errors";

type Context = { params: Promise<{ roomId: string }> };

/** GET: one chat you're in, with its people and what you can do in it (TCH19, TCH22). */
export const GET = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  const room = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => getRoom(tx, roomId));
  return json({ room });
});

/** PATCH: `name` renames a space, `closed: true` closes it: whoever made it, or an owner or admin (TCH16). */
export const PATCH = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  const body = await readJson(request);
  const room = await withTeamChat(request, body.organisationId, "read", (tx) => {
    if (body.closed === true) return closeSpace(tx, roomId);
    if (body.name !== undefined) return renameSpace(tx, roomId, body.name);
    throw new ValidationError("Send a new name, or closed: true.");
  });
  return json({ room });
});
