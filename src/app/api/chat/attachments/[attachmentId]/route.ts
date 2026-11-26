import { route, searchParams, withTeamChat } from "@/lib/api/http";
import { readRoomAttachment } from "@/lib/chat/messages";
import { chatFileResponse } from "@/lib/chat/file-response";

type Context = { params: Promise<{ attachmentId: string }> };

/** GET: a photo or voice note in a chat you're in (TCH3, TCH22), with byte ranges for iPhones. */
export const GET = route<Context>(async (request, context) => {
  const { attachmentId } = await context.params;
  const file = await withTeamChat(request, searchParams(request).get("organisationId"), "read", (tx) => readRoomAttachment(tx, attachmentId));
  return chatFileResponse(request, file);
});
