import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as backupsRoute from "@/app/api/admin/backups/route";
import * as switchRoute from "@/app/api/backup-server/switch-over/route";
import * as roleRoute from "@/app/api/server-role/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { forgetServerRole, pairAsBackupServer, serverIdentity, serverRole } from "@/lib/backup-server/mode";
import { checkMainReachable, lastPractice, practiseSwitchOver, setMainAddress } from "@/lib/backup-server/practice";
import { refreshCopies } from "@/lib/backup-server/refresh";
import { BACKUP_SERVER_ADMINS_ONLY, FENCED_MESSAGE } from "@/lib/backup-server/rules";
import { checkMainMoved, mainAfterAll, makeMainServer } from "@/lib/backup-server/switch";
import { exportRecoveryKit } from "@/lib/backups/recovery-kit";
import { backUpNow, updateBackupSettings } from "@/lib/backups/service";
import { closeOrganisationPool, getAdminPool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { coreQuery } from "@/lib/db/transactions";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { getOrganisation } from "@/lib/organisations/registry";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, sessionCookieFor, startTestServer, TEST_PASSWORD, type TestServer } from "../helpers/test-server";

const HARBOUR = "harbour-club";
const KEY = "backup-server-test-key-0123456789abcdefgh";
const noContext = undefined as unknown;

