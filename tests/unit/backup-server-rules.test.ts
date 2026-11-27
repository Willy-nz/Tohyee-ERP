import { describe, expect, it } from "vitest";
import { backupServerRefuses, FENCED_MESSAGE, openToOwnersOnBackup, refusalFor } from "@/lib/backup-server/rules";

describe("what a backup server refuses (BKS5)", () => {
  it("takes every read, and no change except signing in, its own settings, updates and checking the folder", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(backupServerRefuses(method, "/api/invoices")).toBe(false);
    for (const path of ["/api/invoices", "/api/journals", "/api/admin/backups", "/api/admin/backups/restore", "/api/admin/backups/restore/resume", "/api/organisations", "/api/mcp", "/api/farming/farms/1/tasks", "/api/admin/backup-serverx"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(backupServerRefuses(method, path), `${method} ${path}`).toBe(true);
    }
    for (const path of ["/api/auth/login", "/api/auth/logout", "/api/auth/two-step", "/api/admin/backup-server", "/api/admin/server-update", "/api/admin/backups/check", "/api/admin/backups/restore/find", "/api/backup-server/switch-over", "/api/admin/backup-server/main-after-all"]) {
      expect(backupServerRefuses("POST", path), path).toBe(false);
    }
  });

  it("BKS15 an Owner who isn't a server admin reaches only signing in, the role and the switch-over screen", () => {
    for (const path of ["/api/backup-server/switch-over", "/api/server-role", "/api/auth/logout"]) expect(openToOwnersOnBackup(path), path).toBe(true);
    for (const path of ["/api/invoices", "/api/admin/backup-server", "/api/backup-server/switch-over/x", "/api/organisations"]) expect(openToOwnersOnBackup(path), path).toBe(false);
    expect(refusalFor("fenced")).toBe(FENCED_MESSAGE);
    expect(refusalFor("backup")).toContain("backup copy");
  });
});
