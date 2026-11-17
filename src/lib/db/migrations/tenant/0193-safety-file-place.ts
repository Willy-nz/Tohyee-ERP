import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0193",
    name: "safety_file_place",
    sql: `
-- Where a photo was taken, when the phone could tell (#472 stage 4,
-- decision 1012): latitude, longitude, the phone's accuracy in metres and
-- the phone's time of the fix, as the phone gave them. Optional; never the
-- server's time (received_at is that).
alter table safety_files add column place jsonb check (
  place is null or (
    jsonb_typeof(place) = 'object'
    and (place->>'latitude')::numeric between -90 and 90
    and (place->>'longitude')::numeric between -180 and 180
    and (place->>'accuracyM' is null or (place->>'accuracyM')::numeric between 0 and 100000)
  )
);
`,
  };
