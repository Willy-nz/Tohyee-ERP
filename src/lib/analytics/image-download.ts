import { PublicFetchError, publicFetch } from "@/lib/net/public-fetch";
import { ValidationError } from "@/lib/errors";
import { MAX_IMAGE_BYTES } from "@/lib/analytics/images";

/**
 * A picture the AI asks to put on a report from a web address, such
 * as a product photo from the organisation's own website. Only https and
 * only public addresses: each connection is checked when it's made
 * (`publicFetch`), so a name can't be pointed at this server or its network.
 * At most 3 redirects, each checked the same way; 15 seconds and 5 MB at
 * most. Whether it's really a JPG or PNG is checked from its contents when
 * it's stored, as an upload is.
 */

export const MOST_REDIRECTS = 3;
export const DOWNLOAD_SECONDS = 15;

export type DownloadedImage = { fileName: string; content: Uint8Array };

type Fetcher = (url: string, init: { maxBytes: number; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** JPG or PNG from the first bytes; anything else is left for the upload check to refuse. */
function extensionOf(content: Uint8Array): "jpg" | "png" | null {
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "jpg";
  if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47) return "png";
  return null;
}

/** The file name to store it under: the given name without its extension, then what the contents are. */
export function imageFileName(name: string, content: Uint8Array): string {
  let base = name;
  try {
    base = decodeURIComponent(name);
  } catch {
    // Kept as it is.
  }
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^\w.\- ]+/g, "").trim().slice(0, 120) || "picture";
  return `${stem}.${extensionOf(content) ?? "bin"}`;
}

/** Checks an address before anything is fetched: https, with no user name or password in it. */
export function checkImageAddress(input: unknown): URL {
  if (typeof input !== "string" || !input.trim()) throw new ValidationError("url: give the picture's https:// address.");
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ValidationError("url: that isn't a web address.");
  }
  if (url.protocol !== "https:") throw new ValidationError("url: only https:// addresses can be used.");
  if (url.username || url.password) throw new ValidationError("url: an address with a user name or password in it can't be used.");
  return url;
}

export async function downloadImage(input: unknown, fetcher: Fetcher = publicFetch): Promise<DownloadedImage> {
  let url = checkImageAddress(input);
  const signal = AbortSignal.timeout(DOWNLOAD_SECONDS * 1000);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetcher(url.toString(), { maxBytes: MAX_IMAGE_BYTES, signal, headers: { accept: "image/jpeg, image/png" } });
    } catch (error) {
      if (error instanceof PublicFetchError) throw new ValidationError(`url: ${error.message}`);
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new ValidationError(`url: ${url.hostname} took longer than ${DOWNLOAD_SECONDS} seconds.`);
      throw new ValidationError(`url: couldn't download it from ${url.hostname}.`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new ValidationError(`url: ${url.hostname} redirected without saying where.`);
      if (hop >= MOST_REDIRECTS) throw new ValidationError(`url: more than ${MOST_REDIRECTS} redirects.`);
      url = checkImageAddress(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new ValidationError(`url: ${url.hostname} answered ${response.status}.`);
    const content = new Uint8Array(await response.arrayBuffer());
    if (content.length === 0) throw new ValidationError("url: the picture was empty.");
    return { fileName: imageFileName(url.pathname.split("/").filter(Boolean).pop() ?? "", content), content };
  }
}

/** A picture sent as base64 (JPG or PNG), up to 5 MB. */
export function decodeImage(base64: unknown, fileName: unknown): DownloadedImage {
  if (typeof base64 !== "string" || !base64.trim()) throw new ValidationError("base64: send the picture's contents.");
  const text = base64.replace(/^data:image\/(?:jpeg|png);base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new ValidationError("base64: that isn't base64.");
  if (Math.floor((text.length * 3) / 4) > MAX_IMAGE_BYTES + 3) throw new ValidationError("base64: a report's images can be up to 5 MB.");
  const content = new Uint8Array(Buffer.from(text, "base64"));
  return { fileName: imageFileName(typeof fileName === "string" ? fileName : "", content), content };
}
