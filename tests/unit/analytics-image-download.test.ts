import { describe, expect, it } from "vitest";
import { checkImageAddress, decodeImage, downloadImage, imageFileName, MOST_REDIRECTS } from "@/lib/analytics/image-download";

/** : a picture the AI puts on a report, fetched only from public https addresses. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe("pictures from a web address", () => {
  it("takes only https addresses with no user name or password", () => {
    expect(checkImageAddress("https://glenmore.example/products/paw.png").hostname).toBe("glenmore.example");
    expect(() => checkImageAddress("http://glenmore.example/paw.png")).toThrow(/only https/);
    expect(() => checkImageAddress("https://user:secret@glenmore.example/paw.png")).toThrow(/user name or password/);
    expect(() => checkImageAddress("ftp://glenmore.example/paw.png")).toThrow(/only https/);
    expect(() => checkImageAddress("not an address")).toThrow(/isn't a web address/);
  });

  it("refuses this server and its network before connecting", async () => {
    await expect(downloadImage("https://127.0.0.1/paw.png")).rejects.toThrow(/this server or its local network/);
    await expect(downloadImage("https://10.0.0.5/paw.png")).rejects.toThrow(/this server or its local network/);
    await expect(downloadImage("https://localhost/paw.png")).rejects.toThrow(/on this server/);
  });

  it("follows up to three redirects, each checked, and names the file by what it is", async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(url);
      if (asked.length < 3) return new Response(null, { status: 302, headers: { location: `/hop${asked.length}` } });
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    };
    const picture = await downloadImage("https://shop.example/images/Pendant.jpg?v=2", fetcher);
    expect(asked).toEqual(["https://shop.example/images/Pendant.jpg?v=2", "https://shop.example/hop1", "https://shop.example/hop2"]);
    expect(picture.fileName).toBe("hop2.png");
    expect(picture.content).toEqual(PNG);
  });

  it("refuses a redirect to http and more than three redirects", async () => {
    const toHttp = async () => new Response(null, { status: 301, headers: { location: "http://shop.example/paw.png" } });
    await expect(downloadImage("https://shop.example/paw.png", toHttp)).rejects.toThrow(/only https/);
    const forever = async () => new Response(null, { status: 302, headers: { location: "/again" } });
    await expect(downloadImage("https://shop.example/paw.png", forever)).rejects.toThrow(new RegExp(`more than ${MOST_REDIRECTS} redirects`));
    const missing = async () => new Response("no", { status: 404 });
    await expect(downloadImage("https://shop.example/paw.png", missing)).rejects.toThrow(/answered 404/);
  });

  it("takes base64 contents, and names them by what they are", () => {
    expect(decodeImage(Buffer.from(JPG).toString("base64"), "Koru.png")).toEqual({ fileName: "Koru.jpg", content: JPG });
    expect(decodeImage(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`, undefined).fileName).toBe("picture.png");
    expect(() => decodeImage("not base64!", "x.png")).toThrow(/isn't base64/);
    expect(imageFileName("notes.txt", new Uint8Array([1, 2]))).toBe("notes.bin");
  });
});
