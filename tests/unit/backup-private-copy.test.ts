import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPrivateCopy } from "@/lib/backups/private-copy";

/**
 * A restore checks a backup and then restores it from one private copy, so
 * a change to the original file after the copy is made never reaches the
 * restore.
 */
describe("restoring from a private copy of a backup", () => {
  let folder: string;
  let original: string;

  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "private-copy-test-"));
    original = path.join(folder, "made-up.tohyee");
    await fs.writeFile(original, "checked bytes");
  });

  afterAll(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("works on a copy that only this account can open, which a later change to the original doesn't reach", async () => {
    let copyPath = "";
    const read = await withPrivateCopy(original, async (copy) => {
      copyPath = copy;
      expect(copy).not.toBe(original);
      if (process.platform !== "win32") {
        expect((await fs.stat(copy)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(copy))).mode & 0o777).toBe(0o700);
      }
      // Someone changes the shared file between the check and the restore.
      await fs.writeFile(original, "changed bytes");
      const first = await fs.readFile(copy, "utf8");
      const second = await fs.readFile(copy, "utf8");
      return [first, second];
    });
    expect(read).toEqual(["checked bytes", "checked bytes"]);
    // The copy is gone afterwards.
    await expect(fs.stat(copyPath)).rejects.toThrow();
  });

  it("removes the copy when the work fails, and says plainly when the file can't be opened", async () => {
    let copyPath = "";
    await expect(
      withPrivateCopy(original, async (copy) => {
        copyPath = copy;
        throw new Error("restore failed");
      }),
    ).rejects.toThrow("restore failed");
    await expect(fs.stat(path.dirname(copyPath))).rejects.toThrow();
    await expect(withPrivateCopy(path.join(folder, "missing.tohyee"), async () => "never")).rejects.toThrow(/Can't open/);
  });
});
