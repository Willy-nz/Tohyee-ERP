import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0246",
    name: "rainfall",
    sql: `
-- Rainfall (decisions 1451-1456): rain gauges on a farm, optionally placed
-- on the map, and one reading a gauge a day in millimetres, typed, sent
-- from a phone through the offline queue (operation id), or imported. Edits
-- keep who and when; a reading entered by mistake is removed and kept.
create table rain_gauges (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  name text not null check (length(name) between 1 and 100),
  note text check (note is null or length(note) between 1 and 500),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  check ((latitude is null) = (longitude is null)),
  is_active boolean not null default true,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz
);
create unique index rain_gauges_name on rain_gauges (farm_id, lower(name));

create table rainfall_readings (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  gauge_id bigint not null references rain_gauges(id),
  read_on date not null,
  mm numeric(6, 1) not null check (mm >= 0 and mm <= 2000),
  note text check (note is null or length(note) between 1 and 200),
  source text not null check (length(source) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz,
  removed_by_email text,
  removed_at timestamptz,
  operation_id uuid unique,
  request_hash text,
  check ((operation_id is null) = (request_hash is null))
);
create unique index rainfall_readings_one_a_day on rainfall_readings (gauge_id, read_on) where status = 'active';
create index rainfall_readings_farm on rainfall_readings (farm_id, read_on) where status = 'active';
create trigger rain_gauges_no_delete before delete on rain_gauges for each row execute function toeyee_forbid_delete();
create trigger rainfall_readings_no_delete before delete on rainfall_readings for each row execute function toeyee_forbid_delete();

-- A file of readings is imported once a gauge (its fingerprint is kept).
create table rainfall_imports (
  id bigserial primary key,
  gauge_id bigint not null references rain_gauges(id),
  file_name text not null check (length(file_name) between 1 and 200),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  imported integer not null check (imported >= 0),
  skipped integer not null check (skipped >= 0),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (gauge_id, sha256)
);
`,
  };
