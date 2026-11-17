import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0187",
    name: "farm_app_launchers",
    sql: `
-- Launch tiles for farm apps the organisation uses (#447, decision 908): a
-- name and the address the app opens at, shown on the farm's Today and More
-- pages. Only the address: an app's keys stay with the person who made them
-- (core farm_app_keys), never here. A tile can be for one farm or all.
create table farm_app_launchers (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 60),
  url text not null check (length(url) between 8 and 500),
  description text check (description is null or length(description) <= 200),
  farm_id bigint references farms(id),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text
);
`,
  };
