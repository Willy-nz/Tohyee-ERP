import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { forgetServerRole, pairAsBackupServer } from "@/lib/backup-server/mode";
import { copiesState, KEEP_REMOVED_DAYS, readBackupServerReport, refreshCopies } from "@/lib/backup-server/refresh";
import { exportRecoveryKit } from "@/lib/backups/recovery-kit";
import { backUpNow, updateBackupSettings } from "@/lib/backups/service";
import { closeOrganisationPool, getAdminPool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { coreQuery } from "@/lib/db/transactions";
import { postJournal } from "@/lib/ledger/journals";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { getOrganisation } from "@/lib/organisations/registry";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, TEST_PASSWORD, type TestServer } from "../helpers/test-server";

const HARBOUR = "harbour-club";
const SECOND = "second-co";
const KEY = "backup-server-test-key-0123456789abcdefgh";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function journal(date: string, amount: string, reference: string) {
  return { idempotencyKey: key("j"), postingDate: date, reference, lines: [{ accountCode: "1000", debitAmount: amount }, { accountCode: "4000", creditAmount: amount }] };
}

/**
 * A backup server keeping its copy up to date (BKS8-BKS12, not yet
 * reviewed). One test database plays the main, making three rounds of
 * backups, then a fresh backup server that is handed them a round at a time.
 */
