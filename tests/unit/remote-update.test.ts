import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import type { AuthContext } from "@/lib/auth/guard";

const prepareUpdate = vi.fn();
const writeAdminAuditEvent = vi.fn();

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
    lastStart: null,
  }),
}));
vi.mock("@/lib/audit", () => ({ writeAdminAuditEvent: (...args: unknown[]) => writeAdminAuditEvent(...args) }));
vi.mock("@/lib/db/transactions", () => ({ coreQuery: vi.fn() }));

const { parseUpdaterStatus, remoteUpdateState, requestRemoteUpdate, REQUEST_STUCK_AFTER_MS } = await import("@/lib/updates/remote-update");

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
});
