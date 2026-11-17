import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0207",
    name: "farm_location_shares",
    sql: `
-- Farm members on the map (#498 item 7, decisions 1125-1134): one row per
-- person who has chosen to share where they are with one farm, holding only
-- their latest position (no history). Deleted when they stop, when the time
-- they chose runs out (12 hours at most) and, whatever happens, 24 hours
-- after it started. Left out of backups (pg_dump --exclude-table-data).
create table farm_location_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  user_email text not null check (user_email = lower(user_email) and length(user_email) between 3 and 254),
  farm_id bigint not null references farms(id) on delete cascade,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  accuracy_metres double precision check (accuracy_metres > 0 and accuracy_metres <= 2000),
  -- When the phone took the fix (never later than it reached Tohyee) and when it reached Tohyee (for the rate limit).
  position_at timestamptz,
  received_at timestamptz,
  check (ends_at > started_at and ends_at <= started_at + interval '12 hours'),
  check ((latitude is null) = (longitude is null) and (latitude is null) = (accuracy_metres is null) and (latitude is null) = (position_at is null) and (latitude is null) = (received_at is null))
);
create index farm_location_shares_farm on farm_location_shares (farm_id);
`,
  };
