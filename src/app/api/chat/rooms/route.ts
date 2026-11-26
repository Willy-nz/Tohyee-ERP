import { json, readJson, route, searchParams, withTeamChat } from "@/lib/api/http";
import { chatList } from "@/lib/chat/overview";
import { createSpace, startDirect } from "@/lib/chat/rooms";
import { ValidationError } from "@/lib/errors";

/** GET: the list down the side: Home, Mentions, Direct messages and Spaces, with unread counts (TCH10). */
export const GET = route(async (request) => {
  const list = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => chatList(tx));
  return json(list);
});

/**
 * POST: `kind` "direct" with `userIds` starts a direct message, or opens the
 * one those people already have (TCH12, TCH13); `kind` "space" with `name`
 * and `userIds` makes a space (TCH14). `idempotencyKey` either way.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const room = await withTeamChat(request, body.organisationId, "post", (tx) => {
    if (body.kind === "direct") return startDirect(tx, { userIds: body.userIds, idempotencyKey: body.idempotencyKey });
    if (body.kind === "space") return createSpace(tx, { name: body.name, userIds: body.userIds, idempotencyKey: body.idempotencyKey });
    throw new ValidationError("kind must be direct or space.");
  });
  return json({ room }, { status: 201 });
});
