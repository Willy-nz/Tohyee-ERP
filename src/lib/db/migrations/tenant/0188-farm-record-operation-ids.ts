import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0188",
    name: "farm_record_operation_ids",
    sql: `
-- Records made on a phone carry the phone's own id for them (#447, decision
-- 912), so sending the same one again (a farm walk synced twice, a retry
-- after the signal dropped) finds the first instead of making a second.
-- The request's fingerprint tells a true repeat from a different record
-- reusing the id, which is refused rather than overwriting anything.
alter table pasture_readings add column operation_id uuid, add column request_hash text;
alter table grazings add column operation_id uuid, add column request_hash text;
alter table supplements_fed add column operation_id uuid, add column request_hash text;
create unique index pasture_readings_operation_id_key on pasture_readings (operation_id) where operation_id is not null;
create unique index grazings_operation_id_key on grazings (operation_id) where operation_id is not null;
create unique index supplements_fed_operation_id_key on supplements_fed (operation_id) where operation_id is not null;
`,
  };
