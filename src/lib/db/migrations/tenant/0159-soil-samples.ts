import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0159",
    name: "soil_samples",
    sql: `
-- Soil samples taken in the field, before the lab's results (#249 stage 5;
-- example FA4, decision 561). Recorded on the screens or by a farm app.
create table soil_samples (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  paddock_id bigint not null references paddocks(id),
  taken_on date not null,
  sample_name text check (sample_name is null or length(sample_name) between 1 and 100),
  depth text check (depth is null or length(depth) between 1 and 40),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  check ((latitude is null) = (longitude is null)),
  note text check (note is null or length(note) between 1 and 500),
  recorded_via text check (recorded_via is null or length(recorded_via) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index soil_samples_farm on soil_samples (farm_id, taken_on) where status = 'active';
create trigger soil_samples_no_delete before delete on soil_samples for each row execute function toeyee_forbid_delete();
`,
  };