/** Switching over (BKS15-BKS19, not yet reviewed). One test database plays the main, a fresh backup server, the new main, and then the old main coming back. */
describeWithDatabase("backup server: switching over", () => {
  let server: TestServer;
  let moana: SessionUser;
  let aroha: SessionUser;
  let kim: SessionUser;
  let folder: string;
  let code: string;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const paused = async () => (await coreQuery<{ paused: boolean }>("select jobs_paused_at is not null as paused from organisations where id = $1", [HARBOUR])).rows[0].paused;
  const note = async () => JSON.parse(await fs.readFile(path.join(folder, "_backup-server", "main-moved.json"), "utf8")) as { serverId: string; at: string; byEmail: string };

  beforeAll(async () => {
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = KEY;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-main-backups-"));
    moana = await createTestUser("moana@example.com", { serverAdmin: true });
    aroha = await createTestUser("aroha@example.com");
    kim = await createTestUser("kim@example.com");
    // The main: Harbour Club, owned by Aroha (not a server admin), with Kim a bookkeeper.
    await createTestOrganisation(moana, HARBOUR);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'bookkeeper')", [HARBOUR, aroha.id, kim.id]);
    await updateBackupSettings({ user: moana }, { folder });
    expect((await backUpNow({ trigger: "manual", requestedByEmail: moana.email })).every((run) => run.status === "ok")).toBe(true);
    const kit = await exportRecoveryKit({ user: moana }, { password: TEST_PASSWORD, form: "code" });
    if (kit.form !== "code") throw new Error("expected a code");
    code = kit.code;
    // A fresh backup server, paired and with its first copy.
    const organisation = await getOrganisation(HARBOUR);
    await closeOrganisationPool(organisation!.databaseName).catch(() => undefined);
    await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(organisation!.databaseName)} with (force)`);
    await coreQuery("delete from organisation_members where organisation_id = $1", [HARBOUR]);
    await coreQuery("delete from organisations where id = $1", [HARBOUR]);
    await coreQuery("delete from users where id = any($1::uuid[])", [[aroha.id, kim.id]]);
    await pairAsBackupServer({ user: moana }, { folder, key: code });
    forgetServerRole();
    expect(await refreshCopies(new Date("2026-11-27T10:05:00Z"))).toMatchObject({ refreshed: [HARBOUR], failed: [] });
    // Test people's two-step secret is a placeholder that can't be carried over; put it back so they count as signed in.
    await coreQuery("update users set totp_secret_ciphertext = 'test-placeholder', totp_enabled_at = now() where id = any($1::uuid[])", [[moana.id, aroha.id, kim.id]]);
  }, 240_000);

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    forgetServerRole();
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("BKS15 on a backup server an Owner reaches the switch-over screen and nothing else; others can't switch over", async () => {
    const arohaCookie = await sessionCookieFor(aroha);
    const kimCookie = await sessionCookieFor(kim);
    const seen = (await (await switchRoute.GET(apiRequest("/api/backup-server/switch-over", { cookie: arohaCookie }), noContext)).json()) as { preview: { allowed: boolean; organisations: { id: string; asAt: string | null }[]; folder: string | null } };
    expect(seen.preview.allowed).toBe(true);
    expect(seen.preview.organisations.map((each) => each.id)).toEqual([HARBOUR]);
    expect(seen.preview.organisations[0].asAt).toBeTruthy();
    // The folder's path is for server admins.
    expect(seen.preview.folder).toBeNull();
    expect(await (await roleRoute.GET(apiRequest("/api/server-role", { cookie: arohaCookie }), noContext)).json()).toEqual({ role: "backup", maySwitchOver: true });
    // Anything else is still server admins only.
    const other = await backupsRoute.GET(apiRequest("/api/admin/backups", { cookie: arohaCookie }), noContext);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toBe(BACKUP_SERVER_ADMINS_ONLY);
    // Kim isn't an Owner: told only that she can't, not what's here.
    const kims = (await (await switchRoute.GET(apiRequest("/api/backup-server/switch-over", { cookie: kimCookie }), noContext)).json()) as { preview: { allowed: boolean; organisations: unknown[] } };
    expect(kims.preview).toMatchObject({ allowed: false, organisations: [] });
    await expect(makeMainServer({ user: kim }, { password: TEST_PASSWORD, oldMainIsOff: true, reason: "Fire" })).rejects.toThrow(/Only a server admin or an organisation's Owner/);
  });

  it("BKS20 the backup server asks the main's address whether it's up, and offers a switch-over after 15 minutes without an answer", async () => {
    await expect(setMainAddress({ user: kim }, { url: "https://books.example.nz" })).rejects.toThrow(/Only a server admin/);
    await expect(setMainAddress({ user: moana }, { url: "books" })).rejects.toThrow(/in full/);
    await expect(setMainAddress({ user: moana }, { url: "http://books.example.nz" })).rejects.toThrow(/https:/);
    // Not set: nothing is checked.
    expect(await checkMainReachable(new Date("2026-11-27T12:00:00Z"), async () => false)).toBeNull();
    expect(await setMainAddress({ user: moana }, { url: "https://books.example.nz/some/page" })).toMatchObject({ url: "https://books.example.nz", reachable: null, offer: false });
    const up = async () => true;
    const down = async () => false;
    expect(await checkMainReachable(new Date("2026-11-27T12:00:00Z"), up)).toMatchObject({ reachable: true, unreachableSince: null, offer: false });
    expect(await checkMainReachable(new Date("2026-11-27T12:05:00Z"), down)).toMatchObject({ reachable: false, unreachableSince: "2026-11-27T12:05:00.000Z", offer: false, offeredAt: null });
    expect(await checkMainReachable(new Date("2026-11-27T12:15:00Z"), down)).toMatchObject({ offer: false, offeredAt: null });
    // 15 minutes without an answer: asked once, not every five minutes.
    expect(await checkMainReachable(new Date("2026-11-27T12:20:00Z"), down)).toMatchObject({ offer: true, offeredAt: "2026-11-27T12:20:00.000Z" });
    expect(await checkMainReachable(new Date("2026-11-27T12:25:00Z"), down)).toMatchObject({ offer: true, offeredAt: "2026-11-27T12:20:00.000Z" });
    // It never switches by itself.
    expect(await serverRole()).toBe("backup");
    // The main answers again: the spell is over.
    expect(await checkMainReachable(new Date("2026-11-27T12:30:00Z"), up)).toMatchObject({ reachable: true, unreachableSince: null, offer: false, offeredAt: null });
  });

  it("BKS21 practising a switch-over checks each copy opens, the note can be written and the outside address, and switches nothing", async () => {
    await expect(practiseSwitchOver({ user: kim })).rejects.toThrow(/Only a server admin/);
    const practice = await practiseSwitchOver({ user: moana }, new Date("2026-11-27T10:35:00Z"));
    expect(practice.organisations).toHaveLength(1);
    expect(practice.organisations[0]).toMatchObject({ id: HARBOUR, opens: true, problem: null });
    expect(practice.organisations[0].behindMinutes).toBeGreaterThanOrEqual(0);
    expect(practice.noteCanBeWritten).toBe(true);
    // This test server has no remote access, and the practice says so: after a switch only its own network could reach it.
    expect(practice.ready).toBe(false);
    expect(practice.problems).toEqual(["Remote access is off on this server: after a switch-over only its own network could reach it."]);
    // Nothing was switched, and no note was left for the old main.
    expect(await serverRole()).toBe("backup");
    await expect(fs.access(path.join(folder, "_backup-server", "main-moved.json"))).rejects.toThrow();
    await expect(fs.access(path.join(folder, "_backup-server", "practice.tmp"))).rejects.toThrow();
  });

  it("BKS22 the last practice is kept, and it's due again after 6 months", async () => {
    const kept = await lastPractice(new Date("2026-11-28T10:35:00Z"));
    expect(kept.last).toMatchObject({ at: "2026-11-27T10:35:00.000Z", byEmail: moana.email, ready: false });
    expect(kept.due).toBe(false);
    expect((await lastPractice(new Date("2027-05-28T10:35:00Z"))).due).toBe(false);
    expect((await lastPractice(new Date("2027-05-30T10:35:00Z"))).due).toBe(true);
  });

  it("BKS16 switching over needs the password again, the tick and a reason; then this is the main and jobs are on", async () => {
    expect(await paused()).toBe(true);
    await expect(makeMainServer({ user: aroha }, { password: "not-it", oldMainIsOff: true, reason: "Fire" })).rejects.toThrow(/password isn't right/);
    await expect(makeMainServer({ user: aroha }, { password: TEST_PASSWORD, reason: "Fire" })).rejects.toThrow(/Confirm the old main server is off/);
    await expect(makeMainServer({ user: aroha }, { password: TEST_PASSWORD, oldMainIsOff: true, reason: "  " })).rejects.toThrow(/why you're switching over/);
    expect(await serverRole()).toBe("backup");

    const arohaCookie = await sessionCookieFor(aroha);
    const done = await switchRoute.POST(apiRequest("/api/backup-server/switch-over", { method: "POST", cookie: arohaCookie, body: { password: TEST_PASSWORD, oldMainIsOff: true, reason: "The office burned down" } }), noContext);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { result: unknown }).result).toMatchObject({ organisations: [HARBOUR], noteWritten: true });
    expect(await serverRole()).toBe("main");
    expect(await paused()).toBe(false);
    expect((await listOrganisationsForJobs()).map((each) => each.id)).toEqual([HARBOUR]);
    // The note for the old main names this server, and who switched.
    expect(await note()).toMatchObject({ serverId: await serverIdentity(), byEmail: aroha.email });
    const audit = await coreQuery<{ details: { reason: string; byServerAdmin: boolean; copies: Record<string, string> } }>("select details from admin_audit_events where event_type = 'server.made_main'");
    expect(audit.rows[0].details).toMatchObject({ reason: "The office burned down", byServerAdmin: false });
    expect(audit.rows[0].details.copies[HARBOUR]).toBeTruthy();
    // Changes are taken again, and its own note doesn't fence it.
    expect((await backupsRoute.PUT(apiRequest("/api/admin/backups", { method: "PUT", cookie: await sessionCookieFor(moana), body: { time: "03:00" } }), noContext)).status).toBe(200);
    expect(await checkMainMoved()).toBeNull();
    expect(await serverRole()).toBe("main");
    await expect(makeMainServer({ user: moana }, { password: TEST_PASSWORD, oldMainIsOff: true, reason: "Again" })).rejects.toThrow(/isn't a backup server/);
    // A main server doesn't ask after another main, or practise.
    expect(await checkMainReachable(new Date("2026-11-27T14:00:00Z"), async () => false)).toBeNull();
    await expect(practiseSwitchOver({ user: moana })).rejects.toThrow(/isn't a backup server/);
  });

  it("BKS17 the old main, coming back, finds the note and stops: no changes, no jobs, books still readable", async () => {
    // Play the old main: another server's identity, never switched to, backing up into the same folder.
    await coreQuery("update server_settings set value = jsonb_build_object('id', 'the-old-main') where key = 'server_identity'");
    await coreQuery("delete from server_settings where key = 'main_since'");
    forgetServerRole();
    expect(await serverRole()).toBe("main");
    const moved = await checkMainMoved();
    expect(moved?.byEmail).toBe(aroha.email);
    expect(await serverRole()).toBe("fenced");
    expect(await listOrganisationsForJobs()).toEqual([]);
    const change = await backupsRoute.PUT(apiRequest("/api/admin/backups", { method: "PUT", cookie: await sessionCookieFor(moana), body: { time: "04:00" } }), noContext);
    expect(change.status).toBe(403);
    expect(((await change.json()) as { error: string }).error).toBe(FENCED_MESSAGE);
    // People who aren't server admins can still read here.
    expect(await (await roleRoute.GET(apiRequest("/api/server-role", { cookie: await sessionCookieFor(kim) }), noContext)).json()).toEqual({ role: "fenced", maySwitchOver: false });
  });

  it("BKS18 a server admin can say it's the main after all; the same note doesn't fence it again", async () => {
    await expect(mainAfterAll({ user: kim })).rejects.toThrow(/Only a server admin/);
    await mainAfterAll({ user: moana });
    expect(await serverRole()).toBe("main");
    expect(await checkMainMoved()).toBeNull();
    expect(await serverRole()).toBe("main");
    await expect(mainAfterAll({ user: moana })).rejects.toThrow(/isn't waiting on that/);
  });

  it("BKS19 a returned old main can be paired as the backup server though it has organisations", async () => {
    await coreQuery("delete from server_settings where key = 'main_since'");
    forgetServerRole();
    expect(await checkMainMoved()).not.toBeNull();
    expect(await serverRole()).toBe("fenced");
    await pairAsBackupServer({ user: moana }, { folder, key: code });
    expect(await serverRole()).toBe("backup");
    // Its books are copies now: jobs off, and replaced from the new main's backups at the next look.
    expect(await paused()).toBe(true);
    expect((await getOrganisation(HARBOUR))!.id).toBe(HARBOUR);
    expect(await refreshCopies(new Date("2026-11-27T13:05:00Z"))).toMatchObject({ failed: [] });
  }, 240_000);
});
