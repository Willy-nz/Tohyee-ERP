import { route, searchParams, withTeamChat } from "@/lib/api/http";
import { chatFileResponse } from "@/lib/chat/file-response";
import { reviewAttachment } from "@/lib/chat/review";

type Context = { params: Promise<{ attachmentId: string }> };

/** GET: a photo or voice note opened in Review chats, for owners and admins; recorded in the audit trail (TCH21). */
export const GET = route<Context>(async (request, context) => {
  const { attachmentId } = await context.params;
  const file = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => reviewAttachment(tx, attachmentId));
  return chatFileResponse(request, file);
});
