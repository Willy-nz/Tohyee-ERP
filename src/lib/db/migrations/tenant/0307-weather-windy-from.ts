import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0307",
    name: "weather_windy_from",
    sql: `
-- The forecast's pictures (WX12): a day shows the wind picture once its
-- strongest wind reaches this speed. Each farm has its own, since an
-- exposed coastal farm calls a different day windy than a sheltered one.
alter table weather_locations add column windy_kmh integer not null default 40 check (windy_kmh between 10 and 150);
`,
  };
