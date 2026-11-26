import { json, route, searchParams, withTeamChat } from "@/lib/api/http";
import { reviewRoom } from "@/lib/chat/review";

type Context = { params: Promise<{ roomId: string }> };

/** GET: reads one chat for review, owners and admins only; each opening is in the audit trail (TCH20, TCH21). */
export const GET = route<Context>(async (request, context) => {
  const { roomId } = await context.params;
  const params = searchParams(request);
  return json(await withTeamChat(request, params.get("organisationId"), "read", (tx) => reviewRoom(tx, roomId, { before: params.get("before") })));
});
