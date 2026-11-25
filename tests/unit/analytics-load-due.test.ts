import { describe, expect, it } from "vitest";
import { loadDue } from "@/lib/analytics/scheduler";

/** SPF12 (review L2): a nightly load cut off by a restart doesn't hold back that day's load. */
describe("the nightly Analytics load", () => {
  const at = (time: string) => new Date(`2026-10-05T${time}:00+13:00`);

  it("waits for a load that's still running", () => {
    expect(loadDue(at("04:30"), [{ status: "running", trigger: "schedule", startedAt: at("04:05") }])).toBe(false);
  });

  it("goes ahead once a load has been 'running' for more than an hour", () => {
    expect(loadDue(at("05:06"), [{ status: "running", trigger: "schedule", startedAt: at("04:05") }])).toBe(true);
  });
});
