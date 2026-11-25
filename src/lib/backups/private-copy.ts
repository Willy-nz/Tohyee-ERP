import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ValidationError } from "@/lib/errors";

/**
 * Runs `work` on a private copy of a backup file, then deletes the copy.
 *
 * A restore checks the file's tamper seal and then reads it again to feed
 * the database. Backup folders can be shared or synced folders that other
 * people or devices can write to, so both reads use one copy that only this
 * service's account can open: what was checked is what is restored.
 *
 * The copy goes in a new folder in the service's temporary folder (on
 * Windows, Tohyee's own tmp folder, which only administrators, SYSTEM and
 * the service can open; elsewhere a folder only this account can open).
 */
export async function withPrivateCopy<T>(file: string, work: (copy: string) => Promise<T>): Promise<T> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-restore-"));
  try {
    await fs.chmod(folder, 0o700);
    const copy = path.join(folder, "backup.tohyee");
    const source = createReadStream(file);
    const opened = await new Promise<void>((resolve, reject) => {
      source.once("open", () => resolve());
      source.once("error", reject);
    }).then(
      () => true,
      () => false,
    );
    if (!opened) throw new ValidationError(`Can't open ${file}.`);
    await pipeline(source, createWriteStream(copy, { flags: "wx", mode: 0o600 }));
    return await work(copy);
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
