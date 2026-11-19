import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { readChatAttachment } from "@/lib/farming/chat";

type Context = { params: Promise<{ attachmentId: string }> };

/** GET: a photo on a chat message, for anyone who can see its farm (FCH2). */
export const GET = route<Context>(async (request, context) => {
  const { attachmentId } = await context.params;
  const file = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => readChatAttachment(tx, attachmentId));
  const safeName = file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(file.content), {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "content-disposition": `inline; filename="${safeName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});
