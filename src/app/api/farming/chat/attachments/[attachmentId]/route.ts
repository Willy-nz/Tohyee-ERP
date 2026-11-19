import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { byteRange } from "@/lib/api/byte-range";
import { readChatAttachment } from "@/lib/farming/chat";

type Context = { params: Promise<{ attachmentId: string }> };

/**
 * GET: a photo or voice note on a chat message, for anyone who can see its
 * farm (FCH2, FCH9). Answers a byte range too, which iPhones ask for before
 * they'll play audio.
 */
export const GET = route<Context>(async (request, context) => {
  const { attachmentId } = await context.params;
  const file = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => readChatAttachment(tx, attachmentId));
  const safeName = file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const headers: Record<string, string> = {
    "content-type": file.contentType,
    "content-disposition": `inline; filename="${safeName}"`,
    "cache-control": "private, no-store",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  const size = file.content.length;
  const range = byteRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  if (range) {
    return new Response(new Uint8Array(file.content.subarray(range.start, range.end + 1)), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) },
    });
  }
  return new Response(new Uint8Array(file.content), { status: 200, headers: { ...headers, "content-length": String(size) } });
});
