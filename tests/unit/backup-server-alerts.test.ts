import { describe, expect, it } from "vitest";
import { goneQuiet, quietHoursFor } from "@/lib/backup-server/alerts";

describe("backup server: when the other server has gone quiet (BKS13)", () => {
  it("hourly backups mean 3 hours is too long; nightly ones, or too few to tell, 30", () => {
    expect(quietHoursFor(["2026-11-27T10:00:00Z", "2026-11-27T11:00:00Z"])).toBe(3);
    expect(quietHoursFor(["2026-11-27T11:00:00Z", "2026-11-27T09:00:00Z"])).toBe(3);
    expect(quietHoursFor(["2026-11-26T02:00:00Z", "2026-11-27T02:00:00Z"])).toBe(30);
    expect(quietHoursFor(["2026-11-27T02:00:00Z"])).toBe(30);
    expect(quietHoursFor([])).toBe(30);
  });

  it("is quiet only once the newest is older than that", () => {
    const now = new Date("2026-11-27T14:00:00Z");
    expect(goneQuiet(now, "2026-11-27T11:00:00Z", 3)).toBe(false);
    expect(goneQuiet(now, "2026-11-27T10:59:00Z", 3)).toBe(true);
    expect(goneQuiet(now, "2026-11-26T09:00:00Z", 30)).toBe(false);
    expect(goneQuiet(now, "2026-11-26T07:59:00Z", 30)).toBe(true);
    // Nothing ever seen isn't "gone quiet": there's nothing to compare with yet.
    expect(goneQuiet(now, null, 3)).toBe(false);
  });
});
