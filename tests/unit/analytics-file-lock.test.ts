import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyticsLockedMessage, createWaitingForLock } from "@/lib/analytics/engine";

/** Jade's issue 3 (11 Nov 2026): another Tohyee process holding the analytics file. */
describe("a locked analytics file", () => {
  const windows = new Error(
    'IO Error: Cannot open file "C:\\ProgramData\\Tohyee\\analytics\\example.duckdb": The process cannot access the file because it is being used by another process. File is already open in C:\\Program Files\\Tohyee\\node\\node.exe (PID 12092).',
  );

  it("says so plainly, with the process number", () => {
    expect(analyticsLockedMessage(windows)).toBe(
      "Analytics is locked by another Tohyee process (process 12092), usually one left running after an update. Restart Tohyee (or the computer) and try again.",
    );
    expect(analyticsLockedMessage(new Error('IO Error: Could not set lock on file "/x.duckdb": Conflicting lock is held in /usr/bin/node (PID 5)'))).toContain("(process 5)");
    expect(analyticsLockedMessage(new Error("Catalog Error: no such table"))).toBeNull();
  });

  it("waits for the other process to let go, then gives up with that message", async () => {
    let tries = 0;
    expect(
      await createWaitingForLock(
        async () => {
          tries += 1;
          if (tries < 3) throw windows;
          return "open";
        },
        [1, 1, 1],
      ),
    ).toBe("open");
    expect(tries).toBe(3);
    await expect(createWaitingForLock(async () => Promise.reject(windows), [1])).rejects.toThrow("Analytics is locked by another Tohyee process");
    await expect(createWaitingForLock(async () => Promise.reject(new Error("other")), [1])).rejects.toThrow("other");
  });
});

/**
 * The owner's report of 23 Nov 2026: the lock kept coming back with nothing
 * left running. The built server holds two copies of the engine in one
 * process (start-up schedulers, and the pages and API routes); each kept its
 * own list of open files, so each opened the file, and on Windows the second
 * open is refused. The process number in the message was the server's own.
 */
describe("two copies of the engine in one process", () => {
  it("share one open file, so the server can't lock itself out", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-analytics-copies-"));
    const before = process.env.TOHYEE_ANALYTICS_DIR;
    process.env.TOHYEE_ANALYTICS_DIR = root;
    try {
      vi.resetModules();
      const first = await import("@/lib/analytics/engine");
      vi.resetModules();
      const second = await import("@/lib/analytics/engine");
      expect(second.queryAnalytics).not.toBe(first.queryAnalytics); // really two copies

      expect(await first.queryAnalytics("copies", "select 1 as one")).toEqual([{ one: 1 }]);
      expect(await second.queryAnalytics("copies", "select 2 as two")).toEqual([{ two: 2 }]);
      // One open file between them: the second copy used the first's.
      expect(first.openAnalyticsFiles()).toEqual([first.analyticsFilePath("copies")]);
      expect(second.openAnalyticsFiles()).toEqual(first.openAnalyticsFiles());
      // And closing it through one copy closes it for the other.
      await second.closeAnalytics("copies");
      expect(first.openAnalyticsFiles()).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.TOHYEE_ANALYTICS_DIR;
      else process.env.TOHYEE_ANALYTICS_DIR = before;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("says it's Tohyee's own fault when the process holding the file is this one", async () => {
    const { analyticsLockedMessage } = await import("@/lib/analytics/engine");
    const own = new Error(`IO Error: Cannot open file "C:\\x.duckdb": The process cannot access the file because it is being used by another process. File is already open in node.exe (PID ${process.pid})`);
    expect(analyticsLockedMessage(own)).toContain("a fault in Tohyee");
    expect(analyticsLockedMessage(own)).not.toContain("left running after an update");
  });
});
