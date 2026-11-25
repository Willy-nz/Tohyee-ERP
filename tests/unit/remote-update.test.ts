import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import type { AuthContext } from "@/lib/auth/guard";

const prepareUpdate = vi.fn();
const writeAdminAuditEvent = vi.fn();
let lastStart: { version: string; previousVersion: string | null; startedAt: string; organisationsChecked: number; organisationsUpgraded: number; organisationsBlocked: number } | null = null;

vi.mock("@/lib/updates/updates", () => ({
  prepareUpdate: (...args: unknown[]) => prepareUpdate(...args),
  updateSummary: async () => ({
    currentVersion: packageJson.version,
    checkedAt: null,
    nextCheckAt: null,
    checkError: null,
    latestVersion: "99.0.0",
    updateAvailable: true,
    releaseName: "Tohyee v99.0.0",
    publishedAt: null,
    releaseNotesUrl: null,
    lastStart,
  }),
}));
vi.mock("@/lib/audit", () => ({ writeAdminAuditEvent: (...args: unknown[]) => writeAdminAuditEvent(...args) }));
vi.mock("@/lib/db/transactions", () => ({ coreQuery: vi.fn() }));

const { parseUpdaterStatus, remoteUpdateState, requestRemoteUpdate, REQUEST_STUCK_AFTER_MS } = await import("@/lib/updates/remote-update");
const { updaterBusy } = await import("@/lib/updates/updater-status");

function auth(isServerAdmin = true): AuthContext {
  return { sessionId: "s", user: { id: "u1", email: "admin@example.com", displayName: "Admin", isServerAdmin } } as unknown as AuthContext;
}

const realPlatform = process.platform;
function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

let requests: string;
let statuses: string;

beforeEach(async () => {
  requests = await mkdtemp(path.join(os.tmpdir(), "tohyee-update-request-"));
  statuses = await mkdtemp(path.join(os.tmpdir(), "tohyee-update-status-"));
  process.env.TOHYEE_UPDATE_REQUEST_DIR = requests;
  process.env.TOHYEE_UPDATE_STATUS_DIR = statuses;
  setPlatform("win32");
  lastStart = null;
  prepareUpdate.mockReset();
  writeAdminAuditEvent.mockReset();
  prepareUpdate.mockResolvedValue({ currentVersion: packageJson.version, version: "99.0.0", setup: {}, backups: [{ status: "ok" }, { status: "ok" }] });
});

afterEach(async () => {
  setPlatform(realPlatform);
  delete process.env.TOHYEE_UPDATE_REQUEST_DIR;
  delete process.env.TOHYEE_UPDATE_STATUS_DIR;
  await rm(requests, { recursive: true, force: true });
  await rm(statuses, { recursive: true, force: true });
});

