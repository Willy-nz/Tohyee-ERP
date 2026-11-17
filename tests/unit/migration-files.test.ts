import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreMigrations } from "@/lib/db/migrations/core";
import { tenantMigrations } from "@/lib/db/migrations/tenant";

/*
 * Each migration is its own file. The runner refuses a
 * database whose applied migrations have changed, so moving them between
 * files must leave every one byte for byte the same: this checks each
 * against the checksum it had when it was released.
 */
const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");
const released = JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/migration-checksums.json"), "utf8")) as { core: Record<string, string>; tenant: Record<string, string> };

describe.each([
  ["core", coreMigrations, released.core],
  ["tenant", tenantMigrations, released.tenant],
] as const)("%s migrations", (which, list, known) => {
  it("every released migration is unchanged", () => {
    const now = new Map(list.map((migration) => [migration.version, checksum(migration.sql)]));
    const changed = Object.entries(known).filter(([version, sum]) => now.get(version) !== sum).map(([version]) => version);
    expect(changed, "a released migration changed or went missing: add a new one instead").toEqual([]);
  });

  it("every migration is in the checksum list", () => {
    const missing = list.filter((migration) => !known[migration.version]).map((migration) => `"${migration.version}": "${checksum(migration.sql)}"`);
    expect(missing, `add these to tests/fixtures/migration-checksums.json under "${which}"`).toEqual([]);
  });

  it("each version once (the list's order is the order they run, which isn't always number order)", () => {
    const versions = list.map((migration) => migration.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("has one file per migration, each in the list", () => {
    const folder = path.resolve(__dirname, `../../src/lib/db/migrations/${which}`);
    const files = readdirSync(folder).filter((name) => name.endsWith(".ts")).sort();
    const expected = list.map((migration) => `${migration.version}-${migration.name.replace(/_/g, "-")}.ts`).sort();
    expect(files).toEqual(expected);
  });
});
