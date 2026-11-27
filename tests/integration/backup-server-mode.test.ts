import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as backupServerRoute from "@/app/api/admin/backup-server/route";
import * as backupsRoute from "@/app/api/admin/backups/route";
import * as roleRoute from "@/app/api/server-role/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { backupSource, forgetServerRole, getBackupServerSettings, noteStartedRole, pairAsBackupServer, serverRole, unpairBackupServer } from "@/lib/backup-server/mode";
import { BACKUP_SERVER_ADMINS_ONLY, BACKUP_SERVER_MESSAGE } from "@/lib/backup-server/rules";
import { exportRecoveryKit } from "@/lib/backups/recovery-kit";
import { runDueBackups } from "@/lib/backups/scheduler";
import { backUpNow, checkBackup, listBackupFiles, resumeOrganisationJobs, updateBackupSettings } from "@/lib/backups/service";
import { coreQuery } from "@/lib/db/transactions";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, sessionCookieFor, startTestServer, TEST_PASSWORD, type TestServer } from "../helpers/test-server";

const ORG = "harbour-club";
const KEY = "backup-server-test-key-0123456789abcdefgh";
const noContext = undefined as unknown;

/** Backup server mode (BKS4-BKS7, not yet reviewed). One test database plays the main, then a fresh backup server. Made-up people. */
describeWithDatabase("backup server mode", () => {
  let server: TestServer;
  let admin: SessionUser;
  let kim: SessionUser;
  let folder: string;
  let empty: string;
  let code: string;
  let adminCookie: string;
  let kimCookie: string;
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = KEY;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-main-backups-"));
    empty = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-empty-"));
    admin = await createTestUser("moana@example.com", { serverAdmin: true });
    kim = await createTestUser("kim@example.com");
    await createTestOrganisation(admin, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, kim.id]);
    // The main: backs up into the folder and has a recovery kit.
    await updateBackupSettings({ user: admin }, { folder });
    const made = await backUpNow({ trigger: "manual", requestedByEmail: admin.email });
    expect(made.every((run) => run.status === "ok")).toBe(true);
    const kit = await exportRecoveryKit({ user: admin }, { password: TEST_PASSWORD, form: "code" });
    if (kit.form !== "code") throw new Error("expected a code");
    code = kit.code;
    adminCookie = await sessionCookieFor(admin);
    kimCookie = await sessionCookieFor(kim);
    forgetServerRole();
    await noteStartedRole();
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    forgetServerRole();
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rm(empty, { recursive: true, force: true });
  });

  it("BKS4 a main server by default, and pairing is refused while it has organisations", async () => {
    expect(await serverRole()).toBe("main");
    expect(await getBackupServerSettings()).toMatchObject({ role: "main", folder: null, restartNeeded: false });
    expect(await (await roleRoute.GET(apiRequest("/api/server-role", { cookie: kimCookie }), noContext)).json()).toMatchObject({ role: "main" });
    await expect(pairAsBackupServer({ user: admin }, { folder, key: code })).rejects.toThrow(/starts empty, and this server has an organisation/);
    expect(await serverRole()).toBe("main");
  });

  it("BKS4 on a fresh server: needs a folder with backups and the kit that opens them", async () => {
    // A fresh install: no organisations of its own.
    await coreQuery("delete from organisation_members where organisation_id = $1", [ORG]);
    await coreQuery("delete from organisations where id = $1", [ORG]);
    await expect(pairAsBackupServer({ user: kim }, { folder, key: code })).rejects.toThrow(/Only a server admin/);
    await expect(pairAsBackupServer({ user: admin }, { folder: "relative/folder", key: code })).rejects.toThrow(/full path/);
    await expect(pairAsBackupServer({ user: admin }, { folder: empty, key: code })).rejects.toThrow(/no Tohyee backups/);
    await expect(pairAsBackupServer({ user: admin }, { folder })).rejects.toThrow(/recovery code, or its recovery file/);
    expect(await serverRole()).toBe("main");

    const paired = await backupServerRoute.PUT(apiRequest("/api/admin/backup-server", { method: "PUT", cookie: adminCookie, body: { folder, key: code } }), noContext);
    expect(paired.status).toBe(200);
    const body = (await paired.json()) as { backupServer: { role: string; folder: string; restartNeeded: boolean; pairedByEmail: string } };
    // Jobs were chosen at start as a main server, so a restart finishes the change.
    expect(body.backupServer).toMatchObject({ role: "backup", folder, restartNeeded: true, pairedByEmail: admin.email });
    expect(await serverRole()).toBe("backup");
    // The main's recovery key is kept (encrypted) and opens the main's backups; the stored value shows no key.
    const source = await backupSource();
    expect(source?.folder).toBe(folder);
    const files = await listBackupFiles();
    await expect(checkBackup(path.join(folder, files[0].name), source!.material)).resolves.toMatchObject({ kind: expect.any(String) });
    const stored = await coreQuery<{ value: Record<string, unknown> }>("select value from server_settings where key = 'backup_server'");
    expect(JSON.stringify(stored.rows[0].value)).not.toContain("recoveryKey");
    await expect(pairAsBackupServer({ user: admin }, { folder, key: code })).rejects.toThrow(/already a backup server/);
  });

  it("BKS5 a backup server takes no changes, and only server admins look", async () => {
    const change = await backupsRoute.PUT(apiRequest("/api/admin/backups", { method: "PUT", cookie: adminCookie, body: { time: "04:00" } }), noContext);
    expect(change.status).toBe(403);
    expect(((await change.json()) as { error: string }).error).toBe(BACKUP_SERVER_MESSAGE);
    expect((await backupsRoute.GET(apiRequest("/api/admin/backups", { cookie: adminCookie }), noContext)).status).toBe(200);
    expect(await (await roleRoute.GET(apiRequest("/api/server-role", { cookie: adminCookie }), noContext)).json()).toMatchObject({ role: "backup" });
    // Kim isn't a server admin: every page but the role and the switch-over screen (BKS15) is closed to her.
    expect(await (await roleRoute.GET(apiRequest("/api/server-role", { cookie: kimCookie }), noContext)).json()).toEqual({ role: "backup", maySwitchOver: false });
    const notAdmin = await backupsRoute.GET(apiRequest("/api/admin/backups", { cookie: kimCookie }), noContext);
    expect(notAdmin.status).toBe(403);
    expect(((await notAdmin.json()) as { error: string }).error).toBe(BACKUP_SERVER_ADMINS_ONLY);
  });

  it("BKS6 a backup server runs no jobs and makes no backups of its own", async () => {
    expect(await listOrganisationsForJobs()).toEqual([]);
    expect(await runDueBackups(new Date("2030-01-01T20:00:00Z"))).toEqual([]);
    await expect(resumeOrganisationJobs({ user: admin }, ORG)).rejects.toThrow(/backup server: its copies' automatic jobs stay off/);
  });

  it("BKS7 a pairing with no copies yet can be undone; one with copies can't", async () => {
    await coreQuery("insert into organisations (id, display_name, database_name, base_currency, created_by) values ('copy-co', 'Copy Co', 'tohyee_never_made', 'NZD', $1)", [admin.id]);
    await expect(unpairBackupServer({ user: admin })).rejects.toThrow(/holds copies of organisations/);
    await coreQuery("delete from organisations where id = 'copy-co'");
    const undone = await backupServerRoute.DELETE(apiRequest("/api/admin/backup-server", { method: "DELETE", cookie: adminCookie }), noContext);
    expect(undone.status).toBe(200);
    expect(await serverRole()).toBe("main");
    // A main server again: changes are taken.
    expect((await backupsRoute.PUT(apiRequest("/api/admin/backups", { method: "PUT", cookie: adminCookie, body: { time: "02:00" } }), noContext)).status).toBe(200);
    await expect(unpairBackupServer({ user: admin })).rejects.toThrow(/isn't a backup server/);
  });
});