describeWithDatabase("backup server: keeping the copy up to date", () => {
  let server: TestServer;
  let moana: SessionUser;
  let kim: SessionUser;
  let tama: SessionUser;
  let folder: string;
  let held: string;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const actorOf = (user: SessionUser) => ({ userId: user.id, email: user.email });
  const journals = async (organisationId: string) => Number((await inOrganisation(organisationId, actorOf(moana), (tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
  const members = async (organisationId: string) =>
    (await coreQuery<{ email: string; role: string }>("select u.email, m.role from organisation_members m join users u on u.id = m.user_id where m.organisation_id = $1 order by u.email", [organisationId])).rows.map((row) => `${row.email}:${row.role}`);
  /** Moves every backup file made so far out of the main's folder into a holding folder for that round. */
  const holdBack = async (round: string) => {
    for (const sub of await fs.readdir(folder)) {
      const from = path.join(folder, sub);
      if (!(await fs.stat(from)).isDirectory()) continue;
      for (const name of await fs.readdir(from)) {
        await fs.mkdir(path.join(held, round, sub), { recursive: true });
        await fs.rename(path.join(from, name), path.join(held, round, sub, name));
      }
    }
  };
  /** The main's next round of backups arrives in the folder the backup server reads. */
  const arrive = async (round: string) => {
    for (const sub of await fs.readdir(path.join(held, round))) {
      await fs.mkdir(path.join(folder, sub), { recursive: true });
      for (const name of await fs.readdir(path.join(held, round, sub))) await fs.rename(path.join(held, round, sub, name), path.join(folder, sub, name));
    }
  };
  const dropOrganisation = async (id: string) => {
    const organisation = await getOrganisation(id);
    if (!organisation) return;
    await closeOrganisationPool(organisation.databaseName).catch(() => undefined);
    await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(organisation.databaseName)} with (force)`);
    await coreQuery("delete from organisation_members where organisation_id = $1", [id]);
    await coreQuery("delete from organisations where id = $1", [id]);
  };

  beforeAll(async () => {
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = KEY;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-main-backups-"));
    held = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-held-"));
    moana = await createTestUser("moana@example.com", { serverAdmin: true });
    kim = await createTestUser("kim@example.com");

    // The main, round 1 (10:00): Harbour Club with one journal; Kim is a bookkeeper.
    await createTestOrganisation(moana, HARBOUR);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [HARBOUR, kim.id]);
    await inOrganisation(HARBOUR, actorOf(moana), (tx) => postJournal(tx, journal("2026-06-15", "100.00", "ONE")));
    await updateBackupSettings({ user: moana }, { folder });
    expect((await backUpNow({ trigger: "manual", requestedByEmail: moana.email })).every((run) => run.status === "ok")).toBe(true);
    await holdBack("one");

    // Round 2 (11:00): a second journal, a second organisation, Kim now a viewer, Tama new.
    await wait(1100);
    await inOrganisation(HARBOUR, actorOf(moana), (tx) => postJournal(tx, journal("2026-06-16", "50.00", "TWO")));
    await createTestOrganisation(moana, SECOND);
    tama = await createTestUser("tama@example.com");
    await coreQuery("update organisation_members set role = 'viewer' where organisation_id = $1 and user_id = $2", [HARBOUR, kim.id]);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [SECOND, tama.id]);
    expect((await backUpNow({ trigger: "manual", requestedByEmail: moana.email })).every((run) => run.status === "ok")).toBe(true);
    await holdBack("two");

    // Round 3 (12:00): the main removes the second organisation.
    await wait(1100);
    await dropOrganisation(SECOND);
    expect((await backUpNow({ trigger: "manual", requestedByEmail: moana.email })).every((run) => run.status === "ok")).toBe(true);
    await holdBack("three");

    const kit = await exportRecoveryKit({ user: moana }, { password: TEST_PASSWORD, form: "code" });
    if (kit.form !== "code") throw new Error("expected a code");

    // A fresh backup server: none of the main's organisations or people but its own admin (Moana, here under another account).
    await dropOrganisation(HARBOUR);
    await coreQuery("delete from users where id = any($1::uuid[])", [[kim.id, tama.id]]);
    await arrive("one");
    await pairAsBackupServer({ user: moana }, { folder, key: kit.code });
    forgetServerRole();
  }, 240_000);

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    forgetServerRole();
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rm(held, { recursive: true, force: true });
  });

  it("BKS8 the first look takes each organisation the main has, with its own ID, name, books and members", async () => {
    const result = await refreshCopies(new Date("2026-11-27T10:05:00Z"));
    expect(result).toMatchObject({ refreshed: [HARBOUR], failed: [], people: true });
    const copy = await getOrganisation(HARBOUR);
    expect(copy).toMatchObject({ id: HARBOUR, isActive: true });
    expect(await journals(HARBOUR)).toBe(1);
    // The main's members, and nobody else: the backup server's own actor isn't made an Owner.
    expect(await members(HARBOUR)).toEqual(["kim@example.com:bookkeeper", "moana@example.com:owner"]);
    // Its jobs are off, and stay off.
    expect((await coreQuery<{ paused: boolean }>("select jobs_paused_at is not null as paused from organisations where id = $1", [HARBOUR])).rows[0].paused).toBe(true);
    expect(await listOrganisationsForJobs()).toEqual([]);
    const state = await copiesState();
    expect(state.organisations[HARBOUR]).toMatchObject({ error: null, refreshedAt: "2026-11-27T10:05:00.000Z" });
    expect(state.mainOrganisations).toEqual([HARBOUR]);
    // Nothing new: nothing done.
    expect(await refreshCopies(new Date("2026-11-27T10:10:00Z"))).toMatchObject({ refreshed: [], failed: [], people: false });
  }, 240_000);

  it("BKS9 a newer backup is restored beside the copy, then swapped in; people and memberships follow the main", async () => {
    const before = await getOrganisation(HARBOUR);
    await arrive("two");
    const result = await refreshCopies(new Date("2026-11-27T11:05:00Z"));
    expect(result.failed).toEqual([]);
    expect(result.refreshed.sort()).toEqual([HARBOUR, SECOND]);
    const after = await getOrganisation(HARBOUR);
    // Same organisation, a new database; the one before is gone and nothing is left beside it.
    expect(after!.id).toBe(HARBOUR);
    expect(after!.databaseName).not.toBe(before!.databaseName);
    expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [before!.databaseName])).rowCount).toBe(0);
    expect((await coreQuery("select 1 from organisations where id like 'incoming-%'")).rowCount).toBe(0);
    expect(await journals(HARBOUR)).toBe(2);
    // Kim's role changed on the main, Tama is new, and the second organisation arrived with its members.
    expect(await members(HARBOUR)).toEqual(["kim@example.com:viewer", "moana@example.com:owner"]);
    expect(await members(SECOND)).toEqual(["moana@example.com:owner", "tama@example.com:bookkeeper"]);
    expect((await copiesState()).mainOrganisations?.sort()).toEqual([HARBOUR, SECOND]);
  }, 240_000);

  it("BKS10 a backup that can't be restored leaves the copy from before in use, and says so", async () => {
    const state = await copiesState();
    const good = state.organisations[HARBOUR];
    // A newer-named file for Harbour Club that's damaged part-way through.
    const source = path.join(folder, good.backupName);
    const bytes = await fs.readFile(source);
    const damaged = Buffer.from(bytes);
    for (let index = Math.floor(damaged.length / 2); index < Math.floor(damaged.length / 2) + 64; index += 1) damaged[index] = damaged[index] ^ 0xff;
    const badName = good.backupName.replace(/_(\d{4}-\d{2}-\d{2})_(\d{6})\./, "_2099-01-01_000000.");
    await fs.writeFile(path.join(folder, badName), damaged);
    // Its header says the same time as the good one, so only its name is newer: it's picked when the good one is out of the way.
    await fs.rename(source, `${source}.aside`);
    const before = await getOrganisation(HARBOUR);
    const result = await refreshCopies(new Date("2026-11-27T11:35:00Z"));
    expect(result.refreshed).toEqual([]);
    expect(result.failed.map((failure) => failure.organisationId)).toEqual([HARBOUR]);
    const after = await copiesState();
    expect(after.organisations[HARBOUR]).toMatchObject({ backupName: good.backupName, madeAt: good.madeAt, errorAt: "2026-11-27T11:35:00.000Z" });
    expect(after.organisations[HARBOUR].error).toBeTruthy();
    expect((await getOrganisation(HARBOUR))!.databaseName).toBe(before!.databaseName);
    expect(await journals(HARBOUR)).toBe(2);
    expect((await coreQuery("select 1 from organisations where id like 'incoming-%'")).rowCount).toBe(0);
    await fs.rm(path.join(folder, badName));
    await fs.rename(`${source}.aside`, source);
  }, 240_000);

  it("BKS11 an organisation the main no longer has is archived here, kept 30 days, then deleted", async () => {
    await arrive("three");
    const result = await refreshCopies(new Date("2026-11-27T12:05:00Z"));
    expect(result.failed).toEqual([]);
    expect(result.archived).toEqual([SECOND]);
    expect((await getOrganisation(SECOND))!.isActive).toBe(false);
    expect((await copiesState()).removed[SECOND]).toMatchObject({ archivedAt: "2026-11-27T12:05:00.000Z" });
    expect((await getOrganisation(HARBOUR))!.isActive).toBe(true);
    // Its old backups are still in the folder, and aren't taken again.
    expect(await refreshCopies(new Date("2026-11-28T12:05:00Z"))).toMatchObject({ refreshed: [], archived: [], deleted: [] });
    // 29 days on it's still here; at 30 it's deleted, database and all.
    expect((await refreshCopies(new Date("2026-12-26T12:05:00Z"))).deleted).toEqual([]);
    const database = (await getOrganisation(SECOND))!.databaseName;
    expect(KEEP_REMOVED_DAYS).toBe(30);
    expect((await refreshCopies(new Date("2026-12-27T12:05:00Z"))).deleted).toEqual([SECOND]);
    expect(await getOrganisation(SECOND)).toBeNull();
    expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [database])).rowCount).toBe(0);
    expect((await copiesState()).removed).toEqual({});
  }, 240_000);

  it("BKS12 it says what it has taken in a small file in the main's folder, naming no people", async () => {
    const report = await readBackupServerReport(folder);
    expect(report?.organisations.map((each) => each.id)).toEqual([HARBOUR]);
    expect(report?.organisations[0]).toMatchObject({ error: null });
    expect(report?.people).toMatchObject({ error: null });
    const text = await fs.readFile(path.join(folder, "_backup-server", "status.json"), "utf8");
    expect(text).not.toContain("@");
    expect(await readBackupServerReport(held)).toBeNull();
  });
});
