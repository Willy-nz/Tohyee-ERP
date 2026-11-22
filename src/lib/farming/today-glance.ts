import { farmCover } from "@/lib/farming/pasture-rules";
import type { PaddockStatus } from "@/lib/farming/paddock-status";

/**
 * The few figures at the top of a farm's Today: what a farmer checks first.
 * Worked from the paddock statuses Today already has, so it shows offline too.
 */
export type TodayGlance = {
  /** Area-weighted average of each paddock's latest reading (PF3); null with no readings. */
  averageCover: number | null;
  /** Paddocks the average is from, and how many of those are estimates. */
  readings: number;
  estimates: number;
  /** Paddocks with stock in now. */
  paddocksStocked: number;
  /** Head in those paddocks; null when any mob in has no head count, so a part count isn't shown as the total. */
  head: number | null;
};

export function todayGlance(onDate: string, paddocks: PaddockStatus[]): TodayGlance {
  const cover = farmCover(
    onDate,
    paddocks.map((paddock) => ({
      paddockId: paddock.paddockId,
      name: paddock.name,
      hectares: paddock.hectares,
      latest: paddock.cover ? { id: paddock.paddockId, paddockId: paddock.paddockId, cover: paddock.cover.cover, measuredOn: paddock.cover.measuredOn, method: paddock.cover.method } : null,
    })),
  );
  const stocked = paddocks.filter((paddock) => paddock.inNow);
  const head = stocked.some((paddock) => paddock.inNow!.head === null) ? null : stocked.reduce((sum, paddock) => sum + (paddock.inNow!.head ?? 0), 0);
  return { averageCover: cover.averageKgDmPerHa, readings: cover.readings, estimates: cover.estimates, paddocksStocked: stocked.length, head: stocked.length ? head : 0 };
}
