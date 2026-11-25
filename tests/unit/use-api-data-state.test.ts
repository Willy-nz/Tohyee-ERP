import { describe, expect, it } from "vitest";
import { EMPTY_LOAD_STATE, type LoadState, nextLoadState } from "@/components/hooks";

const key = "/api/farming/medicines?{}";

describe("useApiData's load state", () => {
  it("keeps the last good data when a reload of the same request fails, and says so beside it", () => {
    const loaded = nextLoadState<{ count: number }>(EMPTY_LOAD_STATE, key, { ok: true, data: { count: 5 }, at: 1000 });
    const failed = nextLoadState(loaded, key, { ok: false, message: "Tohyee can't be reached." });
    expect(failed.data).toEqual({ count: 5 });
    expect(failed.loadedAt).toBe(1000);
    // `error` stays empty, so screens that return early on an error still show the figures.
    expect(failed.error).toBeNull();
    expect(failed.refreshError).toBe("Tohyee can't be reached.");
  });

  it("clears the refresh problem once a reload works", () => {
    const failed: LoadState<{ count: number }> = { data: { count: 5 }, error: null, refreshError: "Offline", loadedAt: 1000, key };
    const ok = nextLoadState(failed, key, { ok: true, data: { count: 4 }, at: 2000 });
    expect(ok).toEqual({ data: { count: 4 }, error: null, refreshError: null, loadedAt: 2000, key });
  });

  it("is an error, with no data, when the first load fails", () => {
    const failed = nextLoadState(EMPTY_LOAD_STATE, key, { ok: false, message: "Offline" });
    expect(failed).toEqual({ data: null, error: "Offline", refreshError: null, loadedAt: null, key });
  });

  it("never shows another request's data after a failure", () => {
    const loaded = nextLoadState<{ count: number }>(EMPTY_LOAD_STATE, key, { ok: true, data: { count: 5 }, at: 1000 });
    const other = nextLoadState(loaded, "/api/farming/medicines?{\"farmId\":\"b\"}", { ok: false, message: "Offline" });
    expect(other.data).toBeNull();
    expect(other.error).toBe("Offline");
  });
});