describe("Update now in Tohyee (UPD1-UPD6)", () => {
  it("UPD1: only a server admin, but from any device (no local-address check)", async () => {
    await expect(remoteUpdateState(auth(false))).rejects.toThrow("Only a server admin");
    const state = await remoteUpdateState(auth());
    expect(state.canUpdateHere).toBe(true);
    expect(state.pending).toBeNull();
  });

  it("UPD2: backs up first (prepareUpdate), then leaves only a version for the updater, and records who asked", async () => {
    const now = new Date("2026-11-22T08:00:00Z");
    const state = await requestRemoteUpdate(auth(), { version: "99.0.0" }, () => now);
    expect(prepareUpdate).toHaveBeenCalledWith(expect.anything(), { version: "99.0.0" });
    const written = JSON.parse(await readFile(path.join(requests, "request.json"), "utf8"));
    expect(written).toEqual({ version: "99.0.0", requestedBy: "admin@example.com", requestedAt: now.toISOString() });
    expect(state.pending).toMatchObject({ version: "99.0.0", stuck: false });
    expect(writeAdminAuditEvent).toHaveBeenCalledWith(expect.anything(), { userId: "u1", email: "admin@example.com" }, expect.objectContaining({ eventType: "server_update_requested" }));
  });

  it("UPD3: nothing is handed over when a backup or check fails", async () => {
    prepareUpdate.mockRejectedValue(new Error("The update wasn't started because a backup failed"));
    await expect(requestRemoteUpdate(auth(), { version: "99.0.0" })).rejects.toThrow("a backup failed");
    await expect(readFile(path.join(requests, "request.json"), "utf8")).rejects.toThrow();
  });

  it("UPD4: a second request waits for the first, unless the first is stuck", async () => {
    const at = new Date("2026-11-22T08:00:00Z");
    await requestRemoteUpdate(auth(), { version: "99.0.0" }, () => at);
    await expect(requestRemoteUpdate(auth(), { version: "99.0.0" }, () => new Date(at.getTime() + 60_000))).rejects.toThrow("on its way");
    const later = new Date(at.getTime() + REQUEST_STUCK_AFTER_MS + 1000);
    const state = await requestRemoteUpdate(auth(), { version: "99.0.0" }, () => later);
    expect(state.pending?.requestedAt).toBe(later.toISOString());
  });

  it("UPD5: not offered on servers without the Windows updater", async () => {
    setPlatform("linux");
    const state = await remoteUpdateState(auth());
    expect(state.canUpdateHere).toBe(false);
    expect(state.notHere).toContain("Windows installer");
    await expect(requestRemoteUpdate(auth(), { version: "99.0.0" })).rejects.toThrow("Windows installer");
    expect(prepareUpdate).not.toHaveBeenCalled();
  });

  it("UPD6: reads what the updater said, keeping only known states and a version number", async () => {
    const now = new Date("2026-11-22T09:00:00Z");
    expect(parseUpdaterStatus('﻿{"state":"failed","version":"99.0.0","message":"No SHA-256","at":"2026-11-22T08:59:00Z"}', now, "1.0.0")).toEqual({
      state: "failed",
      version: "99.0.0",
      message: "No SHA-256",
      at: "2026-11-22T08:59:00Z",
      overdue: false,
      outcome: "failed",
      note: null,
    });
    expect(parseUpdaterStatus('{"state":"hacked","version":"1.0.0"}', now)).toBeNull();
    expect(parseUpdaterStatus("not json", now)).toBeNull();
    expect(parseUpdaterStatus('{"state":"skipped","version":"<script>"}', now)?.version).toBeNull();
    // Installing for over 20 minutes without this server reaching that version: it didn't finish.
    expect(parseUpdaterStatus('{"state":"installing","version":"99.0.0","at":"2026-11-22T08:30:00Z"}', now, "1.0.0")?.overdue).toBe(true);
    expect(parseUpdaterStatus('{"state":"installing","version":"1.0.0","at":"2026-11-22T08:30:00Z"}', now, "1.0.0")?.overdue).toBe(false);

    await writeFile(path.join(statuses, "status.json"), '{"state":"skipped","version":"0.0.1","message":"v0.40.0 is already installed."}');
    expect((await remoteUpdateState(auth())).updater).toMatchObject({ state: "skipped", version: "0.0.1" });
  });

  it("UPD7: a finished install doesn't hold Update now back for the next release", async () => {
    const now = new Date("2026-11-29T09:00:00Z");
    // What a 0.44/0.45 updater leaves behind after a good update: "installing" the version that now runs.
    const done = parseUpdaterStatus('{"state":"installing","version":"1.1.0","at":"2026-11-22T08:30:00Z"}', now, "1.1.0");
    expect(done).toMatchObject({ outcome: "installed", overdue: false });
    expect(updaterBusy(done)).toBe(false);
    // What the installer writes from this version on.
    expect(parseUpdaterStatus('{"state":"installed","version":"1.1.0","at":"2026-11-22T08:34:00Z"}', now, "1.1.0")?.outcome).toBe("installed");
    // An earlier update's status, once this server has moved past it, says nothing.
    expect(parseUpdaterStatus('{"state":"failed","version":"1.0.5","at":"2026-11-01T08:00:00Z"}', now, "1.1.0")?.outcome).toBe("old");

    // With that status on the server, the next release can be asked for.
    await writeFile(path.join(statuses, "status.json"), `{"state":"installing","version":"${packageJson.version}","at":"2026-11-22T08:30:00Z"}`);
    const state = await requestRemoteUpdate(auth(), { version: "99.0.0" }, () => now);
    expect(state.updater?.outcome).toBe("installed");
    expect(state.pending?.version).toBe("99.0.0");
  });

  it("UPD8: an install from before this server last started, for a version it doesn't run, didn't finish", async () => {
    const now = new Date("2026-11-22T08:40:00Z");
    const text = '{"state":"installing","version":"1.1.0","message":"Installing. The installer\'s log is update-1.1.0.log in Tohyee\'s logs.","at":"2026-11-22T08:30:00Z"}';
    // Still within 20 minutes and no restart yet: busy.
    expect(parseUpdaterStatus(text, now, "1.0.0", "2026-11-22T07:00:00Z")?.outcome).toBe("working");
    // Tohyee started again at 08:36, still on v1.0.0: failed, with what to do, and Update now can go again.
    const stale = parseUpdaterStatus(text, now, "1.0.0", "2026-11-22T08:36:00Z");
    expect(stale).toMatchObject({ outcome: "failed", overdue: false });
    expect(stale?.note).toContain("still runs v1.0.0");
    expect(stale?.note).toContain("Try Update now again");
    expect(updaterBusy(stale)).toBe(false);

    lastStart = { version: packageJson.version, previousVersion: null, startedAt: "2026-11-22T08:36:00Z", organisationsChecked: 1, organisationsUpgraded: 0, organisationsBlocked: 0 };
    await writeFile(path.join(statuses, "status.json"), text);
    expect((await remoteUpdateState(auth(), now)).updater?.outcome).toBe("failed");
  });

  it("UPD9: the installer's own answer is shown; a failed or overdue install lets it be asked again; a running one doesn't", async () => {
    const now = new Date("2026-11-22T09:00:00Z");
    const failed = parseUpdaterStatus(
      '{"state":"failed","version":"1.1.0","message":"v1.1.0 couldn\'t be installed, so v1.0.0 was put back and is running.","at":"2026-11-22T08:50:00Z"}',
      now,
      "1.0.0",
    );
    expect(failed).toMatchObject({ outcome: "failed", message: expect.stringContaining("was put back") });
    expect(updaterBusy(failed)).toBe(false);
    const downloading = parseUpdaterStatus('{"state":"downloading","version":"1.1.0","at":"2026-11-22T08:50:00Z"}', now, "1.0.0");
    expect(updaterBusy(downloading)).toBe(true);
    // A download can't run longer than the updater's 45 minutes.
    expect(parseUpdaterStatus('{"state":"downloading","version":"1.1.0","at":"2026-11-22T08:00:00Z"}', now, "1.0.0")).toMatchObject({ outcome: "failed", overdue: true });

    // While the updater says it's installing (and it isn't overdue), a second request is refused.
    await writeFile(path.join(statuses, "status.json"), `{"state":"installing","version":"99.0.0","at":"${new Date(Date.now() + 60_000).toISOString()}"}`);
    await expect(requestRemoteUpdate(auth(), { version: "99.0.0" })).rejects.toThrow("installing now");
    expect(prepareUpdate).not.toHaveBeenCalled();
  });
});
